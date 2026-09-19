// 导入流程的客户端侧：抓 tarball → 解压 → 解 tar → 过滤 → 分批 POST。
//
// 这个文件存在的理由就是 **CPU 归属**：这一路全是 O(语料) 的纯 JS 工作，
// 放进 Worker 会撞上 CPU 上限，放在浏览器里是免费的。
//
// 成本拆开看（实测）：gunzip 其实不贵 —— DO 里解 5MB 只要 3ms。
// 真正的大头是**文本量**：解一个 26MB 的 TypeScript tarball（67,373 个条目、
// 137MB 文本）在 Node 里 0.79s，时间几乎都花在走 tar 头、UTF-8 解码和逐行计数上。
// 所以「挪到浏览器」省下的是处理 137MB 文本的代价，不是解压的代价 —— 别把理由记错。

import {
  INITIAL_BATCH_BYTES,
  MAX_BATCH_BYTES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MIN_BATCH_BYTES,
  type IngestBatchResult,
  type IngestFile,
} from "./types.ts";
import { toTarEntries } from "./decode.ts";
import {
  looksBinary,
  looksMinified,
  skipReason,
  stripTopLevel,
  utf8Len,
} from "./filter.ts";

export type IngestPhase = "fetch" | "decode" | "upload" | "done" | "error";

export interface IngestProgress {
  phase: IngestPhase;
  files: number;
  bytes: number;
  skipped: number;
  current: string;
  /**
   * 上一批 **DO 自报**的处理耗时（服务端 CPU 侧的信号，自适应攒批就看它）。
   * 本机 wrangler tail 抓不到日志，页面上的这个读数就是唯一的 profiler。
   */
  msPerBatch: number;
  /** 上一批的端到端往返时间，含网络 —— 只用于显示，不参与攒批决策 */
  wallMs: number;
  batchBytes: number;
  capped: boolean;
  error?: string;
}

export interface IngestResult {
  files: number;
  bytes: number;
  skipped: number;
  capped: boolean;
}

const decoder = new TextDecoder();

async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 把一批文件 POST 给 DO。失败时逐次减半重试 —— 批次太大被 CPU 杀掉是
 * 最可能的首败原因，减半通常立刻就过。
 */
async function sendBatch(
  base: string,
  instance: string,
  ingestId: string,
  files: IngestFile[],
  onRetry: () => void,
): Promise<IngestBatchResult> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await postJson(base, "/api/workspace/ingest", { instance, ingestId, files });
    } catch (e) {
      lastErr = (e as Error).message;
      onRetry();
      continue;
    }

    if (res.ok) return (await res.json()) as IngestBatchResult;

    // 把原始响应体带出来：1102（CPU 超限）之类只能从这里看出来，
    // 本机 wrangler tail 抓不到日志，这个字符串就是我们唯一的现场
    const text = (await res.text()).slice(0, 300);
    lastErr = `HTTP ${res.status}：${text}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    onRetry();
  }
  throw new Error(`写入批次失败：${lastErr}`);
}

export async function ingestRepo(args: {
  instance: string;
  owner: string;
  name: string;
  ref: string;
  signal?: AbortSignal;
  /** 浏览器里留空（同源相对路径）；从 Node 里跑测试时传绝对地址 */
  baseUrl?: string;
  onProgress: (p: IngestProgress) => void;
}): Promise<IngestResult> {
  const { instance, owner, name, ref, onProgress } = args;
  const base = args.baseUrl ?? "";

  const progress: IngestProgress = {
    phase: "fetch",
    files: 0,
    bytes: 0,
    skipped: 0,
    current: "",
    msPerBatch: 0,
    wallMs: 0,
    batchBytes: INITIAL_BATCH_BYTES,
    capped: false,
  };
  const report = () => onProgress({ ...progress });

  // begin
  const beginRes = await postJson(base, "/api/workspace/begin", {
    instance,
    owner,
    name,
    ref,
  });
  if (!beginRes.ok) {
    throw new Error(`开始导入失败：${(await beginRes.text()).slice(0, 300)}`);
  }
  const { ingestId } = (await beginRes.json()) as { ingestId: string };

  // 语料上限撞到了就 abort —— 顺带把还在下载的网络流也掐掉，
  // 否则会白下几百 MB（TypeScript 那种仓库压缩包就有 26MB）
  const ac = new AbortController();
  const abortIfOuterCancelled = () => ac.abort();
  args.signal?.addEventListener("abort", abortIfOuterCancelled);

  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let capped = false;
  let batch: IngestFile[] = [];
  let batchBytes = 0;
  let slowFastBatches = 0;

  try {
    progress.phase = "fetch";
    report();

    const url = `/api/workspace/tarball?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}&ref=${encodeURIComponent(ref)}`;
    const tarRes = await fetch(base + url, { signal: ac.signal });
    if (!tarRes.ok || !tarRes.body) {
      throw new Error(
        `拉取仓库失败：${(await tarRes.text()).slice(0, 300) || `HTTP ${tarRes.status}`}`,
      );
    }

    progress.phase = "decode";
    report();

    const entries = toTarEntries(tarRes.body, {
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

    for await (const entry of entries) {
      if (args.signal?.aborted) throw new Error("已取消");

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

      if (files >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) {
        capped = true;
        ac.abort();
        break;
      }

      const n = utf8Len(text);
      batch.push({ path: rel, content: text });
      batchBytes += n;
      progress.current = rel;

      if (batchBytes >= progress.batchBytes) {
        progress.phase = "upload";
        report();

        const t0 = Date.now();
        const r = await sendBatch(base, instance, ingestId, batch, () => {
          progress.batchBytes = Math.max(MIN_BATCH_BYTES, Math.floor(progress.batchBytes / 2));
        });
        progress.wallMs = Date.now() - t0;

        files += r.accepted;
        bytes += r.bytes;
        progress.files = files;
        progress.bytes = bytes;
        progress.capped = r.capped;

        // ⚠️ 自适应必须用**服务端自报**的 r.ms，不能用上面那个 wall time。
        // wall time 里混着网络往返，实测在这台机器上稳定 300–600ms ——
        // 拿它跟 25ms 比，每一批都会被判定成"太慢"，批次一路塌到 4KB 下限，
        // 一个 4MB 语料要多跑近十倍请求。踩过。
        const serverMs = r.ms;
        progress.msPerBatch = serverMs;

        if (serverMs > 25) {
          progress.batchBytes = Math.max(MIN_BATCH_BYTES, Math.floor(progress.batchBytes / 2));
          slowFastBatches = 0;
        } else if (serverMs < 5) {
          slowFastBatches++;
          if (slowFastBatches >= 3) {
            progress.batchBytes = Math.min(MAX_BATCH_BYTES, progress.batchBytes * 2);
            slowFastBatches = 0;
          }
        } else {
          slowFastBatches = 0;
        }

        batch = [];
        batchBytes = 0;
        report();

        if (r.capped) {
          capped = true;
          ac.abort();
          break;
        }
      }
    }

    if (batch.length > 0) {
      progress.phase = "upload";
      report();
      const t0 = Date.now();
      const r = await sendBatch(base, instance, ingestId, batch, () => {
        progress.batchBytes = Math.max(MIN_BATCH_BYTES, Math.floor(progress.batchBytes / 2));
      });
      files += r.accepted;
      bytes += r.bytes;
      // 尾批也要报数，否则小仓库永远只看到 0
      progress.msPerBatch = r.ms;
      progress.wallMs = Date.now() - t0;
      if (r.capped) capped = true;
    }

    // finish
    const finRes = await postJson(base, "/api/workspace/finish", {
      instance,
      ingestId,
      skipped,
      capped,
    });
    if (!finRes.ok) {
      throw new Error(`收尾失败：${(await finRes.text()).slice(0, 300)}`);
    }

    progress.phase = "done";
    progress.files = files;
    progress.bytes = bytes;
    progress.skipped = skipped;
    progress.capped = capped;
    report();

    return { files, bytes, skipped, capped };
  } catch (e) {
    progress.phase = "error";
    progress.error = (e as Error).message;
    report();
    // 让 DO 别卡在 ingesting 状态。失败本身不致命：active_generation
    // 仍指向上一份完整快照，工具照常可用
    await postJson(base, "/api/workspace/abort", {
      instance,
      ingestId,
      error: (e as Error).message,
    }).catch(() => {});
    throw e;
  } finally {
    args.signal?.removeEventListener("abort", abortIfOuterCancelled);
  }
}
