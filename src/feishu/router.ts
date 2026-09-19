// /api/feishu/event —— 飞书事件回调的 HTTP 层。
//
// ⚠️ 这个路由挂在**密码门之外**：飞书不会带我们的 cookie，进了门就永远 401。
// 所以它自己必须是一道完整的门，见下面的检查顺序。
//
// 这一层只做「证明请求可信 → 解析 → 丢给 DO」，**不碰模型**。
// 飞书要求快速 ACK，而模型要跑二三十秒，所以真正的处理是 DO 里一个
// `schedule()` 出来的作业（见 server.ts 的 feishuEnqueue/feishuRun）。

import { getAgentByName } from "agents";
import { decryptEvent, verifySignature } from "./crypto.ts";
import { parseMessageEvent, readChallenge, readEnvelope } from "./event.ts";

export interface FeishuEnv {
  ChatAgent: DurableObjectNamespace;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  /** 配了这个才有签名校验。生产上应该配 */
  FEISHU_ENCRYPT_KEY?: string;
  /** 逗号分隔的 open_id 白名单。空/未设 = 不限制 */
  FEISHU_ALLOWED_OPEN_IDS?: string;
}

export interface FeishuQueueEvent {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  openId: string;
  text: string;
}

/** DO 上暴露给 Worker 的方法（结构化接口，避免循环 import ChatAgent） */
interface FeishuDo {
  feishuEnqueue(evt: FeishuQueueEvent): Promise<{ accepted: boolean; reason?: string }>;
}

// 只放行飞书真的会发出来的 chat_id 形状。这不是洁癖：getAgentByName 会**按名字
// 创建 DO**，不校验的话一个签名有效但构造出来的 payload 就能刷出无限多个实例。
// 允许 `_` 和 `-` 是保守起见 —— 我见过的都是纯字母数字，但没必要为了洁癖
// 在某个真实 id 上栽跟头（本机测试就先被自己的正则挡了一次）。
const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,64}$/;

const MAX_TEXT_CHARS = 4000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 一律回 200 + `{}`。飞书只关心「收到没有」，业务上的忽略不该触发它的重推 */
const ACK = () => json({ code: 0 });

export async function handleFeishuRoutes(
  req: Request,
  env: FeishuEnv,
): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/api/feishu/event") return null;
  try {
    return await handleEvent(req, env);
  } catch (e) {
    // 500 会让飞书重推，这正是我们想要的（可能只是临时故障）
    return json({ error: (e as Error).message }, 500);
  }
}

async function handleEvent(req: Request, env: FeishuEnv): Promise<Response> {
  if (req.method !== "POST") return json({ error: "方法不支持" }, 405);

  // fail closed：没配应用凭证就没有任何可信度可言，别让门静默敞开
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_VERIFICATION_TOKEN) {
    return json({ error: "服务端未配置飞书应用凭证" }, 503);
  }

  // ⚠️ 必须先拿原始字符串。签名是对**未经解析的 body** 算的，
  // 先 JSON.parse 再 stringify 回去，键序和空白一变签名就永远对不上
  const raw = await req.text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "body 不是合法 JSON" }, 400);
  }

  const encryptKey = env.FEISHU_ENCRYPT_KEY;

  // 先解密（配了 Encrypt Key 时）。注意**顺序**：url_verification 的挑战体同样是
  // 加密的，所以解密要排在识别挑战之前。
  if (encryptKey && typeof (body as { encrypt?: string })?.encrypt === "string") {
    const plain = await decryptEvent((body as { encrypt: string }).encrypt, encryptKey);
    try {
      body = JSON.parse(plain);
    } catch {
      return json({ error: "解密后的内容不是合法 JSON" }, 400);
    }
  }

  // ── 请求网址校验握手 ────────────────────────────────────────────────
  //
  // ⚠️ 这一步**不做签名校验**，而且必须排在签名校验之前。
  //
  // 飞书文档原文：安全校验适用于「接收到开放平台推送的事件时（**不包括请求网址校验**）」。
  // 也就是说保存请求地址那一次握手**不带 X-Lark-Signature**。我原来把验签放在最前面，
  // 于是握手被 401 掉，飞书后台一直报 **「Challenge code没有返回」** ——
  // 实测踩到才知道。这一步的凭据是 Verification Token。
  //
  // 回一个 challenge 本身没有任何副作用（只是原样回声），所以这里放宽是安全的。
  const challenge = readChallenge(body);
  if (challenge !== null) {
    if (String((body as { token?: string }).token ?? "") !== env.FEISHU_VERIFICATION_TOKEN) {
      return json({ error: "verification token 不匹配" }, 401);
    }
    return json({ challenge });
  }

  // ── 事件推送才校验签名 ──────────────────────────────────────────────
  if (encryptKey) {
    const ok = await verifySignature(
      raw,
      req.headers.get("x-lark-request-timestamp") ?? "",
      req.headers.get("x-lark-request-nonce") ?? "",
      encryptKey,
      req.headers.get("x-lark-signature") ?? "",
    );
    if (!ok) return json({ error: "签名校验失败" }, 401);
  }
  // 没配 Encrypt Key 就只剩明文 token 比对 —— 安全性明显更弱，但至少不比飞书给的方案差。

  const envelope = readEnvelope(body);
  if (!envelope) return ACK();
  if (envelope.token !== env.FEISHU_VERIFICATION_TOKEN) {
    return json({ error: "token 不匹配" }, 401);
  }

  if (envelope.eventType !== "im.message.receive_v1") return ACK();

  const msg = parseMessageEvent(body);
  if (!msg) return ACK();

  // ⚠️ 自环防护必须在**去重之前**。我们自己也往会话里发消息（「正在抓取…」、
  // 以及回答），那些消息同样会变成 im.message.receive_v1 事件推回来 ——
  // 不过滤的话 bot 会跟自己的回执聊起来。
  const senderType = (body as any).event?.sender?.sender_type;
  if (senderType === "app") return ACK();

  if (!msg.openId) return ACK();

  const allow = (env.FEISHU_ALLOWED_OPEN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length > 0 && !allow.includes(msg.openId)) {
    return ACK(); // 静默忽略：回一条"你没权限"等于告诉对方这个端点存在
  }

  if (!CHAT_ID_RE.test(msg.chatId)) return ACK();
  if (!msg.text || msg.text.length > MAX_TEXT_CHARS) return ACK();

  const stub = (await getAgentByName(
    env.ChatAgent,
    `fs-${msg.chatId}`,
  )) as unknown as FeishuDo;

  // 只入队，不跑模型。飞书那边会立刻收到 ACK
  await stub.feishuEnqueue({
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    openId: msg.openId,
    text: msg.text,
  });

  return ACK();
}
