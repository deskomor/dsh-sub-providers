/**
 * Claude (Anthropic) subscription provider — clean-room implementation built
 * from Anthropic's public API documentation and publicly documented Claude
 * Code OAuth facts (authorization-code + PKCE against claude.ai, hosted
 * copy/paste callback, Bearer tokens on api.anthropic.com with the
 * `oauth-2025-04-20` beta header).
 *
 * Two protocol nuances, both documented in README ("Security notes"):
 *  - this OAuth client registers ONE hosted redirect
 *    (https://console.anthropic.com/oauth/code/callback) and rejects loopback
 *    URIs, so the login is copy/paste: the callback page shows the code and
 *    the user pastes it back (`code=true` authorize mode; no local server);
 *  - the subscription endpoint expects requests presenting as the Claude Code
 *    CLI, so the CLI product token is PREPENDED to the harness attribution
 *    `User-Agent` — attribution is always present, never replaced.
 */
import { attributionHeaders, ToolCallId, type ContentBlock, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk, type TokenUsage } from "@deepseek-ai/dsh-llm";
import type { OAuthClientConfig, TokenSet } from "../oauth.ts";
import { decodeJwtPayload } from "../oauth.ts";
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

const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
// Token endpoint of the working black-box spec; console.anthropic.com/v1/oauth/token
// is the publicly documented alternative for the same client.
const CLAUDE_TOKEN_URL = "https://claude.ai/v1/oauth/token";
/** The one redirect URI registered for this client: a hosted copy/paste page. */
export const CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?beta=true";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_API_VERSION = "2023-06-01";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";

/**
 * Public Claude Code OAuth client id (documented in community tooling) and the
 * CLI product token the subscription endpoint expects. Both are configurable
 * at the plugin level so deployments are never pinned to one value.
 */
export const CLAUDE_DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CLI_VERSION = "2.1.263";

/** Last-resort catalog when the live model list cannot be fetched. */
const FALLBACK_MODELS = ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"];

const USAGE_WINDOWS: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "7-day window",
  seven_day_opus: "7-day window (Opus)",
  seven_day_sonnet: "7-day window (Sonnet)",
};

// ---------------------------------------------------------------------------
// Request mapping: harness messages -> Anthropic Messages wire.
// ---------------------------------------------------------------------------

type AnthropicBlock = Record<string, unknown>;

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One wire message with a role and content blocks. */
interface WireMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function pushBlock(message: WireMessage | undefined, role: WireMessage["role"], block: AnthropicBlock): WireMessage {
  if (message !== undefined && message.role === role) {
    message.content.push(block);
    return message;
  }
  return { role, content: [block] };
}

async function userBlocks(
  blocks: readonly ContentBlock[],
  resolveImage: ImageResolver,
  signal: AbortSignal | undefined,
): Promise<AnthropicBlock[]> {
  const out: AnthropicBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        // Reasoning is model-private; it is not replayed to the provider.
        break;
      case "image": {
        const stored = await resolveImage(block.attachment, signal);
        out.push({
          type: "image",
          source: {
            type: "base64",
            media_type: stored.mediaType,
            data: Buffer.from(stored.data).toString("base64"),
          },
        });
        break;
      }
      case "file":
        out.push({ type: "text", text: "[file attachment]" });
        break;
      case "tool-call":
        out.push({
          type: "tool_use",
          id: String(block.id),
          name: block.name,
          input: safeJsonObject(block.arguments),
        });
        break;
      case "tool-result": {
        const content: AnthropicBlock[] = [];
        for (const part of block.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text });
        }
        out.push({
          type: "tool_result",
          tool_use_id: String(block.toolCallId),
          content: content.length > 0 ? content : [{ type: "text", text: "" }],
          ...(block.isError === true ? { is_error: true } : {}),
        });
        break;
      }
    }
  }
  return out;
}

/** Map harness messages to Anthropic wire messages, merging same-role runs. */
async function buildWireMessages(
  options: GenerateOptions,
  resolveImage: ImageResolver,
): Promise<{ system: string; messages: WireMessage[] }> {
  const systemParts: string[] = [];
  if (typeof options.system === "string" && options.system.length > 0) systemParts.push(options.system);
  const messages: WireMessage[] = [];
  for (const message of options.messages) {
    if (message.role === "system") {
      const text = message.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    const role: WireMessage["role"] = message.role === "assistant" ? "assistant" : "user";
    const blocks = message.role === "assistant"
      ? message.content.flatMap((block): AnthropicBlock[] => {
          switch (block.type) {
            case "text":
              return [{ type: "text", text: block.text }];
            case "tool-call":
              return [{ type: "tool_use", id: String(block.id), name: block.name, input: safeJsonObject(block.arguments) }];
            default:
              return [];
          }
        })
      : await userBlocks(message.content, resolveImage, options.signal);
    if (blocks.length === 0) continue;
    const last = messages[messages.length - 1];
    const target = last !== undefined && last.role === role ? last : undefined;
    if (target !== undefined) target.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  return { system: systemParts.join("\n\n"), messages };
}

function stopReasonOf(reason: string | undefined): Extract<StreamChunk, { type: "finish" }>["reason"] {
  switch (reason) {
    case "tool_use":
      return { kind: "tool-calls" };
    case "max_tokens":
      return { kind: "max-tokens" };
    default:
      return { kind: "stop" };
  }
}

// ---------------------------------------------------------------------------
// Response mapping: Anthropic SSE -> harness StreamChunk vocabulary.
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

async function* streamTurn(
  options: GenerateOptions,
  session: ProviderSession,
  resolveImage: ImageResolver,
): AsyncIterable<StreamChunk> {
  const { system, messages } = await buildWireMessages(options, resolveImage);
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages,
    stream: true,
  };
  if (system.length > 0) body.system = system;
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.stop !== undefined && options.stop.length > 0) body.stop_sequences = options.stop;

  const attribution = attributionHeaders();
  const response = await fetch(CLAUDE_MESSAGES_URL, {
    method: "POST",
    headers: {
      ...attribution,
      // The CLI product token comes first; the harness attribution product
      // token stays in the same header value.
      "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli) ${attribution["user-agent"]}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${session.accessToken}`,
      "anthropic-version": CLAUDE_API_VERSION,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw streamFailure(
      `Claude request failed (${response.status}): ${detail.slice(0, 400)}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
  if (response.body === null) throw streamFailure("Claude response carried no body");

  const blocks = new Map<number, BlockState>();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let usageSeen = false;
  let stopReason: Extract<StreamChunk, { type: "finish" }>["reason"] | undefined;

  for await (const { event, data } of sseEvents(response.body, options.signal)) {
    const payload = data as Record<string, any>;
    switch (event) {
      case "message_start": {
        const start = payload?.message?.usage ?? {};
        if (typeof start.input_tokens === "number") usage.inputTokens = start.input_tokens;
        if (typeof start.cache_read_input_tokens === "number") usage.cacheReadTokens = start.cache_read_input_tokens;
        if (typeof start.cache_creation_input_tokens === "number") usage.cacheWriteTokens = start.cache_creation_input_tokens;
        usageSeen = true;
        break;
      }
      case "content_block_start": {
        const index = Number(payload?.index);
        const block = payload?.content_block ?? {};
        const blockType = block.type === "thinking" ? "reasoning" : block.type === "tool_use" ? "tool-call" : "text";
        const state: BlockState = { blockType };
        if (blockType === "tool-call") {
          state.id = typeof block.id === "string" ? block.id : `toolu_${index}`;
          state.name = typeof block.name === "string" ? block.name : "";
          state.argumentsText = "";
        } else {
          state.text = "";
        }
        blocks.set(index, state);
        yield { type: "block-start", index, blockType };
        break;
      }
      case "content_block_delta": {
        const index = Number(payload?.index);
        const state = blocks.get(index);
        const delta = payload?.delta ?? {};
        if (state === undefined) break;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          state.text = (state.text ?? "") + delta.text;
          yield { type: "text-delta", index, text: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          state.text = (state.text ?? "") + delta.thinking;
          yield { type: "reasoning-delta", index, text: delta.thinking };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          state.argumentsText = (state.argumentsText ?? "") + delta.partial_json;
          yield {
            type: "tool-call-delta",
            index,
            id: ToolCallId(state.id ?? `toolu_${index}`),
            ...(state.name !== undefined ? { name: state.name } : {}),
            argumentsDelta: delta.partial_json,
          };
        }
        break;
      }
      case "content_block_stop": {
        const index = Number(payload?.index);
        const state = blocks.get(index);
        if (state === undefined) break;
        blocks.delete(index);
        let block: ContentBlock;
        if (state.blockType === "tool-call") {
          block = {
            type: "tool-call",
            id: ToolCallId(state.id ?? `toolu_${index}`),
            name: state.name ?? "",
            arguments: state.argumentsText ?? "",
          };
        } else if (state.blockType === "reasoning") {
          block = { type: "reasoning", text: state.text ?? "" };
        } else {
          block = { type: "text", text: state.text ?? "" };
        }
        yield { type: "block-end", index, block };
        break;
      }
      case "message_delta": {
        const delta = payload?.delta ?? {};
        if (typeof delta.stop_reason === "string") stopReason = stopReasonOf(delta.stop_reason);
        const deltaUsage = payload?.usage ?? {};
        if (typeof deltaUsage.output_tokens === "number") {
          usage.outputTokens = deltaUsage.output_tokens;
          usage.totalTokens = usage.inputTokens + usage.outputTokens;
          usageSeen = true;
        }
        break;
      }
      case "error": {
        const message = typeof payload?.error?.message === "string" ? payload.error.message : "Claude stream error";
        throw streamFailure(message);
      }
      default:
        break;
    }
  }

  if (usageSeen) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    yield { type: "usage", usage };
  }
  yield { type: "finish", reason: stopReason ?? { kind: "stop" } };
}

// ---------------------------------------------------------------------------
// Catalog and usage.
// ---------------------------------------------------------------------------

/** In-memory catalog cache (5 minutes). */
let catalogCache: { at: number; models: LlmModelInfo[] } | undefined;
const CATALOG_TTL_MS = 5 * 60_000;

function toModelInfo(id: string, name: string | undefined): LlmModelInfo {
  return {
    provider: "claude",
    id,
    name: name !== undefined && name.length > 0 ? name : humanizeModelId(id),
    inputModalities: ["text", "image"],
  };
}

function parseUsageWindows(payload: unknown): UsageWindow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const utilization = record.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    const window: UsageWindow = {
      id: key,
      label: USAGE_WINDOWS[key] ?? key,
      usedPercent: Math.max(0, Math.min(100, utilization)),
    };
    const resets = record.resets_at ?? record.resetsAt;
    if (typeof resets === "number" && Number.isFinite(resets)) {
      window.resetsAt = resets > 1e12 ? resets : resets * 1000;
    } else if (typeof resets === "string") {
      const parsed = Date.parse(resets);
      if (Number.isFinite(parsed)) window.resetsAt = parsed;
    }
    windows.push(window);
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Provider assembly.
// ---------------------------------------------------------------------------

export function createClaudeProvider(clientId: string = CLAUDE_DEFAULT_CLIENT_ID): SubscriptionProvider {
  const oauth: OAuthClientConfig = {
    authorizeUrl: CLAUDE_AUTHORIZE_URL,
    tokenUrl: CLAUDE_TOKEN_URL,
    clientId,
    scopes: CLAUDE_OAUTH_SCOPES,
    redirectUri: CLAUDE_REDIRECT_URI,
    loginFlow: "code-paste",
    // `code=true` switches the hosted callback page to copy/paste mode.
    authorizeParams: { code: "true" },
    tokenFormat: "json",
  };

  function authHeaders(session: ProviderSession): Record<string, string> {
    const attribution = attributionHeaders();
    return {
      ...attribution,
      "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli) ${attribution["user-agent"]}`,
      authorization: `Bearer ${session.accessToken}`,
      "anthropic-version": CLAUDE_API_VERSION,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
    };
  }

  return {
    id: "claude",
    displayName: "Claude",
    oauth,
    supportsUsage: true,

    async accountFromTokens(tokens: TokenSet, signal?: AbortSignal): Promise<AccountFacts> {
      const facts: AccountFacts = {};
      const claims = tokens.idToken !== undefined ? decodeJwtPayload(tokens.idToken) : undefined;
      const claimEmail = claims?.email ?? claims?.preferred_username;
      if (typeof claimEmail === "string") facts.email = claimEmail;
      try {
        const response = await fetch(CLAUDE_PROFILE_URL, {
          headers: { ...authHeaders({ accessToken: tokens.accessToken, refreshToken: "", expiresAt: 0 }), accept: "application/json" },
          signal,
        });
        if (response.ok) {
          const profile = (await response.json()) as Record<string, any>;
          const email = profile?.email_address ?? profile?.email ?? profile?.account?.email_address;
          if (typeof email === "string") facts.email = email;
          const plan = profile?.organization?.billing_type ?? profile?.subscription_type ?? profile?.plan;
          if (typeof plan === "string") facts.plan = plan;
        }
      } catch {
        // profile is display metadata only; login still succeeds without it
      }
      return facts;
    },

    async listModels(session, signal) {
      if (session === undefined) return [];
      const cached = catalogCache;
      if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
      try {
        const response = await fetch(CLAUDE_MODELS_URL, {
          headers: { ...authHeaders(session), accept: "application/json" },
          signal,
        });
        if (!response.ok) throw new Error(`model list ${response.status}`);
        const payload = (await response.json()) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
        const models = (payload.data ?? [])
          .filter((entry) => typeof entry.id === "string")
          .map((entry) => toModelInfo(entry.id as string, typeof entry.display_name === "string" ? entry.display_name : undefined));
        if (models.length > 0) {
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
        provider: "claude",
        id: model,
        name: humanizeModelId(model),
        inputModalities: ["text", "image"],
        context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
        defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        systemPromptUpdate: "in-history",
      };
    },

    stream(options, session, resolveImage) {
      return streamTurn(options, session, resolveImage);
    },

    async fetchUsage(session, signal): Promise<UsageReport> {
      const response = await fetch(CLAUDE_USAGE_URL, {
        headers: { ...authHeaders(session), accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error(`Claude usage request failed (${response.status})`);
      const payload = await response.json();
      return {
        provider: "claude",
        supported: true,
        windows: parseUsageWindows(payload),
        fetchedAt: Date.now(),
      };
    },
  };
}

/** Provider id, for the registry type. */
export const CLAUDE_ID: ProviderId = "claude";
