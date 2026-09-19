// 服务端和浏览器共用。`src/workspace/` 下所有"共用"模块必须零 import ——
// 它们会被 Vite 打进客户端 bundle，一旦引到 agents / ai / workers-types 就炸构建。
// 这个文件只有类型和常量，两边都能安全引用。

export type RepoStatusName = "empty" | "ingesting" | "ready" | "error";

export interface RepoStatus {
  status: RepoStatusName;
  owner: string;
  name: string;
  ref: string;
  fileCount: number;
  totalBytes: number;
  activeGeneration: number;
  capped: boolean;
}

export interface IngestFile {
  path: string;
  content: string;
}

export interface DirEntry {
  name: string;
  kind: "d" | "f";
}

export interface IngestBatchResult {
  accepted: number;
  bytes: number;
  ms: number;
  capped: boolean;
}

// ── 语料上限 ────────────────────────────────────────────────────────────
// 免费档 CPU 是这套设计的支配性约束：语料越大，每次 grep/find 的扫描成本越高。
// 4MB 是「够解释一个中小仓库」和「工具调用能活下来」之间的取舍点。
// 单文件 128KB 远低于 DO SQLite 的 2MB 单行/单值上限，留足余量。

export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_FILES = 1500;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

// 攒批的初始目标。客户端会按实测耗时自适应调整（见 ingest.ts）。
export const INITIAL_BATCH_BYTES = 32 * 1024;
export const MIN_BATCH_BYTES = 4 * 1024;
export const MAX_BATCH_BYTES = 128 * 1024;
