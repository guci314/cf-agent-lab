// 解压 + 去 tar 的一层薄封装。共用模块（零 import）。
//
// 这段代码在浏览器和 workerd 里都能跑 —— workerd 同样有 DecompressionStream。
// 所以「在哪边解码」是 **CPU 归属** 的选择，不是能力选择：
// 现在选浏览器，因为那边 CPU 免费。将来若要挪回服务端，只要换个调用方，
// 这个文件和 tar.ts 一行都不用改。

// 显式写 .ts —— Vite / esbuild（wrangler）都能解析，同时让这些纯模块可以用
// `node xxx.ts` 直接跑（Node 22+ 原生剥类型），验证时不必先起构建
import { parseTar, type ParseTarOptions, type TarEntry } from "./tar.ts";

/** 包一层 `DecompressionStream("gzip")` */
export function gunzip(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return source.pipeThrough(new DecompressionStream("gzip"));
}

/** gzip 魔数 `1f 8b` */
export function hasGzipMagic(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * 从流里先取 n 字节，返回 [head 恰好 n 字节, 其余全部]。
 *
 * ⚠️ 关键点：第一次 read() 往往一次就吐回整块（甚至整个文件），所以
 * **不能**把读到的全部当 head —— 那会把魔数之后的字节整个丢掉。
 * 必须按 n 切开，把多余的部分接回 `rest` 的前面。
 * 丢掉它的话，gzip 会因为数据不全报 "unexpected end of file (Z_BUF_ERROR)"，
 * 看着像压缩流损坏，实为这里吞了字节。
 */
async function peek(
  source: ReadableStream<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = source.getReader();
  const parts: Uint8Array[] = [];
  let len = 0;

  while (len < n) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      parts.push(value);
      len += value.length;
    }
  }

  const buf = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }

  const cut = Math.min(n, len);
  const head = buf.subarray(0, cut);
  const leftover = buf.subarray(cut);

  const tail = new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(({ done, value }) => {
        if (done) controller.close();
        else controller.enqueue(value);
      });
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return { head, rest: leftover.length ? prepend(leftover, tail) : tail };
}

function prepend(
  head: Uint8Array,
  rest: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  // reader 只能取一次 —— 放进 pull 里每次取会在第二次抛 "stream is locked"
  const reader = rest.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
    },
    pull(controller) {
      return reader.read().then(({ done, value }) => {
        if (done) controller.close();
        else controller.enqueue(value);
      });
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * tarball 字节流 → tar 条目流。
 *
 * 先探魔数：codeload 发的是 `Content-Type: application/x-gzip` 且**不带**
 * Content-Encoding，所以 workerd 不会透明解压；但万一将来中间换了代理、
 * 真的带上 Content-Encoding，fetch 会替我们解压好，那时流里已经是裸 tar。
 * 探一下魔数，两种情况都能跑，而不是直接报错。
 */
export async function* toTarEntries(
  source: ReadableStream<Uint8Array>,
  opts: ParseTarOptions = {},
): AsyncGenerator<TarEntry> {
  const { head, rest } = await peek(source, 2);
  // 接回完整流再交给 gunzip —— 魔数 `1f 8b` 本身也是 gzip 头的一部分，
  // 只把 rest 喂进去会得到 "incorrect header check (Z_DATA_ERROR)"
  const whole = prepend(head, rest);
  const body = hasGzipMagic(head) ? gunzip(whole) : whole;
  yield* parseTar(body, opts);
}
