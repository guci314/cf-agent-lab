// glob → RegExp。共用模块（零 import）。
//
// 为什么不用 SQL 的 GLOB/LIKE 来做匹配：DO SQL 对 LIKE/GLOB 的**模式串**有 50 字节上限，
// 而且 SQL GLOB 既不支持 `**` 也不支持 `{a,b}`。所以在 JS 里匹配。
// 代价可控：路径上限 MAX_FILES 条，每条几十字节，整表扫一遍不到 1ms。

const RE_SPECIAL = /[.+^$()|[\]{}\\]/;

/**
 * 把 glob 编译成锚定的 RegExp。
 *
 * 支持：`*`（不跨 `/`）、`**`（跨 `/`）、`?`（不跨 `/`）、`{a,b}`、`[abc]`、`[!abc]`。
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;

  while (i < glob.length) {
    const c = glob[i];

    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` 要能匹配「零层目录」：`**/foo.ts` 得匹配根下的 `foo.ts`
        let j = i + 2;
        if (glob[j] === "/") {
          out += "(?:.*/)?";
          j++;
        } else {
          out += ".*";
        }
        i = j;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }

    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }

    if (c === "{") {
      // 花括号展开，内部按 `,` 切并递归编译（所以 `src/*.{ts,tsx}` 也能用）
      const end = findClosingBrace(glob, i);
      if (end === -1) {
        out += "\\{";
        i++;
        continue;
      }
      const alts = splitTopLevel(glob.slice(i + 1, end));
      out += "(?:" + alts.map((a) => globToRegExp(a).source.replace(/^\^|\$$/g, "")).join("|") + ")";
      i = end + 1;
      continue;
    }

    if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        i++;
        continue;
      }
      let body = glob.slice(i + 1, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      // 字符类里 `\` 是转义符；把 `]` 和 `\` 转义掉，其余原样保留
      body = body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      out += "[" + (negate ? "^" : "") + body + "]";
      i = end + 1;
      continue;
    }

    out += RE_SPECIAL.test(c) ? "\\" + c : c;
    i++;
  }

  return new RegExp("^" + out + "$");
}

function findClosingBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * 造一个匹配器。glob 里**不含 `/`** 时退回比对 basename —— 这是用户的直觉：
 * `*.ts` 应该匹配 `src/a.ts`，而不是只匹配根目录下的。
 */
export function makeGlobMatcher(glob: string): (path: string) => boolean {
  const trimmed = glob.trim();
  if (!trimmed) return () => true;

  const basenameOnly = !trimmed.includes("/");
  const re = globToRegExp(trimmed);

  if (!basenameOnly) return (path) => re.test(path);

  return (path) => {
    const slash = path.lastIndexOf("/");
    return re.test(slash === -1 ? path : path.slice(slash + 1));
  };
}
