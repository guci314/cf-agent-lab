// 手写 base64 双向编解码。
//
// 为什么不用现成的：`btoa`/`atob` 走 Latin-1 字符串，二进制要先转码一轮，
// 大文件上既多一份拷贝又容易踩范围错误；`Uint8Array.toBase64()` 这个提案的
// 可用性取决于运行时版本，而这里的代码要在 workerd 和 node 两边都能直接跑
// （zip 的自测就是拿 node 跑的）。所以自己写，行为完全可控。

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) {
    t[B64_CHARS.charCodeAt(i)] = i;
  }
  return t;
})();

export function toBase64(bytes: Uint8Array): string {
  const n = bytes.length;
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    buf += B64_CHARS[b0 >> 2];
    buf += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    buf += i + 1 < n ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    buf += i + 2 < n ? B64_CHARS[b2 & 63] : "=";
    // 分块拼接：一次性 += 到几 MB 会在部分引擎上退化成 O(n²)
    if (buf.length >= 8192) {
      parts.push(buf);
      buf = "";
    }
  }
  if (buf) parts.push(buf);
  return parts.join("");
}

export function fromBase64(s: string): Uint8Array {
  // 先过滤：跳过空白与被截断的 '=' 之后的内容，非字母表字符一律丢弃。
  // 这样换行折行的 base64 也能吃进来。
  const vals = new Uint8Array(s.length);
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break; // '='
    if (c > 127) continue;
    const v = B64_LOOKUP[c];
    if (v < 0) continue; // 空白等
    vals[len++] = v;
  }

  const out = new Uint8Array((len * 3) >> 2);
  let p = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 6) | vals[i];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1; // 防止 acc 无界增长
    }
  }
  return out;
}

/** base64 → 字符串。fatal:false，非法字节退化成 U+FFFD 而不是抛错 */
export function base64ToText(s: string): string {
  return new TextDecoder().decode(fromBase64(s));
}

export function textToBase64(s: string): string {
  return toBase64(new TextEncoder().encode(s));
}
