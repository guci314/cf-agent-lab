// 自建执行器（`executor/server.py`）的客户端。
//
// 和 Judge0 的分工：Judge0 公共实例服务端禁止联网，装不了包也跑不了
// openai-agents；这个执行器把固定依赖烤进镜像、允许出网，代价是多一个
// 要运维的东西。`tool.ts` 按有没有配 `EXECUTOR_URL` 来选后端。

import { toBase64 } from "./base64.ts";
import {
  STATUS_ACCEPTED,
  STATUS_TIMEOUT,
  type RunRequest,
  type RunResult,
} from "./types.ts";

export interface ExecutorConfig {
  /** 执行器基址，如 https://exec.example.com */
  url: string;
  /** 共享密钥。执行器没配 EXECUTOR_KEY 时会拒绝启动 */
  key: string;
}

interface ExecutorResponse {
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  ms?: number;
  timedOut?: boolean;
  truncated?: { stdout?: boolean; stderr?: boolean };
  error?: string;
}

export async function executorRun(
  cfg: ExecutorConfig,
  req: RunRequest,
): Promise<RunResult> {
  const body = {
    code: req.code,
    ...(req.stdin ? { stdin: req.stdin } : {}),
    ...(req.files && req.files.length > 0
      ? {
          files: req.files.map((f) => ({
            name: f.name,
            content_b64: toBase64(f.data),
          })),
        }
      : {}),
    timeout_ms: req.wallTimeLimit * 1000,
  };

  const url = cfg.url.replace(/\/+$/, "") + "/run";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Executor-Key": cfg.key,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error(
        `执行器在 ${Math.round(req.timeoutMs / 1000)} 秒内没有返回（可能离线或过载）`,
      );
    }
    throw new Error(`连不上执行器：${(e as Error).message ?? String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  // 单独认 401：这是"两侧密钥不一致"，和"执行器坏了"是两回事，
  // 报错要说清楚，否则会去查半天可达性和代码。
  if (res.status === 401) {
    throw new Error("执行器拒绝了密钥（两侧的 EXECUTOR_KEY 不一致）");
  }
  if (!res.ok) {
    throw new Error(
      `执行器返回 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`,
    );
  }

  const d = (await res.json()) as ExecutorResponse;
  if (d.error) throw new Error(`执行器报错：${d.error}`);

  const timedOut = d.timedOut === true;
  const exit = typeof d.exitCode === "number" ? d.exitCode : null;
  return {
    ok: d.ok === true,
    // 11 对齐 Judge0 的 "Runtime Error (NZEC)"，这样 tool.ts 里那套
    // hint 判断不用为两个后各写一份
    statusId: timedOut ? STATUS_TIMEOUT : d.ok === true ? STATUS_ACCEPTED : 11,
    status: timedOut ? "超时" : d.ok === true ? "成功" : `运行时错误（退出码 ${exit ?? "?"}）`,
    message: timedOut
      ? "执行超时"
      : d.ok === true
        ? null
        : `Exited with error status ${exit ?? "?"}`,
    stdout: d.stdout ?? "",
    stderr: d.stderr ?? "",
    timeSec: typeof d.ms === "number" ? (d.ms / 1000).toFixed(3) : null,
    memoryKb: null,
  };
}
