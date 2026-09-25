import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import "./styles.css";

type Part = { type: string; text?: string; input?: unknown };

function textOf(parts: readonly Part[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

// 「路径:行号」的形状。要求至少一段目录 + 一个扩展名，免得把普通词当路径。
// 两种：带目录的 a/b/c.ts[:12]，和不带目录但带行号的 x.ts:12。
const CITE_SRC =
  "(?:[\\w.@+-]+\\/)+[\\w.@+-]+\\.[A-Za-z]\\w*(?::\\d+(?:-\\d+)?)?" +
  "|[\\w.@+-]+\\.[A-Za-z]\\w*:\\d+(?:-\\d+)?";
const CITE_ALL = new RegExp(CITE_SRC, "g");
const CITE_FULL = new RegExp("^(?:" + CITE_SRC + ")$");

// 回答里的 `src/server.ts:42` 这类「路径:行号」是模型的常见引用形式，值得单独上色，
// 不能和正文一个样。但这里是纯文本渲染：模型很爱用反引号包路径，不处理的话页面上会
// 直接露出反引号，而真正的引用又埋没在句子里。
//
// 刻意不做完整 markdown（标题、列表、表格会引出新的排版问题），只做两件事：
//   反引号 → 代码样式；其中的「路径:行号」 → 钴蓝引用样式，比普通代码更重。
// 反引号个数为奇数时（模型写残了）整段放弃处理，原样输出 —— 总比乱切强。
//
// （2026-09-25：这段原先注释说「路径:行号 是这个产品的核心承诺」—— 那是
// 「代码仓库问答」时代的定位。现在是通用助手，引用代码只是顺带，样式留着。）
function rich(text: string): ReactNode[] {
  const segments = text.split("`");
  if (segments.length % 2 === 0) return [text];

  const out: ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      out.push(
        CITE_FULL.test(seg) ? (
          <span className="cite" key={i}>
            {seg}
          </span>
        ) : (
          <code className="inline-code" key={i}>
            {seg}
          </code>
        ),
      );
      return;
    }
    let last = 0;
    for (const m of seg.matchAll(CITE_ALL)) {
      const at = m.index ?? 0;
      // URL 的一部分，不是仓库路径：`https://github.com/foo/bar.ts` 里
      // `github.com/foo/bar.ts` 也长得像路径，靠前一个字符是 `/` 或 `:` 识别出来
      const prev = at > 0 ? seg[at - 1] : "";
      if (prev === "/" || prev === ":") continue;
      if (at > last) out.push(seg.slice(last, at));
      out.push(
        <span className="cite" key={i + ":" + at}>
          {m[0]}
        </span>,
      );
      last = at + m[0].length;
    }
    if (last < seg.length) out.push(seg.slice(last));
  });
  return out;
}

type Chip = { name: string; arg: string; web: boolean };

// 工具调用在 UIMessage 里是 type: "tool-<名字>" 的 part，参数在 input。
// 每个工具把参数塞在不同字段里，这里按优先级捞第一个非空的。
//
// 拆成 name / arg 两段（而不是拼成"搜代码：xxx"一句话），是为了让出处槽能把它
// 排成两列——左列工具名、右列目标。右列才是真正要读的东西。
// web 标记用来区分"上网查的"和"跑代码/写工作区的"，对应 CSS 里的实线/虚线。
function toolChip(p: Part): Chip | null {
  if (!p.type.startsWith("tool-")) return null;
  const name = p.type.slice("tool-".length);
  const input = (p.input ?? {}) as Record<string, unknown>;
  const arg = String(
    input.query ?? input.url ?? input.path ?? input.pattern ?? input.glob ?? "",
  );
  const web = name === "web_search" || name === "fetch_page";
  return { name, arg, web };
}

// 从回复里捞出第一个 ```html 代码块；模型被要求只给一个自包含文件
function extractHtml(text: string): string | null {
  const m = text.match(/```(?:html|HTML)?[ \t]*\r?\n([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].trim();
  // 只有看起来像文档的才当预览，避免把一段 JSON 塞进 iframe
  return /<[a-z!]/i.test(body) ? body : null;
}

function PreviewBlock({ html }: { html: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="preview-wrap">
      <button
        type="button"
        className="run"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起预览" : "▶ 在沙箱里运行"}
      </button>
      {open && (
        <>
          <iframe
            className="preview"
            title="sandboxed preview"
            // 只给 allow-scripts、不给 allow-same-origin：
            // 生成代码拿到 opaque origin，碰不到我们的 DOM / cookie / 存储
            sandbox="allow-scripts"
            srcDoc={html}
          />
          <span className="note">
            上面这段是 AI 生成的、运行在 sandbox iframe 里的代码，与本页面不同源
          </span>
        </>
      )}
    </div>
  );
}

function ChatPane({ instance }: { instance: string }) {
  const [input, setInput] = useState("");

  const agent = useAgent<{
    compactCalls?: number;
  }>({
    agent: "ChatAgent",
    name: instance,
  });
  const { messages, sendMessage, status, isServerStreaming, clearHistory } =
    useAgentChat({ agent });

  const busy =
    status === "streaming" || status === "submitted" || isServerStreaming;

  return (
    <>
      <div className="meta">
        <span>实例「{instance}」</span>
        <span id="compact-count">
          压缩已触发 {agent.state?.compactCalls ?? 0} 次
        </span>
        <button type="button" className="ghost" onClick={() => clearHistory()}>
          清空这段对话
        </button>
      </div>

      <div className="log">
        {messages.length === 0 && (
          <div className="msg bot">
            直接问就行 —— 它会搜网页、跑代码来回答。
            上面那条竖线里列的是它为找答案查过的页面和跑过的脚本。
          </div>
        )}
        {messages.map((m) => {
          const text = textOf(m.parts);
          const html = m.role === "assistant" ? extractHtml(text) : null;
          const chips =
            m.role === "assistant"
              ? m.parts.map(toolChip).filter((x): x is Chip => Boolean(x))
              : [];
          return (
            <div
              key={m.id}
              className={"msg " + (m.role === "user" ? "user" : "bot")}
            >
              {chips.length > 0 && (
                <div className="prov">
                  {chips.map((c, i) => (
                    <div key={i} className={c.web ? "tool tool-web" : "tool"}>
                      <span className="tool-name">{c.name}</span>
                      <span className="tool-arg">{c.arg}</span>
                    </div>
                  ))}
                </div>
              )}
              {rich(text)}
              {html && <PreviewBlock html={html} />}
            </div>
          );
        })}
        {busy && <div className="msg bot pending">…</div>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          setInput("");
          sendMessage({ text });
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="例如：帮我查一下 XX 现在的情况，并算一下…"
          autoComplete="off"
        />
        <button type="submit" disabled={busy}>
          {busy ? "回复中" : "发送"}
        </button>
      </form>
    </>
  );
}

function App() {
  const [instance, setInstance] = useState("demo-01");

  return (
    <div className="app">
      <header>
        <h1>通用助手</h1>
        <span className="sub">会搜网页、跑代码、写工作区笔记。</span>
      </header>

      <div className="meta">
        <label>
          实例{" "}
          <input
            value={instance}
            onChange={(e) => setInstance(e.target.value.trim() || "demo-01")}
          />
        </label>
        <span>换个名字就是另一段记忆，互不相通</span>
      </div>

      {/* key 让面板随实例名重挂，否则会留着上一个实例的消息 */}
      <ChatPane key={instance} instance={instance} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
