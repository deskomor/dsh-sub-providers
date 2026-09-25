/**
 * Thin typed wrapper over the connection RPC channel. The client half only
 * ever talks to the host through this channel; it performs no network I/O of
 * its own.
 */
import {
  CHANNEL,
  ENDPOINTS,
  type LoginStartResponse,
  type ProviderId,
  type StatusResponse,
  type UsageReport,
} from "../shared/protocol.ts";

type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface RpcCaller {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>;
}

function unwrap<T>(result: RpcResult): T {
  if (!result.ok) throw new Error(result.error.message || result.error.code);
  return result.value as T;
}

export class SubProvidersClient {
  private readonly rpc: RpcCaller;

  constructor(rpc: RpcCaller) {
    this.rpc = rpc;
  }

  async status(signal?: AbortSignal): Promise<StatusResponse> {
    return unwrap<StatusResponse>(await this.rpc.call(CHANNEL, ENDPOINTS.status, {}, signal));
  }

  async login(provider: ProviderId, signal?: AbortSignal): Promise<LoginStartResponse> {
    return unwrap<LoginStartResponse>(await this.rpc.call(CHANNEL, ENDPOINTS.login, { provider }, signal));
  }

  /** Complete a `code-paste` login with the code the hosted callback page shows. */
  async submitLogin(provider: ProviderId, code: string, signal?: AbortSignal): Promise<void> {
    unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.submitLogin, { provider, code }, signal));
  }

  async cancelLogin(provider: ProviderId, signal?: AbortSignal): Promise<void> {
    unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.cancelLogin, { provider }, signal));
  }

  async logout(provider: ProviderId, signal?: AbortSignal): Promise<void> {
    unwrap(await this.rpc.call(CHANNEL, ENDPOINTS.logout, { provider }, signal));
  }

  async usage(provider: ProviderId, force = false, signal?: AbortSignal): Promise<UsageReport> {
    return unwrap<UsageReport>(await this.rpc.call(CHANNEL, ENDPOINTS.usage, { provider, force }, signal));
  }
}
