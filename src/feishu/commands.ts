// 飞书消息里的命令解析。零依赖纯函数。

export type Command =
  | { kind: "ask"; text: string }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const HELP_TEXT = [
  "发消息直接问就行。",
  "",
  "/status                 看当前会话的状态",
  "/help                   看这一段",
  "",
  "每个飞书会话（单聊、每个群）各自独立：对话记忆互不影响。",
].join("\n");

/**
 * 把一条消息解析成命令。不带斜杠的一律当成提问。
 *
 * 2026-09-25：agent 从「代码仓库问答」改成通用助手，`/repo`（导入 GitHub 仓库）
 * 连同它依赖的 `OWNER_RE` / `REF_RE` 一起删掉了。这里曾经还有一份和网页
 * `workspace-panel.tsx` 里 `parseRepo` 刻意重复的解析实现，也随仓库层一起没了。
 */
export function parseCommand(raw: string): Command {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "ask", text };

  // 只按空白切，命令名大小写不敏感
  const sp = text.search(/\s/);
  const head = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();

  switch (head) {
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
