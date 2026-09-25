import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/host/store.ts";

async function freshStore(): Promise<{ store: SessionStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sub-providers-"));
  const path = join(dir, "auth.json");
  return { store: new SessionStore(path), path };
}

test("store persists and reloads one session", async () => {
  const first = await freshStore();
  await first.store.set("claude", { accessToken: "a", refreshToken: "r", expiresAt: 123, email: "me@example.com" });
  const second = new SessionStore(first.path);
  assert.deepEqual(await second.get("claude"), {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: 123,
    email: "me@example.com",
  });
  assert.equal(await second.get("codex"), undefined);
});

test("store writes with 0600 permissions where the platform honors modes", async () => {
  if (process.platform === "win32") return; // Windows ACLs govern; mode bits are advisory
  const { store, path } = await freshStore();
  await store.set("claude", { accessToken: "a", refreshToken: "r", expiresAt: 1 });
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("store drops unknown fields and rejects malformed sessions", async () => {
  const { store, path } = await freshStore();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      providers: {
        claude: { accessToken: "a", refreshToken: "r", expiresAt: 5, evil: { nested: true }, email: 42 },
        codex: { accessToken: "", refreshToken: "r", expiresAt: 5 },
      },
    }),
    "utf8",
  );
  const loaded = new SessionStore(path);
  assert.deepEqual(await loaded.get("claude"), { accessToken: "a", refreshToken: "r", expiresAt: 5 });
  assert.equal(await loaded.get("codex"), undefined);
});

test("store tolerates corruption and wrong versions", async () => {
  const first = await freshStore();
  await writeFile(first.path, "{ this is not json", "utf8");
  assert.equal(await first.store.get("claude"), undefined);
  const second = await freshStore();
  await writeFile(second.path, JSON.stringify({ version: 99, providers: { claude: { accessToken: "a", refreshToken: "r", expiresAt: 5 } } }), "utf8");
  assert.equal(await second.store.get("claude"), undefined);
});

test("store delete removes one provider only", async () => {
  const { store } = await freshStore();
  await store.set("claude", { accessToken: "a", refreshToken: "r", expiresAt: 1 });
  await store.set("codex", { accessToken: "b", refreshToken: "s", expiresAt: 2 });
  await store.delete("claude");
  assert.equal(await store.get("claude"), undefined);
  assert.equal((await store.get("codex"))?.accessToken, "b");
});
