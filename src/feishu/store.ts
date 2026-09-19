// 飞书相关的小状态，存在 Durable Object 的 SQLite 里。
//
// 三件事：
// ① 事件去重 —— 飞书会重推。官方文档明说**用 message_id，不要用 event_id**。
// ② 每会话限流 —— 这是个公开端点，签名只证明「请求来自这个飞书应用」，
//    不证明「发消息的人是你」；群聊里任何成员 @ 一下就能触发一次模型调用。
// ③ tenant_access_token 缓存 —— 所有出站调用都在 DO 里做，缓存放这儿最省事。

import type { TokenCache } from "./api.ts";

/** 每个会话每分钟允许的提问数 */
const RATE_LIMIT_PER_MIN = 10;
const RATE_WINDOW_MS = 60_000;

/** 去重表的保留时长。只为了限流统计和排查，不需要长留 */
const EVENT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 重推判定窗口。窗口内的重复投递一律当成「同一条，别理」。
 *
 * 取 10 分钟而不是几秒：飞书的重推间隔是秒到分钟级，而我们处理一条消息可能花
 * 几十秒，窗口必须盖住「处理中 + 它的重推」这段时间。窗口外的同 id 才认为是
 * 一个失踪的旧作业，允许重来。
 */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export class FeishuStore {
  sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /** 幂等 DDL。和 repo.ensureSchema 一样，在 agent 构造函数里调一次 */
  ensureSchema(): void {
    this.sql
      .exec(
        `create table if not exists feishu_events (
           message_id text primary key,
           chat_id text not null,
           open_id text not null,
           state text not null default 'pending',
           attempts integer not null default 1,
           created_at integer not null,
           error text
         ) without rowid`,
      )
      .toArray();

    this.sql
      .exec(
        `create index if not exists feishu_events_chat_time
           on feishu_events (chat_id, created_at)`,
      )
      .toArray();

    this.sql
      .exec(
        `create table if not exists feishu_token (
           id integer primary key check (id = 1),
           token text not null,
           expires_at integer not null
         )`,
      )
      .toArray();
  }

  /**
   * 认领一条事件。返回 true = 该处理；false = 窗口内见过，跳过。
   *
   * ⚠️ 判据是**时间窗口**，不是 state。
   *
   * 我第一版写的是「只有 state==='done' 才算重复，否则当成上次失败、再排一个作业」，
   * 实测同一个 /help 回了三遍。原因是**飞书的重推发生在我们还没处理完的时候**
   * —— 它等不到 ACK 就重发，那时 state 还是 'pending'，于是被误判成"上次失败了"，
   * 又排了一个作业，两个作业各回一遍。
   *
   * 正确的语义是：窗口内的同一条就是同一件事，不管它处于什么状态。
   * 而这不会妨碍真正的重试 —— `schedule()` 的重试是 SDK 直接再调一次
   * `feishuRun`，根本不经过 claim。
   *
   * 「先查再插」而不是 `insert or ignore` + `changes()`：claim 全程同步，
   * 而 DO 是单线程的，同步块之间不会插进别的事件 —— 所以这里天然是原子的，
   * 不必依赖具体 SQLite 构建对 `returning` / `changes()` 的支持。
   */
  claim(messageId: string, chatId: string, openId: string): boolean {
    const now = Date.now();
    const rows = this.sql
      .exec<{ created_at: number }>(
        "select created_at from feishu_events where message_id = ?",
        messageId,
      )
      .toArray();

    if (rows[0]) {
      if (now - rows[0].created_at < DEDUPE_WINDOW_MS) {
        this.sql
          .exec(
            "update feishu_events set attempts = attempts + 1 where message_id = ?",
            messageId,
          )
          .toArray();
        return false;
      }
      // 窗口外的同 id：上一个作业多半已经失踪，允许重来
      this.sql
        .exec(
          `update feishu_events set state='pending', attempts=1, created_at=?, error=null
           where message_id = ?`,
          now,
          messageId,
        )
        .toArray();
      return true;
    }

    this.sql
      .exec(
        `insert into feishu_events (message_id, chat_id, open_id, state, attempts, created_at)
         values (?, ?, ?, 'pending', 1, ?)`,
        messageId,
        chatId,
        openId,
        now,
      )
      .toArray();
    return true;
  }

  markDone(messageId: string): void {
    this.sql
      .exec(
        "update feishu_events set state = 'done', error = null where message_id = ?",
        messageId,
      )
      .toArray();
  }

  /** 永久失败（比如仓库不存在）。不抛错 → 不触发重试，但要留下现场 */
  markFailed(messageId: string, error: string): void {
    this.sql
      .exec(
        "update feishu_events set state = 'failed', error = ? where message_id = ?",
        error.slice(0, 500),
        messageId,
      )
      .toArray();
  }

  /** 该会话最近一分钟的提问数（含当前这条，因为 claim 已经把它插进去了） */
  recentCount(chatId: string): number {
    const rows = this.sql
      .exec<{ n: number }>(
        `select count(*) as n from feishu_events
         where chat_id = ? and created_at > ?`,
        chatId,
        Date.now() - RATE_WINDOW_MS,
      )
      .toArray();
    return rows[0]?.n ?? 0;
  }

  overLimit(chatId: string): boolean {
    return this.recentCount(chatId) > RATE_LIMIT_PER_MIN;
  }

  /** 顺手清掉过期行。返回删掉几条 */
  prune(now = Date.now()): number {
    const cutoff = now - EVENT_TTL_MS;
    const before = this.sql
      .exec<{ n: number }>(
        "select count(*) as n from feishu_events where created_at < ?",
        cutoff,
      )
      .toArray();
    this.sql
      .exec("delete from feishu_events where created_at < ?", cutoff)
      .toArray();
    return before[0]?.n ?? 0;
  }

  /** 给 api.ts 用的 token 缓存。落 SQLite 而不是内存 —— 内存会被驱逐，而 DO 还在 */
  tokenCache(): TokenCache {
    const sql = this.sql;
    return {
      async get() {
        const rows = sql
          .exec<{ token: string; expires_at: number }>(
            "select token, expires_at from feishu_token where id = 1",
          )
          .toArray();
        const r = rows[0];
        return r ? { token: r.token, exp: r.expires_at } : null;
      },
      async set(v) {
        sql
          .exec(
            `insert into feishu_token (id, token, expires_at) values (1, ?, ?)
             on conflict(id) do update set token = excluded.token, expires_at = excluded.expires_at`,
            v.token,
            v.exp,
          )
          .toArray();
      },
    };
  }
}
