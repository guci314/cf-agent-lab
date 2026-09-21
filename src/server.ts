import { AIChatAgent } from "@cloudflare/ai-chat";
import { routeAgentRequest, type AgentContext } from "agents";
import { createCompactFunction } from "agents/sessions";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  streamText,
  generateText,
  convertToModelMessages,
  tool,
  jsonSchema,
  stepCountIs,
} from "ai";

import {
  authCookieHeader,
  clearedCookieHeader,
  hasValidCookie,
  loginPage,
  passwordMatches,
} from "./auth.ts";
import { WorkspaceRepo } from "./workspace/repo.ts";
import { makeWorkspaceTools } from "./workspace/tools.ts";
import { makeSandboxTools, sandboxConfig } from "./sandbox/tool.ts";
import { WarmSandbox, type SandboxStore, type StoredSandbox } from "./sandbox/warm.ts";
import { handleWorkspaceRoutes } from "./workspace/routes.ts";
import { serveIngest } from "./workspace/serve-ingest.ts";
import { resolveDefaultBranch } from "./workspace/github.ts";
import { handleFeishuRoutes } from "./feishu/router.ts";
import type { FeishuQueueEvent } from "./feishu/router.ts";
import { FeishuStore } from "./feishu/store.ts";
import { FeishuStreamer } from "./feishu/streamer.ts";
import { runFeishuTurn } from "./feishu/turn.ts";
import type { IngestFile } from "./workspace/types.ts";

interface Env {
  ChatAgent: DurableObjectNamespace;
  OPENCODE_API_KEY: string;
  SERPER_API_KEY: string;
  /** 访问密码。走 `wrangler secret put`，不进源码也不进 bundle */
  PAGE_PASSWORD: string;
  ASSETS: Fetcher;
  // ── 飞书（都可选：没配就是用不了 bot，网页部分照常）──────────────
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  /** 配了才有签名校验。生产环境必须配，否则这个公开端点只有明文 token 可验 */
  FEISHU_ENCRYPT_KEY?: string;
  /** 逗号分隔的 open_id 白名单。留空 = 不限制（自己用可以留空） */
  FEISHU_ALLOWED_OPEN_IDS?: string;
  /** 只为本地测试：把飞书 API 指到 mock 上。生产不要设 */
  FEISHU_API_BASE?: string;
  // ── 代码沙箱（run_python）。全可选，默认开启 ──────────────────
  /** 设成 0 / false / off 即关闭 run_python。不设 = 开启 */
  SANDBOX_ENABLED?: string;
  // ── 阿里云 FC 云沙箱（首选）。配了 KEY 就走它 ────────────────
  /**
   * 阿里云「云沙箱」的 API Key，在 FC 控制台 → 云沙箱 → API Keys 创建。
   * 配了它就走这条：有出网、能 pip install、且沙箱跨调用复用。
   */
  ALIYUN_SANDBOX_API_KEY?: string;
  /** 默认 cn-hangzhou。**必须与模板同地域**，否则创建会失败 */
  ALIYUN_SANDBOX_API_BASE?: string;
  /** 默认 code-interpreter-v1（预装 python 3.13 / numpy / pandas） */
  ALIYUN_SANDBOX_TEMPLATE?: string;
  /** 沙箱存活秒数，默认 900。它是「装一次包一直能用」的时长上限 */
  ALIYUN_SANDBOX_TTL_SEC?: string;
  /**
   * 自建执行器（`executor/`）的地址与共享密钥。**两个都配齐**才走它；
   * 否则退回 Judge0 公共实例（那个装不了包、也不许出网）。
   */
  EXECUTOR_URL?: string;
  EXECUTOR_KEY?: string;
  /** 只为工具描述用，应与 `executor/requirements.txt` 保持一致 */
  EXECUTOR_PACKAGES?: string;
  /** 换成自建 Judge0。默认 https://ce.judge0.com */
  SANDBOX_URL?: string;
  /** 默认 113（Python 3.14）。换实例后语言 id 可能不同，用这个覆盖 */
  SANDBOX_LANGUAGE_ID?: string;
  /** 自建实例需要鉴权时用（X-Auth-Token）。公共实例不要设 */
  SANDBOX_API_KEY?: string;
}

type ChatState = {
  compactCalls: number;
  // 导入状态写进 state，页面刷新后还能看到「已导入 N 个文件」
  workspace?: {
    status: string;
    owner: string;
    name: string;
    ref: string;
    fileCount: number;
    totalBytes: number;
    capped: boolean;
  };
  // 探针结果。本机 wrangler tail 抓不到日志，只能靠把它写进 state 再从页面读
  probe?: Record<string, unknown>;
};

// 走用户的 OpenCode Go 订阅池，不用 Workers AI（免费档每天只有 10,000 neurons，
// 且 glm-5.3 / kimi-k2.7-code 这类强模型被 5035 挡在付费墙后）。
// 两个必守点：① 这是 OpenAI 兼容路径，认证头必须是 Authorization: Bearer，
// 只发 x-api-key 会得到 401 Missing API key（看着像模型不可用，实为头配错）；
// ② x-opencode-session 必须带，值随便取（只是个路由标签），缺了直接被拒。
// 2026-09-21 从 mimo-v2.5 换成 deepseek-v4.1-flash。
// 换之前验过它满足流式输出思考所需的两个条件：返回 `reasoning_content`
// （流式分片里也带），且工具调用正常（`finish_reason: tool_calls`）。
// 注：两个模型都具备这两点；换它是因为要按用户指定的模型跑。
const MODEL = "deepseek-v4.1-flash";

const opencode = (env: Env) =>
  createOpenAICompatible({
    name: "opencode-go",
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: env.OPENCODE_API_KEY,
    headers: { "x-opencode-session": "cf-agent-lab" },
  });

// 人格已经从「企业内助手」换成专职的代码仓库阅读助手。
// 几条规矩不是客套话，各自对应一种实际会犯的错：
// 「不要猜路径」——模型倾向于编一个看着合理的路径然后读不到；
// 「搜不到不是错误」——不写清楚它会因为空结果反复重试同一个搜索；
// 「截断就缩小范围」——不写清楚它会拿半截结果当完整的下结论。
const SYSTEM_PROMPT =
  "你是一个代码仓库阅读助手。用户导入的仓库你可以用 read / ls / grep / find 只读地查看。" +
  "回答必须基于你实际读到的代码，不要凭印象或常识推测；仓库里看不到就说看不到。" +
  "引用代码一律给出「路径:行号」（如 src/server.ts:42），方便用户跳转。" +
  "找东西先用 grep 搜内容、用 find 找路径，不要凭猜测拼路径。" +
  "搜索没有结果不是错误，换个关键词或放宽范围再试。" +
  "工具结果被截断时，加 path 或 glob 缩小范围再查一次，不要基于半截结果下结论。" +
  "仓库里确实没有答案时，可以用 web_search / fetch_page 查外部资料，但要说明那是仓库外的信息。" +
  // 沙箱结果和仓库内容必须分开说。不写这条，模型会把「我跑出来是这样」直接
  // 当成「这个仓库就是这样」—— 而沙箱里跑的是它自己写的脚本，不是仓库的代码。
  "需要验算算法、正则或复现某段逻辑时，可以用 run_python 在沙箱里跑一小段 Python" +
  "（只有标准库、无网络、每次调用互不相干）。" +
  "但要把沙箱结果和仓库内容分清楚：那是你自己写的脚本跑出来的，不是仓库里既有的事实，" +
  "引用时要说明「按上述逻辑推演」而不是当成「仓库里写着」。" +
  "回答简洁，不要客套。";

// 超过这个估算 token 数就压缩，压缩后保留最近 N token 逐字。
//
// 200k 是按模型窗口定的：mimo-v2.5 在 opencode-go 上是 100 万 token 窗口
// （models.dev 的 opencode-go/mimo-v2.5 条目），200k ≈ 用掉 20%，留足余量。
// 原来的 20k 是 Workers AI 那批小窗口模型时代留下的，换成 1M 窗口后没人动过 ——
// 那等于只用了 2%，读几个文件就触发一次压缩。
const COMPACT_AFTER_TOKENS = 200_000;
const KEEP_RECENT_TOKENS = 6_000;

// 默认输出上限只有 256 token，生成 HTML 会在半截被腰斩；给长页面留够余量
const MAX_OUTPUT_TOKENS = 8_192;

// 工具循环的步数上限。一步可以并行多个工具调用，所以"6 步"远不止 6 次调用。
// 实测一次"搜 GitHub 有没有 Workers 上的 ERP"要 6 步才收尾。
// 加了代码工具后提到 16：光是「ls → read → read → 回答」就要 4 步，
// 12 在真实调研里会卡在边界上（撞上就会以"空答案"的形式静默失败）。
const MAX_STEPS = 16;

// 抓页的边界：先按字节截断再解析，避免大页面把免费的 10ms CPU 打爆
const MAX_FETCH_CHARS = 300_000;
const MAX_PAGE_CHARS = 6_000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 正则去标签只在已截断的文本上跑，够用且比 HTMLRewriter 省事
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

// 抓的是模型给的 URL —— 挡掉内网，别让工具变成打内网的跳板
function toPublicUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("只支持 http/https");
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isPrivate =
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h === "0.0.0.0" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (isPrivate) throw new Error("拒绝访问内网地址");
  return u;
}

function makeTools(env: Env) {
  return {
    web_search: tool({
      description:
        "用 Google 搜索公开网页，返回若干条 {title, link, snippet}。" +
        "涉及最新信息、你不确定的事实、或需要给出处时，先调用它。",
      inputSchema: jsonSchema<{ query: string; count?: number }>({
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          count: { type: "number", description: "要几条结果，默认 5，最多 10" },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async ({ query, count }) => {
        let res: Response;
        try {
          res = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": env.SERPER_API_KEY,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              q: String(query ?? "").slice(0, 200),
              num: Math.min(Math.max(Number(count) || 5, 1), 10),
            }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (e) {
          return { error: `搜索请求失败：${(e as Error).name === "TimeoutError" ? "超时" : (e as Error).message}` };
        }
        if (!res.ok) {
          return { error: `搜索接口返回 HTTP ${res.status}` };
        }
        const data = (await res.json()) as {
          organic?: { title?: string; link?: string; snippet?: string }[];
        };
        const results = (data.organic ?? []).slice(0, 10).map((r) => ({
          title: r.title ?? "",
          link: r.link ?? "",
          snippet: (r.snippet ?? "").slice(0, 300),
        }));
        return results.length ? { results } : { error: "没有搜到结果" };
      },
    }),

    fetch_page: tool({
      description:
        "抓取一个网页并返回正文纯文本，用于读搜索结果里的具体页面。" +
        "URL 必须以 http:// 或 https:// 开头。",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "要抓取的完整 URL" } },
        required: ["url"],
        additionalProperties: false,
      }),
      execute: async ({ url }) => {
        let target: URL;
        try {
          target = toPublicUrl(String(url ?? ""));
        } catch (e) {
          return { error: `URL 无效：${(e as Error).message}` };
        }

        let res: Response;
        try {
          res = await fetch(target.toString(), {
            headers: {
              "user-agent": UA,
              accept: "text/html,application/xhtml+xml,text/plain,*/*",
            },
            redirect: "follow",
            // 没有超时的话，一条挂住的 URL 会让工具永远不返回，整个循环死在那一拍
            signal: AbortSignal.timeout(15_000),
          });
        } catch (e) {
          return { error: `抓取失败：${(e as Error).name === "TimeoutError" ? "超时" : (e as Error).message}` };
        }
        if (!res.ok) return { error: `抓取失败 HTTP ${res.status}` };

        const ctype = res.headers.get("content-type") ?? "";
        const raw = (await res.text()).slice(0, MAX_FETCH_CHARS);
        const text = /json|text\/plain/i.test(ctype) ? raw : htmlToText(raw);

        return {
          url: target.toString(),
          content: text.slice(0, MAX_PAGE_CHARS) || "(页面正文为空或无法解析)",
        };
      },
    }),
  };
}

/** 从一条 UIMessage 里缝出全部文本 part */
function messageText(m: {
  parts?: readonly { type: string; text?: string }[];
}): string {
  return (m.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * 把工具结果压成**一行**。
 *
 * 卡片是给人在手机上看的，工具的完整返回值动辄几千字 —— 全倒进去会把真正的
 * 回答淹掉，而且飞书卡片本来就不适合读长文本。所以每类结果只挑最值得看的那一个字段。
 */
function summarizeToolOutput(output: unknown): string {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.error === "string") return `失败：${o.error.slice(0, 80)}`;
    // 工具失败**不一定**有 `error` 字段：run_python / install_python_package
    // 失败时返回的是 `{ok:false, status, stderr}`。只看 error 会把它们判成成功，
    // 卡片上就会出现一个骗人的 ✅。
    if (o.ok === false) {
      const why = String(o.status ?? "").trim();
      const err = typeof o.stderr === "string" ? o.stderr.trim().split("\n").pop() ?? "" : "";
      return `失败：${(why || err || "见详情").slice(0, 80)}`;
    }
    if (typeof o.stdout === "string" && o.stdout.trim()) {
      return o.stdout.trim().split("\n")[0].slice(0, 100);
    }
    if (typeof o.matchCount === "number") return `命中 ${o.matchCount} 条`;
    if (Array.isArray(o.paths)) return `${o.paths.length} 个路径`;
    if (Array.isArray(o.entries)) return `${o.entries.length} 个条目`;
    if (typeof o.totalLines === "number") return `共 ${o.totalLines} 行`;
  }
  return "完成";
}

export class ChatAgent extends AIChatAgent<Env, ChatState> {
  // 只持有 sql 句柄，每请求复用，不必反复 new
  repo: WorkspaceRepo;
  feishu: FeishuStore;
  // 自己存一份：基类上有没有 `this.env` 我没核实出来，不赌这个
  private readonly envRef: Env;
  /**
   * 非空表示「当前这一轮是飞书发起的，且有活的流式卡片」。
   * `onChatMessage` 靠它决定要不要把增量接出去。
   *
   * 用实例字段而不是参数：`streamText` 在 `onChatMessage` 里构造，
   * 而 `onChunk` 拿不到调用方的上下文。DO 的回合是串行的（`saveMessages`
   * 走 `_runExclusiveChatTurn`），所以不会串台。
   */
  private feishuStream: FeishuStreamer | null = null;

  /**
   * 保温沙箱。配了 `ALIYUN_SANDBOX_API_KEY` 才有，否则为 null（退回 Judge0）。
   *
   * 句柄存在 DO 的 storage 里而不是内存里：DO 被驱逐后沙箱**还活着**，
   * 句柄只放内存的话就成了没人回收的孤儿。
   */
  private readonly sandbox: WarmSandbox | null;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.envRef = env;

    this.repo = new WorkspaceRepo(this.ctx.storage.sql);
    // DDL 幂等，每实例一次即可，不必每个请求都跑
    this.repo.ensureSchema();

    this.feishu = new FeishuStore(this.ctx.storage.sql);
    this.feishu.ensureSchema();

    const scfg = sandboxConfig(env);
    const storage = this.ctx.storage;
    const store: SandboxStore = {
      get: async () => (await storage.get<StoredSandbox>("sandbox")) ?? null,
      set: async (v) => {
        if (v) await storage.put("sandbox", v);
        else await storage.delete("sandbox");
      },
    };
    this.sandbox = scfg.aliyun
      ? new WarmSandbox(scfg.aliyun, store, scfg.ttlSec)
      : null;

    this.sessions
      .session()
      .onCompaction(
        createCompactFunction({
          summarize: (prompt: string) => this.summarize(prompt),
          keepRecentTokens: KEEP_RECENT_TOKENS,
        }),
      )
      .compactAfter(COMPACT_AFTER_TOKENS);
  }

  // 只被压缩调用——写进 agent state 是为了能从页面读出它真跑过（本机 wrangler tail 抓不到日志）
  private async summarize(prompt: string): Promise<string> {
    const compactCalls = (this.state?.compactCalls ?? 0) + 1;
    // ⚠️ setState 是整体替换、不是浅合并 —— 必须 spread，
    // 否则 summarize 一跑就把 workspace 字段静默抹掉
    this.setState({ ...this.state, compactCalls });

    const { text } = await generateText({
      model: opencode(this.env)(MODEL),
      maxOutputTokens: 2_048,
      prompt,
    });

    return text;
  }

  // ── 导入协议（由 Worker 经原生 RPC 调用，见 workspace/routes.ts）──────

  async workspaceBegin(
    owner: string,
    name: string,
    ref: string,
    ingestId: string,
  ): Promise<{ generation: number }> {
    return this.repo.beginIngest(owner, name, ref, ingestId);
  }

  async workspaceIngest(ingestId: string, files: IngestFile[]) {
    return this.repo.ingestBatch(ingestId, files);
  }

  async workspaceFinish(ingestId: string, skipped: number, capped: boolean) {
    const r = this.repo.finishIngest(ingestId, skipped, capped);
    this.syncWorkspaceState();
    return r;
  }

  async workspaceFail(ingestId: string, error: string): Promise<void> {
    this.repo.failIngest(ingestId, error);
    this.syncWorkspaceState();
  }

  async workspaceStatus() {
    return this.repo.status();
  }

  private syncWorkspaceState(): void {
    const s = this.repo.status();
    this.setState({
      ...this.state,
      workspace: {
        status: s.status,
        owner: s.owner,
        name: s.name,
        ref: s.ref,
        fileCount: s.fileCount,
        totalBytes: s.totalBytes,
        capped: s.capped,
      },
    });
  }

  // ── 飞书 ────────────────────────────────────────────────────────────
  //
  // 拆成「入队」和「跑」两步，是为了满足飞书那条硬约束：回调必须**快速 ACK**，
  // 而一次模型问答要二三十秒。webhook 只做到此一游的入队就立刻回 200，
  // 真正的活儿交给 schedule() 出来的作业。
  //
  // 用 `schedule()` 而不是 `ctx.waitUntil()`：后者的生命周期绑在 webhook 那个请求上，
  // DO 一被驱逐就整个丢掉 —— 而飞书**已经拿到 200 了**，不会重推，消息静默消失且
  // 没有任何错误信号。schedule() 走 storage + alarm，扛得住驱逐，还自带退避重试。

  /**
   * 这个实例是不是飞书会话。实例名由 webhook 侧构造成 `fs-<chat_id>`。
   *
   * 用 `ctx.id.name` 而不是基类的属性：`getAgentByName` 走 `idFromName`，名字一定在；
   * 而 Agent 基类上有没有暴露 `name` 我没核实出来，不赌它。
   */
  private get isFeishuChannel(): boolean {
    return (this.ctx.id.name ?? "").startsWith("fs-");
  }

  async feishuEnqueue(
    evt: FeishuQueueEvent,
  ): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.feishu.claim(evt.messageId, evt.chatId, evt.openId)) {
      return { accepted: false, reason: "duplicate" };
    }

    if (this.feishu.overLimit(evt.chatId)) {
      // 超频就静默丢掉：回一句「太快了」在被人刷的时候等于替对方放大流量
      this.feishu.markFailed(evt.messageId, "超出频率限制");
      return { accepted: false, reason: "rate" };
    }

    this.feishu.prune(); // 顺手清理过期行，不另开定时任务

    await this.schedule(new Date(), "feishuRun", evt, {
      retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000 },
    });
    return { accepted: true };
  }

  /** 由 schedule() 调用。抛错会触发重试，所以「永久失败」要在 turn 里自己吞掉 */
  async feishuRun(evt: FeishuQueueEvent): Promise<void> {
    await runFeishuTurn(
      {
        ask: (text, messageId, chatId) => this.feishuAsk(text, messageId, chatId),
        ingest: (owner, name, ref) => this.feishuIngest(owner, name, ref),
        statusText: () => this.feishuStatusText(),
      },
      this.envRef,
      this.feishu,
      evt,
    );
  }

  /**
   * 走一轮模型，返回回答正文。
   *
   * **复用网页那条完全相同的路径**（`saveMessages` → `onChatMessage` →
   * `streamText`），所以 system prompt、四个工具、`MAX_STEPS`、`prepareStep`、
   * 以及 200k 的压缩阈值全都不用在这里重写一遍。SDK 自己会把返回的流消费完并落库
   * （programmatic turn 走的是 `connection: void 0` 那条分支，本来就不是给 WS 用的）。
   *
   * 用户消息用**确定性 id**：作业重试时这一条已经在 `this.messages` 里了，
   * 直接拿上次的答案返回，不会重复烧模型。
   */
  private async feishuAsk(
    text: string,
    messageId: string,
    chatId: string,
  ): Promise<{ text: string; streamed: boolean }> {
    const uid = `fs-${messageId}`;
    const existing = this.messages.find((m) => m.id === uid);

    if (existing) {
      const idx = this.messages.indexOf(existing);
      const after = this.messages
        .slice(idx + 1)
        .find((m) => m.role === "assistant");
      // 重试：这一轮之前已经跑完了，直接交回已有答案，不重复烧模型。
      // 标记成「未流式」是有意的 —— 万一上一轮是在**发出之后**才失败的，
      // 宁可多回一条，也不要赌「用户已经看到了」而让他什么都收不到。
      if (after) return { text: messageText(after), streamed: false };
    }

    // 流式卡片：起得来就用它，起不来（比如 cardkit 权限没开）就退回纯文本。
    // 流式是**体验**，不是正确性 —— 绝不能因为它挂了就答不上来。
    const streamer = new FeishuStreamer(
      this.envRef,
      this.feishu.tokenCache(),
      chatId,
    );
    const live = await streamer.start();

    this.feishuStream = live ? streamer : null;
    try {
      // 追加时**去重**：上一次尝试可能已经把这条用户消息写进去了、但那一轮失败了。
      // 不去重的话重试会插进第二条同样 id 的消息，「确定性 id」这个保证就名存实亡。
      // （去重之后语义也对：cur 末尾已经是这条用户消息，这一轮就是一次真正的重试。）
      const res = await this.saveMessages((cur) =>
        cur.some((m) => m.id === uid)
          ? [...cur]
          : [...cur, { id: uid, role: "user", parts: [{ type: "text", text }] } as never],
      );
      if (res.status !== "completed") {
        throw new Error(`模型这一轮没跑完（${res.status}）${res.error ?? ""}`);
      }

      const last = this.messages[this.messages.length - 1];
      const answer = last?.role === "assistant" ? messageText(last) : "";

      if (live) {
        await streamer.finish(answer);
        return { text: answer, streamed: true };
      }
      return { text: answer, streamed: false };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      if (live) {
        // 把错误直接写进卡片 —— 用户看到的是「回答的位置上写着为什么没答上来」，
        // 而不是一条空卡片加一条莫名其妙的文本
        await streamer.fail(`没答上来：${msg}\n\n如果这是刚部署的，八成是模型凭证没配好。`);
        return { text: "", streamed: true };
      }
      throw e;
    } finally {
      this.feishuStream = null;
    }
  }

  private async feishuIngest(
    owner: string,
    name: string,
    ref: string,
  ): Promise<string> {
    const r = await serveIngest(this.repo, owner, name, ref);
    this.syncWorkspaceState();

    const kb = r.totalBytes < 1024 ? `${r.totalBytes}B` : `${Math.round(r.totalBytes / 1024)}KB`;
    const lines = [
      `已入库 ${owner}/${name}@${ref}`,
      `${r.fileCount} 个文件 · ${kb}${r.skipped > 0 ? ` · 跳过 ${r.skipped}` : ""}`,
    ];
    if (r.truncatedBy === "corpus" || r.truncatedBy === "entries") {
      lines.push("（撞到体积/数量上限，只索引了部分文件）");
    } else if (r.truncatedBy === "time") {
      lines.push("（抓取超时，只索引了一部分 —— 可以再发一次，或者选个小点的仓库）");
    }
    lines.push("现在可以直接问代码问题了。");
    return lines.join("\n");
  }

  private async feishuStatusText(): Promise<string> {
    const s = this.repo.status();
    if (s.fileCount === 0) {
      return "这个会话还没有仓库。发 /repo owner/name 导入一个，比如 /repo sindresorhus/is-stream。";
    }
    const kb = s.totalBytes < 1024 ? `${s.totalBytes}B` : `${Math.round(s.totalBytes / 1024)}KB`;
    return (
      `当前仓库 ${s.owner}/${s.name}@${s.ref}\n` +
      `${s.fileCount} 个文件 · ${kb}` +
      (s.capped ? "\n（因为体积上限，只有部分文件进了索引）" : "")
    );
  }

  /**
   * CPU 探针。DO 的 CPU 上限文档自相矛盾（Limits 页写 30 秒，FAQ 页写
   * 和 Workers 一样 = 免费档 10ms），只能实测。
   *
   * 每个 kind 在**独立请求**里只做一件事，结果同时写进 state ——
   * 因为这台机器上 `wrangler tail` 抓不到任何日志，只能从页面读回来。
   */
  async workspaceProbe(
    kind: number,
    payload?: unknown,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { kind };

    if (kind === 5) {
      // 直接跑一个工具，不经过模型 —— 确定性验证用。
      // 走的是和模型完全相同的代码路径（同一批 make*Tools + 同一个 repo）。
      // 沙箱工具也在这里查得到，否则 run_python 只能靠模型触发，而本机
      // `wrangler tail` 抓不到日志，线上出问题就完全没有观测手段。
      const p = (payload ?? {}) as { tool?: string; args?: unknown };
      const tools = {
        ...makeWorkspaceTools(this.repo),
        ...makeSandboxTools(this.repo, this.envRef, this.sandbox),
      } as unknown as Record<string, { execute?: (a: unknown) => unknown }>;
      const t = tools[String(p.tool ?? "")];
      if (!t || typeof t.execute !== "function") {
        out.error = `没有这个工具：${p.tool}`;
      } else {
        const t0 = Date.now();
        out.tool = p.tool;
        out.result = await t.execute(p.args ?? {});
        out.ms = Date.now() - t0;
      }
      return out;
    }

    if (kind === 6) {
      // 跑一轮**真正的模型回合**，把回复和这一轮调了哪些工具一并交回来。
      //
      // 为什么只能靠探针：网页那条路是 WebSocket（`AIChatAgent` 的 HTTP 分支
      // 对 POST 直接回 404），本机没法从外面驱动。这里走 `saveMessages` ——
      // 和飞书用的是**同一条**路径，system prompt、工具集、MAX_STEPS、
      // prepareStep 全都一致，所以测出来的行为就是线上的行为。
      const p = (payload ?? {}) as { args?: { text?: string } };
      const text = String(p.args?.text ?? "").trim();
      if (!text) return { ...out, error: "需要 args.text" };

      const clip = (v: unknown, n: number) => {
        const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
        return s && s.length > n ? s.slice(0, n) + `…(共 ${s.length} 字符)` : s;
      };

      const before = this.messages.length;
      const t0 = Date.now();
      out.text = text;
      try {
        const res = await this.saveMessages((cur) => [
          ...cur,
          {
            id: `probe-${crypto.randomUUID()}`,
            role: "user",
            parts: [{ type: "text", text }],
          } as never,
        ]);
        out.status = res.status;
        if (res.status !== "completed") out.error = res.error ?? res.status;
      } catch (e) {
        out.error = `模型回合失败：${(e as Error).message}`;
      }
      out.ms = Date.now() - t0;

      const added = this.messages.slice(before);
      out.msgsAdded = added.length;
      out.toolCalls = added.flatMap((m) =>
        (m.parts ?? [])
          .filter((pt) => String(pt.type).startsWith("tool-"))
          .map((pt) => {
            const q = pt as unknown as {
              type: string;
              state?: string;
              input?: unknown;
              output?: unknown;
              errorText?: string;
            };
            return {
              name: q.type.slice("tool-".length),
              state: q.state,
              input: clip(q.input, 400),
              output: clip(q.output, 500),
              ...(q.errorText ? { error: clip(q.errorText, 200) } : {}),
            };
          }),
      );
      const last = [...added].reverse().find((m) => m.role === "assistant");
      out.reply = last ? messageText(last) : "";
      return out;
    }

    if (kind === 7) {
      // 服务端导入一份语料（`owner/name` 或 `owner/name@ref`），走的是
      // `serveIngest` —— 和飞书 `/repo` 命令**同一条**路径。
      //
      // 为什么需要它：网页那条导入是浏览器驱动的四步（begin → tarball →
      // ingest → finish），想给某个 DO 实例塞语料做验证，从外面驱动就得自己
      // 解一遍 tarball；而这里没有别的入口能触发服务端导入。
      const p = (payload ?? {}) as { args?: { repo?: string; ref?: string } };
      const spec = String(p.args?.repo ?? "").trim();
      const m = /^([\w.-]+)\/([\w.-]+?)(?:@(.+))?$/.exec(spec);
      if (!m) {
        return { ...out, error: "args.repo 需要 owner/name 或 owner/name@ref" };
      }
      const t0 = Date.now();
      try {
        // ⚠️ 默认分支**必须由调用方解析**：serveIngest 拿空 ref 会直接判
        // 「分支名含非法字符」（它的 REF_RE 要求 ≥1 字符）。飞书那条路是在
        // turn.ts 里先 resolveDefaultBranch 的，这里照做，别指望 serveIngest 兜。
        const ref =
          (m[3] ?? "").trim() ||
          (await resolveDefaultBranch(m[1], m[2]));
        out.ref = ref;
        out.ingest = await serveIngest(this.repo, m[1], m[2], ref);
        this.syncWorkspaceState();
      } catch (e) {
        out.error = `导入失败：${(e as Error).message}`;
      }
      out.ms = Date.now() - t0;
      out.status = this.repo.status();
      return out;
    }

    if (kind === 0) {
      // 能力探测：本地 workerd 有 FTS5 和 trigram，但线上 DO 是另一套后端
      try {
        this.sql`create virtual table if not exists _probe_fts using fts5(x, tokenize='trigram')`;
        out.fts5_trigram = true;
      } catch (e) {
        out.fts5_trigram = `失败：${(e as Error).message}`;
      }
      try {
        const r = this.sql`select instr('abcdef', 'cd') as n`;
        out.instr = r[0]?.n === 3 ? true : r;
      } catch (e) {
        out.instr = `失败：${(e as Error).message}`;
      }
      out.status = this.repo.status();
    } else if (kind === 1) {
      // CPU 天花板：跑**固定迭代次数**，与时钟无关。
      //
      // ⚠️ 别用 `while (Date.now() - t < ms) {}` 这种忙等 —— 在 workerd 里
      // 同步块的 Date.now() 不推进，那个循环**永远不会退出**，于是 1ms 和 200ms
      // 表现完全一样（都被当成超限杀掉），看起来像"CPU 预算不到 1ms"。
      // 我一开始就是这么踩的：不是系统的问题，是量具坏了。
      const p = (payload ?? {}) as { args?: { iters?: number } };
      const iters = Math.min(
        Math.max(Number(p.args?.iters ?? 1_000_000), 1),
        200_000_000,
      );
      const t0 = Date.now();
      let acc = 0;
      // 累加结果回传，避免整段被优化掉
      for (let i = 0; i < iters; i++) acc = (acc + i * 1.000001) % 1_000_003;
      out.iters = iters;
      out.ms = Date.now() - t0;
      out.acc = acc;
      out.sameClock = out.ms === 0;
      out.note = "跑完 ⇒ 这份 CPU 量在预算内；被杀 ⇒ 超了。sameClock=true 说明同步块里时钟确实没走";
    } else if (kind === 2) {
      // SQL 侧全表扫描是否计入 CPU
      const gen = this.repo.activeGeneration();
      const t = Date.now();
      const rows =
        this.sql`select count(*) as c from repo_files where generation = ${gen} and instr(content, 'zzz') > 0`;
      out.ms = Date.now() - t;
      out.gen = gen;
      out.rows = rows[0]?.c ?? 0;
      out.note = "耗时很低 ⇒ SQL 扫描基本不计 CPU，永远不需要 FTS5";
    } else if (kind === 3) {
      // 5MB 解压要花多少 —— 量化「把解码挪到浏览器」这个决定省下了什么
      const raw = new Uint8Array(5 * 1024 * 1024);
      const gz = await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer();
      const t = Date.now();
      const back = await new Response(
        new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
      out.ms = Date.now() - t;
      out.in = raw.byteLength;
      out.out = back.byteLength;
      out.note = "若这一步很贵，说明浏览器侧解码是必须的，不是优化";
    } else if (kind === 4) {
      // 游标是否惰性吐行。rowsRead 远小于文件总数 ⇒ 惰性，grep 的提前收手能省下真金白银
      const cur = this.repo.fileCursor("");
      const first = cur.next();
      out.done = first.done === true;
      out.rowsRead = cur.rowsRead;
      out.totalFiles = this.repo.status().fileCount;
      out.note = "rowsRead ≈ totalFiles ⇒ 结果集被全量物化，grep 的预算必须写进 where 子句";
    } else {
      out.error =
        "未知的探针类型（0-4 见上；5 = 直接跑一个工具；6 = 跑一轮模型回合；7 = 服务端导入语料）";
    }

    this.setState({ ...this.state, probe: out });
    return out;
  }

  async onChatMessage() {
    const st = this.repo.status();
    const hasRepo = st.status === "ready" && st.fileCount > 0;

    // 把实时状态拼进 system，省得模型瞎猜仓库里有什么
    const base = hasRepo
      ? `${SYSTEM_PROMPT}\n\n当前已导入仓库 ${st.owner}/${st.name}@${st.ref}，` +
        `共 ${st.fileCount} 个文件（约 ${Math.round(st.totalBytes / 1024)}KB）。` +
        (st.capped ? "注意：因为体积上限，只有部分文件进了索引。" : "")
      : `${SYSTEM_PROMPT}\n\n当前还没有导入代码仓库。如果用户问的是仓库里的代码，先提醒他用 /repo owner/name 导入。`;

    // 飞书会话（实例名 `fs-` 开头）的回答是走**流式卡片**发的，而卡片**渲染 Markdown**。
    //
    // ⚠️ 这里以前写的是反过来的：那会儿回答走 `text` 消息，飞书不渲染 Markdown，
    // 于是要求模型别用反引号和代码围栏。换成卡片之后那条限制就成了纯粹的自缚 ——
    // 引用代码正是这个产品的主业，平铺反而难读。
    //
    // 唯一保留的约束是**宽表格**：卡片在手机上的宽度很窄，宽表格要横向滚动才看得全。
    const system = this.isFeishuChannel
      ? base +
        "\n\n注意：回答会显示在飞书的卡片里，**支持 Markdown** —— 代码块、`行内代码`、列表、加粗都能正常渲染。" +
        "引用代码时用代码块并标出行号，行内提到标识符用反引号，比平铺更好读。" +
        "只有一个要避开：**别用宽表格**（手机上的卡片很窄，宽表格要横向滚动才看得全），需要对比时改用列表。回答尽量短。"
      : base;

    const result = streamText({
      model: opencode(this.env)(MODEL),
      system,
      messages: await convertToModelMessages(this.messages),
      // 不显式设的话默认只给 256 token，长回答会在半截被砍断
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      tools: {
        ...makeTools(this.env),
        ...makeWorkspaceTools(this.repo),
        ...makeSandboxTools(this.repo, this.envRef, this.sandbox),
      },
      // 允许"ls → read → grep → 答"这种多步；不设就是一步，工具调完就停
      stopWhen: stepCountIs(MAX_STEPS),
      // 最后一步把工具摘掉，逼它用文字收尾。
      // 不加这个，循环会停在"刚调完工具"那一拍，最终 text 为空 —— 页面上就是工具全跑完了却永远没有回答。
      prepareStep: ({ stepNumber }) =>
        stepNumber >= MAX_STEPS - 1 ? { activeTools: [] } : undefined,
      // 飞书流式：把**思考、工具调用、答案**按到达顺序接进同一张卡片。
      // 网页那条路 `feishuStream` 是 null，这里是空转。
      //
      // ⚠️ 回调**必须同步返回** —— SDK 会暂停整个流直到这个 promise 完成。
      // 所以这里只往内存里追加，出网由 FeishuStreamer 自己的定时器负责。
      //
      // 为什么合成一条流而不是分几块：飞书卡片只能**追加**（新文本不是旧文本
      // 前缀时，平台会整段重上屏、打字机效果断掉）。既然只能追加，
      // 那就按模型真实的产出顺序排成一串 —— 这也正好是读起来最自然的顺序。
      onChunk: ({ chunk }) => {
        const s = this.feishuStream;
        if (!s) return;
        switch (chunk.type) {
          case "reasoning-delta":
            s.pushReasoning(chunk.text);
            break;
          case "text-delta":
            s.push(chunk.text);
            break;
          case "tool-input-start":
            s.pushToolCall(chunk.toolName);
            break;
          case "tool-result": {
            const out = (chunk as { output?: unknown }).output;
            const failed =
              !!out &&
              typeof out === "object" &&
              ("error" in out || (out as { ok?: unknown }).ok === false);
            s.pushToolResult(!failed, summarizeToolOutput(out));
            break;
          }
          default:
            break;
        }
      },
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ── 飞书回调 ────────────────────────────────────────────────────
    // ⚠️ 必须放在**最前面**，在密码门之前。两个理由：
    // ① 飞书不会带我们的 cookie，进了门就永远 401；
    // ② 它有自己的凭证和校验（缺 FEISHU_* 时自己 fail closed），
    //    不该因为 PAGE_PASSWORD 忘了配就被连带打死。
    const feishu = await handleFeishuRoutes(request, env);
    if (feishu) return feishu;

    const password = env.PAGE_PASSWORD;

    // fail closed：密码没配就拒绝服务，而不是放行。
    // 反过来写的话，「secret 忘了设」会以「门静默消失」的形式失效 ——
    // 那是安全控制最糟的失败方式（不报错、没人发现、门一直开着）
    if (!password) {
      return new Response(
        "服务未配置访问密码。请先执行：npx wrangler secret put PAGE_PASSWORD",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    const url = new URL(request.url);
    // 本地 http 下不能带 Secure，否则浏览器不存 cookie，登录会死循环
    const secure = url.protocol === "https:";

    if (url.pathname === "/login") {
      if (request.method !== "POST") return loginPage();

      let supplied = "";
      try {
        const form = await request.formData();
        supplied = String(form.get("password") ?? "");
      } catch {
        return loginPage("请求格式不对");
      }
      if (!passwordMatches(supplied, password)) return loginPage("密码不对");

      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": await authCookieHeader(password, secure),
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 303,
        headers: { location: "/", "set-cookie": clearedCookieHeader(secure) },
      });
    }

    if (!(await hasValidCookie(request, password))) {
      // WebSocket 和 API 请求回 401，别把一段 HTML 塞进握手里 ——
      // 塞了也拦得住（拿不到 101 就握不上手），但会让客户端去解析 HTML 而困惑重试。
      // 两个头都认：真实握手带 Sec-WebSocket-Key；Upgrade 有可能在中间被剥掉
      const isWs =
        request.headers.get("upgrade") !== null ||
        request.headers.get("sec-websocket-key") !== null;

      if (isWs || url.pathname.startsWith("/api/")) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "cache-control": "no-store" },
        });
      }
      return loginPage();
    }

    // ── 门内的请求 ──────────────────────────────────────────────────
    // /api/workspace/* 先接走。它和 /agents/:binding/:name 不冲突，
    // 而且 tarball 的流式转发不该进 DO（不占它的 CPU 和 duration）
    const api = await handleWorkspaceRoutes(request, env);
    if (api) return api;

    const agentRes = await routeAgentRequest(request, env);
    if (agentRes) return agentRes;

    // 静态资源。因为 assets 配了 run_worker_first，它们现在也走这里 ——
    // 这正是"没过门连 JS 都拿不到"的实现方式
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
