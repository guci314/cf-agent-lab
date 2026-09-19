// 入库过滤：决定一个仓库文件值不值得进语料。共用模块（零 import）。
//
// 过滤跑在**浏览器**里 —— 那里 CPU 免费。但 DO 侧会独立重校验体量上限，
// 因为浏览器不是信任边界（见 routes.ts）。

/** 永远不看的目录名（按路径段匹配，不按子串） */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn",
  "dist", "build", "out", "output", "target",
  "vendor", "third_party", "bower_components",
  "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache",
  "coverage", ".nyc_output", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache",
  ".idea", ".vscode", ".cache", ".gradle", ".terraform",
]);

/** 永远不看的扩展名 */
const SKIP_EXTS = new Set([
  // 图片
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "avif", "heic", "svgz",
  // 字体
  "woff", "woff2", "ttf", "otf", "eot",
  // 音视频
  "mp3", "wav", "ogg", "flac", "m4a", "mp4", "mov", "avi", "mkv", "webm",
  // 压缩包 / 归档
  "zip", "gz", "tgz", "bz2", "xz", "tar", "jar", "war", "7z", "rar",
  // 二进制 / 产物
  "so", "dylib", "dll", "exe", "bin", "class", "o", "a", "obj", "lib",
  "wasm", "pyc", "pyo", "node", "snap", "db", "sqlite", "sqlite3", "mdb",
  // 文档二进制
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // 地图 / 数据转储
  "map", "min.js", "min.css",
]);

/** 永远不看的文件名（精确匹配，小写比较） */
const SKIP_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
  "bun.lockb", "bun.lock", "composer.lock", "cargo.lock", "poetry.lock",
  "gemfile.lock", "go.sum", "flake.lock", "packages.lock.json",
]);

const MAX_PATH_LEN = 400;

/**
 * 去掉 codeload tarball 的最外层目录（形如 `{owner}-{repo}-{sha}/`）。
 * 顶层目录自身（不含 `/`）返回空串，调用方应跳过。
 */
export function stripTopLevel(path: string): string {
  const i = path.indexOf("/");
  return i === -1 ? "" : path.slice(i + 1);
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * 返回跳过原因，空表示保留。
 *
 * `bytes` 是原始字节数（未解码）。这里只判「明显不该进语料」的，
 * 体量上限在 ingest 流程里单独判。
 */
export function skipReason(path: string, bytes: number): string | null {
  if (!path) return "空路径";
  if (path.length > MAX_PATH_LEN) return "路径过长";
  if (bytes === 0) return "空文件";

  const base = baseOf(path).toLowerCase();
  if (SKIP_NAMES.has(base)) return "锁文件";
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return "压缩过的产物";

  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = base.slice(dot + 1);
    if (SKIP_EXTS.has(ext)) return "二进制或产物：" + ext;
  }

  // 逐段判目录，别用子串 —— 否则 `src/distance.ts` 会被 `dist` 误伤
  for (const seg of path.split("/")) {
    if (SKIP_DIRS.has(seg)) return "忽略目录：" + seg;
  }

  return null;
}

/**
 * NUL 字节判二进制 —— 和 git 的启发式一致，且几乎不花时间。
 *
 * 必须在 UTF-8 解码**之前**判：先解码既会毁掉二进制内容，又白白多花一次编码的 CPU。
 */
export function looksBinary(bytes: Uint8Array, probe = 8000): boolean {
  const n = Math.min(bytes.length, probe);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * 判压缩过的产物（一行几千字符那种）。
 * 这种文件进语料后，read 一行就能顶掉整个输出预算，grep 也会被单行撑爆。
 */
export function looksMinified(text: string): boolean {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
    if (lines > 3) return false; // 行数够了就不必再数
  }
  return text.length / lines > 400;
}

const encoder = new TextEncoder();

export function utf8Len(s: string): number {
  return encoder.encode(s).length;
}

/** 行数按 LF 计；和 read 的切分口径保持一致 */
export function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}
