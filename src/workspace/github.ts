// GitHub tarball 的 URL 构造与校验。
//
// 抽出来的理由：**两个地方要用**——Worker 路由（流式转发给浏览器去解码）和
// Durable Object（飞书的 /repo 命令里自己抓下来入库）。
// 各写一份必然漂移，而 ref 的**逐段编码**是个很容易写错、写错了还只表现为
// 一个 404 的细节（整串 encodeURIComponent 会把 `feature/x` 变成 `feature%2Fx`）。
//
// 零 import，两边运行时都能跑。

export const OWNER_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 超过这个大小就不接了：解压后是几十倍，两边都扛不住 */
export const TARBALL_MAX_BYTES = 50 * 1024 * 1024;

/** codeload 的 tarball 地址。调用方负责先过 OWNER_RE / REF_RE。 */
export function codeloadUrl(owner: string, name: string, ref: string): string {
  const refPath = ref.split("/").map(encodeURIComponent).join("/");
  return `https://codeload.github.com/${owner}/${name}/tar.gz/${refPath}`;
}

/**
 * 问 GitHub 这个仓库的默认分支是什么。
 *
 * 为什么要问：codeload 不接受 `HEAD` 当 ref（会 404），而默认分支不一定是 `main`
 * —— 老仓库普遍是 `master`。硬编码 `main` 会让 `/repo owner/name` 在一半的仓库上
 * 莫名其妙地失败，而错误信息还是「仓库不存在」，非常误导。
 * 显式写了 `@分支` 就不走这里。
 */
export async function resolveDefaultBranch(
  owner: string,
  name: string,
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}`,
    {
      headers: { "user-agent": UA, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    // 404 在这里的含义和 codeload 那边一样：仓库不存在或私有
    throw new Error(`查不到仓库 ${owner}/${name}（GitHub 返回 ${res.status}）`);
  }
  const data = (await res.json()) as { default_branch?: string };
  const branch = String(data.default_branch ?? "");
  if (!branch) throw new Error(`GitHub 没有返回 ${owner}/${name} 的默认分支`);
  return branch;
}
