/**
 * Contract every subscription provider implements. The adapter layer and the
 * RPC handlers speak only this interface; each provider module owns its
 * public vendor wire details.
 */
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { OAuthClientConfig, TokenSet } from "../oauth.ts";
import type { ProviderSession } from "../store.ts";
import type { ProviderId, UsageReport } from "../../shared/protocol.ts";

/** Resolves a durable image reference to bytes a provider wire can carry. */
export type ImageResolver = (
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
) => Promise<{ data: Uint8Array; mediaType: string }>;

/** Account facts captured at login time from tokens or a profile call. */
export type AccountFacts = Pick<ProviderSession, "email" | "plan" | "accountId">;

export interface SubscriptionProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** OAuth client configuration used by the generic loopback flow. */
  readonly oauth: OAuthClientConfig;
  /** Whether the provider exposes a subscription-usage endpoint. */
  readonly supportsUsage: boolean;
  /** Derive persistent account facts right after a successful login. */
  accountFromTokens(tokens: TokenSet, signal?: AbortSignal): Promise<AccountFacts>;
  /** Advisory model catalog; empty when logged out. */
  listModels(session: ProviderSession | undefined, signal?: AbortSignal): Promise<LlmModelInfo[]>;
  /** Exact metadata for one model id; pure and offline. */
  resolveModel(model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /** Stream one conversation turn on the provider wire. */
  stream(options: GenerateOptions, session: ProviderSession, resolveImage: ImageResolver): AsyncIterable<StreamChunk>;
  /** Subscription usage windows for the settings UI. */
  fetchUsage(session: ProviderSession, signal?: AbortSignal): Promise<UsageReport>;
}

/** Turn a provider model id into a readable display name. */
export function humanizeModelId(id: string): string {
  return id
    .split("-")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Standard context window used by subscription chat models when unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Standard output cap used when the caller omits one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
