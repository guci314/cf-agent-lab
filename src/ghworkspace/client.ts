// GitHub Contents API 客户端 —— 只服务于「工作区仓库」那一族工具。
//
// 不引 SDK：只有四个端点，不值得一个依赖，而且 workerd 里全程 fetch 就够
// （和 sandbox/aliyun.ts 手写 Connect RPC 是同一个取舍）。
//
// 凭证是 fine-grained PAT，**只授予这一个仓库的 Contents 读写**。它只出现在请求头里，
// 绝不进任何错误信息 —— 错误信息会被模型读、被飞书卡片渲染、被用户复制出去。
//
// 实测（2026-09-21，非猜测）：
//   目录 → 数组 [{name, path, sha, size, type}]，type 是 "file" | "dir"
//   文件 → {name, path, sha, size, encoding: "base64", content}
//          content 每 60 字符夹一个 \n；fromBase64 会跳过空白，直接喂进去即可
//   路径不存在 → {"message":"Not Found"} + HTTP 404
//   限额 5000 次/小时

import { fromBase64, textToBase64 } from "../sandbox/base64.ts";
import { UA } from "../workspace/github.ts";

export const DEFAULT_API_BASE = "https://api.github.com";
/** 仓库名不是密钥，硬编码默认值；要改指向就用 GITHUB_WORKSPACE_REPO */
export const DEFAULT_REPO = "guci314/cf-agent-workspace";

// ⚠️ 超时给得比"正常该多快"宽得多，是有意的。
//
// 原来的 10s / 15s 是按"GitHub 正常几百毫秒就回"定的，实际太紧：写一个文件不是
// **一次**请求 —— 得先 GET 拿当前 sha 再 PUT，任何一次慢都让整个写操作失败，
// 而用户看到的是"写操作超时"。这类失败还会有连锁反应：模型拿到超时后往往重试，
// 于是一轮对话里反复卡同一个慢请求。
//
// 代价是极端情况下单次工具调用最长等这么久。但"等的久"远好过"明明能成却报错"：
// 前者只是慢，后者会让模型基于假信息改道。
const GET_TIMEOUT_MS = 25_000;
/** 写要传请求体（可能几百 KB）而且 GitHub 侧要落一次 commit，比读更慢 */
const WRITE_TIMEOUT_MS = 30_000;

export interface GhWorkspaceConfig {
  token: string;
  /** "owner/name" */
  repo: string;
  apiBase: string;
}

export interface GhEnv {
  GITHUB_WORKSPACE_TOKEN?: string;
  GITHUB_WORKSPACE_REPO?: string;
  /** 只为本地测试指向 mock。生产不要设 */
  GITHUB_API_BASE?: string;
}

/**
 * **没配 TOKEN 就返回 null** —— 和 sandboxConfig 里 executor 要求 URL+KEY 齐备
 * 是同一个规矩：配不全就当没配，别挂出一族永远失败的工具让模型反复去试。
 */
export function ghWorkspaceConfig(env: GhEnv): GhWorkspaceConfig | null {
  const token = (env.GITHUB_WORKSPACE_TOKEN ?? "").trim();
  if (!token) return null;

  const repo = (env.GITHUB_WORKSPACE_REPO ?? "").trim() || DEFAULT_REPO;
  // 认不出 owner/name 就当作没配：宁可没有工具，也不要拿一个拼错的仓库名去 404，
  // 那种错看起来像「仓库不存在」，实际是配置问题
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;

  return {
    token,
    repo,
    apiBase: (env.GITHUB_API_BASE ?? "").trim().replace(/\/+$/, "") || DEFAULT_API_BASE,
  };
}

/**
 * **模型自己能纠正的**用法错，不是环境故障：拿错工具、文件太大、文件不在。
 *
 * 分出来是因为上层的 `guarded` 会把任何异常都包成「工具执行失败：…」——
 * 那句话对网络故障是对的，对「你该用 ws_ls」就纯属误导，模型可能因此
 * 去重试或道歉，而正确反应是换个工具。工具层据此原样透出消息。
 */
export class UsageError extends Error {}

export interface GhEntry {
  name: string;
  type: "file" | "dir" | "other";
  size: number;
}

export interface GhFile {
  path: string;
  sha: string;
  size: number;
  /** 含 NUL 字节时判为二进制，此时 text 为空串 */
  binary: boolean;
  text: string;
}

/**
 * 逐段编码，**不是**整串 encodeURIComponent —— 后者会把 `a/b` 变成 `a%2Fb`，
 * 于是每个路径都 404。这个坑 `codeloadUrl` 的注释里已经写过一次。
 */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** 归一化 + 校验。返回错误说明，或 null 表示合法。 */
export function checkPath(raw: unknown): { path: string; error?: undefined } | { path: string; error: string } {
  const path = String(raw ?? "")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!path) return { path, error: "path 不能为空" };
  if (path.length > 900) return { path, error: "path 过长" };
  for (const seg of path.split("/")) {
    if (!seg || seg === "." || seg === "..") {
      return { path, error: `path 里有非法片段 ${JSON.stringify(seg)}（不允许空段、. 和 ..）` };
    }
    // 反斜杠在 GitHub 上是合法文件名字符，但在我们这套路径语义里只会造成歧义；
    // 控制字符则会让 HTTP 层出问题
    if (/[\u0000-\u001f\\]/.test(seg)) {
      return { path, error: "path 里有控制字符或反斜杠" };
    }
  }
  return { path };
}

async function req(
  cfg: GhWorkspaceConfig,
  path: string,
  init: { method: string; body?: string },
  timeoutMs: number,
): Promise<Response> {
  const tail = path ? "/" + encodePath(path) : "";
  const url = `${cfg.apiBase}/repos/${cfg.repo}/contents${tail}`;

  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": UA,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(
      name === "TimeoutError" || name === "AbortError"
        ? `连接 GitHub 超时（等了 ${Math.round(timeoutMs / 1000)} 秒）`
        : `连不上 GitHub：${(e as Error).message}`,
    );
  }
}

/**
 * 把失败响应翻译成「下一步该怎么做」。
 *
 * 每种状态码都要指向一个**不同的动作**，否则模型只能瞎试：
 * 401 要换凭证（人来做）、403 两条岔路、404 三种可能、409/422 重读再写。
 */
async function fail(res: Response, ctx: string): Promise<never> {
  let detail = "";
  try {
    const j = (await res.json()) as { message?: string };
    detail = String(j.message ?? "").slice(0, 200);
  } catch {
    /* body 不是 JSON（限流页之类），不影响下面的判断 */
  }
  // GitHub 自己的 message 很具体（'"sha" wasn\'t supplied'、'sha does not match'），
  // 附上去能省模型一轮试错
  const suffix = detail ? `（GitHub 说：${detail}）` : "";

  if (res.status === 401) {
    throw new Error(`GitHub 拒绝了这个凭证：PAT 无效、已过期或被撤销。这需要人去重新生成并更新 secret。${suffix}`);
  }
  if (res.status === 403) {
    // 限流和权限不足都是 403，靠这个响应头区分 —— 两者该给的建议完全不同
    const limited = res.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(
      limited
        ? `GitHub 限流了（每小时 5000 次），过一会儿再试。${suffix}`
        : `PAT 权限不足：这个仓库需要授予 Contents: Read and write。${suffix}`,
    );
  }
  if (res.status === 404) {
    // ⚠️ GitHub 对「仓库不存在」「PAT 没被授权访问这个仓库」「路径不存在」**故意**都回 404
    // —— 避免泄漏私有仓库是否存在。所以不能说死是哪种，三种必须都列出来，
    // 否则模型会照着「文件不存在」的结论去找文件，而真正的问题是凭证没授权。
    // 404 归到 UsageError：它几乎总是「路径不对」这种模型自己能纠正的事，
    // 不该被包成听上去像环境坏了的「工具执行失败」。
    throw new UsageError(
      `${ctx}：GitHub 回 404。可能是①这个路径不存在；②仓库名写错了；` +
        `③这把 PAT 没有被授权访问这个仓库。GitHub 故意让这三种情况回同一个码，从错误上分不出来。${suffix}`,
    );
  }
  if (res.status === 409 || res.status === 422) {
    throw new Error(`GitHub 拒绝了这次写入（HTTP ${res.status}）：多半是文件在你读之后被改动过。重新读一次再写。${suffix}`);
  }
  throw new Error(`GitHub 返回 HTTP ${res.status}${suffix}`);
}

/** 列一个目录。path 为空串表示仓库根目录。 */
export async function listDir(cfg: GhWorkspaceConfig, path: string): Promise<GhEntry[]> {
  const res = await req(cfg, path, { method: "GET" }, GET_TIMEOUT_MS);
  if (!res.ok) await fail(res, `列目录 ${path || "/"}`);

  const j = (await res.json()) as unknown;
  if (!Array.isArray(j)) {
    // 路径指向文件时 GitHub 回的是**对象**而不是数组。这不是故障，
    // 但「列目录」对文件没有意义，得把模型推向正确的工具。
    throw new UsageError(`${path} 是文件不是目录。用 ws_read 读它。`);
  }
  return j.map((raw) => {
    const e = raw as Record<string, unknown>;
    const t = String(e.type ?? "");
    return {
      name: String(e.name ?? ""),
      type: t === "file" || t === "dir" ? t : "other",
      size: Number(e.size ?? 0),
    };
  });
}

/**
 * 读一个文件。**不存在返回 null**，不是抛错 —— 「不存在」是正常结果，
 * 调用方（尤其 ws_write 的自动取 sha）要靠它决定是创建还是更新。
 */
export async function getFile(cfg: GhWorkspaceConfig, path: string): Promise<GhFile | null> {
  const res = await req(cfg, path, { method: "GET" }, GET_TIMEOUT_MS);
  if (res.status === 404) return null;
  if (!res.ok) await fail(res, `读 ${path}`);

  const j = (await res.json()) as unknown;
  if (Array.isArray(j)) {
    throw new UsageError(`${path} 是目录不是文件。用 ws_ls 列它。`);
  }
  const o = j as Record<string, unknown>;
  const size = Number(o.size ?? 0);

  // >1MB 的文件 Contents API 回 encoding:"none" + content:""。当成"空文件"返回
  // 是**静默的谎**，模型会据此下错误的结论 —— 宁可明确报错。
  if (String(o.encoding ?? "") === "none" || (!o.content && size > 0)) {
    throw new UsageError(
      `${path} 有 ${size} 字节，超过 Contents API 能返回的上限（1MB），它不给这种文件的内容。` +
        `让用户直接在 GitHub 上看，或换个小文件。`,
    );
  }

  const bytes = fromBase64(String(o.content ?? ""));
  // 含 NUL 就当二进制。TextDecoder 会把非法字节变成 U+FFFD，把一屏 � 交给模型
  // 比直接说「这是二进制文件」糟得多。
  let binary = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      binary = true;
      break;
    }
  }

  return {
    path: String(o.path ?? path),
    sha: String(o.sha ?? ""),
    size,
    binary,
    text: binary ? "" : new TextDecoder().decode(bytes),
  };
}

/**
 * 新建或覆盖一个文件，产生一次真实 commit。
 *
 * 不传 sha 就自己先读一次拿当前的 sha（last-write-wins）。这是有意的便利取舍：
 * 让模型自己管 sha 的话，它几乎必然会在某轮忘记传，然后拿到 422 反复重试。
 * 需要"防覆盖"的调用方仍可显式传 sha。
 *
 * 读到写之间文件被别人改动 → GitHub 回 409/422。这里**重读 sha 再写一次**
 * （只一次）：这类竞争在单人工作区里很少见，但一旦发生，模型看懂 sha 冲突的
 * 报错几乎不可能，它会反复重试烧掉步数预算。
 */
export async function putFile(
  cfg: GhWorkspaceConfig,
  path: string,
  text: string,
  message: string,
  sha?: string,
): Promise<{ sha: string; commit: string; created: boolean }> {
  let current = (sha ?? "").trim() || undefined;
  let created = false;

  if (!current) {
    const cur = await getFile(cfg, path);
    if (cur) current = cur.sha;
    else created = true;
  }

  const body = (s?: string) =>
    JSON.stringify({ message, content: textToBase64(text), ...(s ? { sha: s } : {}) });

  let res = await req(cfg, path, { method: "PUT", body: body(current) }, WRITE_TIMEOUT_MS);

  if (res.status === 409 || res.status === 422) {
    const fresh = await getFile(cfg, path);
    if (fresh) {
      res = await req(cfg, path, { method: "PUT", body: body(fresh.sha) }, WRITE_TIMEOUT_MS);
    }
  }
  if (!res.ok) await fail(res, `写 ${path}`);

  const d = (await res.json()) as { content?: { sha?: string }; commit?: { sha?: string } };
  return {
    sha: String(d.content?.sha ?? ""),
    commit: String(d.commit?.sha ?? "").slice(0, 7),
    created,
  };
}

/** 删一个文件。同样自己解析 sha。 */
export async function deleteFile(
  cfg: GhWorkspaceConfig,
  path: string,
  message: string,
  sha?: string,
): Promise<{ commit: string }> {
  let current = (sha ?? "").trim() || undefined;
  if (!current) {
    const cur = await getFile(cfg, path);
    if (!cur) throw new UsageError(`文件不存在：${path}（先 ws_ls 确认路径）`);
    current = cur.sha;
  }

  const res = await req(cfg, path, { method: "DELETE", body: JSON.stringify({ message, sha: current }) }, WRITE_TIMEOUT_MS);
  if (!res.ok) await fail(res, `删除 ${path}`);

  const d = (await res.json()) as { commit?: { sha?: string } };
  return { commit: String(d.commit?.sha ?? "").slice(0, 7) };
}
