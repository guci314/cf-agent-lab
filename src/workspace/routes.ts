// /api/workspace/* —— 导入协议的 HTTP 层。
//
// 为什么路由放在 **Worker 入口** 而不是 agent 的 `onRequest`：
// `AIChatAgent` 在构造函数里把 `this.onRequest` 换成了一个实例属性包装器
// （`const _onRequest = this.onRequest.bind(this); this.onRequest = async (r) => {...}`），
// 里面藏着 `get-messages` 路由。子类里覆盖它，`super.onRequest` 会解析到
// `Agent.prototype` 的 404 而不是那个包装器，很容易把既有路由静默搞没。
// 放 Worker 层还顺带解决两件事：路径不用从 `/agents/<ns>/<name>/...` 尾巴上剥，
// 而且 tarball 的流式转发完全不进 DO，不占它的 CPU 和 duration。
//
// DO 用原生 RPC 调（`getAgentByName` 拿 stub 直接调方法），不走 fetch。

import { getAgentByName } from "agents";
import type { IngestBatchResult, IngestFile, RepoStatus } from "./types.ts";
import {
  OWNER_RE,
  REF_RE,
  TARBALL_MAX_BYTES,
  UA,
  codeloadUrl,
} from "./github.ts";

interface Env {
  ChatAgent: DurableObjectNamespace;
}

/** DO 上暴露给 Worker 的方法。用结构化接口而不是 import ChatAgent，避免循环依赖。 */
interface WorkspaceDo {
  workspaceBegin(
    owner: string,
    name: string,
    ref: string,
    ingestId: string,
  ): Promise<{ generation: number }>;
  workspaceIngest(ingestId: string, files: IngestFile[]): Promise<IngestBatchResult>;
  workspaceFinish(
    ingestId: string,
    skipped: number,
    capped: boolean,
  ): Promise<{ fileCount: number; totalBytes: number }>;
  workspaceFail(ingestId: string, error: string): Promise<void>;
  workspaceStatus(): Promise<RepoStatus>;
  workspaceProbe(kind: number, payload?: unknown): Promise<unknown>;
}

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * tarball 流式转发。
 *
 * ⚠️ 这里**绝不缓冲**整体：`new Response(upstream.body, ...)` 让字节直接穿过去，
 * 既不解析也不进内存，CPU 开销约等于零。浏览器那边拿 `DecompressionStream`
 * 自己解 —— CPU 在浏览器是免费的，在 Worker 里是要花配额的。
 *
 * codeload 不发 CORS 头，所以浏览器不能直连它；这个同源路由就是为了绕开那一点。
 */
async function handleTarball(url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const ref = url.searchParams.get("ref") ?? "";

  if (!OWNER_RE.test(owner) || !OWNER_RE.test(name)) {
    return fail("owner / name 含非法字符");
  }
  if (!REF_RE.test(ref)) {
    return fail("ref 含非法字符");
  }

  let upstream: Response;
  try {
    upstream = await fetch(codeloadUrl(owner, name, ref), {
      headers: { "user-agent": UA },
      redirect: "follow",
    });
  } catch (e) {
    return fail(`连接 GitHub 失败：${(e as Error).message}`, 502);
  }

  if (!upstream.ok) {
    return fail(
      `GitHub 返回 HTTP ${upstream.status} —— 仓库或分支可能不存在、或者是私有仓库`,
      502,
    );
  }

  const len = Number(upstream.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > TARBALL_MAX_BYTES) {
    return fail(
      `仓库压缩包 ${Math.round(len / 1048576)}MB，超过 50MB 上限`,
      413,
    );
  }
  if (!upstream.body) return fail("上游没有返回内容", 502);

  return new Response(upstream.body, {
    headers: {
      "content-type": "application/gzip",
      "cache-control": "no-store",
    },
  });
}

async function handleRequest(req: Request, env: Env, path: string): Promise<Response> {
  // 探测端点：既用来定 DO 的 CPU 预算（cpu=0..4），也用来不带模型地
  // 直接跑一个工具做确定性验证（cpu=5&tool=read&args=<urlencoded JSON>）
  if (path === "/api/workspace/probe") {
    const url = new URL(req.url);
    const instance = url.searchParams.get("instance") ?? "";
    if (!INSTANCE_RE.test(instance)) return fail("instance 非法");
    const kind = Number(url.searchParams.get("cpu") ?? "0");
    const raw = url.searchParams.get("args");
    const tool = url.searchParams.get("tool");

    let args: unknown = undefined;
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        return fail("args 不是合法 JSON");
      }
    }
    // cpu=5 用 tool 跑工具；cpu=1 用 args.ms 指定忙等时长
    const payload = tool || args !== undefined ? { tool, args } : undefined;
    const stub = (await getAgentByName(env.ChatAgent, instance)) as unknown as WorkspaceDo;
    return json(await stub.workspaceProbe(kind, payload));
  }

  if (req.method === "GET" && path === "/api/workspace/tarball") {
    return handleTarball(new URL(req.url));
  }

  if (req.method === "GET" && path === "/api/workspace/status") {
    const instance = new URL(req.url).searchParams.get("instance") ?? "";
    if (!INSTANCE_RE.test(instance)) return fail("instance 非法");
    const stub = (await getAgentByName(env.ChatAgent, instance)) as unknown as WorkspaceDo;
    return json(await stub.workspaceStatus());
  }

  if (req.method !== "POST") return fail("方法不支持", 405);

  const body = await readJson(req);
  const instance = String(body.instance ?? "");
  if (!INSTANCE_RE.test(instance)) return fail("instance 非法");

  const stub = (await getAgentByName(env.ChatAgent, instance)) as unknown as WorkspaceDo;

  if (path === "/api/workspace/begin") {
    const owner = String(body.owner ?? "");
    const name = String(body.name ?? "");
    const ref = String(body.ref ?? "");
    if (!OWNER_RE.test(owner) || !OWNER_RE.test(name)) return fail("owner / name 含非法字符");
    if (!REF_RE.test(ref)) return fail("ref 含非法字符");

    const ingestId = crypto.randomUUID();
    const { generation } = await stub.workspaceBegin(owner, name, ref, ingestId);
    return json({ ingestId, generation });
  }

  if (path === "/api/workspace/ingest") {
    const ingestId = String(body.ingestId ?? "");
    const files = Array.isArray(body.files) ? (body.files as IngestFile[]) : null;
    if (!ingestId) return fail("缺 ingestId");
    if (!files || files.length === 0) return fail("files 为空");
    return json(await stub.workspaceIngest(ingestId, files));
  }

  if (path === "/api/workspace/finish") {
    const ingestId = String(body.ingestId ?? "");
    if (!ingestId) return fail("缺 ingestId");
    const skipped = Number(body.skipped ?? 0) || 0;
    const capped = body.capped === true;
    try {
      return json(await stub.workspaceFinish(ingestId, skipped, capped));
    } catch (e) {
      return fail((e as Error).message, 409);
    }
  }

  if (path === "/api/workspace/abort") {
    const ingestId = String(body.ingestId ?? "");
    if (!ingestId) return fail("缺 ingestId");
    await stub.workspaceFail(ingestId, String(body.error ?? "已取消"));
    return json({ ok: true });
  }

  return fail("未知的接口", 404);
}

/** 命中 /api/workspace/* 就返回响应，否则返回 null 让调用方继续走 agents 路由 */
export async function handleWorkspaceRoutes(
  req: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/workspace/")) return null;
  try {
    return await handleRequest(req, env, path);
  } catch (e) {
    return fail(`服务端错误：${(e as Error).message}`, 500);
  }
}
