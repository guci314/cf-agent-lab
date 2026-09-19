// 飞书事件体的解析。零依赖纯函数，可以用 node 直接跑。
//
// 事件体的形状（官方文档核实过，不是记忆）：
//   header.event_type / header.token
//   event.sender.sender_type        "user" | "app"
//   event.sender.sender_id.open_id
//   event.message.{message_id, chat_id, chat_type, message_type, content, mentions[]}
//
// ⚠️ `content` 是**一个 JSON 字符串**，不是对象：`"{\"text\":\"@_user_1 hello\"}"`。
//    直接当对象用会静默拿到 undefined，然后整条消息变成空字符串。

export interface FeishuMessageEvent {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  openId: string;
  /** 剥掉 @占位符并压掉多余空格后的正文 */
  text: string;
}

export interface FeishuEnvelope {
  eventType: string;
  token: string;
  payload: unknown;
}

/** 从已解密的 body 里取出事件类型 / token / 事件体。形不合法就返回 null。 */
export function readEnvelope(body: unknown): FeishuEnvelope | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const header = b.header ?? {};
  return {
    eventType: String(header.event_type ?? b.type ?? ""),
    token: String(header.token ?? b.token ?? ""),
    payload: b,
  };
}

/** 请求网址校验握手：`{challenge, token, type:"url_verification"}` → 回 challenge */
export function readChallenge(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  if (b.type !== "url_verification") return null;
  const c = b.challenge;
  return typeof c === "string" && c ? c : null;
}

/**
 * 解析一条接收消息事件。
 *
 * 返回 null 的情形都要**静默忽略**（不是错误）：不是消息事件、不是文本消息、
 * 缺关键字段。这些情况飞书都会推，但都不是给我们处理的。
 */
export function parseMessageEvent(body: unknown): FeishuMessageEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  if (b.header?.event_type !== "im.message.receive_v1") return null;

  const msg = b.event?.message;
  if (!msg || typeof msg !== "object") return null;
  // 只处理纯文本。图片/文件/卡片一律忽略（v1 不支持，去处理它们只会产生空问题）
  if (msg.message_type !== "text") return null;

  const messageId = String(msg.message_id ?? "");
  const chatId = String(msg.chat_id ?? "");
  const openId = String(b.event?.sender?.sender_id?.open_id ?? "");
  if (!messageId || !chatId) return null;

  const mentionKeys: string[] = Array.isArray(msg.mentions)
    ? msg.mentions.map((m: any) => String(m?.key ?? "")).filter(Boolean)
    : [];

  return {
    messageId,
    chatId,
    chatType: msg.chat_type === "group" ? "group" : "p2p",
    openId,
    text: extractText(msg.content, mentionKeys),
  };
}

/**
 * 取出 content 里的 text 并剥掉 @占位符。
 *
 * 群聊里 @机器人 之后，正文里留的是 `@_user_1` 这种占位符（真正的显示名在
 * mentions 里）。不剥的话会原样喂给模型，问题里就多了一串 `@_user_1`。
 *
 * 只压空格和制表符、**不动换行** —— 用户发多行代码片段是常有的事，
 * 把换行也吃掉会让整段代码糊成一行。
 */
function extractText(content: unknown, mentionKeys: string[]): string {
  let text = "";
  try {
    const parsed = JSON.parse(String(content ?? ""));
    text = String(parsed?.text ?? "");
  } catch {
    return "";
  }

  for (const key of mentionKeys) text = text.split(key).join(" ");
  return text.replace(/[ \t]+/g, " ").trim();
}
