// 保温沙箱：在一个 DO 实例的范围内复用同一个沙箱。
//
// 为什么必须复用：沙箱里装包一次要二十几秒（实测 pip install openai-agents 24s），
// 而每次调用都新建沙箱的话，这个成本每次都要重付一遍。复用之后
// 「装一次包 → 后面一直能用」，而且模型写下的文件也会留在沙箱里。
//
// 代价是沙箱变成**有状态**的 —— 工具描述必须如实说明这一点，
// 否则模型会以为自己每次都从零开始。

import {
  createSandbox,
  execInSandbox,
  installPackages,
  killSandbox,
  type AliyunConfig,
  type SandboxExecRequest,
  type SandboxHandle,
} from "./aliyun.ts";
import type { RunResult } from "./types.ts";

export interface StoredSandbox {
  handle: SandboxHandle;
  /** 创建时刻（ms）。沙箱会在平台侧按 ttl 自动过期，这里用来提前判断 */
  createdAt: number;
}

/** 持久化槽位。由 ChatAgent 用 DO 的 storage 实现 —— 不能只放内存：
 *  DO 被驱逐后沙箱还活着，句柄丢了就成了没人回收的孤儿 */
export interface SandboxStore {
  get(): Promise<StoredSandbox | null>;
  set(v: StoredSandbox | null): Promise<void>;
}

export class WarmSandbox {
  /** 同一时刻多个并发调用只应该创建一次沙箱 */
  private inflight: Promise<SandboxHandle> | null = null;

  constructor(
    private readonly cfg: AliyunConfig,
    private readonly store: SandboxStore,
    /** 沙箱存活秒数。到时平台自动销毁，我们也会提前弃用句柄 */
    private readonly ttlSec: number,
  ) {}

  private async acquire(): Promise<SandboxHandle> {
    const cur = await this.store.get();
    if (cur && Date.now() - cur.createdAt < this.ttlSec * 1000) {
      return cur.handle;
    }
    // 句柄过期了就主动弃用并新建，不要等调用失败再补救 ——
    // 那种失败会直接浪费用户一轮对话
    if (cur) await killSandbox(this.cfg, cur.handle.sandboxId);

    const handle = await createSandbox(this.cfg, this.ttlSec);
    await this.store.set({ handle, createdAt: Date.now() });
    return handle;
  }

  async handle(): Promise<SandboxHandle> {
    if (!this.inflight) {
      this.inflight = this.acquire().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /**
   * 跑一段代码。
   *
   * ⚠️ **不重试**：抛错只可能来自网络或沙箱本身（用户代码的非零退出是正常返回值，
   * 不走异常）。重试会让副作用跑两遍，比失败更糟。抛错时把句柄清掉，下次重建。
   */
  async run(req: SandboxExecRequest): Promise<RunResult> {
    const h = await this.handle();
    try {
      return await execInSandbox(h, req);
    } catch (e) {
      await this.store.set(null);
      throw e;
    }
  }

  /** 装包。成功与否看返回的 ok，不抛 */
  async install(packages: string[], timeoutMs: number): Promise<RunResult> {
    const h = await this.handle();
    try {
      return await installPackages(h, packages, timeoutMs);
    } catch (e) {
      await this.store.set(null);
      throw e;
    }
  }

  /** 主动销毁。用于在沙箱里留下了敏感东西、或用户要求重置时 */
  async destroy(): Promise<void> {
    const cur = await this.store.get();
    await this.store.set(null);
    if (cur) await killSandbox(this.cfg, cur.handle.sandboxId);
  }
}
