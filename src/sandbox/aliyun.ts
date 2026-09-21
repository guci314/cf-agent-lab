// 阿里云 FC「云沙箱」（FC Agent Sandbox）的客户端。
//
// 数据面是 **E2B 协议兼容**的，但只有一部分：裸 HTTP 全通，官方 SDK / CLI 反而不行
// （Python SDK 打 /sandboxes 回 405、E2B CLI 建模板回 "steps are not supported"，
// 都是客户端与服务端版本不匹配）。所以这里**不引任何 SDK**，直接按实测出来的
// 协议说话 —— 这也正好适配 workerd：全程 fetch，没有 Node 私有 API。
//
// 实测（2026-09-21，cn-hangzhou）：
//   创建沙箱   ~1.0s
//   跑一段代码 ~1.3s
//   模板 code-interpreter-v1 预装 python 3.13.13 / numpy 2.5.2 / pandas 3.0.5
//   沙箱**有出网**，pip install 可用（openai-agents 约 24s）

import { base64ToText, textToBase64, toBase64 } from "./base64.ts";
import { STATUS_ACCEPTED, STATUS_TIMEOUT, type RunResult } from "./types.ts";

export interface AliyunConfig {
  /** 如 https://api.cn-hangzhou.e2b.fc.aliyuncs.com */
  apiBase: string;
  apiKey: string;
  /** 模板名，默认 code-interpreter-v1 */
  template: string;
  /**
   * 每次执行时注入沙箱的环境变量。
   *
   * ⚠️ **不能用创建沙箱时的 `envs` 字段** —— 实测阿里云忽略了它：请求成功返回
   * 201，但沙箱进程里根本看不到那些变量。所以改成在执行包装层 `export`，
   * 每次跑代码时现导一次。副作用是模型代码只能通过 `os.environ` 读，
   * 拿不到"沙箱启动时就存在"的语义 —— 对我们够用了。
   */
  envs?: Record<string, string>;
}

export interface SandboxHandle {
  sandboxId: string;
  /** envd 的访问令牌，跑代码时放在 X-Access-Token */
  token: string;
  /** 如 cn-hangzhou.e2b.fc.aliyuncs.com */
  domain: string;
}

/** envd 固定监听这个端口，实测确认 */
const ENVD_PORT = 49983;

function api(cfg: AliyunConfig, path: string): string {
  return cfg.apiBase.replace(/\/+$/, "") + path;
}

async function must(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  throw new Error(`${what} 失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** 创建一个新沙箱。timeoutSec 到点后平台自动销毁 */
export async function createSandbox(
  cfg: AliyunConfig,
  timeoutSec: number,
): Promise<SandboxHandle> {
  const res = await fetch(api(cfg, "/sandboxes"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": cfg.apiKey },
    body: JSON.stringify({ templateID: cfg.template, timeout: timeoutSec }),
  });
  await must(res, "创建沙箱");
  const d = (await res.json()) as Record<string, unknown>;
  const sandboxId = String(d.sandboxID ?? "");
  const token = String(d.envdAccessToken ?? "");
  const domain = String(d.domain ?? "");
  if (!sandboxId || !token || !domain) {
    throw new Error(`创建沙箱的返回不完整：${JSON.stringify(d).slice(0, 200)}`);
  }
  return { sandboxId, token, domain };
}

/** 立刻销毁。失败不抛 —— 沙箱本来也有超时兜底，别因为清理失败就把这轮结果丢掉 */
export async function killSandbox(cfg: AliyunConfig, sandboxId: string): Promise<void> {
  try {
    await fetch(api(cfg, `/sandboxes/${encodeURIComponent(sandboxId)}`), {
      method: "DELETE",
      headers: { "X-API-Key": cfg.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* 交给平台的超时回收 */
  }
}

/**
 * 解析 envd 的 Connect RPC 分帧流。
 *
 * 帧格式：1 字节 flags + 4 字节大端长度 + JSON 载荷。flags 的 0x02 位表示是结尾的 trailer。
 * 事件形状：{"event":{"start":{"pid":N}}} / {"event":{"data":{"stdout"|"stderr": base64}}} /
 * {"event":{"end":{"exitCode":N,"exited":true}}}
 */
function parseFrames(buf: Uint8Array): { stdout: string; stderr: string; exitCode: number | null } {
  let i = 0;
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  const dec = new TextDecoder();

  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = (buf[i + 1] << 24) | (buf[i + 2] << 16) | (buf[i + 3] << 8) | buf[i + 4];
    i += 5;
    if (flags & 0x02) break;
    if (len < 0 || i + len > buf.length) break;

    let ev: Record<string, any> = {};
    try {
      ev = JSON.parse(dec.decode(buf.subarray(i, i + len))).event ?? {};
    } catch {
      /* 单帧坏了就跳过，不要把整轮结果丢掉 */
    }
    i += len;

    const data = ev.data;
    if (data && typeof data === "object") {
      // 实测 stdout/stderr 是 base64
      if (typeof data.stdout === "string") stdout += base64ToText(data.stdout);
      if (typeof data.stderr === "string") stderr += base64ToText(data.stderr);
    }
    if (ev.end && typeof ev.end === "object") {
      exitCode = typeof ev.end.exitCode === "number" ? ev.end.exitCode : null;
    }
  }
  return { stdout, stderr, exitCode };
}

export interface SandboxExecRequest {
  code: string;
  stdin?: string;
  files?: { name: string; data: Uint8Array }[];
  /** 本地等待上限。**要留够**：pip install 这类操作本身就要几十秒 */
  timeoutMs: number;
}

/**
 * 在已有沙箱里跑一段 Python。
 *
 * 代码与文件都走 base64 送进去：拼 shell 命令最怕转义，
 * 而 base64 只含字母数字，拼进去一定安全。
 */
export async function execInSandbox(
  sbx: SandboxHandle,
  req: SandboxExecRequest,
  /** 每次执行前 export 进沙箱的变量，见 AliyunConfig.envs 的说明 */
  envs?: Record<string, string>,
): Promise<RunResult> {
  // ⚠️ 这里**不清理**工作目录。沙箱是跨调用复用的，"上次写下的文件还在"
  // 正是有状态契约的一部分（工具描述里也是这么写的）。清掉它会让
  // "装了包、写了文件，下次还能用"这个承诺当场失效。
  // 每次会覆盖 main.py 和 files 里列出的同名文件，这没问题。
  const lines = ["set -e", "mkdir -p /tmp/cfal && cd /tmp/cfal"];

  // 凭证走 base64 落地再 export：值里可能有引号、换行、$ 之类，
  // 直接拼进 shell 命令会被吃掉或执行。变量名做严格校验，挡住注入。
  for (const [k, v] of Object.entries(envs ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`环境变量名不合法：${k}`);
    }
    lines.push(`export ${k}="$(printf %s '${textToBase64(v)}' | base64 -d)"`);
  }
  for (const f of req.files ?? []) {
    // 只取 basename：不给 ../ 之类任何跳出工作目录的机会
    const name = f.name.split("/").pop() || "file";
    lines.push(`printf %s ${toBase64(f.data)} | base64 -d > ${JSON.stringify(name)}`);
  }
  lines.push(`printf %s ${textToBase64(req.code)} | base64 -d > main.py`);
  if (req.stdin) {
    lines.push(`printf %s ${textToBase64(req.stdin)} | base64 -d > .stdin`);
    lines.push("python3 -u main.py < .stdin");
  } else {
    lines.push("python3 -u main.py");
  }

  const body = {
    process: { cmd: "/bin/bash", args: ["-c", lines.join("\n")] },
  };

  const url = `https://${ENVD_PORT}-${sbx.sandboxId}.${sbx.domain}/process.Process/Start`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Token": sbx.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (e) {
    const aborted = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
    throw new Error(
      aborted
        ? `沙箱在 ${Math.round(req.timeoutMs / 1000)} 秒内没有返回`
        : `连不上沙箱：${(e as Error).message ?? String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`沙箱执行失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  const parsed = parseFrames(new Uint8Array(await res.arrayBuffer()));
  const ok = parsed.exitCode === 0;
  return {
    ok,
    statusId: ok ? STATUS_ACCEPTED : 11, // 与 Judge0 的 NZEC 对齐，hint 逻辑可复用
    status: ok ? "成功" : `运行时错误（退出码 ${parsed.exitCode ?? "?"}）`,
    message: ok ? null : `Exited with error status ${parsed.exitCode ?? "?"}`,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    timeSec: ((Date.now() - t0) / 1000).toFixed(3),
    memoryKb: null,
  };
}

/** 装包。走 pip，用的是沙箱自己的解释器 */
export async function installPackages(
  sbx: SandboxHandle,
  packages: string[],
  timeoutMs: number,
  envs?: Record<string, string>,
): Promise<RunResult> {
  // 包名做严格校验：它会被拼进 shell 命令，不能让它带空格、引号、分号
  const bad = packages.filter((p) => !/^[A-Za-z0-9._-]+(\[[A-Za-z0-9._,-]+\])?$/.test(p));
  if (bad.length > 0) {
    throw new Error(`包名不合法：${bad.join(", ")}（只允许字母、数字、. _ - 和可选的 [extras]）`);
  }
  const code = [
    "import subprocess, sys",
    `r = subprocess.run([sys.executable, "-m", "pip", "install", "--no-warn-script-location", ${packages
      .map((p) => JSON.stringify(p))
      .join(", ")}], capture_output=True, text=True)`,
    'print("pip exit:", r.returncode)',
    'print((r.stdout or "")[-3000:])',
    'print((r.stderr or "")[-3000:], file=sys.stderr)',
    "sys.exit(r.returncode)",
  ].join("\n");
  return execInSandbox(sbx, { code, timeoutMs }, envs);
}
