/**
 * Wire vocabulary shared by the host and client halves. Browser-safe: plain
 * constants and JSON payload types only — no node or host imports.
 */

/**
 * RPC channel shared with the harness. The host half owns exact Fetch routes
 * on it (`connection.fetch.register`); dedicated `rpc.handle` channels are
 * not usable from a plugin in dsh 0.1.5 (they resolve `webServer` in the
 * connection plugin's own context).
 */
export const CHANNEL = "/api";

/** Providers this plugin serves. */
export type ProviderId = "claude" | "codex";

export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex"];

/** Endpoint names under {@link CHANNEL}; namespaced so they cannot collide with harness endpoints. */
export const ENDPOINTS = {
  status: "sub-providers.status",
  login: "sub-providers.login",
  submitLogin: "sub-providers.submitLogin",
  cancelLogin: "sub-providers.cancelLogin",
  logout: "sub-providers.logout",
  usage: "sub-providers.usage",
} as const;

/** Absolute request path for one endpoint. */
export function endpointPath(endpoint: EndpointName): string {
  return `${CHANNEL}/${endpoint}`;
}

export type EndpointName = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];

/** One provider's login state as the settings UI renders it. */
export interface AccountSummary {
  provider: ProviderId;
  loggedIn: boolean;
  /** Account email, when the provider discloses one at login time. */
  email?: string;
  /** Subscription plan label, when known (e.g. "pro", "max"). */
  plan?: string;
  /** True while an OAuth login flow is in progress. */
  busy?: boolean;
  /** Last login/refresh failure the UI should surface. */
  error?: string;
}

/** One rate-limit window of subscription usage. */
export interface UsageWindow {
  /** Stable window id (e.g. "five_hour", "seven_day"). */
  id: string;
  /** Human-readable window label. */
  label: string;
  /** Percentage of the window consumed, 0-100, when the provider discloses it. */
  usedPercent?: number;
  /** Epoch milliseconds when the window resets, when disclosed. */
  resetsAt?: number;
}

/** Subscription usage report for one provider. */
export interface UsageReport {
  provider: ProviderId;
  /** False when the provider exposes no usage endpoint. */
  supported: boolean;
  plan?: string;
  windows: UsageWindow[];
  /** Epoch ms of the fetch that produced this report. */
  fetchedAt?: number;
}

export interface StatusResponse {
  providers: AccountSummary[];
}

/** How a login collects its authorization code. */
export type LoginMode = "loopback" | "code-paste";

export interface LoginStartResponse {
  /** Provider authorize URL the browser should open in a new tab. */
  authorizeUrl: string;
  /** Epoch ms when the pending flow times out. */
  expiresAt: number;
  /**
   * `loopback`: the flow completes in the browser. `code-paste`: the hosted
   * callback page shows a code the user pastes back via submitLogin.
   */
  mode: LoginMode;
}

/** Payload shapes sent by the client half (validated again on the host). */
export interface ProviderPayload {
  provider: ProviderId;
}

export interface UsagePayload extends ProviderPayload {
  force?: boolean;
}

/** Pasted authorization code for a `code-paste` login (`CODE` or `CODE#STATE`). */
export interface SubmitLoginPayload extends ProviderPayload {
  code: string;
}
