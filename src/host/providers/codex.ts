/**
 * ChatGPT (Codex) subscription provider — clean-room implementation built
 * from OpenAI's public API documentation and the publicly documented Codex
 * CLI wire (authorization-code + PKCE against auth.openai.com, Bearer tokens
 * on the chatgpt.com Codex backend, OpenAI Responses API over SSE).
 *
 * Protocol nuances, both documented in README ("Security notes"):
 *  - the Codex OAuth client registers ONE fixed redirect
 *    (http://localhost:1455/auth/callback), so the loopback listener binds
 *    that exact port instead of an OS-assigned one;
 *  - the Codex backend expects the Codex CLI `originator`/product tokens, so
 *    the CLI product token is PREPENDED to the harness attribution UA and the
 *    `originator` header names the CLI family — attribution is never replaced.
 */
import { randomUUID } from "node:crypto";
import {
  attributionHeaders,
  ReasoningEffortId,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmReasoningEffortInfo,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { decodeJwtPayload, type OAuthClientConfig, type TokenSet } from "../oauth.ts";
import { sseEvents } from "../sse.ts";
import type { ProviderSession } from "../store.ts";
import type { ProviderId, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  humanizeModelId,
  type AccountFacts,
  type ImageResolver,
  type SubscriptionProvider,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public vendor endpoints and OAuth facts.
// ---------------------------------------------------------------------------

const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/wham/usage";
const CODEX_OAUTH_SCOPES = "openid profile email offline_access";
/** The one redirect URI registered for the public Codex CLI OAuth client. */
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
/** ID-token claim namespace carrying ChatGPT account facts. */
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * Public Codex CLI OAuth client id and the CLI product token the Codex
 * backend expects. Both configurable at the plugin level.
 */
export const CODEX_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_CLI_VERSION = "0.153.4";

/** Last-resort catalog when the live model list cannot be fetched. */
const FALLBACK_MODELS = ["gpt-5-codex", "gpt-5-codex-mini", "codex-mini-latest"];

/** Selectable reasoning efforts the Codex Responses wire understands. */
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type CodexEffort = (typeof CODEX_EFFORTS)[number];

export const CODEX_REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = CODEX_EFFORTS.map((id) => ({
  id: id as LlmReasoningEffortInfo["id"],
  name: id.charAt(0).toUpperCase() + id.slice(1),
}));

/** Map a harness effort id to the wire value; undefined keeps the provider default. */
export function codexEffortOf(effort: string | undefined): CodexEffort | undefined {
  return effort !== undefined && (CODEX_EFFORTS as readonly string[]).includes(effort) ? (effort as CodexEffort) : undefined;
}

// ---------------------------------------------------------------------------
// Account facts from token claims.
// ---------------------------------------------------------------------------

/** Account facts carried by the ID/access token claims (display + routing only). */
export function codexAccountFromClaims(claims: Record<string, unknown> | undefined): AccountFacts {
  const facts: AccountFacts = {};
  if (claims === undefined) return facts;
  const email = claims.email ?? claims.preferred_username;
  if (typeof email === "string") facts.email = email;
  const auth = claims[OPENAI_AUTH_CLAIM];
  if (typeof auth === "object" && auth !== null) {
    const record = auth as Record<string, unknown>;
    const accountId = record.chatgpt_account_id;
    if (typeof accountId === "string") facts.accountId = accountId;
    const plan = record.chatgpt_plan_type;
    if (typeof plan === "string") facts.plan = plan;
  }
  return facts;
}

/** Account id for the `chatgpt-account-id` header, with an access-token fallback. */
function accountIdOf(session: ProviderSession): string | undefined {
  if (typeof session.accountId === "string" && session.accountId.length > 0) return session.accountId;
  return codexAccountFromClaims(decodeJwtPayload(session.accessToken)).accountId;
}

// ---------------------------------------------------------------------------
// Request mapping: harness messages -> OpenAI Responses wire.
// ---------------------------------------------------------------------------

type ResponsesItem = Record<string, unknown>;

function buildInputItems(options: GenerateOptions, resolveImage: ImageResolver, signal: AbortSignal | undefined): Promise<ResponsesItem[]> {
  const work = options.messages.map(async (message): Promise<ResponsesItem[]> => {
    if (message.role === "system") return []; // system text goes to `instructions`
    const out: ResponsesItem[] = [];
    const parts: ResponsesItem[] = [];
    // Content parts accumulate into one message item, flushed in-place so the
    // item order always mirrors the harness content-block order.
    const flush = (): void => {
      if (parts.length > 0) {
        out.push({ type: "message", role: message.role === "assistant" ? "assistant" : "user", content: parts.splice(0, parts.length) });
      }
    };
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (message.role === "assistant") {
            out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] });
          } else {
            parts.push({ type: "input_text", text: block.text });
          }
          break;
        case "reasoning":
          // Reasoning is model-private; it is not replayed to the provider.
          break;
        case "image": {
          const stored = await resolveImage(block.attachment, signal);
          parts.push({
            type: "input_image",
            image_url: `data:${stored.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`,
          });
          break;
        }
        case "file":
          parts.push({ type: "input_text", text: "[file attachment]" });
          break;
        case "tool-call":
          flush();
          out.push({
            type: "function_call",
            call_id: String(block.id),
            name: block.name,
            arguments: block.arguments,
          });
          break;
        case "tool-result": {
          flush();
          const text = block.content
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("\n");
          out.push({
            type: "function_call_output",
            call_id: String(block.toolCallId),
            output: text,
          });
          break;
        }
      }
    }
    flush();
    return out;
  });
  return Promise.all(work).then((groups) => groups.flat());
}

/** Assemble the request body for one streamed turn (pure; exported for tests). */
export async function buildCodexBody(
  options: GenerateOptions,
  resolveImage: ImageResolver,
): Promise<Record<string, unknown>> {
  const systemParts: string[] = [];
  if (typeof options.system === "string" && options.system.length > 0) systemParts.push(options.system);
  for (const message of options.messages) {
    if (message.role !== "system") continue;
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text.length > 0) systemParts.push(text);
  }
  const body: Record<string, unknown> = {
    model: options.model,
    input: await buildInputItems(options, resolveImage, options.signal),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
    body.parallel_tool_calls = false;
  }
  const effort = codexEffortOf(options.reasoningEffort !== undefined ? String(options.reasoningEffort) : undefined);
  body.reasoning = { effort: effort ?? "medium", summary: "auto" };
  return body;
}

// ---------------------------------------------------------------------------
// Response mapping: Responses SSE -> harness StreamChunk vocabulary.
// ---------------------------------------------------------------------------

interface BlockState {
  blockType: "text" | "reasoning" | "tool-call";
  text?: string;
  id?: string;
  name?: string;
  argumentsText?: string;
}

function streamFailure(message: string, status?: number, retryAfterMs?: number): Error {
  const failure = new Error(message) as Error & { status?: number; providerRetryAfterMs?: number };
  if (status !== undefined) failure.status = status;
  if (retryAfterMs !== undefined) failure.providerRetryAfterMs = retryAfterMs;
  return failure;
}

function itemBlock(state: BlockState): ContentBlock {
  if (state.blockType === "tool-call") {
    return {
      type: "tool-call",
      id: ToolCallId(state.id ?? "call"),
      name: state.name ?? "",
      arguments: state.argumentsText ?? "",
    };
  }
  if (state.blockType === "reasoning") return { type: "reasoning", text: state.text ?? "" };
  return { type: "text", text: state.text ?? "" };
}

async function* streamTurn(
  options: GenerateOptions,
  session: ProviderSession,
  resolveImage: ImageResolver,
  cliVersion: string,
): AsyncIterable<StreamChunk> {
  const body = await buildCodexBody(options, resolveImage);
  // Opportunistic request tier: sent only when the live catalog advertises one.
  const tier = modelTiers.get(options.model);
  if (tier !== undefined) body.service_tier = tier;

  const attribution = attributionHeaders();
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      ...attribution,
      // CLI product token first; the harness attribution product token stays.
      "user-agent": `codex_cli_rs/${cliVersion} (external, cli) ${attribution["user-agent"]}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${session.accessToken}`,
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      "session_id": randomUUID(),
      ...(accountIdOf(session) !== undefined ? { "chatgpt-account-id": accountIdOf(session) as string } : {}),
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw streamFailure(
      `ChatGPT (Codex) request failed (${response.status}): ${detail.slice(0, 400)}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
  if (response.body === null) throw streamFailure("ChatGPT (Codex) response carried no body");

  const blocks = new Map<number, BlockState>();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let usageSeen = false;
  let sawToolCall = false;
  let stopReason: Extract<StreamChunk, { type: "finish" }>["reason"] = { kind: "stop" };

  for await (const { event, data } of sseEvents(response.body, options.signal)) {
    const payload = data as Record<string, any>;
    switch (event) {
      case "response.output_item.added": {
        const index = Number(payload?.output_index);
        const item = payload?.item ?? {};
        const blockType = item.type === "reasoning" ? "reasoning" : item.type === "function_call" ? "tool-call" : "text";
        const state: BlockState = { blockType };
        if (blockType === "tool-call") {
          sawToolCall = true;
          state.id = typeof item.call_id === "string" ? item.call_id : `call_${index}`;
          state.name = typeof item.name === "string" ? item.name : "";
          state.argumentsText = "";
        } else {
          state.text = "";
        }
        blocks.set(index, state);
        yield { type: "block-start", index, blockType };
        break;
      }
      case "response.output_text.delta": {
        const index = Number(payload?.output_index);
        const state = blocks.get(index);
        if (state === undefined || typeof payload?.delta !== "string") break;
        state.text = (state.text ?? "") + payload.delta;
        yield { type: "text-delta", index, text: payload.delta };
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const index = Number(payload?.output_index);
        const state = blocks.get(index);
        if (state === undefined || typeof payload?.delta !== "string") break;
        state.text = (state.text ?? "") + payload.delta;
        yield { type: "reasoning-delta", index, text: payload.delta };
        break;
      }
      case "response.function_call_arguments.delta": {
        const index = Number(payload?.output_index);
        const state = blocks.get(index);
        if (state === undefined || typeof payload?.delta !== "string") break;
        state.argumentsText = (state.argumentsText ?? "") + payload.delta;
        yield {
          type: "tool-call-delta",
          index,
          id: ToolCallId(state.id ?? `call_${index}`),
          ...(state.name !== undefined ? { name: state.name } : {}),
          argumentsDelta: payload.delta,
        };
        break;
      }
      case "response.output_item.done": {
        const index = Number(payload?.output_index);
        const state = blocks.get(index);
        if (state === undefined) break;
        blocks.delete(index);
        yield { type: "block-end", index, block: itemBlock(state) };
        break;
      }
      case "response.completed": {
        const done = payload?.response ?? {};
        const counts = done.usage ?? {};
        if (typeof counts.input_tokens === "number") {
          usage.inputTokens = counts.input_tokens;
          usage.outputTokens = typeof counts.output_tokens === "number" ? counts.output_tokens : 0;
          if (typeof counts.cached_input_tokens === "number") usage.cacheReadTokens = counts.cached_input_tokens;
          usage.totalTokens = typeof counts.total_tokens === "number" ? counts.total_tokens : usage.inputTokens + usage.outputTokens;
          usageSeen = true;
        }
        if (done.status === "incomplete" && done.incomplete_details?.reason === "max_output_tokens") {
          stopReason = { kind: "max-tokens" };
        } else {
          stopReason = sawToolCall ? { kind: "tool-calls" } : { kind: "stop" };
        }
        break;
      }
      case "response.failed": {
        const message = payload?.response?.error?.message ?? payload?.error?.message ?? "ChatGPT (Codex) stream error";
        throw streamFailure(String(message));
      }
      case "error": {
        const message = typeof payload?.message === "string" ? payload.message : "ChatGPT (Codex) stream error";
        throw streamFailure(message);
      }
      default:
        break;
    }
  }

  if (usageSeen) yield { type: "usage", usage };
  yield { type: "finish", reason: stopReason };
}

// ---------------------------------------------------------------------------
// Catalog and usage.
// ---------------------------------------------------------------------------

/** In-memory catalog cache (5 minutes). */
let catalogCache: { at: number; models: LlmModelInfo[] } | undefined;
const CATALOG_TTL_MS = 5 * 60_000;
/** Optional per-model request tier advertised by the live catalog. */
const modelTiers = new Map<string, string>();

function toModelInfo(id: string, name: string | undefined): LlmModelInfo {
  return {
    provider: "codex",
    id,
    name: name !== undefined && name.length > 0 ? name : humanizeModelId(id),
    inputModalities: ["text", "image"],
  };
}

/** Parse the live model catalog; exported for tests. */
export function parseCodexModels(payload: unknown): { models: LlmModelInfo[]; tiers: Map<string, string> } {
  const tiers = new Map<string, string>();
  const models: LlmModelInfo[] = [];
  const data = (payload as { data?: unknown })?.data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      const id = (entry as { id?: unknown })?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const name = (entry as { display_name?: unknown })?.display_name;
      models.push(toModelInfo(id, typeof name === "string" ? name : undefined));
      const tier = (entry as { service_tier?: unknown })?.service_tier;
      if (typeof tier === "string" && tier.length > 0) tiers.set(id, tier);
    }
  }
  return { models, tiers };
}

const USAGE_WINDOW_LABELS: Record<string, string> = {
  primary: "Primary window",
  secondary: "Secondary window",
  five_hour: "5-hour window",
  seven_day: "7-day window",
  weekly: "Weekly window",
  daily: "Daily window",
};

function toWindow(id: string, record: Record<string, unknown>): UsageWindow | undefined {
  const percent = record.used_percent ?? record.utilization ?? record.percent_used ?? record.usage_percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  const window: UsageWindow = {
    id,
    label: USAGE_WINDOW_LABELS[id] ?? id,
    usedPercent: Math.max(0, Math.min(100, percent)),
  };
  const resets = record.resets_at ?? record.reset_at ?? record.expires_at ?? record.resetsAt;
  if (typeof resets === "number" && Number.isFinite(resets)) {
    window.resetsAt = resets > 1e12 ? resets : resets * 1000;
  } else if (typeof resets === "string") {
    const parsed = Date.parse(resets);
    if (Number.isFinite(parsed)) window.resetsAt = parsed;
  }
  return window;
}

/**
 * Parse subscription usage windows from the usage endpoint, tolerating the
 * flat record and nested (`windows`/`rate_limits`) shapes; exported for tests.
 */
export function parseCodexUsageWindows(payload: unknown): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 3 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const window = toWindow(key, value as Record<string, unknown>);
      if (window !== undefined && !seen.has(window.id)) {
        seen.add(window.id);
        windows.push(window);
      } else {
        visit(value, depth + 1);
      }
    }
  };
  visit(payload, 0);
  return windows;
}

// ---------------------------------------------------------------------------
// Provider assembly.
// ---------------------------------------------------------------------------

export interface CodexProviderConfig {
  clientId?: string;
  clientVersion?: string;
}

export function createCodexProvider(config: CodexProviderConfig = {}): SubscriptionProvider {
  const cliVersion = config.clientVersion !== undefined && config.clientVersion.length > 0 ? config.clientVersion : CODEX_CLI_VERSION;
  const oauth: OAuthClientConfig = {
    authorizeUrl: CODEX_AUTHORIZE_URL,
    tokenUrl: CODEX_TOKEN_URL,
    clientId: config.clientId !== undefined && config.clientId.length > 0 ? config.clientId : CODEX_DEFAULT_CLIENT_ID,
    scopes: CODEX_OAUTH_SCOPES,
    redirectUri: CODEX_REDIRECT_URI,
    tokenFormat: "json",
  };

  function authHeaders(session: ProviderSession): Record<string, string> {
    const attribution = attributionHeaders();
    return {
      ...attribution,
      "user-agent": `codex_cli_rs/${cliVersion} (external, cli) ${attribution["user-agent"]}`,
      authorization: `Bearer ${session.accessToken}`,
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
    };
  }

  return {
    id: "codex",
    displayName: "ChatGPT (Codex)",
    oauth,
    supportsUsage: true,

    async accountFromTokens(tokens: TokenSet): Promise<AccountFacts> {
      const claims = tokens.idToken !== undefined ? decodeJwtPayload(tokens.idToken) : decodeJwtPayload(tokens.accessToken);
      return codexAccountFromClaims(claims);
    },

    async listModels(session, signal) {
      if (session === undefined) return [];
      const cached = catalogCache;
      if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
      try {
        const response = await fetch(CODEX_MODELS_URL, {
          headers: { ...authHeaders(session), accept: "application/json" },
          signal,
        });
        if (!response.ok) throw new Error(`model list ${response.status}`);
        const { models, tiers } = parseCodexModels(await response.json());
        if (models.length > 0) {
          for (const [id, tier] of tiers) modelTiers.set(id, tier);
          catalogCache = { at: Date.now(), models };
          return models;
        }
        throw new Error("model list empty");
      } catch {
        const fallback = FALLBACK_MODELS.map((id) => toModelInfo(id, undefined));
        catalogCache = { at: Date.now(), models: fallback };
        return fallback;
      }
    },

    async resolveModel(model) {
      return {
        provider: "codex",
        id: model,
        name: humanizeModelId(model),
        inputModalities: ["text", "image"],
        context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
        defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        systemPromptUpdate: "in-history",
        reasoning: { efforts: CODEX_REASONING_EFFORTS, defaultEffort: ReasoningEffortId("medium") },
      };
    },

    stream(options, session, resolveImage) {
      return streamTurn(options, session, resolveImage, cliVersion);
    },

    async fetchUsage(session, signal): Promise<UsageReport> {
      const headers = { ...authHeaders(session), accept: "application/json" };
      const accountId = accountIdOf(session);
      const response = await fetch(CODEX_USAGE_URL, {
        headers: accountId !== undefined ? { ...headers, "chatgpt-account-id": accountId } : headers,
        signal,
      });
      if (!response.ok) throw new Error(`ChatGPT (Codex) usage request failed (${response.status})`);
      return {
        provider: "codex",
        supported: true,
        windows: parseCodexUsageWindows(await response.json()),
        fetchedAt: Date.now(),
      };
    },
  };
}

/** Provider id, for the registry type. */
export const CODEX_ID: ProviderId = "codex";
