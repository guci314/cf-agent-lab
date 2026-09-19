// 流式 tar 解析。共用模块（零 import）。
//
// 为什么流式而不是先解到内存：一个 40MB 的 tarball 里可能有 20MB 是 vendored bundle。
// 会丢的文件**绝不进内存** —— 只做 drop（推进游标，不拷贝）。这是这套东西能在
// 浏览器里廉价跑起来的前提，也是将来万一要挪回服务端时唯一要注意的点。

const BLOCK = 512;

export type TarEntry =
  | { path: string; type: "dir" }
  | { path: string; type: "file"; bytes: Uint8Array };

export type SkipReason = "size" | "type" | "excluded";

export interface ParseTarOptions {
  signal?: AbortSignal;
  /** 超过这个字节数的文件直接跳过（不读进内存） */
  maxFileBytes?: number;
  /** 返回 false 则跳过该文件（不读进内存） */
  include?: (path: string, size: number) => boolean;
  onSkip?: (path: string, reason: SkipReason) => void;
}

const decoder = new TextDecoder();

/**
 * 带游标的字节缓冲。`drop` 是这里的关键：丢弃 n 字节而不物化。
 */
class ByteReader {
  // 不用 TS 的构造函数参数属性（`constructor(private x)`）—— 那需要代码生成，
  // Node 的 strip-only 模式会直接报错，这些纯模块就用不了 `node xxx.ts` 直跑了
  chunks: Uint8Array[] = [];
  len = 0;
  done = false;
  reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  /** 保证缓冲区至少 n 字节；返回实际可提供的字节数（< n 表示流已结束） */
  async need(n: number): Promise<number> {
    while (this.len < n && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      if (value && value.length) {
        this.chunks.push(value);
        this.len += value.length;
      }
    }
    return this.len;
  }

  /** 消费恰好 n 字节并拷贝出来；不足 n 返回 null */
  take(n: number): Uint8Array | null {
    if (this.len < n) return null;
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const want = n - off;
      if (head.length <= want) {
        out.set(head, off);
        off += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, want), off);
        this.chunks[0] = head.subarray(want);
        off += want;
      }
    }
    this.len -= n;
    return out;
  }

  /** 消费 n 字节但不拷贝 —— 跳过超大文件时用它 */
  async drop(n: number): Promise<number> {
    let left = n;
    while (left > 0) {
      if (this.len === 0) {
        const got = await this.need(Math.min(left, 1 << 16));
        if (got === 0) break;
      }
      const head = this.chunks[0];
      if (!head) break;
      const want = Math.min(head.length, left);
      if (want === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(want);
      this.len -= want;
      left -= want;
    }
    return n - left;
  }
}

function isZeroBlock(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/** 读 NUL 结尾的定长字段 */
function readString(b: Uint8Array, off: number, len: number): string {
  const max = off + len;
  let end = off;
  while (end < max && b[end] !== 0) end++;
  return end === off ? "" : decoder.decode(b.subarray(off, end));
}

/** 八进制数值字段（size 等） */
function readOctal(b: Uint8Array, off: number, len: number): number {
  const s = readString(b, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readData(
  r: ByteReader,
  size: number,
  padded: number,
): Promise<Uint8Array | null> {
  if ((await r.need(size)) < size) return null;
  const data = r.take(size)!;
  const pad = padded - size;
  if (pad > 0 && (await r.drop(pad)) < pad) return null;
  return data;
}

/**
 * 流式解出 tar 条目。
 *
 * 目录条目也会产出（调用方据此建目录索引，不必再自己推父目录）。
 * 链接/设备文件/pax 头一律跳过；GNU 长名字（`L`）会被接上。
 */
export async function* parseTar(
  source: ReadableStream<Uint8Array>,
  opts: ParseTarOptions = {},
): AsyncGenerator<TarEntry> {
  const reader = source.getReader();
  const r = new ByteReader(reader);
  const maxFileBytes = opts.maxFileBytes ?? Number.POSITIVE_INFINITY;

  let longName: string | null = null;

  try {
    for (;;) {
      if (opts.signal?.aborted) return;

      if ((await r.need(BLOCK)) < BLOCK) return;

      const header = r.take(BLOCK)!;
      // 连续两个全零块表示归档结束；遇到第一个就收工
      if (isZeroBlock(header)) return;

      const rawName = readString(header, 0, 100);
      const prefix = readString(header, 345, 155);
      const size = readOctal(header, 124, 12);
      const typeflag = String.fromCharCode(header[156]);

      const fullName =
        longName ?? (prefix ? prefix + "/" + rawName : rawName);
      longName = null;

      const padded = Math.ceil(size / BLOCK) * BLOCK;

      // GNU 长名字：这一块的"数据"就是真名字本身，不产出条目
      if (typeflag === "L") {
        const data = await readData(r, size, padded);
        if (!data) return;
        longName = decoder.decode(data).replace(/\0+$/, "");
        continue;
      }

      // pax 扩展头：codeload 会发一个 typeflag 'g' 的 pax_global_header，
      // 漏掉它就会把它的数据块当成下一个 header，整条流从此错位
      if (typeflag === "x" || typeflag === "g") {
        if ((await r.drop(padded)) < padded) return;
        continue;
      }

      if (typeflag === "5") {
        if ((await r.drop(padded)) < padded) return;
        const p = fullName.replace(/\/+$/, "");
        if (p) yield { path: p, type: "dir" };
        continue;
      }

      const isFile = typeflag === "0" || typeflag === "\0" || typeflag === "";
      if (!isFile) {
        if ((await r.drop(padded)) < padded) return;
        opts.onSkip?.(fullName, "type");
        continue;
      }

      // 会丢的文件只 drop，不读进内存
      if (size > maxFileBytes) {
        if ((await r.drop(padded)) < padded) return;
        opts.onSkip?.(fullName, "size");
        continue;
      }
      if (opts.include && !opts.include(fullName, size)) {
        if ((await r.drop(padded)) < padded) return;
        opts.onSkip?.(fullName, "excluded");
        continue;
      }

      const data = await readData(r, size, padded);
      if (!data) return;
      yield { path: fullName, type: "file", bytes: data };
    }
  } finally {
    reader.releaseLock();
  }
}
