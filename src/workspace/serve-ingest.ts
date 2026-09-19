// 服务端导入：飞书的 `/repo owner/name` 走这条路。
//
// 和浏览器版（ingest.ts）的关系：**解码管线完全共用**（decode / tar / filter 都是
// 零依赖、双运行时写的），差别只在两端的驱动方式 —— 浏览器版把批次 POST 回来，
// 这里直接调 `repo.ingestBatch`。所以这个文件取代的是 ingest.ts 里那层 HTTP，
// 不是取代解码。
//
// 为什么现在敢放在服务端跑：DO 的 CPU 是**秒级**不是 10ms（实测 2 亿次浮点迭代通过）。
// 但仍然是 O(语料) 的纯 JS 工作，所以三道语料上限（见 types.ts）在这里同样是硬闸。

import type { WorkspaceRepo } from "./repo.ts";
import { toTarEntries } from "./decode.ts";
import {
  looksBinary,
  looksMinified,
  skipReason,
  stripTopLevel,
  utf8Len,
} from "./filter.ts";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type IngestFile,
} from "./types.ts";
import {
  OWNER_RE,
  REF_RE,
  TARBALL_MAX_BYTES,
  UA,
  codeloadUrl,
} from "./github.ts";

/** 攒到这个字节数就落一次库。256KB ≈ 一次 SQL 批量插入，内存占用有界 */
const FLUSH_BYTES = 256 * 1024;

// 扫描守卫。语料上限管的是「存进去多少」，但**走 tar 头的成本是条目数决定的**，
// 跟存不存无关：TypeScript 那种仓库有 6.7 万个条目。被 skip 掉的文件不读进内存，
// 但每一个都还要走一遍 512 字节头、而且它前面的字节仍要从网络收下来。
// 所以条目数和墙钟各自需要一个硬上限。
const MAX_SCAN_ENTRIES = 60_000;
const MAX_WALL_MS = 90_000;

const decoder = new TextDecoder();

/** 为什么语料是部分的。undefined = 完整。 */
export type TruncationReason = "corpus" | "entries" | "time";

export interface ServeIngestResult {
  fileCount: number;
  totalBytes: number;
  skipped: number;
  /** 语料是部分的 —— 调用方**必须**把这件事告诉用户 */
  capped: boolean;
  truncatedBy?: TruncationReason;
}

/**
 * 抓取并入库。失败时抛错（调用方负责把它变成给用户看的一句话）。
 *
 * 出错**不让已有语料失效** —— `repo.failIngest` 会在上一份快照还可用时把状态
 * 退回 ready，工具照常工作（这是 repo.ts 里已经处理好的）。
 */
export async function serveIngest(
  repo: WorkspaceRepo,
  owner: string,
  name: string,
  ref: string,
  /** 只给测试用：把墙钟上限压到很小，好验证「掐断后必须标记成部分语料」 */
  opts: { maxWallMs?: number } = {},
): Promise<ServeIngestResult> {
  if (!OWNER_RE.test(owner) || !OWNER_RE.test(name)) {
    throw new Error("owner / name 含非法字符");
  }
  if (!REF_RE.test(ref)) throw new Error("分支名含非法字符");

  let upstream: Response;
  try {
    upstream = await fetch(codeloadUrl(owner, name, ref), {
      headers: { "user-agent": UA },
      redirect: "follow",
    });
  } catch (e) {
    throw new Error(`连接 GitHub 失败：${(e as Error).message}`);
  }

  if (!upstream.ok) {
    throw new Error(
      `GitHub 返回 HTTP ${upstream.status} —— 仓库或分支可能不存在，或者是私有仓库`,
    );
  }
  if (!upstream.body) throw new Error("上游没有返回内容");

  const declared = Number(upstream.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > TARBALL_MAX_BYTES) {
    throw new Error(
      `仓库压缩包 ${Math.round(declared / 1048576)}MB，超过 50MB 上限`,
    );
  }

  const ingestId = crypto.randomUUID();
  repo.beginIngest(owner, name, ref, ingestId);

  // 撞上限就 abort —— 顺带掐掉还在下载的网络流，别白下几百 MB。
  //
  // ⚠️ 不用 `AbortSignal.any([...])`：workerd 上的可用性没实测过，而这里只需要
  // 「超时或撞上限，任一发生就掐」，一个 controller 加一个定时器就够了。
  const ac = new AbortController();

  // ⚠️ 中止之后**必须**记下是谁掐的。踩过：定时器到点在 90 秒掐断了流，
  // 循环静静地结束，于是 finishIngest 照常执行，用户收到「已入库 472 个文件」
  // ——一份被腰斩的语料被当成完整快照交付，而 capped 还是 false，没有任何信号。
  // 「截断了」和「完整」必须能从返回值上区分开。
  let truncatedBy: TruncationReason | null = null;
  const stop = (reason: TruncationReason) => {
    if (!truncatedBy) truncatedBy = reason;
    ac.abort();
  };
  const deadline = setTimeout(() => stop("time"), opts.maxWallMs ?? MAX_WALL_MS);

  let scanned = 0;
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let batch: IngestFile[] = [];
  let batchBytes = 0;

  const flush = () => {
    if (batch.length === 0) return;
    repo.ingestBatch(ingestId, batch);
    batch = [];
    batchBytes = 0;
  };

  try {
    const entries = toTarEntries(upstream.body, {
      signal: ac.signal,
      maxFileBytes: MAX_FILE_BYTES,
      include: (path) => {
        const rel = stripTopLevel(path);
        if (!rel) return false; // codeload 的顶层目录本身
        return skipReason(rel, 1) === null;
      },
      onSkip: () => {
        skipped++;
      },
    });

    try {
      for await (const entry of entries) {
        if (++scanned > MAX_SCAN_ENTRIES) {
          stop("entries");
          break;
        }
        if (entry.type === "dir") continue;

        const rel = stripTopLevel(entry.path);
        if (!rel) continue;

        // 二进制必须在 UTF-8 解码**之前**判：先解码既毁内容又白费一次编码
        if (looksBinary(entry.bytes)) {
          skipped++;
          continue;
        }

        const text = decoder.decode(entry.bytes);
        if (looksMinified(text)) {
          skipped++;
          continue;
        }

        if (
          files + batch.length >= MAX_FILES ||
          bytes + batchBytes >= MAX_TOTAL_BYTES
        ) {
          stop("corpus");
          break;
        }

        batch.push({ path: rel, content: text });
        batchBytes += utf8Len(text);

        if (batchBytes >= FLUSH_BYTES) {
          files += batch.length;
          bytes += batchBytes;
          flush();
        }
      }
    } catch (e) {
      // 我们自己掐的流会让 reader 抛 AbortError —— 那是**预期收尾**，不是失败。
      // 只有不是我们掐的错误才该把整次导入判死。
      if (!truncatedBy) throw e;
    }

    files += batch.length;
    bytes += batchBytes;
    flush();

    const totals = repo.finishIngest(ingestId, skipped, truncatedBy !== null);
    return {
      ...totals,
      skipped,
      capped: truncatedBy !== null,
      ...(truncatedBy ? { truncatedBy } : {}),
    };
  } catch (e) {
    // 别让 DO 卡在 ingesting：失败不致命，active_generation 仍指向上一份完整快照
    repo.failIngest(ingestId, (e as Error).message);
    throw e;
  } finally {
    clearTimeout(deadline);
  }
}
