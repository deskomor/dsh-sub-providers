/**
 * OAuth 2.0 authorization-code flows with PKCE. Two login modes: a loopback
 * redirect (local HTTP listener on an OS-assigned or fixed port) and a
 * copy/paste flow against the provider's hosted callback (no local server).
 * Token refresh is a plain refresh-token grant. Everything here is generic
 * RFC 6749/7636 machinery — provider endpoints and client ids arrive from
 * the provider modules.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";

/** Static OAuth client configuration for one provider. */
export interface OAuthClientConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Space-separated OAuth scopes requested at authorization. */
  scopes: string;
  /** Extra query parameters for the authorize URL. */
  authorizeParams?: Record<string, string>;
  /**
   * Fixed redirect URI registered with the provider for this client. When
   * set, the loopback listener binds that URI's port and the flow uses it
   * verbatim instead of an OS-assigned port. For `code-paste` flows this is
   * the provider's hosted callback URL, used verbatim in both legs.
   */
  redirectUri?: string;
  /**
   * How the login collects the authorization code: `loopback` (local HTTP
   * listener) or `code-paste` (the provider-hosted callback page shows the
   * code and the user pastes it back; no local server). Default `loopback`.
   */
  loginFlow?: "loopback" | "code-paste";
  /** Token request body encoding; standard is form, some providers take JSON. */
  tokenFormat?: "form" | "json";
}

/** Tokens returned by the token endpoint. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes?: string;
  /** Raw ID token JWT when the provider issued one (claims are provider-owned). */
  idToken?: string;
}

/** Thrown when the user cancels or the pending flow times out. */
export class LoginCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginCancelledError";
  }
}

/** Thrown when the token endpoint refuses the request. */
export class OAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** PKCE verifier (43-128 chars) and its S256 challenge. */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** Cryptographically random OAuth `state`. */
export function makeState(): string {
  return base64url(randomBytes(24));
}

/** Decode a JWT payload without verifying the signature (claims are display metadata only). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function toTokenSet(payload: Record<string, unknown>, previousRefreshToken: string | undefined): TokenSet {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthError("token endpoint response carried no access_token", 502);
  }
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
    ? payload.refresh_token
    : previousRefreshToken ?? "";
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const set: TokenSet = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.trunc(expiresIn * 1000),
  };
  if (typeof payload.scope === "string") set.scopes = payload.scope;
  if (typeof payload.id_token === "string") set.idToken = payload.id_token;
  return set;
}

async function requestTokens(
  config: OAuthClientConfig,
  body: Record<string, string>,
  previousRefreshToken: string | undefined,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const json = config.tokenFormat === "json";
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
      ...attributionHeaders(),
    },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    signal,
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // fall through with an empty payload; the status check below reports it
  }
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : response.statusText;
    throw new OAuthError(`token endpoint refused the request (${response.status}): ${detail}`, response.status);
  }
  return toTokenSet(payload, previousRefreshToken);
}

/** Exchange an authorization code for tokens. */
export function exchangeAuthorizationCode(
  config: OAuthClientConfig,
  input: { code: string; redirectUri: string; codeVerifier: string; state?: string; signal?: AbortSignal },
): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: config.clientId,
    code_verifier: input.codeVerifier,
  };
  if (input.state !== undefined) body.state = input.state;
  return requestTokens(config, body, undefined, input.signal);
}

/** Refresh an access token; the response may or may not rotate the refresh token. */
export function refreshTokens(
  config: OAuthClientConfig,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenSet> {
  return requestTokens(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    },
    refreshToken,
    signal,
  );
}

/** A pending loopback login. */
export interface PendingLogin {
  /** Provider authorize URL to open in the browser. */
  readonly authorizeUrl: string;
  /** Redirect URI registered with the provider for this flow. */
  readonly redirectUri: string;
  /** Epoch ms when the flow times out. */
  readonly expiresAt: number;
  /** Resolves with the token set once the browser round-trip completes. */
  readonly completed: Promise<TokenSet>;
  /** Abort the flow: closes the callback server and rejects `completed`. */
  cancel(): void;
}

export interface LoopbackOptions {
  /** Flow timeout in milliseconds (default 5 minutes). */
  timeoutMs?: number;
  callbackPath?: string;
  /**
   * Exact redirect URI the provider has registered for this client (fixed
   * host, port and path). When set, the loopback listener binds that port and
   * the flow uses this URI verbatim — the token exchange must present the
   * same registered URI. An occupied port fails the login start.
   */
  redirectUri?: string;
}

/** Build the authorization URL for one PKCE login. */
function buildAuthorizeUrl(config: OAuthClientConfig, redirectUri: string, challenge: string, state: string): string {
  return `${config.authorizeUrl}?${new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...config.authorizeParams,
  }).toString()}`;
}

/**
 * Start one PKCE login on a loopback listener. The caller opens
 * `authorizeUrl` in the browser and awaits `completed`.
 */
export function startLoopbackLogin(config: OAuthClientConfig, options: LoopbackOptions = {}): Promise<PendingLogin> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const fixedRedirect = options.redirectUri ?? config.redirectUri;
  const fixedUrl = fixedRedirect !== undefined ? new URL(fixedRedirect) : undefined;
  const callbackPath = fixedUrl !== undefined ? fixedUrl.pathname : options.callbackPath ?? "/oauth/callback";
  const listenPort = fixedUrl !== undefined ? Number(fixedUrl.port) : 0;
  const { verifier, challenge } = makePkce();
  const state = makeState();

  return new Promise<PendingLogin>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let finish: (result: TokenSet | Error) => void = () => undefined;
    /** Redirect URI of this exact bound listener; set once listen() reports the port. */
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
      exchangeAuthorizationCode(config, { code, redirectUri: boundRedirect, codeVerifier: verifier })
        .then((tokens) => finish(tokens))
        .catch((cause: unknown) => finish(cause instanceof Error ? cause : new Error(String(cause))));
    });

    server.on("error", (cause) => {
      if (!settled) {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(cause);
      }
    });

    server.listen(listenPort, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      boundRedirect = fixedRedirect ?? `http://127.0.0.1:${port}${callbackPath}`;
      const authorizeUrl = buildAuthorizeUrl(config, boundRedirect, challenge, state);

      const completed = new Promise<TokenSet>((resolveCompletion, rejectCompletion) => {
        finish = (result) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
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
        cancel,
      });
    });
  });
}

function page(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>dsh-sub-providers</title></head><body><p>${message}</p></body></html>`;
}

/** A pending copy/paste login (provider-hosted callback; no local server). */
export interface PendingCodeLogin {
  /** Provider authorize URL to open in the browser. */
  readonly authorizeUrl: string;
  /** Hosted redirect URI registered with the provider for this client. */
  readonly redirectUri: string;
  /** Epoch ms when the flow times out. */
  readonly expiresAt: number;
  /** Resolves with the token set once the pasted code is exchanged. */
  readonly completed: Promise<TokenSet>;
  /** Complete the flow with the code the hosted page shows (`CODE` or `CODE#STATE`). */
  submit(code: string): void;
  /** Abort the flow and reject `completed`. */
  cancel(): void;
}

/**
 * Start one PKCE login whose code arrives by copy/paste: the authorize URL
 * targets the provider's hosted callback (registered verbatim for this
 * client), whose page displays the code. `submit` performs the exchange.
 */
export function startCodePasteLogin(config: OAuthClientConfig, options: LoopbackOptions = {}): Promise<PendingCodeLogin> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const redirectUri = config.redirectUri;
  if (redirectUri === undefined) {
    return Promise.reject(new Error("code-paste login requires the client's registered redirectUri"));
  }
  const { verifier, challenge } = makePkce();
  // This client's documented convention: `state` carries the verifier value.
  const state = verifier;
  const authorizeUrl = buildAuthorizeUrl(config, redirectUri, challenge, state);

  return new Promise<PendingCodeLogin>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let finish: (result: TokenSet | Error) => void = () => undefined;

    const completed = new Promise<TokenSet>((resolveCompletion, rejectCompletion) => {
      finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
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
      submit: (raw: string) => {
        const trimmed = raw.trim();
        const hash = trimmed.indexOf("#");
        const code = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
        const returnedState = hash >= 0 ? trimmed.slice(hash + 1) : undefined;
        if (code.length === 0) {
          finish(new LoginCancelledError("no authorization code supplied"));
          return;
        }
        exchangeAuthorizationCode(config, {
          code,
          redirectUri,
          codeVerifier: verifier,
          state: returnedState ?? state,
        })
          .then((tokens) => finish(tokens))
          .catch((cause: unknown) => finish(cause instanceof Error ? cause : new Error(String(cause))));
      },
      cancel: () => finish(new LoginCancelledError("login cancelled")),
    });
  });
}
