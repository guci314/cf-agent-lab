// 飞书消息里的命令解析。零依赖纯函数。
//
// ⚠️ 这里**故意**和 `src/workspace-panel.tsx` 里的 `parseRepo` 重复了一份实现。
// 那个文件 import 了 React，服务端复用会把整个 React 拉进 Worker bundle。
// 两份解析器的输入形状也不同：那边是网页输入框（允许人慢慢打字、可带空格），
// 这边是聊天消息（可能混着 @ 占位符、可能有人在句子中间贴链接）。

import { OWNER_RE, REF_RE } from "../workspace/github.ts";

export type Command =
  | { kind: "ask"; text: string }
  | { kind: "repo"; owner: string; name: string; ref?: string }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const HELP_TEXT = [
  "发消息直接问代码问题就行。",
  "",
  "/repo owner/name        导入一个 GitHub 仓库（也可以粘完整链接）",
  "/repo owner/name@分支   指定分支，默认用仓库的默认分支",
  "/status                 看当前导入了哪个仓库、多少文件",
  "/help                   看这一段",
  "",
  "每个飞书会话（单聊、每个群）各自独立：仓库和对话记忆互不影响。",
].join("\n");

const REPO_USAGE = "用法：/repo owner/name，比如 /repo sindresorhus/is-stream，也可以直接粘 GitHub 链接。换分支写 /repo owner/name@dev。";

/**
 * 把一条消息解析成命令。不带斜杠的一律当成提问。
 */
export function parseCommand(raw: string): Command {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "ask", text };

  // 只按空白切，命令名大小写不敏感
  const sp = text.search(/\s/);
  const head = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? "" : text.slice(sp).trim();

  switch (head) {
    case "/repo":
    case "/导入":
      if (!arg) return { kind: "error", message: REPO_USAGE };
      return parseRepoArg(arg);
    case "/status":
    case "/状态":
      return { kind: "status" };
    case "/help":
    case "/帮助":
    case "/?":
      return { kind: "help" };
    default:
      return {
        kind: "error",
        message: `不认识的命令 ${head}。发 /help 看看有什么。`,
      };
  }
}

/** 接受 `owner/name`、`owner/name@ref`，也接受 GitHub 链接（含 /tree/<ref>） */
function parseRepoArg(arg: string): Command {
  const s = arg
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return { kind: "error", message: REPO_USAGE };

  const [owner, name, ...rest] = parts;

  // `owner/name@ref`
  const at = name.indexOf("@");
  let ref: string | undefined;
  let repoName = name;
  if (at > 0) {
    repoName = name.slice(0, at);
    ref = name.slice(at + 1);
  }

  // `github.com/owner/name/tree/<ref>`
  if (!ref && rest[0] === "tree" && rest.length > 1) ref = rest.slice(1).join("/");

  if (!OWNER_RE.test(owner) || !OWNER_RE.test(repoName)) {
    return { kind: "error", message: `owner / 仓库名里有不认识的字符。\n\n${REPO_USAGE}` };
  }
  if (ref !== undefined && !REF_RE.test(ref)) {
    return { kind: "error", message: `分支名里有不认识的字符。\n\n${REPO_USAGE}` };
  }

  return ref ? { kind: "repo", owner, name: repoName, ref } : { kind: "repo", owner, name: repoName };
}
