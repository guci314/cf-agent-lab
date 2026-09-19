// 把模型的增量输出喂给飞书流式卡片。
//
// ⚠️ 这个类的存在理由是一条硬约束：`streamText` 的 `onChunk` 回调
// **会暂停整个流直到回调的 promise 完成**（AI SDK 文档原话）。所以 `push()`
// 必须是同步的、绝不 await 网络请求；真正推给飞书的动作交给一个独立的
// 定时循环去做。
//
// 换句话说：**增量只进内存，出网单独排队**。搞反了会把模型输出按网络 RTT 拖慢。

import type { FeishuEnv, TokenCache } from "./api.ts";
import {
  closeStreaming,
  createStreamingCard,
  pushCardText,
  sendCard,
} from "./card.ts";

/** 推给飞书的节奏。飞书自己在 50ms/2字符 地渲染，我们 250ms 喂一次绰绰有余 */
const FLUSH_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FeishuStreamer {
  private cardId: string | null = null;
  private buffer = "";
  private sent = "";
  private sequence = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private env: FeishuEnv,
    private cache: TokenCache,
    private chatId: string,
  ) {}

  /**
   * 建卡片 + 发出去。返回 false 表示没起来（比如权限没配），
   * 调用方应该退回「攒完整段再发一条纯文本」的老路 —— 流式是体验，不是正确性。
   */
  async start(): Promise<boolean> {
    try {
      const card = await createStreamingCard(this.env, this.cache);
      await sendCard(this.env, this.cache, this.chatId, card.cardId);
      this.cardId = card.cardId;
      this.timer = setInterval(() => {
        void this.flush();
      }, FLUSH_MS);
      return true;
    } catch {
      this.timer = null;
      return false;
    }
  }

  /** 追加增量。**必须同步** —— 见文件头 */
  push(delta: string): void {
    this.buffer += delta;
  }

  /** 出错时把说明直接写进卡片，用户看到的是「回答的位置上写着为什么没答上来」 */
  async fail(message: string): Promise<void> {
    this.push(`\n\n⚠️ ${message}`);
    await this.finish();
  }

  /**
   * `fallbackText` 是一道保险：如果增量一个都没收到（比如 `onChunk` 没接上），
   * 卡片会永远停在「…」，而调用方又因为 `streamed: true` 不再补发文本消息 ——
   * 用户就什么都看不到了。把完整答案传进来兜底，最坏情况也是「没有打字效果」
   * 而不是「没有回答」。
   */
  async finish(fallbackText?: string): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.cardId) return;
    if (!this.buffer && fallbackText) this.buffer = fallbackText;

    // 等到最后一次推送落地（可能有一次正在飞的请求）
    for (let i = 0; i < 6 && this.sent !== this.buffer; i++) {
      if (this.busy) {
        await sleep(120);
        continue;
      }
      await this.flush();
    }

    try {
      // 用**下一个**序号，不能从头开始 —— 关流也是这张卡片上的一次操作，
      // 和推正文共享同一个递增计数器
      await closeStreaming(this.env, this.cache, this.cardId, ++this.sequence);
    } catch {
      // 关流失败不影响用户已经看到的内容，只是卡片停在「生成中」。
      // 不值得让整轮回答因此失败
    }
  }

  private async flush(): Promise<void> {
    if (!this.cardId || this.busy) return;
    if (this.buffer === this.sent) return; // 没有新内容，省一次请求

    this.busy = true;
    const text = this.buffer;
    try {
      await pushCardText(this.env, this.cache, this.cardId, text, ++this.sequence);
      this.sent = text;
    } catch {
      // 单次失败不致命：buffer 里是最新全文，下一拍会连上次没推的一起重推。
      // 前缀不变，所以打字机效果不会因此断掉
    } finally {
      this.busy = false;
    }
  }
}
