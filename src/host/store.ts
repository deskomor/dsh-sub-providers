/**
 * OAuth token store. Owns exactly one file — `plugins/sub-providers/auth.json`
 * under the DSH home — written atomically with mode 0600. Reads are strictly
 * structural: values are validated field-by-field and unknown content is
 * dropped, so a tampered file can never smuggle code or unexpected shapes
 * into the plugin.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { ProviderId } from "../shared/protocol.ts";

/** One provider's persisted OAuth session. */
export interface ProviderSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  scopes?: string;
  /** Account email, captured at login time when the provider discloses one. */
  email?: string;
  /** Subscription plan label, when known. */
  plan?: string;
  /** Provider-specific account identity needed on requests (e.g. Codex account id). */
  accountId?: string;
}

export interface StoreData {
  version: 1;
  providers: Partial<Record<ProviderId, ProviderSession>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSession(value: unknown): value is ProviderSession {
  if (!isRecord(value)) return false;
  if (typeof value.accessToken !== "string" || value.accessToken.length === 0) return false;
  if (typeof value.refreshToken !== "string" || value.refreshToken.length === 0) return false;
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return false;
  return true;
}

/** Keep only known, well-typed fields from one parsed session. */
function sanitizeSession(value: unknown): ProviderSession | undefined {
  if (!isSession(value)) return undefined;
  const record = value as unknown as Record<string, unknown>;
  const clean: ProviderSession = {
    accessToken: record.accessToken as string,
    refreshToken: record.refreshToken as string,
    expiresAt: Math.trunc(record.expiresAt as number),
  };
  for (const key of ["scopes", "email", "plan", "accountId"] as const) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) clean[key] = field;
  }
  return clean;
}

function sanitizeData(parsed: unknown): StoreData {
  const clean: StoreData = { version: 1, providers: {} };
  if (!isRecord(parsed)) return clean;
  if (parsed.version !== 1) return clean;
  if (!isRecord(parsed.providers)) return clean;
  for (const id of ["claude", "codex"] as const) {
    const session = sanitizeSession(parsed.providers[id]);
    if (session !== undefined) clean.providers[id] = session;
  }
  return clean;
}

/** File mode 0600: owner read/write only. */
const FILE_MODE = 0o600;
/** Directory mode 0700: owner only. */
const DIR_MODE = 0o700;

export class SessionStore {
  readonly path: string;
  private cache: StoreData | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  /** Read and sanitize the store file; a missing or corrupt file yields empty. */
  private async read(): Promise<StoreData> {
    let text: string;
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
  async load(): Promise<StoreData> {
    this.cache ??= await this.read();
    return { version: 1, providers: { ...this.cache.providers } };
  }

  async get(provider: ProviderId): Promise<ProviderSession | undefined> {
    const data = await this.load();
    return data.providers[provider];
  }

  /** Insert or replace one provider session. */
  async set(provider: ProviderId, session: ProviderSession): Promise<void> {
    await this.mutate((data) => {
      data.providers[provider] = session;
    });
  }

  /** Remove one provider session. */
  async delete(provider: ProviderId): Promise<void> {
    await this.mutate((data) => {
      delete data.providers[provider];
    });
  }

  /** Serialize mutations so concurrent login/logout/status calls cannot interleave writes. */
  private mutate(change: (data: StoreData) => void): Promise<void> {
    const task = this.queue.then(async () => {
      const data = await this.load();
      change(data);
      this.cache = data;
      await this.persist(data);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Atomic write: temp file with 0600, then rename over the target. */
  private async persist(data: StoreData): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${this.path}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: FILE_MODE });
    try {
      await rename(tmp, this.path);
    } catch (error) {
      await chmod(tmp, FILE_MODE).catch(() => undefined);
      throw error;
    }
    await chmod(this.path, FILE_MODE).catch(() => undefined);
  }
}
