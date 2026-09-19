// 四个只读代码工具：read / ls / grep / find。
//
// 语义是从 pi（`@earendil-works/pi-coding-agent`）移植过来的 —— 移植的是**行为**，
// 不是代码：pi 的工具跑在本机文件系统和子进程上，那两样在 workerd 里都不存在。
// 值得照搬的是那些容易忽略的规矩：截断绝不切断半行、grep 总量也要卡、
// 工具永不抛错、搜不到不是错误。
//
// 所有 execute 都过 `guarded`：工具抛错会中断整个工具循环，所以一律转成
// `{ error }` 让模型自己看到并调整 —— 这和现有 web_search / fetch_page 的契约一致。

import { jsonSchema, tool } from "ai";
import type { WorkspaceRepo } from "./repo.ts";
import { makeGlobMatcher } from "./glob.ts";
import { utf8Len } from "./filter.ts";

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50_000;

const LS_DEFAULT_LIMIT = 500;
const LS_MAX_LIMIT = 1000;

const FIND_DEFAULT_LIMIT = 500;
const FIND_MAX_LIMIT = 2000;
// 一次 find 最多看多少条路径。路径短，2000 条也就 ~80KB
const FIND_SCAN_LIMIT = 2000;

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 500;
const GREP_MAX_LINE_CHARS = 500;
const GREP_MAX_CONTEXT = 10;
const GREP_MAX_PATTERN = 300;
// 单次调用的总输出上限。只卡单行不够：100 条 × 500 字符 ≈ 50KB ≈ 15k token，
// 一次 grep 就能吃掉上下文的一大块。
// （压缩阈值已从 20k 提到 200k，所以这里不再是为了"别撞爆阈值"，而是为了
// 让工具结果保持聚焦 —— 一次性倒 50KB 匹配行只会把真正相关的那几条淹掉。）
const GREP_MAX_OUTPUT_BYTES = 16_000;
// 扫描预算：pattern 里没有可预筛的字面量核心时，整表扫描只能靠这个兜住
const GREP_MAX_SCAN_BYTES = 1_000_000;

/** 模型经常把数字发成字符串；空串、null、undefined 一律落到默认值 */
function toInt(v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function normPath(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function normDir(v: unknown): string {
  const s = String(v ?? "")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return s === "." ? "" : s;
}

/** 目录 → 路径区间前缀；根目录是空串 */
function dirPrefix(v: unknown): string {
  const d = normDir(v);
  return d ? d + "/" : "";
}

/** 供同族工具（如沙箱的 run_python）复用，保证「工具永不抛错」这条契约只有一处实现 */
export async function guarded<T>(
  fn: () => T | Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: `工具执行失败：${(e as Error).message}` };
  }
}

/**
 * 没语料时四个工具都不该工作 —— 先挡住，别让模型对着空气猜。
 *
 * 判据是「有没有一份可用的快照」，不是 status 字符串：一次失败的重新导入
 * 会把 status 弄成 error，但上一份语料其实还在、还能用，那种情况下必须放行。
 */
function notReady(repo: WorkspaceRepo): { error: string } | null {
  const st = repo.status();
  if (st.activeGeneration === 0 || st.fileCount === 0) {
    return {
      error:
        "还没有导入代码仓库。请让用户在左侧「代码仓库」里填 owner/repo 并点导入，" +
        "导入完成后才能用 read / ls / grep / find。",
    };
  }
  return null;
}

/**
 * 抽 pattern 里最长的一段纯字面量（≥3 字符），用作 SQL 侧预筛。
 * 抽不出来（比如 `\b\d{3}\b`）就返回 null，那时只能靠扫描预算兜。
 */
function literalCore(pattern: string): string | null {
  const meta = /[\\^$.*+?()[\]{}|]/;
  let best = "";
  let cur = "";
  for (const ch of pattern) {
    if (meta.test(ch)) {
      if (cur.length > best.length) best = cur;
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.length > best.length) best = cur;
  return best.length >= 3 ? best : null;
}

/**
 * 便宜的灾难性回溯启发式。
 *
 * JS 正则**没有超时**，所以这里挡不掉的形状仍然可能拖死一次工具调用。
 * 这是已知局限，不是"已解决"——真正的兜底是 GREP_MAX_SCAN_BYTES
 * 限制喂进去的行数。宁可如实写明，也不要假装安全。
 */
function hasNestedQuantifier(pattern: string): boolean {
  return (
    /\([^)]*[*+][^)]*\)\s*[*+{]/.test(pattern) ||
    /\([^)]*\|[^)]*\)\s*[+*]{2}/.test(pattern)
  );
}

export function makeWorkspaceTools(repo: WorkspaceRepo) {
  return {
    read: tool({
      description:
        "读取仓库里某个文件的文本内容，返回带行号的内容。" +
        "path 是仓库内相对路径，例如 src/server.ts。" +
        "offset 是起始行号（从 1 开始），limit 是最多读多少行。" +
        "返回内容最多 2000 行或 50KB，以先到者为准，且绝不返回半行；" +
        "被截断时 truncated=true 并给出 nextOffset，用它继续读下一段。" +
        "读之前先用 ls 或 find 确认路径，不要凭猜测拼路径。",
      inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
        type: "object",
        properties: {
          path: { type: "string", description: "仓库内相对路径，如 src/index.ts" },
          offset: { type: "number", description: "起始行号，从 1 开始，默认 1" },
          limit: { type: "number", description: "最多读多少行，默认读到上限为止" },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path, offset, limit }) =>
        guarded(() => {
          const bad = notReady(repo);
          if (bad) return bad;

          const p = normPath(path);
          if (!p) return { error: "path 不能为空" };

          const row = repo.readFile(p);
          if (!row) {
            return {
              error: `文件不存在：${p}。用 ls 看目录、用 find 按名字找，不要凭猜测拼路径。`,
            };
          }

          const lines = row.content.split("\n");
          // 结尾换行会切出一个空元素，那不是一行
          if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

          const totalLines = lines.length;
          const start = toInt(offset, 1, 1, Number.MAX_SAFE_INTEGER);
          const want = toInt(limit, READ_MAX_LINES, 1, READ_MAX_LINES);

          if (totalLines === 0) {
            return { path: p, startLine: 1, endLine: 0, totalLines: 0, content: "", truncated: false };
          }
          if (start > totalLines) {
            return {
              path: p,
              startLine: start,
              endLine: totalLines,
              totalLines,
              content: "",
              truncated: false,
              note: `起始行超出文件末尾（本文件共 ${totalLines} 行）`,
            };
          }

          const out: string[] = [];
          let bytes = 0;
          let i = start - 1;
          const stop = Math.min(i + want, totalLines);
          let lineClipped = false;

          while (i < stop) {
            const rendered = `${String(i + 1).padStart(6, " ")}\t${lines[i]}`;
            const cost = utf8Len(rendered) + 1;
            if (bytes + cost > READ_MAX_BYTES) break;
            out.push(rendered);
            bytes += cost;
            i++;
          }

          // 第一行就超预算（压缩过的产物常见）。必须吐点东西出去，
          // 否则 truncated + nextOffset 等于原地打转，调用方永远读完这一行。
          if (out.length === 0 && i < stop) {
            const budget = READ_MAX_BYTES - 40;
            const raw = lines[i];
            let cut = Math.min(raw.length, budget);
            while (cut > 0 && utf8Len(raw.slice(0, cut)) > budget) cut -= 64;
            out.push(`${String(i + 1).padStart(6, " ")}\t${raw.slice(0, cut)} …[本行过长，已截断]`);
            i++;
            lineClipped = true;
          }

          const truncated = i < totalLines;
          return {
            path: p,
            startLine: start,
            endLine: i,
            totalLines,
            content: out.join("\n"),
            truncated,
            ...(truncated ? { nextOffset: i + 1 } : {}),
            ...(lineClipped ? { note: "文件里有超长行，已按字节预算截断显示" } : {}),
          };
        }),
    }),

    ls: tool({
      description:
        "列出仓库里某个目录下的条目。目录名以 / 结尾。" +
        "path 省略时列出仓库根目录。" +
        "默认最多返回 500 条，目录在前、同级按名称升序。" +
        "如果 path 指向的是一个文件，会返回错误 —— 那种情况用 read。",
      inputSchema: jsonSchema<{ path?: string; limit?: number }>({
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，省略表示仓库根目录" },
          limit: { type: "number", description: "最多返回多少条，默认 500" },
        },
        additionalProperties: false,
      }),
      execute: async ({ path, limit }) =>
        guarded(() => {
          const bad = notReady(repo);
          if (bad) return bad;

          const dir = normDir(path);
          const lim = toInt(limit, LS_DEFAULT_LIMIT, 1, LS_MAX_LIMIT);

          if (dir && repo.hasFile(dir)) {
            return { error: `不是目录：${dir}（这是一个文件，用 read 读它）` };
          }

          const rows = repo.listDir(dir, lim + 1);
          const truncated = rows.length > lim;
          const shown = truncated ? rows.slice(0, lim) : rows;

          return {
            path: dir || ".",
            entries: shown.map((e) => (e.kind === "d" ? e.name + "/" : e.name)),
            count: shown.length,
            truncated,
            ...(shown.length === 0 ? { note: "这个目录是空的，或路径不存在" } : {}),
            ...(truncated ? { hint: `只显示了前 ${lim} 条，可用 path 缩小到子目录` } : {}),
          };
        }),
    }),

    find: tool({
      description:
        "按 glob 匹配仓库内的文件路径，例如 **/*.test.ts 或 src/**/*.{ts,tsx}。" +
        "支持 *（不跨目录）、**（跨目录）、?、{a,b}、[abc]。" +
        "path 可选，限定只在某个目录下找。默认最多返回 500 条。" +
        "找文件用它，别用 grep —— grep 是搜文件内容的。",
      inputSchema: jsonSchema<{ glob: string; path?: string; limit?: number }>({
        type: "object",
        properties: {
          glob: { type: "string", description: "glob 模式，如 **/*.ts 或 src/**/*.{ts,tsx}" },
          path: { type: "string", description: "限定搜索的目录，省略表示整个仓库" },
          limit: { type: "number", description: "最多返回多少条，默认 500" },
        },
        required: ["glob"],
        additionalProperties: false,
      }),
      execute: async ({ glob, path, limit }) =>
        guarded(() => {
          const bad = notReady(repo);
          if (bad) return bad;

          const g = String(glob ?? "").trim();
          if (!g) return { error: "glob 不能为空" };

          const lim = toInt(limit, FIND_DEFAULT_LIMIT, 1, FIND_MAX_LIMIT);
          const prefix = dirPrefix(path);
          const match = makeGlobMatcher(g);

          // 匹配在 JS 里做，不是 SQL GLOB：DO SQL 的 LIKE/GLOB 模式串有 50 字节上限，
          // 且 SQL GLOB 既不支持 ** 也不支持 {a,b}
          const candidates = repo.allPaths(prefix, FIND_SCAN_LIMIT);
          const hits: string[] = [];
          for (const p of candidates) {
            if (match(p)) hits.push(p);
            if (hits.length >= lim) break;
          }

          const truncated = hits.length >= lim;
          return {
            paths: hits,
            count: hits.length,
            truncated,
            ...(hits.length === 0
              ? { note: "没有匹配的路径。换个 glob 试试，比如去掉目录前缀只留 *.ts。" }
              : {}),
            ...(truncated ? { hint: `已到 ${lim} 条上限，用 path 或更窄的 glob 缩小范围` } : {}),
          };
        }),
    }),

    grep: tool({
      description:
        "在仓库文件内容里搜索。pattern 默认按正则解释；literal=true 时按普通字符串。" +
        "path 限定目录，glob 限定文件名（如 **/*.ts），ignoreCase 忽略大小写。" +
        "context 给出每个匹配行的前后文行数（最多 10）。" +
        "默认最多 100 条匹配，每条匹配行最多 500 字符。" +
        "搜不到会返回空列表而不是错误 —— 那是正常结果。" +
        "结果被截断时，用 path 或 glob 缩小范围后重试。",
      inputSchema: jsonSchema<{
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      }>({
        type: "object",
        properties: {
          pattern: { type: "string", description: "要搜索的内容，默认是正则表达式" },
          path: { type: "string", description: "限定目录，省略表示整个仓库" },
          glob: { type: "string", description: "限定文件名的 glob，如 **/*.ts" },
          ignoreCase: { type: "boolean", description: "忽略大小写，默认 false" },
          literal: { type: "boolean", description: "把 pattern 当普通字符串，默认 false" },
          context: { type: "number", description: "每个匹配行的前后文行数，最多 10，默认 0" },
          limit: { type: "number", description: "最多返回多少条匹配，默认 100" },
        },
        required: ["pattern"],
        additionalProperties: false,
      }),
      execute: async ({ pattern, path, glob, ignoreCase, literal, context, limit }) =>
        guarded(() => {
          const bad = notReady(repo);
          if (bad) return bad;

          const pat = String(pattern ?? "");
          if (!pat) return { error: "pattern 不能为空" };
          if (pat.length > GREP_MAX_PATTERN) {
            return { error: `pattern 过长（上限 ${GREP_MAX_PATTERN} 字符）` };
          }

          const ci = ignoreCase === true;
          const lit = literal === true;

          let test: (line: string) => boolean;
          if (lit) {
            const needle = ci ? pat.toLowerCase() : pat;
            test = (line) => (ci ? line.toLowerCase() : line).includes(needle);
          } else {
            if (hasNestedQuantifier(pat)) {
              return {
                error:
                  "pattern 含嵌套量词（形如 (a+)+），可能触发灾难性回溯并拖死这次调用。" +
                  "请改写得更具体，或用 literal=true 当普通字符串搜。",
              };
            }
            let re: RegExp;
            try {
              re = new RegExp(pat, ci ? "i" : "");
            } catch (e) {
              return { error: `正则表达式无效：${(e as Error).message}` };
            }
            test = (line) => re.test(line);
          }

          // SQL 侧预筛用的字面量。短于 3 字符就不值得预筛（命中面太大）
          let needle: string | null;
          if (lit) {
            needle = ci ? pat.toLowerCase() : pat;
          } else {
            const core = literalCore(pat);
            needle = core === null ? null : ci ? core.toLowerCase() : core;
          }

          const ctx = toInt(context, 0, 0, GREP_MAX_CONTEXT);
          const lim = toInt(limit, GREP_DEFAULT_LIMIT, 1, GREP_MAX_LIMIT);
          const matchFile = glob ? makeGlobMatcher(String(glob)) : null;
          const prefix = dirPrefix(path);

          const matches: {
            path: string;
            line: number;
            text: string;
            before?: string[];
            after?: string[];
          }[] = [];

          let filesScanned = 0;
          let bytesScanned = 0;
          let truncated = false;

          const cursor = repo.fileCursor(
            prefix,
            needle === null ? undefined : { needle, ci },
          );

          for (const row of cursor) {
            if (matchFile && !matchFile(row.path)) continue;

            filesScanned++;
            bytesScanned += row.bytes;

            const lines = row.content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (!test(lines[i])) continue;

              const raw = lines[i];
              const entry: (typeof matches)[number] = {
                path: row.path,
                line: i + 1,
                text:
                  raw.length > GREP_MAX_LINE_CHARS
                    ? raw.slice(0, GREP_MAX_LINE_CHARS) + "…"
                    : raw,
              };
              if (ctx > 0) {
                entry.before = lines.slice(Math.max(0, i - ctx), i);
                entry.after = lines.slice(i + 1, i + 1 + ctx);
              }
              matches.push(entry);

              if (matches.length >= lim) {
                truncated = true;
                break;
              }
            }

            if (truncated) break;
            if (bytesScanned >= GREP_MAX_SCAN_BYTES) {
              truncated = true;
              break;
            }
          }

          // 再按总输出字节卡一道
          const out: typeof matches = [];
          let outBytes = 0;
          let outputTruncated = false;
          for (const m of matches) {
            const cost =
              utf8Len(m.text) + m.path.length + 24 + ctx * 40;
            if (outBytes + cost > GREP_MAX_OUTPUT_BYTES) {
              outputTruncated = true;
              break;
            }
            out.push(m);
            outBytes += cost;
          }

          const cut = truncated || outputTruncated;
          return {
            matches: out,
            matchCount: out.length,
            filesScanned,
            bytesScanned,
            truncated: cut,
            ...(out.length === 0
              ? { note: "没有匹配。搜不到不是错误 —— 换个关键词，或去掉 glob / path 限制再试。" }
              : {}),
            ...(cut
              ? {
                  hint:
                    "结果被截断。用 path 或 glob 缩小范围，或把 context 调小，再搜一次以拿到完整结果。",
                }
              : {}),
          };
        }),
    }),
  };
}
