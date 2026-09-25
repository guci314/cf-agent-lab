// 跨模块共用的三个小工具。
//
// ── 为什么单独一个文件 ──────────────────────────────────────────────
// 这三个原先分别住在 `workspace/tools.ts`（`guarded`）、`workspace/filter.ts`
// （`utf8Len`）、`workspace/github.ts`（`UA`）—— 而 `workspace/` 是
// 「读**用户导入的**仓库快照」那一层，2026-09-25 把 agent 改成通用助手时整层删掉了。
//
// 但另外两处还在用它们，所以先搬出来，别让它们跟着那一层一起消失：
//   · `sandbox/tool.ts`（run_python）用 `guarded`
//   · `ghworkspace/*`（工作区仓库 ws_*）用 `guarded` / `utf8Len` / `UA`
//
// 教训：**删一层之前先看有没有别人在 import 它里面的通用零件。**

/**
 * 工具永不抛错。
 *
 * 工具抛错会**中断整个工具循环** —— 模型看不到错因，只看到这一轮断了。
 * 所以一律转成 `{ error }` 让它自己读到并调整参数。这是全仓所有工具的共同契约，
 * 所以实现只留这一份。
 */
export async function guarded<T>(
  fn: () => T | Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: `工具执行失败：${(e as Error).message}` };
  }
}

const encoder = new TextEncoder();

/** 按 UTF-8 字节数计长度。中文一个字 3 字节，用 `str.length` 会低估 3 倍 */
export function utf8Len(s: string): number {
  return encoder.encode(s).length;
}

/** 抓外网页面时用的 UA。多个抓取点共用，免得各写一份慢慢漂移 */
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";
