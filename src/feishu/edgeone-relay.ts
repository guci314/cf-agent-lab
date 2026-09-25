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

import { createHash, createHmac } from "node:crypto";
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
 * EdgeOne 会话实例上，否则两个群的对话记忆就串了。平台限制 6~36 字符。
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
  const pathname = new URL(req.url).pathname;

  // 云文档授权回调。**公网可达、无凭证**（浏览器跳转过来的，带不了 cookie
  // 或自定义头），所以它自己要把关：签名不对一律拒。见下面 verifyState
  if (pathname === OAUTH_CALLBACK_PATH) {
    if (!env.EO_AGENT_URL || !env.EO_INTERNAL_TOKEN) {
      return oauthHtml("服务端未配置", "缺少 EO_AGENT_URL / EO_INTERNAL_TOKEN。", 503);
    }
    return handleOAuthCallback(req, env);
  }

  if (pathname !== "/api/feishu/edgeone") return null;

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

// ── /api/feishu/oauth —— 云文档授权的浏览器回调 ────────────────────────
//
// ⚠️ **这个路径必须和飞书后台「安全设置 → 重定向 URL」里登记的完全一致**，
// 也和 EdgeOne 侧 FEISHU_OAUTH_REDIRECT_URI 的值一致。三处差一个字符都不行。
//
// ── 为什么回调要落在一个 Worker 上 ──────────────────────────────────
// EdgeOne 的 agents 路由**强制要求 `Makers-Conversation-Id` 请求头**，而浏览器
// 302 跳转带不了自定义头 —— 直接指向它必然是 400。这里补上头再转发，和飞书
// webhook 那条路走的是同一套（见文件头）。
//
// ── 本 Worker 不碰什么 ──────────────────────────────────────────────
// **不碰 app secret，也不换 token**。它只把一次性 code 转发给 EdgeOne，
// 由那边完成换取与落库。令牌和长期凭据都不经过这里。

const OAUTH_CALLBACK_PATH = "/api/feishu/oauth";

// ⚠️ 这里**不用 `Buffer`**：本仓库的类型来自 `@cloudflare/workers-types`，
// 它不声明 Buffer，引进来就是一堆类型错误；而 atob / TextDecoder 两边都有。
function b64urlDecode(s: string): string {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 常数时间比较。签名比对不能用 `===` —— 它会因为「第几位不同」而提前返回 */
function sameSig(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 验 state 的签名并取出 chatId / openId。
 *
 * 签名密钥就是 `EO_INTERNAL_TOKEN` —— 和 EdgeOne 侧签它用的是同一个值
 * （那边的 `INTERNAL_TOKEN`）。共用省掉一次密钥分发，而它本来就是这个
 * 转发通道的信任根。
 *
 * ⚠️ EdgeOne 那边**会再验一遍**。这里验是为了早失败（给用户一个看得懂的结果页，
 * 而不是把垃圾转发过去换回一个 400），不是唯一防线。
 */
function verifyState(raw: string, secret: string): { chatId: string; openId: string } | null {
  if (!secret) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;

  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  // digest("base64url") 不带填充，和 EdgeOne 侧 btoa 后剥掉 `=` 的写法一致
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!sameSig(sig, expected)) return null;

  try {
    const s = JSON.parse(b64urlDecode(payload)) as { chatId?: string; openId?: string };
    if (!s?.chatId || !s?.openId) return null;
    return { chatId: String(s.chatId), openId: String(s.openId) };
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 极简结果页。用户看完就关，不值得做成卡片 */
function oauthHtml(title: string, detail: string, status = 200): Response {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.7 -apple-system,system-ui,"PingFang SC",sans-serif;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2329}
main{background:#fff;padding:32px 28px;border-radius:12px;max-width:440px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 12px}p{margin:0;color:#646a73;word-break:break-all}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(detail)}</p></main>
<script>if(location.search)history.replaceState(null,"",location.pathname);</script>
</body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleOAuthCallback(req: Request, env: EdgeOneRelayEnv): Promise<Response> {
  if (req.method !== "GET") return oauthHtml("方法不支持", "这个地址只接受浏览器跳转。", 405);

  const url = new URL(req.url);
  const stateRaw = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";

  const st = verifyState(stateRaw, env.EO_INTERNAL_TOKEN as string);
  if (!st) {
    return oauthHtml("授权链接无效", "链接可能已过期。请回飞书重新发一次 /login。", 400);
  }

  // 用户在授权页点了「拒绝」：飞书带 error 回来，不带 code。
  // 这是用户的正常选择，不是故障，别报成失败
  if (!code) {
    return oauthHtml("已取消授权", "没有授予任何权限。需要时回飞书再发一次 /login。");
  }

  let res: Response;
  try {
    res = await fetch(env.EO_AGENT_URL as string, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Makers-Conversation-Id": conversationIdFor(st.chatId),
      },
      body: JSON.stringify({
        op: "oauth",
        chatId: st.chatId,
        openId: st.openId,
        code,
        // 原样带上：EdgeOne 那边要自己验一遍签名（这里验过不等于那边可以跳过）
        state: stateRaw,
        token: env.EO_INTERNAL_TOKEN,
      }),
      // 换令牌 + 回飞书一条消息，给宽一点。浏览器在等，不设重试
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return oauthHtml("没能连上后台", `转发失败：${(e as Error).message}`, 502);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return oauthHtml("授权没成功", `后台返回 HTTP ${res.status}。${body.slice(0, 200)}`, 502);
  }

  return oauthHtml("授权成功", "可以关掉这个页面，回飞书继续了。");
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
