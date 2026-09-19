import { useRef, useState } from "react";
import { ingestRepo, type IngestProgress } from "./workspace/ingest.ts";

export interface WorkspaceState {
  status: string;
  owner: string;
  name: string;
  ref: string;
  fileCount: number;
  totalBytes: number;
  capped: boolean;
}

/** 接受 `owner/repo`，也接受粘一个完整链接（顺带从 /tree/<ref> 里把分支捞出来） */
function parseRepo(v: string): { owner: string; name: string; ref?: string } | null {
  const s = v
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const [owner, name, ...rest] = parts;
  const ok = /^[A-Za-z0-9._-]+$/;
  if (!ok.test(owner) || !ok.test(name)) return null;

  let ref: string | undefined;
  if (rest[0] === "tree" && rest.length > 1) ref = rest.slice(1).join("/");
  return { owner, name, ref };
}

function kb(n: number): string {
  return n < 1024 ? `${n}B` : `${Math.round(n / 1024)}KB`;
}

export function WorkspacePanel({
  instance,
  workspace,
}: {
  instance: string;
  workspace?: WorkspaceState;
}) {
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("main");
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acRef = useRef<AbortController | null>(null);

  const run = async () => {
    const parsed = parseRepo(repo);
    if (!parsed) {
      setError("请填 owner/repo，或直接粘一个 GitHub 仓库链接");
      return;
    }
    const useRef = parsed.ref ?? ref.trim() ?? "main";

    setBusy(true);
    setError(null);
    const ac = new AbortController();
    acRef.current = ac;

    try {
      await ingestRepo({
        instance,
        owner: parsed.owner,
        name: parsed.name,
        ref: useRef || "main",
        signal: ac.signal,
        onProgress: setProgress,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      acRef.current = null;
    }
  };

  const live = progress && progress.phase !== "done" && progress.phase !== "error";
  const current = live ? progress : null;

  return (
    <div className="ws">
      <div className="ws-row">
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/repo 或 GitHub 链接"
          autoComplete="off"
          disabled={busy}
        />
        <input
          className="ws-ref"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="main"
          autoComplete="off"
          disabled={busy}
        />
        {busy ? (
          <button type="button" className="ghost" onClick={() => acRef.current?.abort()}>
            取消
          </button>
        ) : (
          <button type="button" onClick={run}>
            导入
          </button>
        )}
      </div>

      {current && (
        <div className="ws-status">
          <span>
            {current.phase === "fetch"
              ? "拉取压缩包…"
              : current.phase === "decode"
                ? "解压解析中…"
                : "写入索引中…"}
          </span>
          <span>
            {current.files} 个文件 · {kb(current.bytes)}
            {current.skipped > 0 && ` · 跳过 ${current.skipped}`}
          </span>
          {/* 这几个读数就是唯一的 profiler：本机 wrangler tail 抓不到任何日志。
              分开显示 DO 侧耗时与往返耗时 —— 自适应攒批只看前者，
              混在一起会把网络延迟误判成 DO 太慢（踩过）。 */}
          {(current.msPerBatch > 0 || current.wallMs > 0) && (
            <span className="ws-dim">
              DO {current.msPerBatch}ms · 往返 {current.wallMs}ms · 批{" "}
              {kb(current.batchBytes)}
            </span>
          )}
          {current.current && <span className="ws-dim ws-path">{current.current}</span>}
        </div>
      )}

      {!current && workspace && workspace.fileCount > 0 && (
        <div className="ws-status">
          <span>
            已导入 <b>{workspace.owner}/{workspace.name}</b>@{workspace.ref}
          </span>
          <span>
            {workspace.fileCount} 个文件 · {kb(workspace.totalBytes)}
          </span>
          {workspace.capped && (
            <span className="ws-warn">已达体积上限，索引是部分内容</span>
          )}
        </div>
      )}

      {!current && (!workspace || workspace.fileCount === 0) && (
        <div className="ws-status ws-dim">
          还没有导入仓库。导入后就能问「这个仓库的登录逻辑在哪」这类问题。
        </div>
      )}

      {error && <div className="ws-error">{error}</div>}
    </div>
  );
}
