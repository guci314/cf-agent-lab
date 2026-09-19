// 语料仓储层。只在服务端跑（Durable Object 里）。
//
// 设计要点：
// ① generation 制 —— 重导入时新语料写在新 generation 下，`finish` 那一刻才切换。
//    中途放弃或失败，agent 读到的仍是上一份完整快照，不会看到半成品。
// ② 计数器不在 ingest 过程中累加，而是在 finish 时从表里 `count/sum` 算出来。
//    这样批次重试、同路径重复提交都不会把计数搞歪。
// ③ 查询一律走 `exec()` 拿惰性游标，不用 `this.sql` 模板标签 —— 后者会
//    `[...cursor]` 全量物化，grep 就没法在预算用尽时提前收手。

import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type DirEntry,
  type IngestBatchResult,
  type IngestFile,
  type RepoStatus,
  type RepoStatusName,
} from "./types.ts";
import { countLines, utf8Len } from "./filter.ts";

// 路径区间扫描的上界。用 "￿" 而不是 "￿…" 拼接：
// path >= 'src/' and path < 'src/￿' 恰好覆盖 'src/' 下的全部路径
const HIGH = "￿";

interface MetaRow {
  owner: string;
  name: string;
  ref: string;
  status: string;
  ingest_id: string | null;
  active_generation: number;
  building_generation: number | null;
  file_count: number;
  total_bytes: number;
  skipped: number;
  capped: number;
  error: string | null;
  building_owner: string | null;
  building_name: string | null;
  building_ref: string | null;
}

export interface FileRow {
  path: string;
  content: string;
  bytes: number;
  lines: number;
}

export class WorkspaceRepo {
  sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /** 幂等 DDL。在 agent 构造函数里调一次即可，不必每请求都跑。 */
  ensureSchema(): void {
    this.sql
      .exec(
        `create table if not exists repo_meta (
           id integer primary key check (id = 1),
           owner text not null default '',
           name text not null default '',
           ref text not null default '',
           status text not null default 'empty',
           ingest_id text,
           active_generation integer not null default 0,
           building_generation integer,
           file_count integer not null default 0,
           total_bytes integer not null default 0,
           skipped integer not null default 0,
           capped integer not null default 0,
           error text,
           started_at integer,
           finished_at integer,
           building_owner text,
           building_name text,
           building_ref text
         )`,
      )
      .toArray();

    // 幂等加列迁移：给这个字段引入之前建好的库补上。
    // 列已存在时 SQLite 抛 "duplicate column name"，忽略即可
    for (const stmt of [
      "alter table repo_meta add column building_owner text",
      "alter table repo_meta add column building_name text",
      "alter table repo_meta add column building_ref text",
    ]) {
      try {
        this.sql.exec(stmt).toArray();
      } catch {
        /* 列已存在 */
      }
    }

    this.sql
      .exec(
        `create table if not exists repo_files (
           generation integer not null,
           path text not null,
           content text not null,
           bytes integer not null,
           lines integer not null,
           primary key (generation, path)
         ) without rowid`,
      )
      .toArray();

    this.sql
      .exec(
        `create table if not exists repo_entries (
           generation integer not null,
           dir text not null,
           name text not null,
           kind text not null,
           primary key (generation, dir, name)
         ) without rowid`,
      )
      .toArray();

    this.sql.exec("insert or ignore into repo_meta (id) values (1)").toArray();
  }

  // ── 元信息 ──────────────────────────────────────────────────────────

  private meta(): MetaRow {
    const rows = this.sql
      .exec<MetaRow>("select * from repo_meta where id = 1")
      .toArray();
    return rows[0];
  }

  activeGeneration(): number {
    return this.meta().active_generation;
  }

  status(): RepoStatus {
    const m = this.meta();
    return {
      status: m.status as RepoStatusName,
      owner: m.owner,
      name: m.name,
      ref: m.ref,
      fileCount: m.file_count,
      totalBytes: m.total_bytes,
      activeGeneration: m.active_generation,
      capped: m.capped === 1,
    };
  }

  // ── 导入 ────────────────────────────────────────────────────────────

  beginIngest(
    owner: string,
    name: string,
    ref: string,
    ingestId: string,
  ): { generation: number } {
    const m = this.meta();
    const generation = m.active_generation + 1;

    // 先清掉这个 generation 的残留。上一轮如果导入失败，已经有行写进来了，
    // 而 active_generation 没动 —— 不清的话这次会**合并**进上次的半截数据，
    // 让本该被替换掉的文件活到新快照里
    this.sql.exec("delete from repo_files where generation = ?", generation).toArray();
    this.sql.exec("delete from repo_entries where generation = ?", generation).toArray();

    // owner/name/ref 先写进 building_* ，**要等 finish 成功才提升为正式值**。
    // 否则一次失败的导入会留下"元信息说的是 A 仓库、语料其实是 B 仓库"的矛盾状态，
    // 而 system prompt 正是拿这三个字段告诉模型它在看哪个仓库 —— 会把模型带偏。
    this.sql
      .exec(
        `update repo_meta set building_owner=?, building_name=?, building_ref=?,
           status='ingesting', ingest_id=?, building_generation=?, capped=0, error=null, started_at=?
         where id = 1`,
        owner,
        name,
        ref,
        ingestId,
        generation,
        Date.now(),
      )
      .toArray();
    return { generation };
  }

  /**
   * 写入一批文件（外加它们的父目录索引）。
   *
   * 浏览器传过来的东西**不可信** —— 单文件大小、文件数、总字节数都在这里重校验一遍，
   * 不能只靠客户端自己过滤。
   */
  ingestBatch(ingestId: string, files: IngestFile[]): IngestBatchResult {
    const t0 = Date.now();
    const m = this.meta();

    if (m.status !== "ingesting" || m.ingest_id !== ingestId || m.building_generation === null) {
      // 陈旧批次：可能是上一轮导入的残留请求，静默丢弃
      return { accepted: 0, bytes: 0, ms: 0, capped: true };
    }

    const gen = m.building_generation;
    let totals = this.generationTotals(gen);
    let accepted = 0;
    let bytes = 0;
    let capped = false;

    for (const f of files) {
      if (totals.count >= MAX_FILES || totals.bytes >= MAX_TOTAL_BYTES) {
        capped = true;
        break;
      }

      const path = String(f.path ?? "").replace(/^\/+/, "");
      if (!path) continue;

      const content = String(f.content ?? "");
      const n = utf8Len(content);
      if (n > MAX_FILE_BYTES) {
        capped = true;
        continue;
      }

      this.sql
        .exec(
          `insert or replace into repo_files (generation, path, content, bytes, lines)
           values (?, ?, ?, ?, ?)`,
          gen,
          path,
          content,
          n,
          countLines(content),
        )
        .toArray();

      this.addDirEntries(gen, path);

      accepted++;
      bytes += n;
      totals = { count: totals.count + 1, bytes: totals.bytes + n };
    }

    // ms 交给客户端做自适应攒批的输入（见 ingest.ts）
    return { accepted, bytes, ms: Date.now() - t0, capped };
  }

  /** 为 `a/b/c.ts` 建 `a/b/c.ts`(f)、`a/b`(d)、`a`(d) 三条索引；`insert or ignore` 天然去重 */
  private addDirEntries(gen: number, path: string): void {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);

    this.sql
      .exec(
        "insert or ignore into repo_entries (generation, dir, name, kind) values (?, ?, ?, 'f')",
        gen,
        dir,
        name,
      )
      .toArray();

    let parent = dir;
    while (parent) {
      const cut = parent.lastIndexOf("/");
      const pdir = cut === -1 ? "" : parent.slice(0, cut);
      const pname = cut === -1 ? parent : parent.slice(cut + 1);
      this.sql
        .exec(
          "insert or ignore into repo_entries (generation, dir, name, kind) values (?, ?, ?, 'd')",
          gen,
          pdir,
          pname,
        )
        .toArray();
      parent = pdir;
    }
  }

  private generationTotals(gen: number): { count: number; bytes: number } {
    const rows = this.sql
      .exec<{ c: number; b: number }>(
        "select count(*) as c, coalesce(sum(bytes), 0) as b from repo_files where generation = ?",
        gen,
      )
      .toArray();
    return { count: rows[0]?.c ?? 0, bytes: rows[0]?.b ?? 0 };
  }

  finishIngest(
    ingestId: string,
    skipped: number,
    capped: boolean,
  ): { fileCount: number; totalBytes: number } {
    const m = this.meta();
    if (m.status !== "ingesting" || m.ingest_id !== ingestId || m.building_generation === null) {
      throw new Error("导入会话已失效，请重新导入");
    }

    const gen = m.building_generation;
    // 计数从表里算，不依赖过程中的累加 —— 批次重试不会把它搞歪
    const totals = this.generationTotals(gen);

    // generation 单调递增，所以 `<?` 就是"所有旧快照"，而且是主键区间扫
    this.sql.exec("delete from repo_files where generation < ?", gen).toArray();
    this.sql.exec("delete from repo_entries where generation < ?", gen).toArray();

    // 到这里才把 building_* 提升为正式元信息 —— 和语料切换同一拍完成
    this.sql
      .exec(
        `update repo_meta set status='ready', ingest_id=null, building_generation=null,
           owner=coalesce(building_owner, owner), name=coalesce(building_name, name),
           ref=coalesce(building_ref, ref),
           building_owner=null, building_name=null, building_ref=null,
           active_generation=?, file_count=?, total_bytes=?, skipped=?, capped=?, finished_at=?
         where id = 1`,
        gen,
        totals.count,
        totals.bytes,
        skipped,
        capped ? 1 : 0,
        Date.now(),
      )
      .toArray();

    return { fileCount: totals.count, totalBytes: totals.bytes };
  }

  failIngest(ingestId: string, error: string): void {
    const m = this.meta();
    if (m.ingest_id !== ingestId) return;

    // 导入失败**不该让已有语料变得不可用** —— 只要上一份快照还在，
    // 状态就退回 ready，工具照常工作；错误文本留着给页面显示。
    // （踩过：这里原来无条件写 'error'，一次失败的重新导入就把好端端的仓库变成读不了）
    const usable = m.active_generation > 0 && m.file_count > 0;

    this.sql
      .exec(
        `update repo_meta set status=?, error=?, ingest_id=null, building_generation=null,
           building_owner=null, building_name=null, building_ref=null
         where id = 1`,
        usable ? "ready" : "empty",
        error.slice(0, 500),
      )
      .toArray();
  }

  /** 清空语料（回到未导入状态） */
  reset(): void {
    this.sql.exec("delete from repo_files").toArray();
    this.sql.exec("delete from repo_entries").toArray();
    const gen = this.meta().active_generation + 1;
    this.sql
      .exec(
        `update repo_meta set status='empty', owner='', name='', ref='', ingest_id=null,
           building_generation=null, building_owner=null, building_name=null, building_ref=null,
           active_generation=?, file_count=0, total_bytes=0,
           skipped=0, capped=0, error=null
         where id = 1`,
        gen,
      )
      .toArray();
  }

  // ── 查询（工具用）──────────────────────────────────────────────────

  readFile(path: string): FileRow | null {
    const rows = this.sql
      .exec<FileRow>(
        "select path, content, bytes, lines from repo_files where generation = ? and path = ?",
        this.activeGeneration(),
        path,
      )
      .toArray();
    return rows[0] ?? null;
  }

  hasFile(path: string): boolean {
    const rows = this.sql
      .exec<{ n: number }>(
        "select count(*) as n from repo_files where generation = ? and path = ?",
        this.activeGeneration(),
        path,
      )
      .toArray();
    return (rows[0]?.n ?? 0) > 0;
  }

  listDir(dir: string, limit: number): DirEntry[] {
    return this.sql
      .exec<{ name: string; kind: string }>(
        `select name, kind from repo_entries
         where generation = ? and dir = ?
         order by kind asc, name asc
         limit ?`,
        this.activeGeneration(),
        dir,
        limit,
      )
      .toArray()
      .map((r) => ({ name: r.name, kind: r.kind === "d" ? "d" : "f" }));
  }

  /** 某目录下的全部文件路径（已排序）。glob 匹配在 JS 里做，见 tools.ts 的说明。 */
  allPaths(prefix: string, limit: number): string[] {
    return this.sql
      .exec<{ path: string }>(
        `select path from repo_files
         where generation = ? and path >= ? and path < ?
         order by path asc
         limit ?`,
        this.activeGeneration(),
        prefix,
        prefix + HIGH,
        limit,
      )
      .toArray()
      .map((r) => r.path);
  }

  /**
   * 惰性游标 —— grep 靠它在中途停下。
   * `bytes` 列随行返回，这样统计扫描量不必再对 content 做一次编码。
   *
   * `prefilter` 是 SQL 侧的候选预筛，用 `instr` 而**不是** `LIKE`：
   * DO SQL 对 LIKE/GLOB 的**模式串**有 50 字节上限，`instr` 没有，且它天然
   * 区分大小写、不用转义。带 3 字符以上字面量核心的 pattern 能靠它把
   * 整表扫描缩到只碰命中行。
   *
   * ⚠️ SQLite 的 `lower()` 只折 ASCII 字母。对代码标识符够用，
   * 非 ASCII 的大小写差异会漏掉 —— 这是 `ignoreCase` 预筛的已知边界。
   */
  fileCursor(
    prefix: string,
    prefilter?: { needle: string; ci: boolean },
  ): SqlStorageCursor<{ path: string; content: string; bytes: number }> {
    const gen = this.activeGeneration();
    const range =
      "select path, content, bytes from repo_files where generation = ? and path >= ? and path < ?";

    if (!prefilter) {
      return this.sql.exec<{ path: string; content: string; bytes: number }>(
        range,
        gen,
        prefix,
        prefix + HIGH,
      );
    }

    const sql = prefilter.ci
      ? range + " and instr(lower(content), ?) > 0"
      : range + " and instr(content, ?) > 0";

    return this.sql.exec<{ path: string; content: string; bytes: number }>(
      sql,
      gen,
      prefix,
      prefix + HIGH,
      prefilter.needle,
    );
  }
}
