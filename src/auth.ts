// 访问密码门。
//
// ⚠️ 门在**服务端**，不是前端。前端藏密码（JS 里比一下、对了才渲染）是安全剧场：
// 密码随 bundle 发给每个人，读一眼 JS、或者干脆直接打 /api 和 /agents 就绕过去了 ——
// 那样连"防止陌生人蹭我的模型额度"这个最低目标都达不到。
// 所以这里在 Worker 入口拦掉**所有**请求，没过门的连 JS 资源都拿不到。

const COOKIE_NAME = "cf_lab_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

// 换这个字符串等于让所有已发的 cookie 失效
const TOKEN_MESSAGE = "cf-agent-lab:v1";

/** 常数时间比较，别用 `===` —— 字符串比较会在首个不同字符处提前返回，泄漏前缀 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** cookie 里放的是 HMAC(密码, 常量)，所以验证不需要任何存储 —— 重算一遍比一下即可 */
async function cookieToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(TOKEN_MESSAGE));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** 登录时比对用户输入的密码 */
export function passwordMatches(supplied: string, password: string): boolean {
  return safeEqual(supplied, password);
}

export async function hasValidCookie(
  req: Request,
  password: string,
): Promise<boolean> {
  const got = readCookie(req, COOKIE_NAME);
  if (!got) return false;
  return safeEqual(got, await cookieToken(password));
}

export async function authCookieHeader(
  password: string,
  secure: boolean,
): Promise<string> {
  const token = await cookieToken(password);
  // 本地跑 http 时不能带 Secure，否则浏览器根本不存这个 cookie
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookieHeader(secure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

// 自包含：不引任何外部 JS/CSS —— 否则这些资源本身就得放在门外面，
// 而"门外面能拿到什么"越小越好。
// 令牌是从 styles.css 手抄的一份（同一个色板），改那边记得同步这里。
const PAGE_CSS = `
  :root{color-scheme:light;
    --paper:#eef0f4;--sheet:#fff;--ink:#14171c;--ink-soft:#5b6472;
    --rule:#dadfe6;--pen:#1b3aa6;--danger:#a32318;
    --ctl:3px;--sheet-r:10px}
  @media (prefers-color-scheme:dark){:root{color-scheme:dark;
    --paper:#0e1014;--sheet:#161920;--ink:#e7e9ed;--ink-soft:#949caa;
    --rule:#262b33;--pen:#8fa8ff;--danger:#f08a80}}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;height:100dvh;
    display:flex;align-items:center;justify-content:center;
    padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom));
    background:var(--paper);color:var(--ink);
    font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  form{background:var(--sheet);border:1px solid var(--rule);border-radius:var(--sheet-r);
    padding:24px 20px;display:flex;flex-direction:column;gap:12px;width:min(340px,100%)}
  h1{font-size:18px;margin:0;font-weight:650;letter-spacing:-.01em}
  .lede{margin:0;font-size:13px;color:var(--ink-soft)}
  .err{margin:0;font-size:13px;color:var(--danger);font-weight:600}
  /* font-size 必须 >=16px，否则 iOS 聚焦这个框时会自动放大整页且不缩回去 */
  input{font:inherit;font-size:16px;padding:12px 13px;width:100%;
    border:1px solid var(--rule);border-radius:var(--ctl);
    background:var(--paper);color:inherit;letter-spacing:.18em}
  button{font:inherit;font-size:16px;font-weight:600;padding:13px 18px;border:0;
    border-radius:var(--ctl);background:var(--pen);color:#fff;cursor:pointer}
  /* 暗色下 pen 是被提亮的，配白字对比度不够，实心底要压回去 */
  @media (prefers-color-scheme:dark){button{background:#2543b8}}
  :focus-visible{outline:2px solid var(--pen);outline-offset:2px}
  input:focus-visible{outline-offset:-1px}
`;

export function loginPage(error?: string): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>需要密码 · 通用助手</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<form method="POST" action="/login">
  <h1>通用助手</h1>
  <p class="lede">这个页面需要访问密码。</p>
  ${error ? `<p class="err" role="alert">${error}</p>` : ""}
  <input type="password" name="password" inputmode="numeric" autocomplete="current-password"
         aria-label="访问密码" placeholder="访问密码" autofocus required/>
  <button type="submit">进入</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
