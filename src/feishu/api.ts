// 飞书开放平台的调用：取 tenant_access_token、发文本消息。
//
// 这个文件不 import 任何 Cloudflare 的东西 —— token 缓存通过 `TokenCache`
// 接口注入（Durable Object 那边用 `this.ctx.storage` 实现），
// 这样纯逻辑可以脱离 workerd 测。

// 国内版。飞书国际版（Lark）是 https://open.larksuite.com/open-apis ——
// 换版只需改这一个常量
const DEFAULT_BASE = "https://open.feishu.cn/open-apis";

/** token 缓存。DO 侧用 storage 实现 */
export interface TokenCache {
  get(): Promise<{ token: string; exp: number } | null>;
  set(v: { token: string; exp: number }): Promise<void>;
}

export interface FeishuEnv {
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  /**
   * 覆盖 API 根地址。**只为本地测试**：飞书应用还没建好之前，整条回复链路
   * （取 token → 发消息 → 重试）没法验证，指向一个本地 mock 就能全跑通。生产不要设。
   */
  FEISHU_API_BASE?: string;
}

const base = (env: FeishuEnv) =>
  (env.FEISHU_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");

/** 提前 60 秒判过期，避免「取出来刚好在这一刻失效」 */
const TOKEN_SAFETY_MS = 60_000;

/** 文本消息长度上限。飞书没有公开的精确数字，这里取个保守值 —— 超长直接截断，
 *  总比整条消息发失败、用户什么都收不到好 */
const MAX_TEXT_CHARS = 4000;

interface FeishuResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
  data?: { message_id?: string };
}

class FeishuError extends Error {
  code: number;
  constructor(code: number, msg: string) {
    super(`飞书 API 错误 ${code}：${msg}`);
    this.code = code;
  }
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<FeishuResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  // 飞书即使出错也回 200 + 业务错误码，所以不能只看 res.ok
  const text = await res.text();
  let json: FeishuResponse;
  try {
    json = JSON.parse(text) as FeishuResponse;
  } catch {
    throw new Error(`飞书返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (json.code !== 0) {
    throw new FeishuError(json.code ?? -1, json.msg ?? `HTTP ${res.status}`);
  }
  return json;
}

/**
 * 带鉴权的通用调用。卡片相关的一堆接口（创建卡片、推文本、改配置）都是同一个
 * 权限、同一个 token，没必要每个都写一遍取 token + 取 base 的样板。
 *
 * `path` 从 `/open-apis` 之后开始写，比如 `/cardkit/v1/cards`。
 */
export async function feishuCall(
  env: FeishuEnv,
  cache: TokenCache,
  method: string,
  path: string,
  body?: unknown,
): Promise<FeishuResponse> {
  const send = async (token: string) => {
    const res = await fetch(`${base(env)}${path}`, {
      method,
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: FeishuResponse;
    try {
      json = JSON.parse(text) as FeishuResponse;
    } catch {
      throw new Error(`飞书返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (json.code !== 0) throw new FeishuError(json.code ?? -1, json.msg ?? `HTTP ${res.status}`);
    return json;
  };

  try {
    return await send(await tenantAccessToken(env, cache));
  } catch (e) {
    if (e instanceof FeishuError && e.code === 99991663) {
      return send(await tenantAccessToken(env, cache, true));
    }
    throw e;
  }
}

export async function tenantAccessToken(
  env: FeishuEnv,
  cache: TokenCache,
  forceRefresh = false,
): Promise<string> {
  if (!forceRefresh) {
    const hit = await cache.get();
    if (hit && hit.exp > Date.now() + TOKEN_SAFETY_MS) return hit.token;
  }

  const json = await post(`${base(env)}/auth/v3/tenant_access_token/internal`, {}, {
    app_id: env.FEISHU_APP_ID,
    app_secret: env.FEISHU_APP_SECRET,
  });

  const token = json.tenant_access_token;
  if (!token) throw new Error("飞书没有返回 tenant_access_token");

  // expire 单位是秒（通常 7200）
  const ttl = Number(json.expire ?? 7200) * 1000;
  await cache.set({ token, exp: Date.now() + ttl });
  return token;
}

/**
 * 往会话里发一条纯文本消息。
 *
 * `content` 必须是**序列化后的字符串**而不是对象（飞书的约定），
 * 传对象进去会得到 `code: 10002 invalid param`。
 */
export async function sendText(
  env: FeishuEnv,
  cache: TokenCache,
  receiveId: string,
  text: string,
  receiveIdType: "chat_id" | "open_id" = "chat_id",
): Promise<void> {
  const clipped =
    text.length > MAX_TEXT_CHARS
      ? text.slice(0, MAX_TEXT_CHARS) + "\n\n…（回答太长，已截断）"
      : text;

  const body = {
    receive_id: receiveId,
    msg_type: "text",
    content: JSON.stringify({ text: clipped }),
  };

  const send = async (token: string) =>
    post(
      `${base(env)}/im/v1/messages?receive_id_type=${receiveIdType}`,
      { authorization: `Bearer ${token}` },
      body,
    );

  try {
    await send(await tenantAccessToken(env, cache));
  } catch (e) {
    // 99991663 = tenant_access_token 无效/过期。缓存里的 token 可能是被别人
    // 吊销的（比如后台重置了 App Secret），这时候局部重试一次比让用户重发强
    if (e instanceof FeishuError && e.code === 99991663) {
      await send(await tenantAccessToken(env, cache, true));
      return;
    }
    throw e;
  }
}
