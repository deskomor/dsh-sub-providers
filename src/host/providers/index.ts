/**
 * Provider registry. Only providers with a complete implementation are
 * registered here; the host iterates this map for status, routes, and RPCs.
 */
import { createClaudeProvider, CLAUDE_DEFAULT_CLIENT_ID } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";
import type { SubscriptionProvider } from "./types.ts";

export interface RegistryConfig {
  claudeClientId?: string;
  /** OAuth client id override for the ChatGPT (Codex) login. */
  codexClientId?: string;
  /** Codex CLI product version used in wire metadata (no registry probing). */
  codexClientVersion?: string;
}

export function createProviderRegistry(config: RegistryConfig = {}): Map<string, SubscriptionProvider> {
  const providers = new Map<string, SubscriptionProvider>();
  const claude = createClaudeProvider(config.claudeClientId ?? CLAUDE_DEFAULT_CLIENT_ID);
  providers.set(claude.id, claude);
  const codex = createCodexProvider({
    ...(config.codexClientId !== undefined ? { clientId: config.codexClientId } : {}),
    ...(config.codexClientVersion !== undefined ? { clientVersion: config.codexClientVersion } : {}),
  });
  providers.set(codex.id, codex);
  return providers;
}
