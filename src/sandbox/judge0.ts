// Judge0 CE 客户端。
//
// 为什么是它：workerd 是 V8 隔离环境，**不能跑 Python、不能起子进程**，所以
// 「给 agent 一个跑代码的地方」只能是调外部沙箱。Piston 的公共 API 从
// 2026-02-15 起改成白名单制（不再免费用），Judge0 CE 的 ce.judge0.com 还开着，
// 免 key、有 Python 3.14。
//
// 全程 `base64_encoded=true`：仓库里的文件可以是二进制，模型也可能 print 出
// 非 UTF-8 字节，用明文模式让 Judge0 直接塞进 JSON 字符串，会在编码边界上
// 变成一堆难查的乱码。base64 多一点体积，换掉整类问题，值。

import { base64ToText, textToBase64, toBase64 } from "./base64.ts";
import { zipStore } from "./zip.ts";
import { STATUS_ACCEPTED, type RunRequest, type RunResult } from "./types.ts";

/** 只翻常用的几个，其余透传 Judge0 自己的英文描述 */
const STATUS_ZH: Record<number, string> = {
  1: "排队中",
  2: "执行中",
  3: "成功",
  4: "答案错误",
  5: "超时",
  6: "编译错误",
  7: "运行时错误（段错误）",
  8: "运行时错误（文件大小超限）",
  9: "运行时错误（浮点异常）",
  10: "运行时错误（被中止）",
  11: "运行时错误（未捕获异常或有非零退出）",
  12: "运行时错误（其它）",
  13: "沙箱内部错误",
  14: "可执行格式错误",
};

/** HTTP 层面的拒绝。这类错误重试没有意义，所以单独一个类型直接冒到顶 */
class FatalSandboxError extends Error {}

export interface Judge0Config {
  /** 去掉尾部斜杠的 base，例如 https://ce.judge0.com */
  baseUrl: string;
  languageId: number;
  /** 自建实例需要鉴权时用（Judge0 的 X-Auth-Token）。公共实例不填 */
  apiKey?: string;
}

// 请求/结果的形状与另一个后端共用，见 types.ts。

function b64Field(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  return base64ToText(v);
}

function normalize(raw: Record<string, unknown>): RunResult {
  const st = (raw.status ?? {}) as { id?: unknown; description?: unknown };
  const id = typeof st.id === "number" ? st.id : 0;
  return {
    ok: id === STATUS_ACCEPTED,
    statusId: id,
    status:
      STATUS_ZH[id] ??
      (typeof st.description === "string" ? st.description : `未知状态 ${id}`),
    message: b64Field(raw.message) || null,
    stdout: b64Field(raw.stdout),
    stderr: b64Field(raw.stderr),
    timeSec: typeof raw.time === "string" ? raw.time : null,
    memoryKb: typeof raw.memory === "number" ? raw.memory : null,
  };
}

export async function judge0Run(
  cfg: Judge0Config,
  req: RunRequest,
): Promise<RunResult> {
  const payload: Record<string, unknown> = {
    language_id: cfg.languageId,
    source_code: textToBase64(req.code),
    cpu_time_limit: req.cpuTimeLimit,
    wall_time_limit: req.wallTimeLimit,
    memory_limit: req.memoryLimitKb,
    // 沙箱是用来「验算」的，不是用来「联网」的。开着网络等于把模型写的代码
    // 直接接到公网：既能被拿来扫描外连，也让 stdout 不再只反映代码本身的逻辑。
    // 要取外部资料有专门的 fetch_page / web_search，不需要从这里开洞。
    enable_network: false,
  };
  if (req.stdin) payload.stdin = textToBase64(req.stdin);
  if (req.files && req.files.length > 0) {
    payload.additional_files = toBase64(zipStore(req.files));
  }

  const url =
    cfg.baseUrl.replace(/\/+$/, "") +
    "/submissions?base64_encoded=true&wait=true";

  let lastErr: unknown;
  // 公共实例是免费共享服务，偶发抖动很常见，所以「根本没拿到响应」重试一次。
  // 但拿到 4xx/5xx 说明请求本身有问题（或实例在维护），重试只是白等一轮。
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { "X-Auth-Token": cfg.apiKey } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new FatalSandboxError(`沙箱返回 HTTP ${res.status}：${text}`);
      }
      return normalize((await res.json()) as Record<string, unknown>);
    } catch (e) {
      if (e instanceof FatalSandboxError) throw e;
      lastErr = e;
      if (ctrl.signal.aborted) {
        if (attempt >= 1) {
          throw new Error(
            `沙箱在 ${Math.round(req.timeoutMs / 1000)} 秒内没有返回（公共实例可能拥堵）`,
          );
        }
      } else if (attempt >= 1) {
        throw new Error(`连不上沙箱：${(e as Error).message ?? String(e)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  // 循环要么 return 要么 throw，走不到这里；留着是为了让 lastErr 不被 lint 判为未用
  throw new Error(`沙箱请求失败：${String(lastErr)}`);
}
