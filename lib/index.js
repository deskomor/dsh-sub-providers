/* dsh-sub-providers host half — clean-room build. */

// src/host/index.ts
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";

// src/host/adapter.ts
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
var SubscriptionAdapter = class extends LlmAdapter {
  deps;
  constructor(deps) {
    super();
    this.deps = deps;
  }
  must(provider) {
    const found = this.deps.provider(provider);
    if (found === void 0) throw new Error(`dsh-sub-providers: unknown provider route "${provider}"`);
    return found;
  }
  providerInfo(provider) {
    return { id: provider, name: this.must(provider).displayName };
  }
  providerRetryPolicy() {
    return void 0;
  }
  imageRequestPricing() {
    return void 0;
  }
  async listModels(provider) {
    return this.must(provider).listModels(await this.deps.session(provider));
  }
  resolveModel(provider, model, signal) {
    return this.must(provider).resolveModel(model, signal);
  }
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return {
      model: resolved,
      stream: (options) => this.stream(options)
    };
  }
  async *stream(options) {
    const provider = this.must(options.provider);
    const session = await this.deps.session(options.provider);
    if (session === void 0) {
      throw new Error(`dsh-sub-providers: no ${provider.displayName} login for route "${options.provider}"`);
    }
    yield* provider.stream(options, session, this.deps.resolveImage);
  }
};

// src/host/oauth.ts
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
var LoginCancelledError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginCancelledError";
  }
};
var OAuthError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
  }
};
function base64url(buffer) {
  return buffer.toString("base64url");
}
function makePkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}
function makeState() {
  return base64url(randomBytes(24));
}
function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length < 2) return void 0;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function toTokenSet(payload, previousRefreshToken) {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthError("token endpoint response carried no access_token", 502);
  }
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : previousRefreshToken ?? "";
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const set = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.trunc(expiresIn * 1e3)
  };
  if (typeof payload.scope === "string") set.scopes = payload.scope;
  if (typeof payload.id_token === "string") set.idToken = payload.id_token;
  return set;
}
async function requestTokens(config, body, previousRefreshToken, signal) {
  const json = config.tokenFormat === "json";
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
      ...attributionHeaders()
    },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    signal
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
  }
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : response.statusText;
    throw new OAuthError(`token endpoint refused the request (${response.status}): ${detail}`, response.status);
  }
  return toTokenSet(payload, previousRefreshToken);
}
function exchangeAuthorizationCode(config, input) {
  const body = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: config.clientId,
    code_verifier: input.codeVerifier
  };
  if (input.state !== void 0) body.state = input.state;
  return requestTokens(config, body, void 0, input.signal);
}
function refreshTokens(config, refreshToken, signal) {
  return requestTokens(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId
    },
    refreshToken,
    signal
  );
}
function buildAuthorizeUrl(config, redirectUri, challenge, state) {
  return `${config.authorizeUrl}?${new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...config.authorizeParams
  }).toString()}`;
}
function startLoopbackLogin(config, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 6e4;
  const fixedRedirect = options.redirectUri ?? config.redirectUri;
  const fixedUrl = fixedRedirect !== void 0 ? new URL(fixedRedirect) : void 0;
  const callbackPath = fixedUrl !== void 0 ? fixedUrl.pathname : options.callbackPath ?? "/oauth/callback";
  const listenPort = fixedUrl !== void 0 ? Number(fixedUrl.port) : 0;
  const { verifier, challenge } = makePkce();
  const state = makeState();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let finish = () => void 0;
    let boundRedirect = "";
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (error !== null) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Sign-in was refused."));
        finish(new LoginCancelledError(`provider returned error: ${error}`));
        return;
      }
      if (returnedState !== state || code === null) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Invalid sign-in response."));
        finish(new LoginCancelledError("state mismatch or missing code in the OAuth callback"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Sign-in complete. You can close this window."));
      exchangeAuthorizationCode(config, { code, redirectUri: boundRedirect, codeVerifier: verifier }).then((tokens) => finish(tokens)).catch((cause) => finish(cause instanceof Error ? cause : new Error(String(cause))));
    });
    server.on("error", (cause) => {
      if (!settled) {
        settled = true;
        if (timer !== void 0) clearTimeout(timer);
        reject(cause);
      }
    });
    server.listen(listenPort, "127.0.0.1", () => {
      const port = server.address().port;
      boundRedirect = fixedRedirect ?? `http://127.0.0.1:${port}${callbackPath}`;
      const authorizeUrl = buildAuthorizeUrl(config, boundRedirect, challenge, state);
      const completed = new Promise((resolveCompletion, rejectCompletion) => {
        finish = (result) => {
          if (settled) return;
          settled = true;
          if (timer !== void 0) clearTimeout(timer);
          server.close();
          if (result instanceof Error) rejectCompletion(result);
          else resolveCompletion(result);
        };
      });
      timer = setTimeout(() => finish(new LoginCancelledError("login timed out")), timeoutMs);
      const cancel = () => finish(new LoginCancelledError("login cancelled"));
      if (settled) return;
      resolve({
        authorizeUrl,
        redirectUri: boundRedirect,
        expiresAt: Date.now() + timeoutMs,
        completed,
        cancel
      });
    });
  });
}
function page(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>dsh-sub-providers</title></head><body><p>${message}</p></body></html>`;
}
function startCodePasteLogin(config, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 6e4;
  const redirectUri = config.redirectUri;
  if (redirectUri === void 0) {
    return Promise.reject(new Error("code-paste login requires the client's registered redirectUri"));
  }
  const { verifier, challenge } = makePkce();
  const state = verifier;
  const authorizeUrl = buildAuthorizeUrl(config, redirectUri, challenge, state);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let finish = () => void 0;
    const completed = new Promise((resolveCompletion, rejectCompletion) => {
      finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== void 0) clearTimeout(timer);
        if (result instanceof Error) rejectCompletion(result);
        else resolveCompletion(result);
      };
    });
    timer = setTimeout(() => finish(new LoginCancelledError("login timed out")), timeoutMs);
    resolve({
      authorizeUrl,
      redirectUri,
      expiresAt: Date.now() + timeoutMs,
      completed,
      submit: (raw) => {
        const trimmed = raw.trim();
        const hash = trimmed.indexOf("#");
        const code = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
        const returnedState = hash >= 0 ? trimmed.slice(hash + 1) : void 0;
        if (code.length === 0) {
          finish(new LoginCancelledError("no authorization code supplied"));
          return;
        }
        exchangeAuthorizationCode(config, {
          code,
          redirectUri,
          codeVerifier: verifier,
          state: returnedState ?? state
        }).then((tokens) => finish(tokens)).catch((cause) => finish(cause instanceof Error ? cause : new Error(String(cause))));
      },
      cancel: () => finish(new LoginCancelledError("login cancelled"))
    });
  });
}

// src/host/providers/claude.ts
import { attributionHeaders as attributionHeaders2, ToolCallId } from "@deepseek-ai/dsh-llm";

// src/host/sse.ts
function parseEvent(raw) {
  let event = "message";
  let dataText = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataText += line.slice("data:".length).trim();
  }
  if (dataText.length === 0) return void 0;
  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return void 0;
  }
}
async function* sseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted === true) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary !== null) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const parsed = parseEvent(raw);
        if (parsed !== void 0) yield parsed;
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    await reader.cancel().catch(() => void 0);
  }
}

// src/host/providers/types.ts
function humanizeModelId(id) {
  return id.split("-").map((part) => part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}
var DEFAULT_CONTEXT_WINDOW = 2e5;
var DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// src/host/providers/claude.ts
var CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
var CLAUDE_TOKEN_URL = "https://claude.ai/v1/oauth/token";
var CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
var CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
var CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models?beta=true";
var CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
var CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
var CLAUDE_API_VERSION = "2023-06-01";
var CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
var CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";
var CLAUDE_DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
var CLAUDE_CLI_VERSION = "2.1.263";
var FALLBACK_MODELS = ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"];
var USAGE_WINDOWS = {
  five_hour: "5-hour window",
  seven_day: "7-day window",
  seven_day_opus: "7-day window (Opus)",
  seven_day_sonnet: "7-day window (Sonnet)"
};
function safeJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function userBlocks(blocks, resolveImage, signal) {
  const out = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "reasoning":
        break;
      case "image": {
        const stored = await resolveImage(block.attachment, signal);
        out.push({
          type: "image",
          source: {
            type: "base64",
            media_type: stored.mediaType,
            data: Buffer.from(stored.data).toString("base64")
          }
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
          input: safeJsonObject(block.arguments)
        });
        break;
      case "tool-result": {
        const content = [];
        for (const part of block.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text });
        }
        out.push({
          type: "tool_result",
          tool_use_id: String(block.toolCallId),
          content: content.length > 0 ? content : [{ type: "text", text: "" }],
          ...block.isError === true ? { is_error: true } : {}
        });
        break;
      }
    }
  }
  return out;
}
async function buildWireMessages(options, resolveImage) {
  const systemParts = [];
  if (typeof options.system === "string" && options.system.length > 0) systemParts.push(options.system);
  const messages = [];
  for (const message of options.messages) {
    if (message.role === "system") {
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const blocks = message.role === "assistant" ? message.content.flatMap((block) => {
      switch (block.type) {
        case "text":
          return [{ type: "text", text: block.text }];
        case "tool-call":
          return [{ type: "tool_use", id: String(block.id), name: block.name, input: safeJsonObject(block.arguments) }];
        default:
          return [];
      }
    }) : await userBlocks(message.content, resolveImage, options.signal);
    if (blocks.length === 0) continue;
    const last = messages[messages.length - 1];
    const target = last !== void 0 && last.role === role ? last : void 0;
    if (target !== void 0) target.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  return { system: systemParts.join("\n\n"), messages };
}
function stopReasonOf(reason) {
  switch (reason) {
    case "tool_use":
      return { kind: "tool-calls" };
    case "max_tokens":
      return { kind: "max-tokens" };
    default:
      return { kind: "stop" };
  }
}
function streamFailure(message, status, retryAfterMs) {
  const failure = new Error(message);
  if (status !== void 0) failure.status = status;
  if (retryAfterMs !== void 0) failure.providerRetryAfterMs = retryAfterMs;
  return failure;
}
async function* streamTurn(options, session, resolveImage) {
  const { system, messages } = await buildWireMessages(options, resolveImage);
  const body = {
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages,
    stream: true
  };
  if (system.length > 0) body.system = system;
  if (options.tools !== void 0 && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }
  if (options.temperature !== void 0) body.temperature = options.temperature;
  if (options.stop !== void 0 && options.stop.length > 0) body.stop_sequences = options.stop;
  const attribution = attributionHeaders2();
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
      "anthropic-beta": CLAUDE_OAUTH_BETA
    },
    body: JSON.stringify(body),
    signal: options.signal
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw streamFailure(
      `Claude request failed (${response.status}): ${detail.slice(0, 400)}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1e3 : void 0
    );
  }
  if (response.body === null) throw streamFailure("Claude response carried no body");
  const blocks = /* @__PURE__ */ new Map();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let usageSeen = false;
  let stopReason;
  for await (const { event, data } of sseEvents(response.body, options.signal)) {
    const payload = data;
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
        const state = { blockType };
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
        if (state === void 0) break;
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
            ...state.name !== void 0 ? { name: state.name } : {},
            argumentsDelta: delta.partial_json
          };
        }
        break;
      }
      case "content_block_stop": {
        const index = Number(payload?.index);
        const state = blocks.get(index);
        if (state === void 0) break;
        blocks.delete(index);
        let block;
        if (state.blockType === "tool-call") {
          block = {
            type: "tool-call",
            id: ToolCallId(state.id ?? `toolu_${index}`),
            name: state.name ?? "",
            arguments: state.argumentsText ?? ""
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
var catalogCache;
var CATALOG_TTL_MS = 5 * 6e4;
function toModelInfo(id, name2) {
  return {
    provider: "claude",
    id,
    name: name2 !== void 0 && name2.length > 0 ? name2 : humanizeModelId(id),
    inputModalities: ["text", "image"]
  };
}
function parseUsageWindows(payload) {
  if (typeof payload !== "object" || payload === null) return [];
  const windows = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value;
    const utilization = record.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    const window = {
      id: key,
      label: USAGE_WINDOWS[key] ?? key,
      usedPercent: Math.max(0, Math.min(100, utilization))
    };
    const resets = record.resets_at ?? record.resetsAt;
    if (typeof resets === "number" && Number.isFinite(resets)) {
      window.resetsAt = resets > 1e12 ? resets : resets * 1e3;
    } else if (typeof resets === "string") {
      const parsed = Date.parse(resets);
      if (Number.isFinite(parsed)) window.resetsAt = parsed;
    }
    windows.push(window);
  }
  return windows;
}
function createClaudeProvider(clientId = CLAUDE_DEFAULT_CLIENT_ID) {
  const oauth = {
    authorizeUrl: CLAUDE_AUTHORIZE_URL,
    tokenUrl: CLAUDE_TOKEN_URL,
    clientId,
    scopes: CLAUDE_OAUTH_SCOPES,
    redirectUri: CLAUDE_REDIRECT_URI,
    loginFlow: "code-paste",
    // `code=true` switches the hosted callback page to copy/paste mode.
    authorizeParams: { code: "true" },
    tokenFormat: "json"
  };
  function authHeaders(session) {
    const attribution = attributionHeaders2();
    return {
      ...attribution,
      "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli) ${attribution["user-agent"]}`,
      authorization: `Bearer ${session.accessToken}`,
      "anthropic-version": CLAUDE_API_VERSION,
      "anthropic-beta": CLAUDE_OAUTH_BETA
    };
  }
  return {
    id: "claude",
    displayName: "Claude",
    oauth,
    supportsUsage: true,
    async accountFromTokens(tokens, signal) {
      const facts = {};
      const claims = tokens.idToken !== void 0 ? decodeJwtPayload(tokens.idToken) : void 0;
      const claimEmail = claims?.email ?? claims?.preferred_username;
      if (typeof claimEmail === "string") facts.email = claimEmail;
      try {
        const response = await fetch(CLAUDE_PROFILE_URL, {
          headers: { ...authHeaders({ accessToken: tokens.accessToken, refreshToken: "", expiresAt: 0 }), accept: "application/json" },
          signal
        });
        if (response.ok) {
          const profile = await response.json();
          const email = profile?.email_address ?? profile?.email ?? profile?.account?.email_address;
          if (typeof email === "string") facts.email = email;
          const plan = profile?.organization?.billing_type ?? profile?.subscription_type ?? profile?.plan;
          if (typeof plan === "string") facts.plan = plan;
        }
      } catch {
      }
      return facts;
    },
    async listModels(session, signal) {
      if (session === void 0) return [];
      const cached = catalogCache;
      if (cached !== void 0 && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models;
      try {
        const response = await fetch(CLAUDE_MODELS_URL, {
          headers: { ...authHeaders(session), accept: "application/json" },
          signal
        });
        if (!response.ok) throw new Error(`model list ${response.status}`);
        const payload = await response.json();
        const models = (payload.data ?? []).filter((entry) => typeof entry.id === "string").map((entry) => toModelInfo(entry.id, typeof entry.display_name === "string" ? entry.display_name : void 0));
        if (models.length > 0) {
          catalogCache = { at: Date.now(), models };
          return models;
        }
        throw new Error("model list empty");
      } catch {
        const fallback = FALLBACK_MODELS.map((id) => toModelInfo(id, void 0));
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
        systemPromptUpdate: "in-history"
      };
    },
    stream(options, session, resolveImage) {
      return streamTurn(options, session, resolveImage);
    },
    async fetchUsage(session, signal) {
      const response = await fetch(CLAUDE_USAGE_URL, {
        headers: { ...authHeaders(session), accept: "application/json" },
        signal
      });
      if (!response.ok) throw new Error(`Claude usage request failed (${response.status})`);
      const payload = await response.json();
      return {
        provider: "claude",
        supported: true,
        windows: parseUsageWindows(payload),
        fetchedAt: Date.now()
      };
    }
  };
}

// src/host/providers/codex.ts
import { randomUUID } from "node:crypto";
import {
  attributionHeaders as attributionHeaders3,
  ReasoningEffortId,
  ToolCallId as ToolCallId2
} from "@deepseek-ai/dsh-llm";
var CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
var CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
var CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
var CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
var CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/wham/usage";
var CODEX_OAUTH_SCOPES = "openid profile email offline_access";
var CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
var OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
var CODEX_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var CODEX_CLI_VERSION = "0.153.4";
var FALLBACK_MODELS2 = ["gpt-5-codex", "gpt-5-codex-mini", "codex-mini-latest"];
var CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
var CODEX_REASONING_EFFORTS = CODEX_EFFORTS.map((id) => ({
  id,
  name: id.charAt(0).toUpperCase() + id.slice(1)
}));
function codexEffortOf(effort) {
  return effort !== void 0 && CODEX_EFFORTS.includes(effort) ? effort : void 0;
}
function codexAccountFromClaims(claims) {
  const facts = {};
  if (claims === void 0) return facts;
  const email = claims.email ?? claims.preferred_username;
  if (typeof email === "string") facts.email = email;
  const auth = claims[OPENAI_AUTH_CLAIM];
  if (typeof auth === "object" && auth !== null) {
    const record = auth;
    const accountId = record.chatgpt_account_id;
    if (typeof accountId === "string") facts.accountId = accountId;
    const plan = record.chatgpt_plan_type;
    if (typeof plan === "string") facts.plan = plan;
  }
  return facts;
}
function accountIdOf(session) {
  if (typeof session.accountId === "string" && session.accountId.length > 0) return session.accountId;
  return codexAccountFromClaims(decodeJwtPayload(session.accessToken)).accountId;
}
function buildInputItems(options, resolveImage, signal) {
  const work = options.messages.map(async (message) => {
    if (message.role === "system") return [];
    const out = [];
    const parts = [];
    const flush = () => {
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
          break;
        case "image": {
          const stored = await resolveImage(block.attachment, signal);
          parts.push({
            type: "input_image",
            image_url: `data:${stored.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`
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
            arguments: block.arguments
          });
          break;
        case "tool-result": {
          flush();
          const text = block.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
          out.push({
            type: "function_call_output",
            call_id: String(block.toolCallId),
            output: text
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
async function buildCodexBody(options, resolveImage) {
  const systemParts = [];
  if (typeof options.system === "string" && options.system.length > 0) systemParts.push(options.system);
  for (const message of options.messages) {
    if (message.role !== "system") continue;
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (text.length > 0) systemParts.push(text);
  }
  const body = {
    model: options.model,
    input: await buildInputItems(options, resolveImage, options.signal),
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  };
  if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");
  if (options.tools !== void 0 && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false
    }));
    body.parallel_tool_calls = false;
  }
  const effort = codexEffortOf(options.reasoningEffort !== void 0 ? String(options.reasoningEffort) : void 0);
  body.reasoning = { effort: effort ?? "medium", summary: "auto" };
  return body;
}
function streamFailure2(message, status, retryAfterMs) {
  const failure = new Error(message);
  if (status !== void 0) failure.status = status;
  if (retryAfterMs !== void 0) failure.providerRetryAfterMs = retryAfterMs;
  return failure;
}
function itemBlock(state) {
  if (state.blockType === "tool-call") {
    return {
      type: "tool-call",
      id: ToolCallId2(state.id ?? "call"),
      name: state.name ?? "",
      arguments: state.argumentsText ?? ""
    };
  }
  if (state.blockType === "reasoning") return { type: "reasoning", text: state.text ?? "" };
  return { type: "text", text: state.text ?? "" };
}
async function* streamTurn2(options, session, resolveImage, cliVersion) {
  const body = await buildCodexBody(options, resolveImage);
  const tier = modelTiers.get(options.model);
  if (tier !== void 0) body.service_tier = tier;
  const attribution = attributionHeaders3();
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
      ...accountIdOf(session) !== void 0 ? { "chatgpt-account-id": accountIdOf(session) } : {}
    },
    body: JSON.stringify(body),
    signal: options.signal
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw streamFailure2(
      `ChatGPT (Codex) request failed (${response.status}): ${detail.slice(0, 400)}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1e3 : void 0
    );
  }
  if (response.body === null) throw streamFailure2("ChatGPT (Codex) response carried no body");
  const blocks = /* @__PURE__ */ new Map();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let usageSeen = false;
  let sawToolCall = false;
  let stopReason = { kind: "stop" };
  for await (const { event, data } of sseEvents(response.body, options.signal)) {
    const payload = data;
    switch (event) {
      case "response.output_item.added": {
        const index = Number(payload?.output_index);
        const item = payload?.item ?? {};
        const blockType = item.type === "reasoning" ? "reasoning" : item.type === "function_call" ? "tool-call" : "text";
        const state = { blockType };
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
        if (state === void 0 || typeof payload?.delta !== "string") break;
        state.text = (state.text ?? "") + payload.delta;
        yield { type: "text-delta", index, text: payload.delta };
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const index = Number(payload?.output_index);
        const state = blocks.get(index);
        if (state === void 0 || typeof payload?.delta !== "string") break;
        state.text = (state.text ?? "") + payload.delta;
        yield { type: "reasoning-delta", index, text: payload.delta };
        break;
      }
      case "response.function_call_arguments.delta": {
        const index = Number(payload?.output_index);
        const state = blocks.get(index);
        if (state === void 0 || typeof payload?.delta !== "string") break;
        state.argumentsText = (state.argumentsText ?? "") + payload.delta;
        yield {
          type: "tool-call-delta",
          index,
          id: ToolCallId2(state.id ?? `call_${index}`),
          ...state.name !== void 0 ? { name: state.name } : {},
          argumentsDelta: payload.delta
        };
        break;
      }
      case "response.output_item.done": {
        const index = Number(payload?.output_index);
        const state = blocks.get(index);
        if (state === void 0) break;
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
        throw streamFailure2(String(message));
      }
      case "error": {
        const message = typeof payload?.message === "string" ? payload.message : "ChatGPT (Codex) stream error";
        throw streamFailure2(message);
      }
      default:
        break;
    }
  }
  if (usageSeen) yield { type: "usage", usage };
  yield { type: "finish", reason: stopReason };
}
var catalogCache2;
var CATALOG_TTL_MS2 = 5 * 6e4;
var modelTiers = /* @__PURE__ */ new Map();
function toModelInfo2(id, name2) {
  return {
    provider: "codex",
    id,
    name: name2 !== void 0 && name2.length > 0 ? name2 : humanizeModelId(id),
    inputModalities: ["text", "image"]
  };
}
function parseCodexModels(payload) {
  const tiers = /* @__PURE__ */ new Map();
  const models = [];
  const data = payload?.data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      const id = entry?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const name2 = entry?.display_name;
      models.push(toModelInfo2(id, typeof name2 === "string" ? name2 : void 0));
      const tier = entry?.service_tier;
      if (typeof tier === "string" && tier.length > 0) tiers.set(id, tier);
    }
  }
  return { models, tiers };
}
var USAGE_WINDOW_LABELS = {
  primary: "Primary window",
  secondary: "Secondary window",
  five_hour: "5-hour window",
  seven_day: "7-day window",
  weekly: "Weekly window",
  daily: "Daily window"
};
function toWindow(id, record) {
  const percent = record.used_percent ?? record.utilization ?? record.percent_used ?? record.usage_percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return void 0;
  const window = {
    id,
    label: USAGE_WINDOW_LABELS[id] ?? id,
    usedPercent: Math.max(0, Math.min(100, percent))
  };
  const resets = record.resets_at ?? record.reset_at ?? record.expires_at ?? record.resetsAt;
  if (typeof resets === "number" && Number.isFinite(resets)) {
    window.resetsAt = resets > 1e12 ? resets : resets * 1e3;
  } else if (typeof resets === "string") {
    const parsed = Date.parse(resets);
    if (Number.isFinite(parsed)) window.resetsAt = parsed;
  }
  return window;
}
function parseCodexUsageWindows(payload) {
  const windows = [];
  const seen = /* @__PURE__ */ new Set();
  const visit = (node, depth) => {
    if (depth > 3 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== "object" || value === null) continue;
      const window = toWindow(key, value);
      if (window !== void 0 && !seen.has(window.id)) {
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
function createCodexProvider(config = {}) {
  const cliVersion = config.clientVersion !== void 0 && config.clientVersion.length > 0 ? config.clientVersion : CODEX_CLI_VERSION;
  const oauth = {
    authorizeUrl: CODEX_AUTHORIZE_URL,
    tokenUrl: CODEX_TOKEN_URL,
    clientId: config.clientId !== void 0 && config.clientId.length > 0 ? config.clientId : CODEX_DEFAULT_CLIENT_ID,
    scopes: CODEX_OAUTH_SCOPES,
    redirectUri: CODEX_REDIRECT_URI,
    tokenFormat: "json"
  };
  function authHeaders(session) {
    const attribution = attributionHeaders3();
    return {
      ...attribution,
      "user-agent": `codex_cli_rs/${cliVersion} (external, cli) ${attribution["user-agent"]}`,
      authorization: `Bearer ${session.accessToken}`,
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs"
    };
  }
  return {
    id: "codex",
    displayName: "ChatGPT (Codex)",
    oauth,
    supportsUsage: true,
    async accountFromTokens(tokens) {
      const claims = tokens.idToken !== void 0 ? decodeJwtPayload(tokens.idToken) : decodeJwtPayload(tokens.accessToken);
      return codexAccountFromClaims(claims);
    },
    async listModels(session, signal) {
      if (session === void 0) return [];
      const cached = catalogCache2;
      if (cached !== void 0 && Date.now() - cached.at < CATALOG_TTL_MS2) return cached.models;
      try {
        const response = await fetch(CODEX_MODELS_URL, {
          headers: { ...authHeaders(session), accept: "application/json" },
          signal
        });
        if (!response.ok) throw new Error(`model list ${response.status}`);
        const { models, tiers } = parseCodexModels(await response.json());
        if (models.length > 0) {
          for (const [id, tier] of tiers) modelTiers.set(id, tier);
          catalogCache2 = { at: Date.now(), models };
          return models;
        }
        throw new Error("model list empty");
      } catch {
        const fallback = FALLBACK_MODELS2.map((id) => toModelInfo2(id, void 0));
        catalogCache2 = { at: Date.now(), models: fallback };
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
        reasoning: { efforts: CODEX_REASONING_EFFORTS, defaultEffort: ReasoningEffortId("medium") }
      };
    },
    stream(options, session, resolveImage) {
      return streamTurn2(options, session, resolveImage, cliVersion);
    },
    async fetchUsage(session, signal) {
      const headers = { ...authHeaders(session), accept: "application/json" };
      const accountId = accountIdOf(session);
      const response = await fetch(CODEX_USAGE_URL, {
        headers: accountId !== void 0 ? { ...headers, "chatgpt-account-id": accountId } : headers,
        signal
      });
      if (!response.ok) throw new Error(`ChatGPT (Codex) usage request failed (${response.status})`);
      return {
        provider: "codex",
        supported: true,
        windows: parseCodexUsageWindows(await response.json()),
        fetchedAt: Date.now()
      };
    }
  };
}

// src/host/providers/index.ts
function createProviderRegistry(config = {}) {
  const providers = /* @__PURE__ */ new Map();
  const claude = createClaudeProvider(config.claudeClientId ?? CLAUDE_DEFAULT_CLIENT_ID);
  providers.set(claude.id, claude);
  const codex = createCodexProvider({
    ...config.codexClientId !== void 0 ? { clientId: config.codexClientId } : {},
    ...config.codexClientVersion !== void 0 ? { clientVersion: config.codexClientVersion } : {}
  });
  providers.set(codex.id, codex);
  return providers;
}

// src/host/store.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes as randomBytes2 } from "node:crypto";
import { dirname } from "node:path";
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isSession(value) {
  if (!isRecord(value)) return false;
  if (typeof value.accessToken !== "string" || value.accessToken.length === 0) return false;
  if (typeof value.refreshToken !== "string" || value.refreshToken.length === 0) return false;
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return false;
  return true;
}
function sanitizeSession(value) {
  if (!isSession(value)) return void 0;
  const record = value;
  const clean = {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: Math.trunc(record.expiresAt)
  };
  for (const key of ["scopes", "email", "plan", "accountId"]) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) clean[key] = field;
  }
  return clean;
}
function sanitizeData(parsed) {
  const clean = { version: 1, providers: {} };
  if (!isRecord(parsed)) return clean;
  if (parsed.version !== 1) return clean;
  if (!isRecord(parsed.providers)) return clean;
  for (const id of ["claude", "codex"]) {
    const session = sanitizeSession(parsed.providers[id]);
    if (session !== void 0) clean.providers[id] = session;
  }
  return clean;
}
var FILE_MODE = 384;
var DIR_MODE = 448;
var SessionStore = class {
  path;
  cache;
  queue = Promise.resolve();
  constructor(path) {
    this.path = path;
  }
  /** Read and sanitize the store file; a missing or corrupt file yields empty. */
  async read() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return { version: 1, providers: {} };
    }
    try {
      return sanitizeData(JSON.parse(text));
    } catch {
      return { version: 1, providers: {} };
    }
  }
  /** Full sanitized snapshot (fresh read before the first mutation). */
  async load() {
    this.cache ??= await this.read();
    return { version: 1, providers: { ...this.cache.providers } };
  }
  async get(provider) {
    const data = await this.load();
    return data.providers[provider];
  }
  /** Insert or replace one provider session. */
  async set(provider, session) {
    await this.mutate((data) => {
      data.providers[provider] = session;
    });
  }
  /** Remove one provider session. */
  async delete(provider) {
    await this.mutate((data) => {
      delete data.providers[provider];
    });
  }
  /** Serialize mutations so concurrent login/logout/status calls cannot interleave writes. */
  mutate(change) {
    const task = this.queue.then(async () => {
      const data = await this.load();
      change(data);
      this.cache = data;
      await this.persist(data);
    });
    this.queue = task.catch(() => void 0);
    return task;
  }
  /** Atomic write: temp file with 0600, then rename over the target. */
  async persist(data) {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${this.path}.tmp-${randomBytes2(6).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}
`, { mode: FILE_MODE });
    try {
      await rename(tmp, this.path);
    } catch (error) {
      await chmod(tmp, FILE_MODE).catch(() => void 0);
      throw error;
    }
    await chmod(this.path, FILE_MODE).catch(() => void 0);
  }
};

// src/shared/protocol.ts
var CHANNEL = "/api";
var ENDPOINTS = {
  status: "sub-providers.status",
  login: "sub-providers.login",
  submitLogin: "sub-providers.submitLogin",
  cancelLogin: "sub-providers.cancelLogin",
  logout: "sub-providers.logout",
  usage: "sub-providers.usage"
};
function endpointPath(endpoint) {
  return `${CHANNEL}/${endpoint}`;
}

// src/host/index.ts
var name = "sub-providers";
var inject = ["attachments", "connection", "llm"];
var Config = z.object({
  /** OAuth client id for the Claude login. */
  claudeClientId: z.string().default(""),
  /** OAuth client id for the ChatGPT (Codex) login. */
  codexClientId: z.string().default(""),
  /** Codex CLI product version used in wire metadata (fixed default; never probed). */
  codexClientVersion: z.string().default("")
});
function ok(value) {
  return { ok: true, value };
}
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function parseClientRequest(body) {
  if (!isRecord2(body) || body.type !== "client-request") return void 0;
  if (typeof body.rpcId !== "string" || typeof body.method !== "string") return void 0;
  return { type: "client-request", rpcId: body.rpcId, method: body.method, payload: body.payload };
}
function rpcRoute(endpoint, handler) {
  return {
    path: endpointPath(endpoint),
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const message = parseClientRequest(body);
      if (message === void 0) return new Response("invalid client-request message", { status: 400 });
      const result = message.method === endpoint ? await handler(message.payload, request.signal).catch(
        (error) => fail("handler-failure", String(error))
      ) : fail("gateway/bad-request", `method "${message.method}" does not match endpoint "${endpoint}"`);
      return Response.json({ type: "server-response", rpcId: message.rpcId, result });
    }
  };
}
var USAGE_TTL_MS = 6e4;
function apply(ctx, config = {}) {
  const store = new SessionStore(dshHomePath("plugins", "sub-providers", "auth.json"));
  const registryConfig = {};
  if (typeof config.claudeClientId === "string" && config.claudeClientId.length > 0) {
    registryConfig.claudeClientId = config.claudeClientId;
  }
  if (typeof config.codexClientId === "string" && config.codexClientId.length > 0) {
    registryConfig.codexClientId = config.codexClientId;
  }
  if (typeof config.codexClientVersion === "string" && config.codexClientVersion.length > 0) {
    registryConfig.codexClientVersion = config.codexClientVersion;
  }
  const providers = createProviderRegistry(registryConfig);
  const loginFlows = /* @__PURE__ */ new Map();
  const refreshes = /* @__PURE__ */ new Map();
  const usageCache = /* @__PURE__ */ new Map();
  const activeRoutes = /* @__PURE__ */ new Set();
  const adapter = new SubscriptionAdapter({
    provider: (id) => providers.get(id),
    session: (id) => {
      const provider = providers.get(id);
      return provider === void 0 ? Promise.resolve(void 0) : validSession(provider);
    },
    resolveImage: async (ref, signal) => {
      const stored = await ctx.attachments.readImage(ref, signal);
      return { data: stored.data, mediaType: stored.ref.mediaType };
    }
  });
  let adapterHandle;
  function syncRoutes() {
    const routes = [...activeRoutes];
    if (adapterHandle === void 0) {
      if (routes.length === 0) return;
      adapterHandle = ctx.llm.registerAdapter(routes, adapter);
      ctx.effect(() => {
        const handle = adapterHandle;
        adapterHandle = void 0;
        return () => handle?.();
      }, "dsh-sub-providers: adapter routes");
    } else {
      adapterHandle.replace(routes);
    }
  }
  async function validSession(provider) {
    const session = await store.get(provider.id);
    if (session === void 0) return void 0;
    if (session.expiresAt - 6e4 > Date.now()) return session;
    const pending = refreshes.get(provider.id);
    if (pending !== void 0) return pending;
    const task = (async () => {
      try {
        const tokens = await refreshTokens(provider.oauth, session.refreshToken);
        const next = {
          ...session,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt
        };
        if (tokens.scopes !== void 0) next.scopes = tokens.scopes;
        await store.set(provider.id, next);
        return next;
      } catch (error) {
        if (error instanceof OAuthError && (error.status === 400 || error.status === 401)) {
          await store.delete(provider.id);
          activeRoutes.delete(provider.id);
          syncRoutes();
        }
        throw error;
      } finally {
        refreshes.delete(provider.id);
      }
    })();
    refreshes.set(provider.id, task);
    return task;
  }
  function providerOf(payload) {
    if (!isRecord2(payload) || typeof payload.provider !== "string") return fail("bad-request", "payload.provider must be a provider id");
    const provider = providers.get(payload.provider);
    if (provider === void 0) return fail("bad-request", `unknown provider "${payload.provider}"`);
    return provider;
  }
  async function statusResponse() {
    const summaries = [];
    for (const provider of providers.values()) {
      const session = await store.get(provider.id);
      const summary = {
        provider: provider.id,
        loggedIn: session !== void 0,
        busy: loginFlows.has(provider.id)
      };
      if (session?.email !== void 0) summary.email = session.email;
      if (session?.plan !== void 0) summary.plan = session.plan;
      summaries.push(summary);
    }
    return { providers: summaries };
  }
  async function handleRpc(endpoint, payload, signal) {
    switch (endpoint) {
      case ENDPOINTS.status:
        return ok(await statusResponse());
      case ENDPOINTS.login: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        if (loginFlows.has(provider.id)) return fail("login-in-progress", `a ${provider.displayName} sign-in is already pending`);
        const mode = provider.oauth.loginFlow === "code-paste" ? "code-paste" : "loopback";
        const flow = mode === "code-paste" ? await startCodePasteLogin(provider.oauth) : await startLoopbackLogin(provider.oauth);
        loginFlows.set(provider.id, flow);
        void flow.completed.then(async (tokens) => {
          loginFlows.delete(provider.id);
          const facts = await provider.accountFromTokens(tokens).catch(() => ({}));
          const session = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            ...facts
          };
          if (tokens.scopes !== void 0) session.scopes = tokens.scopes;
          await store.set(provider.id, session);
          activeRoutes.add(provider.id);
          syncRoutes();
        }).catch((cause) => {
          loginFlows.delete(provider.id);
          if (!(cause instanceof LoginCancelledError)) {
            ctx.logger("dsh-sub-providers").warn("login failed:", cause);
          }
        });
        return ok({ authorizeUrl: flow.authorizeUrl, expiresAt: flow.expiresAt, mode });
      }
      case ENDPOINTS.submitLogin: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        const flow = loginFlows.get(provider.id);
        if (flow === void 0) return fail("no-login-pending", `no ${provider.displayName} sign-in is pending`);
        if (!("submit" in flow)) return fail("wrong-mode", `the ${provider.displayName} login completes in the browser`);
        const code = isRecord2(payload) && typeof payload.code === "string" ? payload.code.trim() : "";
        if (code.length === 0) return fail("bad-request", "payload.code must be the pasted authorization code");
        flow.submit(code);
        return ok(null);
      }
      case ENDPOINTS.cancelLogin: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        const flow = loginFlows.get(provider.id);
        if (flow !== void 0) {
          loginFlows.delete(provider.id);
          flow.cancel();
        }
        return ok(null);
      }
      case ENDPOINTS.logout: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        loginFlows.get(provider.id)?.cancel();
        loginFlows.delete(provider.id);
        await store.delete(provider.id);
        usageCache.delete(provider.id);
        activeRoutes.delete(provider.id);
        syncRoutes();
        return ok(null);
      }
      case ENDPOINTS.usage: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        const session = await validSession(provider);
        if (session === void 0) return fail("not-logged-in", `no ${provider.displayName} login`);
        const force = isRecord2(payload) && payload.force === true;
        const cached = usageCache.get(provider.id);
        if (!force && cached !== void 0 && Date.now() - cached.at < USAGE_TTL_MS) return ok(cached.report);
        const report = await provider.fetchUsage(session, signal);
        usageCache.set(provider.id, { at: Date.now(), report });
        return ok(report);
      }
      default:
        return fail("unknown-endpoint", `unknown endpoint "${endpoint}"`);
    }
  }
  for (const endpoint of Object.values(ENDPOINTS)) {
    ctx.effect(
      () => ctx.connection.fetch.register(rpcRoute(endpoint, (payload, signal) => handleRpc(endpoint, payload, signal))),
      `dsh-sub-providers: ${endpointPath(endpoint)} route`
    );
  }
  void store.load().then((data) => {
    for (const id of Object.keys(data.providers)) activeRoutes.add(id);
    syncRoutes();
  });
}
export {
  Config,
  apply,
  inject,
  name
};
