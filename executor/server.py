#!/usr/bin/env python3
"""cf-agent-lab 的远程 Python 执行器。

为什么需要它：Judge0 的公共实例（ce.judge0.com）服务端禁止联网，
所以 pip 装不了任何东西；而 openai-agents 这类库既需要预装、运行时还需要出网。
这个执行器把固定的依赖烤进镜像，然后按请求在子进程里跑代码。

依赖是**固定**的（见 requirements.txt）—— 这是刻意的：不提供运行时 pip，
所以不需要维护一个包索引，攻击面也小得多。要加包就改 requirements.txt 重新构建。

跑法：
    EXECUTOR_KEY=<共享密钥> python3 server.py            # 本地
    docker build -t cf-agent-executor . && docker run -e EXECUTOR_KEY=... -p 8080:8080 cf-agent-executor

协议：
    POST /run
      header  X-Executor-Key: <共享密钥>
      body    {"code": str, "stdin": str?, "files": [{"name": str, "content_b64": str}]?, "timeout_ms": int?}
    200     {"ok": bool, "stdout": str, "stderr": str, "exitCode": int,
             "ms": int, "timedOut": bool, "truncated": {"stdout": bool, "stderr": bool}}
    401     密钥不对
    400    请求体不合法
"""

import base64
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST = os.environ.get("HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PORT", "8080"))
SHARED_KEY = os.environ.get("EXECUTOR_KEY", "")

# 上限。这些不是"性能调优"，是防止一次调用把执行器拖垮的硬闸。
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_CODE_BYTES = 256 * 1024
MAX_OUT_BYTES = 64 * 1024          # 单路输出（调用方还会再截一次）
MAX_FILES = 16
MAX_FILE_BYTES = 2 * 1024 * 1024
DEFAULT_TIMEOUT_MS = 20_000
MAX_TIMEOUT_MS = 60_000

# _boot.py 要在子进程里以绝对路径被找到（cwd 是每个请求的临时目录）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 哪些环境变量允许进沙箱（逗号分隔）。**默认一个都不透传。**
#
# ⚠️ 不能用 `{**os.environ}` —— 那会把 EXECUTOR_KEY 自己送进子进程，
# 而子进程跑的是模型生成的代码。要让 openai-agents 能调模型，就在这里
# 显式写上 key 的名字（如 `PASSTHROUGH_ENV=OPENAI_API_KEY`），
# 并且清楚这意味着"沙箱里的任何代码都能读到这把钥匙"。
PASSTHROUGH_ENV = [
    x.strip() for x in os.environ.get("PASSTHROUGH_ENV", "").split(",") if x.strip()
]

# 额外的 import 搜索路径，冒号分隔。**非 Docker 场景才需要**：
#
# 沙箱子进程的 HOME 被指到临时目录（见 _child_env），而 Python 的
# **user site-packages 目录是按 HOME 算出来的**。所以装在 `~/.local/...` 的包
# 会整个消失 —— 而且症状是 `ModuleNotFoundError: No module named 'pandas'`，
# 看着像包没装，实际是这一条 HOME 改动把它藏起来了。
# Docker 里没这问题（pip 装进系统 site-packages），所以默认留空。
EXTRA_PYTHONPATH = os.environ.get("EXTRA_PYTHONPATH", "").strip()


def _child_env(workdir: str) -> dict:
    """给沙箱子进程的环境。刻意是"构造出来"的，不是"继承回来的"。

    ⚠️ HOME 指到本次请求的临时目录是为了不让代码往执行器用户的 home 里写东西，
    但这同时会**改变 Python 找包的位置**：user site-packages 是按 HOME 算的，
    所以 `~/.local` 下的包会看不见。Docker 里无所谓（包在系统 site-packages），
    非 Docker 场景用 EXTRA_PYTHONPATH 补回来。
    """
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": workdir,
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if EXTRA_PYTHONPATH:
        env["PYTHONPATH"] = EXTRA_PYTHONPATH
    for k in PASSTHROUGH_ENV:
        if k in os.environ:
            env[k] = os.environ[k]
    return env


def _clip(s: str) -> tuple[str, bool]:
    b = s.encode("utf-8", "replace")
    if len(b) <= MAX_OUT_BYTES:
        return s, False
    cut = MAX_OUT_BYTES
    while cut > 0 and (b[cut] & 0xC0) == 0x80:  # 别切断半个字符
        cut -= 1
    return b[:cut].decode("utf-8", "replace") + f"\n…[输出超过 {MAX_OUT_BYTES} 字节，已截断]", True


def run_code(payload: dict) -> dict:
    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code 必须是非空字符串")
    if len(code.encode()) > MAX_CODE_BYTES:
        raise ValueError(f"code 过长（上限 {MAX_CODE_BYTES} 字节）")

    stdin = payload.get("stdin") or ""
    if not isinstance(stdin, str):
        raise ValueError("stdin 必须是字符串")

    files = payload.get("files") or []
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise ValueError(f"files 必须是数组且不超过 {MAX_FILES} 项")

    timeout_ms = payload.get("timeout_ms") or DEFAULT_TIMEOUT_MS
    timeout_ms = max(1000, min(int(timeout_ms), MAX_TIMEOUT_MS))

    workdir = tempfile.mkdtemp(prefix="exec-")
    try:
        for f in files:
            name = str(f.get("name") or "")
            # 只取 basename：绝不允许 ../ 之类跳出工作目录
            name = os.path.basename(name)
            if not name:
                raise ValueError("files[].name 不能为空")
            raw = base64.b64decode(f.get("content_b64") or "")
            if len(raw) > MAX_FILE_BYTES:
                raise ValueError(f"文件 {name} 超过 {MAX_FILE_BYTES} 字节")
            with open(os.path.join(workdir, name), "wb") as fh:
                fh.write(raw)

        script = os.path.join(workdir, "main.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(code)

        t0 = time.time()
        timed_out = False
        try:
            proc = subprocess.run(
                # 资源闸在 _boot.py 里设，不用 preexec_fn（多线程下会死锁，见 _boot.py）
                [sys.executable, "-u", os.path.join(BASE_DIR, "_boot.py"), "main.py"],
                input=stdin.encode(),
                cwd=workdir,
                capture_output=True,
                timeout=timeout_ms / 1000,
                # 自己的进程组：超时被杀时不会连带影响到服务自己
                start_new_session=True,
                env=_child_env(workdir),
            )
            out = proc.stdout.decode("utf-8", "replace")
            err = proc.stderr.decode("utf-8", "replace")
            code_rc = proc.returncode
        except subprocess.TimeoutExpired as e:
            timed_out = True
            out = (e.stdout or b"").decode("utf-8", "replace")
            err = (e.stderr or b"").decode("utf-8", "replace")
            code_rc = -1

        clipped_out, cut_out = _clip(out)
        clipped_err, cut_err = _clip(err)
        return {
            "ok": (not timed_out) and code_rc == 0,
            "stdout": clipped_out,
            "stderr": clipped_err,
            "exitCode": code_rc,
            "ms": int((time.time() - t0) * 1000),
            "timedOut": timed_out,
            "truncated": {"stdout": cut_out, "stderr": cut_err},
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, body: dict):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):  # 默认会把每个请求打到 stderr，太吵
        sys.stderr.write("[executor] " + fmt % args + "\n")

    def do_GET(self):
        # 给容器健康检查用。刻意不要求密钥——它不泄露任何东西
        if self.path == "/healthz":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            self._send(404, {"error": "not found"})
            return
        if not SHARED_KEY:
            self._send(500, {"error": "执行器没配 EXECUTOR_KEY"})
            return
        # 定时比较，避免用响应时间侧信道猜密钥
        if not hmac.compare_digest(self.headers.get("X-Executor-Key", ""), SHARED_KEY):
            self._send(401, {"error": "密钥不对"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, {"error": f"请求体大小非法（上限 {MAX_BODY_BYTES} 字节）"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except Exception as e:
            self._send(400, {"error": f"请求体不是合法 JSON：{e}"})
            return

        try:
            self._send(200, run_code(payload))
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # 兜底：绝不让异常变成 500 空响应
            self._send(500, {"error": f"{type(e).__name__}: {e}"})


def _selfcheck() -> None:
    """启动时确认**沙箱子进程那一侧**真能看到 requirements.txt 里的包。

    必须在子进程环境里查。服务进程自己有正常的 HOME，在它这儿查永远通过；
    而真正跑代码的是那个 HOME 被改过、因而看不到 user site-packages 的子进程。
    不查的话，环境配错的表现是"每次调用都 ModuleNotFoundError" ——
    一个看着像模型代码写错、实际是环境坏了的失败。
    """
    req = os.path.join(BASE_DIR, "requirements.txt")
    if not os.path.exists(req):
        return
    names = []
    for line in open(req, encoding="utf-8"):
        line = line.split("#")[0].strip()
        if line:
            names.append(re.split(r"[<>=!~\[; ]", line, maxsplit=1)[0])
    if not names:
        return

    probe = (
        "import importlib.metadata as m, sys\n"
        "bad = []\n"
        "for n in sys.argv[1:]:\n"
        "    try:\n"
        "        m.version(n)\n"
        "    except Exception:\n"
        "        bad.append(n)\n"
        "print(','.join(bad))\n"
    )
    try:
        p = subprocess.run(
            [sys.executable, "-c", probe, *names],
            env=_child_env(tempfile.gettempdir()),
            capture_output=True, text=True, timeout=180,
        )
        missing = [x for x in p.stdout.strip().split(",") if x]
    except Exception as e:
        print(f"[executor] 依赖自检跳过：{e}", flush=True)
        return

    if missing:
        print(
            "[executor] ⚠️  沙箱里看不到这些依赖：" + ", ".join(missing),
            flush=True,
        )
        print(
            "[executor]    镜像构建有问题？或者非 Docker 跑时包在 user site —— "
            "那种情况用 EXTRA_PYTHONPATH 指过去。",
            flush=True,
        )
    else:
        print(f"[executor] 依赖自检通过（{len(names)} 个）", flush=True)


if __name__ == "__main__":
    if not SHARED_KEY:
        sys.exit("必须先设 EXECUTOR_KEY（共享密钥）。没有它这个服务就是个公开的代码执行端点。")
    print(f"[executor] listening on {LISTEN_HOST}:{LISTEN_PORT}  python={sys.version.split()[0]}", flush=True)
    _selfcheck()
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
