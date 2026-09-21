// 飞书开放平台的最小 mock，用来在真应用建好之前跑通整条回调链路。
//
// 解决的问题：飞书那侧还没建应用时，「取 token → 发消息 → 重试」这一段就完全没法
// 验证。把 `.dev.vars` 的 `FEISHU_API_BASE` 指到这里，整条链路（包括回执消息长什么样）
// 就都能本地看一遍。
//
// 用法：
//   node tools/feishu-mock.mjs          # 默认 127.0.0.1:18123
//   PORT=9000 node tools/feishu-mock.mjs
//
// 它只认两个端点，其余一律 404：
//   POST /open-apis/auth/v3/tenant_access_token/internal   → 假 token
//   POST /open-apis/im/v1/messages                          → 记录并回 code 0
//
// ⚠️ 不要在生产用。它不做任何鉴权，谁调都回成功。

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 18123);
let sent = 0;
/** cardId → 最新一次推的全量文本。关流时把它整段打出来，那是这轮回答的真身 */
const cards = new Map();
let cardSeq = 0;

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const path = new URL(req.url, "http://localhost").pathname;
    const reply = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };

    if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
      console.log(`[mock] 取 token  body=${raw}`);
      return reply({
        code: 0,
        msg: "ok",
        tenant_access_token: "mock-token-abc",
        expire: 7200,
      });
    }

    if (path === "/open-apis/im/v1/messages") {
      sent++;
      // 把 content 解出来单独打一行 —— 那是回复正文，最需要看的东西
      let text = "";
      try {
        text = JSON.parse(JSON.parse(raw).content).text;
      } catch {
        text = "(解析失败)";
      }
      console.log(`[mock] 发消息 #${sent} auth=${req.headers.authorization ?? "-"}`);
      console.log(`       正文：${text}`);
      return reply({ code: 0, msg: "ok", data: { message_id: `om_mock_${sent}` } });
    }

    // ── cardkit：流式卡片 ─────────────────────────────────────────
    if (path === "/open-apis/cardkit/v1/cards") {
      const id = `mock-card-${++cardSeq}`;
      cards.set(id, "");
      console.log(`[mock] 建卡片 ${id}`);
      return reply({ code: 0, msg: "ok", data: { card_id: id } });
    }

    // 推全量文本。这里**不逐条打**（250ms 一条太吵），只存最新的
    const push = path.match(/^\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/elements\/([^/]+)\/content$/);
    if (push) {
      const [, id, eid] = push.map(decodeURIComponent);
      let content = "";
      try {
        content = JSON.parse(raw).content ?? "";
      } catch {
        /* 保持空 */
      }
      cards.set(id, content);
      return reply({ code: 0, msg: "ok", data: {} });
    }

    // 关流。**这里把最终全文打出来** —— 就是我们想验的东西
    const close = path.match(/^\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/settings$/);
    if (close) {
      const id = decodeURIComponent(close[1]);
      console.log(`[mock] 关流 ${id}，最终卡片正文：`);
      console.log("┌─────────────────────────────────────────────");
      for (const line of String(cards.get(id) ?? "").split("\n")) {
        console.log(`│ ${line}`);
      }
      console.log("└─────────────────────────────────────────────");
      return reply({ code: 0, msg: "ok", data: {} });
    }

    console.log(`[mock] 未处理 ${req.method} ${req.url}`);
    res.writeHead(404).end("{}");
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[mock] 飞书 mock 监听 127.0.0.1:${PORT}`),
);
