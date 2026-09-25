// 工作区仓库的读写工具。
//
// 这一族读写的是 **agent 自己的 GitHub 私有仓库**（可写，每次写都是一次真实 commit），
// 不是用户的代码。
//
// ⚠️ 2026-09-25 之前，这里必须反复强调「别和 read / ls / grep / find 拿混」—— 那四个
// 读的是**用户导入的**代码快照，两边都有「读文件」的形状，光看输入参数分不出来，模型
// 一定会拿错。现在那一族已随仓库层删除，**手上只剩这一族文件工具了**，所以那段辨析
// 也删掉了。保留这段注释是为了说明：如果以后再加第二个文件工具族，这个坑会回来。
//
// 所有 execute 都过 `guarded`（shared/util.ts）：工具抛错会中断整个工具循环，
// 一律转成 `{ error }` 让模型自己看到并调整。

import { jsonSchema, tool } from "ai";
import { guarded, utf8Len } from "../shared/util.ts";
import type { GhFile } from "./client.ts";
import {
  checkPath,
  deleteFile,
  getFile,
  listDir,
  putFile,
  UsageError,
  type GhWorkspaceConfig,
} from "./client.ts";

// 这几个上限刻意沿用「只读代码工具」那代定下的数值：契约一致，
// 模型已有的使用习惯可以直接迁移过来。
//
// ⚠️ 注意 GitHub Contents API **不支持分段读取** —— 这里的 offset/limit 是在
// 取回全文之后**在本地切片**。它管的是"喂给模型的上下文有多大"，不是省流量。
// 所以它和 read 的行为一致，但没有 read 那种"从 SQL 里按需取行"的省算力。
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50_000;

const LS_DEFAULT_LIMIT = 500;
const LS_MAX_LIMIT = 1000;

/** 写的内容上限。Contents API 本身能收 100MB，卡这里是别让一次工具调用
 *  把 DO 的内存和模型上下文都撑爆；工作区也不该放这么大的文件。 */
const WRITE_MAX_BYTES = 256 * 1024;

/** 模型经常把数字发成字符串；空串、null、undefined 一律落到默认值 */
function toInt(v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * `getFile` 撞到目录、`listDir` 撞到文件时会抛错 —— 但那是**用法错**，不是工具故障。
 * 让 `guarded` 兜住的话消息会带上「工具执行失败：」前缀，读起来像环境坏了，
 * 模型可能因此去重试或道歉；正确的反应是换个工具。所以在这两个形状上
 * 把异常翻成干净的 `{ error }`。
 */
async function usageError<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UsageError) return { error: e.message };
    throw e;
  }
}

const REPO_FRAMING =
  "**工作区仓库** —— 你在 GitHub 上的私有仓库，可读写，每次写都是一次真实的 commit。" +
  "⚠️ 这**不是**用户导入的代码仓库：读导入的代码用 read / ls / grep / find。" +
  "两个仓库内容完全不同，不要交叉使用。";

export function makeGithubTools(cfg: GhWorkspaceConfig | null) {
  // 没配凭证就一个工具都不挂 —— 挂出来只会让模型反复试用一个必然失败的工具
  if (!cfg) return {};

  return {
    ws_ls: tool({
      description:
        `列出${REPO_FRAMING}\n` +
        "path 是仓库内的相对目录，省略时列出仓库根目录。目录名以 / 结尾。" +
        `默认最多返回 ${LS_DEFAULT_LIMIT} 条，目录在前、同级按名称升序。` +
        "如果 path 指向的是文件，会让你改用 ws_read。",
      inputSchema: jsonSchema<{ path?: string; limit?: number }>({
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，省略表示仓库根目录" },
          limit: { type: "number", description: `最多返回多少条，默认 ${LS_DEFAULT_LIMIT}` },
        },
        additionalProperties: false,
      }),
      execute: async ({ path, limit }) =>
        guarded(async () => {
          const dir = String(path ?? "")
            .trim()
            .replace(/^\.\/+/, "")
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");
          // 根目录是空串，是合法的；非空才校验
          if (dir) {
            const c = checkPath(dir);
            if (c.error) return { error: c.error };
          }

          const lim = toInt(limit, LS_DEFAULT_LIMIT, 1, LS_MAX_LIMIT);
          const listed = await usageError(() => listDir(cfg, dir));
          if ("error" in listed) return listed;
          const entries = listed;
          // 目录在前、同级按名称升序 —— 沿用「只读代码工具」那代的排序口径
          entries.sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
          );

          const truncated = entries.length > lim;
          const shown = truncated ? entries.slice(0, lim) : entries;
          return {
            path: dir || ".",
            entries: shown.map((e) => ({
              name: e.type === "dir" ? e.name + "/" : e.name,
              type: e.type,
              ...(e.type === "file" ? { size: e.size } : {}),
            })),
            count: shown.length,
            truncated,
            ...(shown.length === 0 ? { note: "这个目录是空的" } : {}),
            ...(truncated ? { hint: `只显示了前 ${lim} 条，用 path 缩小到子目录` } : {}),
          };
        }),
    }),

    ws_read: tool({
      description:
        `读取${REPO_FRAMING}里某个文件的文本内容，返回带行号的内容。\n` +
        "path 是仓库内相对路径，例如 notes/hello.md。" +
        "offset 是起始行号（从 1 开始），limit 是最多读多少行。" +
        `返回内容最多 ${READ_MAX_LINES} 行或 ${READ_MAX_BYTES / 1000}KB，以先到者为准，且绝不返回半行；` +
        "被截断时 truncated=true 并给出 nextOffset，用它继续读下一段。" +
        "⚠️ 超过 1MB 的文件 GitHub 的 Contents API 根本不返回内容，这里会直接报错而不是给你一个空文件。" +
        "工作区不该放这么大的文件。读之前先用 ws_ls 确认路径。",
      inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
        type: "object",
        properties: {
          path: { type: "string", description: "仓库内相对路径，如 notes/hello.md" },
          offset: { type: "number", description: "起始行号，从 1 开始，默认 1" },
          limit: { type: "number", description: "最多读多少行，默认读到上限为止" },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path, offset, limit }) =>
        guarded(async () => {
          const c = checkPath(path);
          if (c.error) return { error: c.error };

          const got = await usageError(() => getFile(cfg, c.path));
          // ⚠️ 必须先判 null 再用 `in`：getFile 拿 null 表示「文件不存在」——那是正常
          // 结果而不是异常。对 null 用 `in` 会直接抛 TypeError，于是**读一个不存在的
          // 文件**这条最常见的路径反而变成工具崩溃。（这正是我第一版写的 bug。）
          if (got !== null && "error" in got) return got;
          const f = got;
          if (!f) {
            // ⚠️ 这里不能只说「文件不存在」。`getFile` 的 404 → null 会把**两种完全不同的
            // 情况合并**：路径确实不存在（常见），和"这把 PAT 根本没被授权访问这个仓库"
            // （罕见但致命，比如仓库名配错了）。后者会让每一次读都报"文件不存在"，
            // 把模型引向"去找文件"这个错误方向。所以给一句可自查的提示。
            return {
              error:
                `工作区仓库里没有 ${c.path}。用 ws_ls 看目录，或 ws_write 创建它。` +
                `（自查：如果 ws_ls 连根目录都列不出来，那是凭证没被授权这个仓库，不是文件不存在。）`,
            };
          }
          if (f.binary) {
            return { error: `${c.path} 看起来是二进制文件（${f.size} 字节），读不出文本。` };
          }

          const lines = f.text.split("\n");
          // 结尾换行会切出一个空元素，那不是一行
          if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

          const totalLines = lines.length;
          const start = toInt(offset, 1, 1, Number.MAX_SAFE_INTEGER);
          const want = toInt(limit, READ_MAX_LINES, 1, READ_MAX_LINES);

          if (totalLines === 0) {
            return { path: c.path, startLine: 1, endLine: 0, totalLines: 0, content: "", truncated: false };
          }
          if (start > totalLines) {
            return {
              path: c.path,
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
          // 否则 truncated + nextOffset 等于原地打转。
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
            path: c.path,
            sha: f.sha,
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

    ws_write: tool({
      description:
        `在工作区仓库里新建或覆盖一个文件，产生一次**真实的 commit**（用户在 GitHub 上看得见）。\n` +
        "content 是文件的**完整新内容**，不是补丁 —— 要改一处也得给出全文。" +
        "message 是 commit 说明，省略会用一个默认值；写得具体些，之后翻历史时有用。" +
        "sha 通常**不用传**：覆盖已有文件时工具会自己读当前 sha（等于「最后写入者胜」）。" +
        "只有你想防住「别人在我读之后改了这个文件」时才显式传 sha。" +
        `覆盖已有文件前先用 ws_read 看一眼现状，别盖掉别人的改动。上限 ${WRITE_MAX_BYTES / 1024}KB。`,
      inputSchema: jsonSchema<{
        path: string;
        content: string;
        message?: string;
        sha?: string;
      }>({
        type: "object",
        properties: {
          path: { type: "string", description: "仓库内相对路径，如 notes/hello.md" },
          content: { type: "string", description: "文件的完整内容" },
          message: { type: "string", description: "commit 说明，省略则自动生成" },
          sha: { type: "string", description: "通常省略。只在需要防覆盖时才传" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      }),
      execute: async ({ path, content, message, sha }) =>
        guarded(async () => {
          const c = checkPath(path);
          if (c.error) return { error: c.error };

          const text = String(content ?? "");
          const bytes = utf8Len(text);
          if (bytes > WRITE_MAX_BYTES) {
            return {
              error: `内容 ${bytes} 字节，超过上限 ${WRITE_MAX_BYTES}。工作区不适合放这么大的文件，拆开写。`,
            };
          }

          const msg = (String(message ?? "").trim() || `agent: write ${c.path}`).slice(0, 200);
          const put = await usageError(() => putFile(cfg, c.path, text, msg, sha));
          if ("error" in put) return put;
          return {
            ok: true,
            path: c.path,
            sha: put.sha,
            commit: put.commit,
            created: put.created,
            bytes,
          };
        }),
    }),

    ws_rm: tool({
      description:
        `删除工作区仓库里的一个文件，产生一次**真实的 commit**。\n` +
        "GitHub 上的历史还在，能从提交记录里找回，但别指望这个 —— 删之前先用 ws_ls / ws_read 确认路径。" +
        "不能删目录：Contents API 一次只能删一个文件，目录要逐个文件删。",
      inputSchema: jsonSchema<{ path: string; message?: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "要删除的文件路径" },
          message: { type: "string", description: "commit 说明，省略则自动生成" },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path, message }) =>
        guarded(async () => {
          const c = checkPath(path);
          if (c.error) return { error: c.error };

          // 先探一下它是文件还是目录。getFile 撞到目录会抛「是目录不是文件」，
          // 那句话对 ws_read 是对的，对 ws_rm 得换成"目录不能一次删"。
          let f: GhFile | null;
          try {
            f = await getFile(cfg, c.path);
          } catch (e) {
            if (/是目录/.test((e as Error).message)) {
              return {
                error:
                  `${c.path} 是目录，不能一次删除。用 ws_ls 列出里面的文件，逐个 ws_rm；` +
                  "目录本身会在最后一个文件删掉后消失（git 不跟踪空目录）。",
              };
            }
            throw e;
          }
          if (!f) return { error: `工作区仓库里没有 ${c.path}（先 ws_ls 确认路径）` };

          const msg = (String(message ?? "").trim() || `agent: delete ${c.path}`).slice(0, 200);
          const del = await usageError(() => deleteFile(cfg, c.path, msg, f.sha));
          if ("error" in del) return del;
          return { ok: true, path: c.path, deleted: true, commit: del.commit };
        }),
    }),
  };
}
