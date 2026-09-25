/**
 * LlmAdapter implementation bridging the harness stream vocabulary to the
 * per-provider wire modules. Registered under the routes of logged-in
 * providers only (see host/index.ts).
 */
import type {
  GenerateOptions,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import type { ProviderSession } from "./store.ts";
import type { ImageResolver, SubscriptionProvider } from "./providers/types.ts";

export interface AdapterDeps {
  /** Look up one provider implementation by route id. */
  provider(id: string): SubscriptionProvider | undefined;
  /** Current (refreshed) session for a route, or undefined when logged out. */
  session(id: string): Promise<ProviderSession | undefined>;
  /** Resolve durable image references to bytes. */
  resolveImage: ImageResolver;
}

export class SubscriptionAdapter extends LlmAdapter {
  private readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    super();
    this.deps = deps;
  }

  private must(provider: string): SubscriptionProvider {
    const found = this.deps.provider(provider);
    if (found === undefined) throw new Error(`dsh-sub-providers: unknown provider route "${provider}"`);
    return found;
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.must(provider).displayName };
  }

  providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return undefined;
  }

  imageRequestPricing(): LlmImageRequestPricing | undefined {
    return undefined;
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.must(provider).listModels(await this.deps.session(provider));
  }

  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.must(provider).resolveModel(model, signal);
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal);
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.stream(options),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const provider = this.must(options.provider);
    const session = await this.deps.session(options.provider);
    if (session === undefined) {
      throw new Error(`dsh-sub-providers: no ${provider.displayName} login for route "${options.provider}"`);
    }
    yield* provider.stream(options, session, this.deps.resolveImage);
  }
}
