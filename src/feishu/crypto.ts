// 飞书事件的验签与解密。零依赖（只用 WebCrypto / atob / TextDecoder），
// 所以可以用 `node --experimental-strip-types` 直接跑测试。
//
// 两个必须记住的点：
//
// ① **验签用的是未经解析的原始 body**。飞书文档明写「不要在反序列化后再计算」。
//    所以调用方必须先 `await req.text()` 拿到字符串，再拿这个字符串去算签名，
//    最后才 `JSON.parse`。顺序反了签名永远对不上。
//
// ② **WebCrypto 的 AES-CBC 已经按规范做了 PKCS#7 去填充**，解出来就是明文本身，
//    不要再去剥一遍。
//
//    ⚠️ 这一条我一开始判断反了。我看飞书官方的 Go/Java 示例都在靠扫第一个 `{`
//    和最后一个 `}` 来裁掉尾部，就推断 WebCrypto 也不去填充，还写了段
//    stripPkcs7 去「补上这一步」。结果拿官方的测试向量一跑就炸：
//    `P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=` + key `test key`
//    解出来是 11 字节的 `hello world` —— 11 不是 16 的倍数，说明填充**早就没了**。
//
//    教训：示例代码怎么写，说明的是**那个库**的行为，不是规范的行为。
//    W3C WebCrypto 规范里 AES-CBC 的 decrypt 明确规定要校验并去除填充，
//    Node 和 workerd 都照做了。要判断这个，看规范或者跑一下，别从邻居推。

/** 常数时间比较，别用 `===`（会在首个不同字符处提前返回） */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * `X-Lark-Signature` == sha256_hex(timestamp + nonce + encrypt_key + rawBody)
 *
 * 只有在飞书侧配了 Encrypt Key 才有这个头 —— 也就是说**没有 Encrypt Key 就没有
 * 任何请求来源证明**，只靠明文比对 Verification Token，谁都能伪造。
 * 所以生产上应该强制配 Encrypt Key（路由层会检查）。
 */
export async function verifySignature(
  rawBody: string,
  timestamp: string,
  nonce: string,
  encryptKey: string,
  signature: string,
): Promise<boolean> {
  if (!timestamp || !nonce || !signature) return false;
  const data = new TextEncoder().encode(timestamp + nonce + encryptKey + rawBody);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return safeEqual(toHex(digest), signature.toLowerCase());
}

/**
 * 解开 `{"encrypt": "..."}` 里的密文，返回解密后的 JSON 字符串。
 *
 * 密钥是 `SHA-256(encrypt_key)` 的**原始 32 字节**（不是 hex 字符串再编码），
 * IV 是密文 base64 解码后的**前 16 字节**，其余才是真正的密文。
 */
export async function decryptEvent(
  encrypted: string,
  encryptKey: string,
): Promise<string> {
  let buf: Uint8Array;
  try {
    buf = fromBase64(encrypted);
  } catch {
    throw new Error("密文不是合法 base64");
  }

  if (buf.length <= 16 || (buf.length - 16) % 16 !== 0) {
    throw new Error(`密文长度不合法：${buf.length}`);
  }

  const keyBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(encryptKey),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );

  const iv = buf.subarray(0, 16);
  // ⚠️ subtle.decrypt 的入参要 ArrayBuffer/BufferSource；subarray 是视图，直接传是 OK 的，
  // 但加密库对「恰好整块」的输入有时会多加一层校验，所以这里显式拷一份干净的
  const cipher = buf.slice(16);

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, cipher);
  } catch (e) {
    throw new Error(`AES 解密失败：${(e as Error).message}`);
  }

  // 解密即明文：填充已由 subtle.decrypt 按规范处理掉了（见文件头 ②）
  const bytes = new Uint8Array(plain);
  if (bytes.length === 0) throw new Error("解密结果为空");

  // fatal:true —— 解出来不是合法 UTF-8 说明密文/密钥不对，宁可硬失败也别把乱码塞给下游
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
