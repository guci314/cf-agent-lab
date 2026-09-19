// 飞书流式卡片：创建卡片实体 → 发出去 → 反复推全量文本 → 关流。
//
// 为什么不用「编辑消息」（PUT /im/v1/messages/:id）：
// **一条消息最多只能编辑 20 次**。一次问答二三十秒，20 次意味着最密 1.5 秒一更，
// 长回答根本不够用。而卡片流式更新是**专门为 AI 打字机效果做的**：
//   - 文本更新不受 QPS 限制（官方原文："在流式更新模式下…不会触发接口的频率限制"）
//   - 平台**自己算增量** —— 我们每次推全量文本，它负责逐字上屏
//   - 官方推荐的更新节奏是 30–50ms，我们按需推就行
//
// 一个必守点：呈现效果取决于「新文本是否以旧文本为前缀」。
// 一致就继续打字机；前缀一变就**整段直接上屏**（没有打字效果）。
// 所以这里只做追加、绝不重写前缀 —— 中断重试也是拿更长的全文覆盖。

import type { FeishuEnv, TokenCache } from "./api.ts";
import { feishuCall } from "./api.ts";

/** 卡片的文本组件 id。推内容时要按这个 id 指到具体组件 */
export const ANSWER_ELEMENT_ID = "answer";

export interface StreamingCard {
  cardId: string;
}

/**
 * 建一个处于流式模式的卡片实体。
 *
 * `streaming_config` 显式指定而不用默认值：默认值随客户端类型/版本/机型变化，
 * 想要一致的观感就得自己定死。50ms/2 字符 ≈ 每秒 40 字，接近正常阅读节奏。
 */
export async function createStreamingCard(
  env: FeishuEnv,
  cache: TokenCache,
): Promise<StreamingCard> {
  const card = {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "正在回答…" },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 2 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        { tag: "markdown", element_id: ANSWER_ELEMENT_ID, content: "…" },
      ],
    },
  };

  const r = await feishuCall(env, cache, "POST", "/cardkit/v1/cards", {
    type: "card_json",
    // ⚠️ data 是**序列化后的字符串**，不是对象
    data: JSON.stringify(card),
  });
  const cardId = r.data?.card_id;
  if (!cardId) throw new Error("飞书没有返回 card_id");
  return { cardId };
}

/** 把卡片实体作为一条消息发到会话里。**一个卡片实体只能发一次** */
export async function sendCard(
  env: FeishuEnv,
  cache: TokenCache,
  chatId: string,
  cardId: string,
): Promise<void> {
  await feishuCall(env, cache, "POST", "/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
  });
}

/**
 * 推一次文本。传的是**累计的全量文本**。
 *
 * `sequence` 必须严格递增 —— 平台靠它丢弃乱序到达的旧版本，
 * 否则网络重排会让卡片内容来回跳。
 */
export async function pushCardText(
  env: FeishuEnv,
  cache: TokenCache,
  cardId: string,
  text: string,
  sequence: number,
): Promise<void> {
  await feishuCall(
    env,
    cache,
    "PUT",
    `/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${ANSWER_ELEMENT_ID}/content`,
    { content: text, sequence },
  );
}

/**
 * 关掉流式模式。
 *
 * 不关的话卡片一直停在「生成中」——会话列表里的预览会永远显示那个摘要，
 * 而且卡片上的交互组件也不可用。
 *
 * ⚠️ `sequence` 是**必填**，而且要和推正文用的是同一个计数器：
 * 文档要求「通过卡片 OpenAPI 操作同一张卡片时，sequence 严格递增」。
 * 这里从 1 重新开始会被直接拒掉（实测 `99992402 field validation failed`）。
 */
export async function closeStreaming(
  env: FeishuEnv,
  cache: TokenCache,
  cardId: string,
  sequence: number,
): Promise<void> {
  await feishuCall(
    env,
    cache,
    "PATCH",
    `/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
    {
      settings: JSON.stringify({ config: { streaming_mode: false } }),
      sequence,
    },
  );
}
