/**
 * dsh-sub-providers — host half. Registers subscription provider routes with
 * the LLM adapter registry and exposes the settings RPC channel.
 *
 * Clean-room implementation: no code from dsh-plugin-subscriptions. Vendor
 * behavior comes from public API documentation; the harness surface comes
 * from @deepseek-ai package type contracts.
 */
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import type { Context } from "@deepseek-ai/cordis";
// Type-only: loads the `Context.connection` augmentation; erased at runtime.
import type {} from "@deepseek-ai/dsh-client-connection";
import z from "@deepseek-ai/schemastery";
import { SubscriptionAdapter } from "./adapter.ts";
import { LoginCancelledError, OAuthError, refreshTokens, startCodePasteLogin, startLoopbackLogin, type PendingCodeLogin, type PendingLogin } from "./oauth.ts";
import { createProviderRegistry, type RegistryConfig } from "./providers/index.ts";
import type { SubscriptionProvider } from "./providers/types.ts";
import { SessionStore, type ProviderSession } from "./store.ts";
import {
  ENDPOINTS,
  endpointPath,
  type AccountSummary,
  type EndpointName,
  type ProviderId,
  type StatusResponse,
  type UsageReport,
} from "../shared/protocol.ts";

export const name = "sub-providers";
export const inject = ["attachments", "connection", "llm"];

/** Runtime configuration schema (all fields optional with sane defaults). */
export const Config = z.object({
  /** OAuth client id for the Claude login. */
  claudeClientId: z.string().default(""),
  /** OAuth client id for the ChatGPT (Codex) login. */
  codexClientId: z.string().default(""),
  /** Codex CLI product version used in wire metadata (fixed default; never probed). */
  codexClientVersion: z.string().default(""),
});

type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } };

function ok(value: unknown): RpcResult {
  return { ok: true, value };
}

function fail(code: string, message: string): RpcResult {
  return { ok: false, error: { code, message, details: {} } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Envelope the browser `connection.rpc.call` sends and expects back (dsh-client-connection wire shape). */
interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

function parseClientRequest(body: unknown): ClientRequest | undefined {
  if (!isRecord(body) || body.type !== "client-request") return undefined;
  if (typeof body.rpcId !== "string" || typeof body.method !== "string") return undefined;
  return { type: "client-request", rpcId: body.rpcId, method: body.method, payload: body.payload };
}

/**
 * One exact `/api/<endpoint>` route that decodes the RPC envelope and answers
 * with the harness' server-response shape, so the client half needs no
 * transport knowledge of its own.
 */
function rpcRoute(endpoint: EndpointName, handler: (payload: unknown, signal: AbortSignal) => Promise<RpcResult>) {
  return {
    path: endpointPath(endpoint),
    methods: ["POST"] as const,
    requestBody: "buffered" as const,
    async fetch(request: Request): Promise<Response> {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const message = parseClientRequest(body);
      if (message === undefined) return new Response("invalid client-request message", { status: 400 });
      const result =
        message.method === endpoint
          ? await handler(message.payload, request.signal).catch(
              (error: unknown) => fail("handler-failure", String(error)),
            )
          : fail("gateway/bad-request", `method "${message.method}" does not match endpoint "${endpoint}"`);
      return Response.json({ type: "server-response", rpcId: message.rpcId, result });
    },
  };
}

/** Usage responses are cached briefly so the UI poller cannot hammer the vendor. */
const USAGE_TTL_MS = 60_000;

export function apply(ctx: Context, config: RegistryConfig = {}): void {
  const store = new SessionStore(dshHomePath("plugins", "sub-providers", "auth.json"));
  const registryConfig: RegistryConfig = {};
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

  const loginFlows = new Map<ProviderId, PendingLogin | PendingCodeLogin>();
  const refreshes = new Map<string, Promise<ProviderSession>>();
  const usageCache = new Map<string, { at: number; report: UsageReport }>();
  /** Routes currently registered with the LLM adapter registry. */
  const activeRoutes = new Set<string>();

  // ---- adapter registration (routes follow login state) ---------------------

  const adapter = new SubscriptionAdapter({
    provider: (id) => providers.get(id),
    session: (id) => {
      const provider = providers.get(id);
      return provider === undefined ? Promise.resolve(undefined) : validSession(provider);
    },
    resolveImage: async (ref, signal) => {
      const stored = await ctx.attachments.readImage(ref, signal);
      return { data: stored.data, mediaType: stored.ref.mediaType };
    },
  });

  let adapterHandle: { (): void; replace(providers: string[]): void } | undefined;

  function syncRoutes(): void {
    const routes = [...activeRoutes];
    if (adapterHandle === undefined) {
      if (routes.length === 0) return;
      adapterHandle = ctx.llm.registerAdapter(routes, adapter);
      ctx.effect(() => {
        const handle = adapterHandle;
        adapterHandle = undefined;
        return () => handle?.();
      }, "dsh-sub-providers: adapter routes");
    } else {
      adapterHandle.replace(routes);
    }
  }

  // ---- session lifecycle ----------------------------------------------------

  /** Current session for a provider, transparently refreshing expired tokens. */
  async function validSession(provider: SubscriptionProvider): Promise<ProviderSession | undefined> {
    const session = await store.get(provider.id);
    if (session === undefined) return undefined;
    if (session.expiresAt - 60_000 > Date.now()) return session;
    const pending = refreshes.get(provider.id);
    if (pending !== undefined) return pending;
    const task = (async (): Promise<ProviderSession> => {
      try {
        const tokens = await refreshTokens(provider.oauth, session.refreshToken);
        const next: ProviderSession = {
          ...session,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        };
        if (tokens.scopes !== undefined) next.scopes = tokens.scopes;
        await store.set(provider.id, next);
        return next;
      } catch (error) {
        // A refused refresh means the stored login is dead; drop it so the UI
        // offers sign-in again instead of retrying a revoked token forever.
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

  function providerOf(payload: unknown): SubscriptionProvider | RpcResult {
    if (!isRecord(payload) || typeof payload.provider !== "string") return fail("bad-request", "payload.provider must be a provider id");
    const provider = providers.get(payload.provider);
    if (provider === undefined) return fail("bad-request", `unknown provider "${payload.provider}"`);
    return provider;
  }

  async function statusResponse(): Promise<StatusResponse> {
    const summaries: AccountSummary[] = [];
    for (const provider of providers.values()) {
      const session = await store.get(provider.id);
      const summary: AccountSummary = {
        provider: provider.id as ProviderId,
        loggedIn: session !== undefined,
        busy: loginFlows.has(provider.id as ProviderId),
      };
      if (session?.email !== undefined) summary.email = session.email;
      if (session?.plan !== undefined) summary.plan = session.plan;
      summaries.push(summary);
    }
    return { providers: summaries };
  }

  // ---- RPC channel ----------------------------------------------------------

  async function handleRpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult> {
    switch (endpoint) {
      case ENDPOINTS.status:
        return ok(await statusResponse());

      case ENDPOINTS.login: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        if (loginFlows.has(provider.id as ProviderId)) return fail("login-in-progress", `a ${provider.displayName} sign-in is already pending`);
        const mode = provider.oauth.loginFlow === "code-paste" ? "code-paste" : "loopback";
        const flow =
          mode === "code-paste"
            ? await startCodePasteLogin(provider.oauth)
            : await startLoopbackLogin(provider.oauth);
        loginFlows.set(provider.id as ProviderId, flow);
        void flow.completed
          .then(async (tokens) => {
            loginFlows.delete(provider.id as ProviderId);
            const facts = await provider.accountFromTokens(tokens).catch(() => ({}));
            const session: ProviderSession = {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
              ...facts,
            };
            if (tokens.scopes !== undefined) session.scopes = tokens.scopes;
            await store.set(provider.id, session);
            activeRoutes.add(provider.id);
            syncRoutes();
          })
          .catch((cause: unknown) => {
            loginFlows.delete(provider.id as ProviderId);
            if (!(cause instanceof LoginCancelledError)) {
              ctx.logger("dsh-sub-providers").warn("login failed:", cause);
            }
          });
        return ok({ authorizeUrl: flow.authorizeUrl, expiresAt: flow.expiresAt, mode });
      }

      case ENDPOINTS.submitLogin: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        const flow = loginFlows.get(provider.id as ProviderId);
        if (flow === undefined) return fail("no-login-pending", `no ${provider.displayName} sign-in is pending`);
        if (!("submit" in flow)) return fail("wrong-mode", `the ${provider.displayName} login completes in the browser`);
        const code = isRecord(payload) && typeof payload.code === "string" ? payload.code.trim() : "";
        if (code.length === 0) return fail("bad-request", "payload.code must be the pasted authorization code");
        flow.submit(code);
        return ok(null);
      }

      case ENDPOINTS.cancelLogin: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        const flow = loginFlows.get(provider.id as ProviderId);
        if (flow !== undefined) {
          loginFlows.delete(provider.id as ProviderId);
          flow.cancel();
        }
        return ok(null);
      }

      case ENDPOINTS.logout: {
        const provider = providerOf(payload);
        if ("ok" in provider) return provider;
        loginFlows.get(provider.id as ProviderId)?.cancel();
        loginFlows.delete(provider.id as ProviderId);
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
        if (session === undefined) return fail("not-logged-in", `no ${provider.displayName} login`);
        const force = isRecord(payload) && payload.force === true;
        const cached = usageCache.get(provider.id);
        if (!force && cached !== undefined && Date.now() - cached.at < USAGE_TTL_MS) return ok(cached.report);
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
      `dsh-sub-providers: ${endpointPath(endpoint)} route`,
    );
  }

  // Routes follow the persisted login state from previous runs.
  void store.load().then((data) => {
    for (const id of Object.keys(data.providers)) activeRoutes.add(id);
    syncRoutes();
  });
}
