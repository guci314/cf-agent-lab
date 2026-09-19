// `run_python` —— 把一段 Python 丢到外部沙箱里跑，拿回 stdout/stderr。
//
// 和 workspace 那四个只读工具不同，这个**不依赖仓库**：没有导入代码仓库时
// 照样能用来验算。只有 `files` 参数需要仓库（把仓库里的文件喂进沙箱）。

import { jsonSchema, tool } from "ai";
import type { WorkspaceRepo } from "../workspace/repo.ts";
import { guarded } from "../workspace/tools.ts";
import { judge0Run, type Judge0Result } from "./judge0.ts";

const DEFAULT_BASE_URL = "https://ce.judge0.com";
/** Python 3.14.0（Judge0 CE 的标准语言表）。换实例时用 SANDBOX_LANGUAGE_ID 覆盖 */
const DEFAULT_LANGUAGE_ID = 113;

const CODE_MAX_BYTES = 64_000;
const STDIN_MAX_BYTES = 16_000;
const STAGE_MAX_FILES = 8;
// 仓库摄入时单文件已卡在 128KB，这里卡的是「一次送几个」的总量。
// 实测 4MB 的请求体对端照收，所以这个上限是保守值，不是平台限制。
const STAGE_MAX_TOTAL_BYTES = 1_000_000;
// 和 grep 的输出上限对齐：一次工具调用吃掉 16KB 已经很多了
const OUT_MAX_BYTES = 16_000;
// 公共实例的墙钟上限是 30 秒，CPU 上限 20 秒。这里取小值 ——
// 这是个交互式工具，一次调用卡十秒已经到体感极限了。
const CPU_TIME_LIMIT = 5;
const WALL_TIME_LIMIT = 10;
const MEMORY_LIMIT_KB = 256_000;
/** 本地等待上限：必须**大于** wallTimeLimit + 排队，否则会把自己的超时误报成沙箱故障 */
const REQUEST_TIMEOUT_MS = 25_000;

export interface SandboxEnv {
  /** 设成 0/false/off 即整条关闭。其它值（含未设）= 开启 */
  SANDBOX_ENABLED?: string;
  SANDBOX_URL?: string;
  SANDBOX_LANGUAGE_ID?: string;
  SANDBOX_API_KEY?: string;
}

export function sandboxConfig(env: SandboxEnv) {
  const off = (env.SANDBOX_ENABLED ?? "").trim().toLowerCase();
  const id = Number(env.SANDBOX_LANGUAGE_ID ?? "");
  return {
    enabled: off !== "0" && off !== "false" && off !== "off",
    baseUrl: (env.SANDBOX_URL ?? "").trim() || DEFAULT_BASE_URL,
    languageId: Number.isFinite(id) && id > 0 ? Math.trunc(id) : DEFAULT_LANGUAGE_ID,
    apiKey: (env.SANDBOX_API_KEY ?? "").trim() || undefined,
  };
}

/** 按 UTF-8 字节截断，且不切断半个字符 */
function clipUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  // 0b10xxxxxx 是 UTF-8 的续字节；回退到它的起点，避免解出 U+FFFD
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * 把最常见的三种失败翻译成「下一步该怎么做」。
 *
 * 没有这段，模型看到 ModuleNotFoundError 的第一反应是换个包名再试一次 ——
 * 而真正的原因是镜像里根本没有第三方包，再试多少次都一样。
 */
function hintFor(r: Judge0Result): string | undefined {
  const all = `${r.stderr}\n${r.message ?? ""}`;
  if (/ModuleNotFoundError|ImportError/.test(all)) {
    return "沙箱里只有 Python 标准库，装不了也没法装第三方包。改用 csv / json / re / sqlite3 / statistics / collections / itertools / math 这些重写。";
  }
  if (r.statusId === 5) {
    return "脚本超时（10 秒墙钟 / 5 秒 CPU）。缩小输入规模、去掉不必要的循环，或先用小样本验证逻辑。";
  }
  // 网络报错至少两种长相：走 urllib 是 URLError + "name resolution"，
  // 直接开 socket 则是裸 OSError("Network is unreachable")。两种都得认，
  // 只match前者的话，模型改开 socket 再来一次就会发现提示消失了。
  if (
    /URLError|ConnectionError|getaddrinfo|name resolution|Connection refused|Network is unreachable|No route to host|Errno 10[13]|Errno 111/.test(
      all,
    )
  ) {
    return "沙箱的网络是关闭的，这里的代码发不出任何请求。要取外部资料改用 fetch_page / web_search。";
  }
  if (/FileNotFoundError/.test(all)) {
    return "文件不存在。只有 files 参数里列出的仓库文件会被放进工作目录，用相对路径按原名读。";
  }
  return undefined;
}

export function makeSandboxTools(repo: WorkspaceRepo, env: SandboxEnv) {
  const cfg = sandboxConfig(env);

  return {
    run_python: tool({
      description:
        "在一次性沙箱里执行一段 Python 3.14 脚本，返回 stdout / stderr。用来验算或复现一段逻辑，" +
        "不是用来跑用户项目的测试套件。\n" +
        "⚠️ 三条硬约束，不知道就会白跑一轮：\n" +
        "① 无状态 —— 每次调用都是全新进程，上一次定义的变量、导入的模块、写下的文件全都不在。" +
        "需要多步就写成一个脚本一次跑完（在同一次调用里依次做）。\n" +
        "② 只有标准库 —— 没有任何第三方包，import numpy / pandas / requests 一律 ModuleNotFoundError。" +
        "能用的是 csv / json / re / sqlite3 / statistics / collections / itertools / math / datetime 这些。\n" +
        "③ 无网络 —— 出网请求全部失败。要外部资料用 fetch_page / web_search。\n" +
        "files 里列出的仓库文件会以原名出现在工作目录，用 open() / csv.reader 按相对路径读。" +
        "超时 10 秒（CPU 5 秒）；stdout/stderr 各自超过 16KB 会被截断，截断处有说明。\n" +
        "脚本失败不会报错，而是返回 ok=false 加 status / stderr / message，据此判断。",
      inputSchema: jsonSchema<{
        code: string;
        stdin?: string;
        files?: string[];
      }>({
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "完整的 Python 脚本，会作为单个文件执行",
          },
          stdin: {
            type: "string",
            description: "喂给脚本的标准输入（会被 sys.stdin 读到），可省略",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "要放进沙箱工作目录的仓库内相对路径（如 data/sample.csv），最多 8 个。" +
              "只有确实要用文件内容时才列，列了会原样复制进去。",
          },
        },
        required: ["code"],
        additionalProperties: false,
      }),
      execute: async ({ code, stdin, files }) =>
        guarded(async () => {
          if (!cfg.enabled) {
            return { error: "沙箱已被关闭（SANDBOX_ENABLED=0），无法执行代码。" };
          }

          const src = String(code ?? "");
          if (!src.trim()) return { error: "code 不能为空" };
          const srcBytes = new TextEncoder().encode(src).length;
          if (srcBytes > CODE_MAX_BYTES) {
            return { error: `code 过长（${srcBytes} 字节，上限 ${CODE_MAX_BYTES}）` };
          }

          const inText = String(stdin ?? "");
          if (new TextEncoder().encode(inText).length > STDIN_MAX_BYTES) {
            return { error: `stdin 过长（上限 ${STDIN_MAX_BYTES} 字节）` };
          }

          // ── 把仓库文件取出来 ──────────────────────────────────────
          const wanted = Array.isArray(files)
            ? files.map((f) => String(f ?? "").trim()).filter(Boolean)
            : [];
          if (wanted.length > STAGE_MAX_FILES) {
            return { error: `files 最多 ${STAGE_MAX_FILES} 个，收到 ${wanted.length} 个` };
          }

          const staged: { name: string; data: Uint8Array }[] = [];
          let stagedBytes = 0;
          if (wanted.length > 0) {
            const st = repo.status();
            if (st.activeGeneration === 0 || st.fileCount === 0) {
              return {
                error:
                  "还没有导入代码仓库，files 无从取文件。" +
                  "要么先用 /repo owner/name 导入，要么去掉 files 参数直接跑代码。",
              };
            }
            for (const raw of wanted) {
              const p = raw.replace(/^\.\/+/, "").replace(/^\/+/, "");
              const row = repo.readFile(p);
              if (!row) {
                return {
                  error: `文件不存在：${p}。用 ls / find 确认路径后再列进来。`,
                };
              }
              const data = new TextEncoder().encode(row.content);
              stagedBytes += data.length;
              if (stagedBytes > STAGE_MAX_TOTAL_BYTES) {
                return {
                  error: `files 总大小超过上限（${STAGE_MAX_TOTAL_BYTES} 字节）。` +
                    "减少文件数，或只挑真正需要的那一段。",
                };
              }
              // zip 里用 basename：Judge0 会把条目解到工作目录，
              // 带目录的路径（data/a.csv）解出来通常不建中间目录。
              staged.push({ name: p.split("/").pop() ?? p, data });
            }
          }

          const r = await judge0Run(
            { baseUrl: cfg.baseUrl, languageId: cfg.languageId, apiKey: cfg.apiKey },
            {
              code: src,
              stdin: inText || undefined,
              files: staged.length > 0 ? staged : undefined,
              cpuTimeLimit: CPU_TIME_LIMIT,
              wallTimeLimit: WALL_TIME_LIMIT,
              memoryLimitKb: MEMORY_LIMIT_KB,
              timeoutMs: REQUEST_TIMEOUT_MS,
            },
          );

          const out = clipUtf8(r.stdout, OUT_MAX_BYTES);
          const err = clipUtf8(r.stderr, OUT_MAX_BYTES);
          const hint = hintFor(r);
          // 标记写在**正文里**，不能只靠 truncated 字段：模型读的是字符串，
          // 不会去翻兄弟字段，半截输出会被当成完整结果下结论。
          const outText = out.truncated
            ? `${out.text}\n…[stdout 超过 ${OUT_MAX_BYTES} 字节，已截断]`
            : out.text;
          const errText = err.truncated
            ? `${err.text}\n…[stderr 超过 ${OUT_MAX_BYTES} 字节，已截断]`
            : err.text;

          return {
            ok: r.ok,
            status: r.status,
            stdout: outText,
            stderr: errText,
            ...(r.message ? { message: r.message } : {}),
            ...(r.timeSec ? { timeSec: Number(r.timeSec) } : {}),
            ...(r.memoryKb ? { memoryKb: r.memoryKb } : {}),
            ...(staged.length > 0 ? { staged: staged.map((f) => f.name) } : {}),
            ...(out.truncated || err.truncated
              ? { truncated: { stdout: out.truncated, stderr: err.truncated } }
              : {}),
            ...(hint ? { hint } : {}),
          };
        }),
    }),
  };
}
