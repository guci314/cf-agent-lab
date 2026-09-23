// /api/feishu/edgeone —— 「代码仓库助手」(cli_aa392e9beb799bce) 的事件入口。
//
// ── 为什么这个 bot 挂在我们这里 ──────────────────────────────────────
// 这个 bot 的"大脑"跑在 EdgeOne Makers 的 agents 路由上
// （https://eolab.yujizi.org/feishu）。EdgeOne 的两类 Runtime 是分离的：
// cloud-functions 内部 fetch 同项目 agents 路由会被平台拒
// （404 domain endpoints match fail），所以「webhook → 转发」必须在
// **外部**做。而我们是 7×24 在线的公网 Worker，正好干这个。
//
// ⚠️ 注意角色边界：本 Worker 只做「证明可信 → 解析 → 转发」，**不碰模型、
// 不回复**。回答是 EdgeOne 那边调飞书 API 发的（它自己有 app secret）。
//
// ── 和 /api/feishu/event 的分工 ─────────────────────────────────────
// 那个路由服务「代码仓库问答」（本地 DO 跑模型，密钥是 FEISHU_* 系列）；
// 这个路由服务「代码仓库助手」（转发 EdgeOne，密钥是 EO_BOT_* 系列）。
// 两个应用各自独立配置 webhook 地址，密钥互不通用，别混。
//
// ── ACK 策略 ────────────────────────────────────────────────────────
// 飞书要求 3 秒内 ACK，而 EdgeOne 返回 202 实测要 3.4~4.6 秒 —— 同步等
// 必超时，飞书会重推。所以：**立刻 ACK，转发放 ctx.waitUntil**。
// 代价是转发失败飞书不会重推（它以为已签收），所以 waitUntil 里带重试。
// EdgeOne 那边有 messageId 去重，重试不会造成重复回答。

import { createHash } from "node:crypto";
import { decryptEvent, verifySignature } from "./crypto.ts";
import { parseMessageEvent, readChallenge, readEnvelope } from "./event.ts";

export interface EdgeOneRelayEnv {
  /** 「代码仓库助手」应用的 Verification Token */
  EO_BOT_VERIFICATION_TOKEN?: string;
  /** 「代码仓库助手」应用的 Encrypt Key */
  EO_BOT_ENCRYPT_KEY?: string;
  /** EdgeOne agents 路由的公网地址 */
  EO_AGENT_URL?: string;
  /** EdgeOne agent 校验的内部令牌（和它 env 里的 INTERNAL_TOKEN 同值） */
  EO_INTERNAL_TOKEN?: string;
}

const MAX_TEXT_CHARS = 4000;
const FORWARD_RETRIES = 2;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 一律 200 —— 业务上忽略不该触发飞书重推 */
const ACK = () => json({ code: 0 });

/**
 * conversation_id 算法必须**永远不变**：同一个 chat_id 必须落到同一个
 * EdgeOne 会话实例上，否则记忆和语料就串了。平台限制 6~36 字符。
 * （EdgeOne 侧本地调试也用这个算法，改了要对齐两边。）
 */
function conversationIdFor(chatId: string): string {
  return `fs-${createHash("sha256").update(chatId).digest("hex").slice(0, 32)}`;
}

async function forwardOnce(
  env: EdgeOneRelayEnv,
  evt: { messageId: string; chatId: string; chatType: string; openId: string; text: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(env.EO_AGENT_URL as string, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 平台按它做粘性路由 + store/沙箱归属。缺了直接 400
      "Makers-Conversation-Id": conversationIdFor(evt.chatId),
    },
    // 令牌放 body.token：EdgeOne runtime 的 request.headers 是普通对象，
    // 但保险起见 header 也带（agent 两种形态都读）
    body: JSON.stringify({ ...evt, token: env.EO_INTERNAL_TOKEN }),
    // agent 在 async 模式下 ~4 秒回 202；这是兜底，别让它吃掉整个 waitUntil 预算
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text().catch(() => "");
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body: body.slice(0, 300) };
}

async function forwardWithRetry(
  env: EdgeOneRelayEnv,
  evt: { messageId: string; chatId: string; chatType: string; openId: string; text: string },
): Promise<void> {
  let last = { ok: false, status: 0, body: "" };
  for (let i = 0; i <= FORWARD_RETRIES; i++) {
    try {
      last = await forwardOnce(env, evt);
      if (last.ok) {
        console.log(`[edgeone-relay] ${evt.messageId} → ${last.status}`);
        return;
      }
    } catch (e) {
      last = { ok: false, status: 0, body: (e as Error).message };
    }
    // 指数退避：2s / 4s。waitUntil 总预算 30s，够用
    if (i < FORWARD_RETRIES) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  console.error(`[edgeone-relay] ${evt.messageId} 转发失败：`, JSON.stringify(last));
}

export async function handleEdgeOneRelayRoutes(
  req: Request,
  env: EdgeOneRelayEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/api/feishu/edgeone") return null;

  // fail closed：凭证没配齐就拒绝服务，别让门静默敞开
  if (!env.EO_BOT_VERIFICATION_TOKEN || !env.EO_AGENT_URL || !env.EO_INTERNAL_TOKEN) {
    return json(
      { error: "服务端未配置 EdgeOne 转发凭证（EO_BOT_* / EO_AGENT_URL / EO_INTERNAL_TOKEN）" },
      503,
    );
  }

  try {
    return await handleEvent(req, env, ctx);
  } catch (e) {
    // 500 会让飞书重推 —— 转发层本身出错时这是我们想要的
    return json({ error: (e as Error).message }, 500);
  }
}

async function handleEvent(
  req: Request,
  env: EdgeOneRelayEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "方法不支持" }, 405);

  // ⚠️ 先拿原始字符串：签名对未解析 body 算，parse 再 stringify 键序就变了
  const raw = await req.text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "body 不是合法 JSON" }, 400);
  }

  const encryptKey = env.EO_BOT_ENCRYPT_KEY;

  // 先解密（挑战体同样加密）。密钥是「代码仓库助手」的，不是问答 bot 的
  if (encryptKey && typeof (body as { encrypt?: string })?.encrypt === "string") {
    const plain = await decryptEvent((body as { encrypt: string }).encrypt, encryptKey);
    try {
      body = JSON.parse(plain);
    } catch {
      return json({ error: "解密后的内容不是合法 JSON" }, 400);
    }
  }

  // 挑战握手不验签（飞书文档：安全校验不包括请求网址校验），必须排在验签前
  const challenge = readChallenge(body);
  if (challenge !== null) {
    if (String((body as { token?: string }).token ?? "") !== env.EO_BOT_VERIFICATION_TOKEN) {
      return json({ error: "verification token 不匹配" }, 401);
    }
    return json({ challenge });
  }

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

  const envelope = readEnvelope(body);
  if (!envelope) return ACK();
  if (envelope.token !== env.EO_BOT_VERIFICATION_TOKEN) {
    return json({ error: "token 不匹配" }, 401);
  }

  if (envelope.eventType !== "im.message.receive_v1") return ACK();

  const msg = parseMessageEvent(body);
  if (!msg) return ACK();

  // 自环防护：bot 自己发的回答/回执也会作为事件推回来
  if ((body as any).event?.sender?.sender_type === "app") return ACK();

  if (!msg.openId) return ACK();
  if (!msg.text || msg.text.length > MAX_TEXT_CHARS) return ACK();

  // 立刻 ACK，转发放后台（见文件头「ACK 策略」）
  ctx.waitUntil(
    forwardWithRetry(env, {
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      openId: msg.openId,
      text: msg.text,
    }),
  );
  return ACK();
}
