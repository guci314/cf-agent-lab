// 一条飞书消息的完整处理：解析命令 → 干活 → 把结果发回去 → 标记完成。
//
// 跑在 DO 的 `schedule()` 作业里，**不在** webhook 请求里 —— 飞书那边早就 ACK 过了。
//
// 这里的 host 接口只有两个方法，不是过度抽象：turn 需要的宿主能力确实就这两样
// （问模型、报状态），而把它们留在 server.ts 里会让那个文件继续膨胀。
// 同时这让整个回合流程可以脱离 DO 单独测。
//
// 2026-09-25：agent 改成通用助手后去掉了第三个方法 `ingest`（抓取并入库 GitHub 仓库）
// —— 那整条「导入仓库再问答」的链路已删除。

import { sendText } from "./api.ts";
import type { FeishuEnv } from "./api.ts";
import { HELP_TEXT, parseCommand } from "./commands.ts";
import type { FeishuStore } from "./store.ts";
import type { FeishuQueueEvent } from "./router.ts";

export interface FeishuTurnHost {
  /**
   * 走一轮模型。
   *
   * `streamed: true` 表示回答已经**通过流式卡片发到会话里了**，调用方不要再发一条；
   * false 才是「把 text 发出去」。
   */
  ask(
    text: string,
    messageId: string,
    chatId: string,
  ): Promise<{ text: string; streamed: boolean }>;
  /** 「当前会话什么状态」的一句话 */
  statusText(): Promise<string>;
}

const EMPTY_ANSWER =
  "模型没有返回任何内容。这通常是服务端的模型凭证有问题（不是你的问题），稍后再试一次。";

export async function runFeishuTurn(
  host: FeishuTurnHost,
  env: FeishuEnv,
  store: FeishuStore,
  evt: FeishuQueueEvent,
): Promise<void> {
  const cache = store.tokenCache();
  const cmd = parseCommand(evt.text);

  switch (cmd.kind) {
    case "help":
      await sendText(env, cache, evt.chatId, HELP_TEXT);
      break;

    case "error":
      await sendText(env, cache, evt.chatId, cmd.message);
      break;

    case "status":
      await sendText(env, cache, evt.chatId, await host.statusText());
      break;

    case "ask": {
      let reply: string;
      try {
        const r = await host.ask(cmd.text, evt.messageId, evt.chatId);
        // 已经流式发出去了，别再补一条 —— 那会变成同一段回答的两份
        if (r.streamed) break;
        reply = r.text.trim() || EMPTY_ANSWER;
      } catch (e) {
        // ⚠️ 这里**必须把异常吞掉**。
        //
        // 让异常冒出去的话，`schedule()` 会重试三次然后在服务端日志里留一句
        // "error executing callback after 3 attempts" 就放弃 —— 用户那边
        // **一条消息都收不到，也没有任何提示**。实测就是这个结果。
        //
        // 而发送失败（下面的 sendText）仍然会抛，仍然会被 schedule() 重试 ——
        // 那才是重试真正擅长的场景（网络抖动）。模型失败通常是配置问题，
        // 立刻说清楚比让用户干等九十秒再收到一句含糊的失败有用。
        const msg = (e as Error).message.slice(0, 300);
        reply = `没答上来：${msg}\n\n如果这是刚部署的，八成是模型凭证没配好。`;
      }
      await sendText(env, cache, evt.chatId, reply);
      break;
    }
  }

  // 只有全部发完才标记完成。中途抛错（比如发消息时网络抖动）会让 state 停在
  // pending，`schedule()` 的重试会再进来一次 —— 那时 host.ask 靠确定性的消息 id
  // 认出这一轮已经跑过，直接返回已有答案，不会重复烧模型。
  store.markDone(evt.messageId);
}
