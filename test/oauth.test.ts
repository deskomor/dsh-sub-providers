import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  decodeJwtPayload,
  makePkce,
  makeState,
  refreshTokens,
  startCodePasteLogin,
  startLoopbackLogin,
  type OAuthClientConfig,
} from "../src/host/oauth.ts";

test("pkce challenge is S256 of the verifier", () => {
  const { verifier, challenge } = makePkce();
  assert.ok(verifier.length >= 43);
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
});

test("state values are unique", () => {
  assert.notEqual(makeState(), makeState());
});

test("jwt payload decodes without verification and rejects garbage", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.deepEqual(decodeJwtPayload(`${encode({ alg: "none" })}.${encode({ email: "a@b.c" })}.sig`), { email: "a@b.c" });
  assert.equal(decodeJwtPayload("not-a-jwt"), undefined);
});

/** Fake OAuth token endpoint recording the bodies it receives. */
async function fakeTokenEndpoint(): Promise<{
  url: string;
  received: Array<Record<string, string>>;
  close(): Promise<void>;
}> {
  const received: Array<Record<string, string>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      received.push(Object.fromEntries(new URLSearchParams(body)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600, scope: "s" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/token`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("loopback login performs the full PKCE code exchange", async () => {
  const endpoint = await fakeTokenEndpoint();
  try {
    const config: OAuthClientConfig = {
      authorizeUrl: "https://provider.example/authorize",
      tokenUrl: endpoint.url,
      clientId: "client-123",
      scopes: "a b",
    };
    const flow = await startLoopbackLogin(config, { timeoutMs: 30_000 });

    // Simulate the browser: follow the authorize URL, approve, land on the redirect.
    const authorize = new URL(flow.authorizeUrl);
    assert.equal(authorize.searchParams.get("client_id"), "client-123");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("state") !== null, true);

    const callback = new URL(flow.redirectUri);
    const response = await fetch(
      `${callback.origin}${callback.pathname}?code=the-code&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
    );
    assert.equal(response.status, 200);

    const tokens = await flow.completed;
    assert.equal(tokens.accessToken, "fresh-access");
    assert.equal(tokens.refreshToken, "fresh-refresh");
    assert.ok(tokens.expiresAt > Date.now());

    assert.equal(endpoint.received.length, 1);
    const body = endpoint.received[0];
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.code, "the-code");
    assert.equal(body.client_id, "client-123");
    const expectedChallenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
    assert.equal(authorize.searchParams.get("code_challenge"), expectedChallenge);
  } finally {
    await endpoint.close();
  }
});

test("loopback login rejects a state mismatch", async () => {
  const endpoint = await fakeTokenEndpoint();
  try {
    const config: OAuthClientConfig = {
      authorizeUrl: "https://provider.example/authorize",
      tokenUrl: endpoint.url,
      clientId: "client-123",
      scopes: "a b",
    };
    const flow = await startLoopbackLogin(config, { timeoutMs: 30_000 });
    // Attach the rejection handler before the failing callback lands, so the
    // expected rejection is never unhandled.
    const rejection = assert.rejects(flow.completed, /state mismatch/);
    const callback = new URL(flow.redirectUri);
    const response = await fetch(`${callback.origin}${callback.pathname}?code=the-code&state=WRONG`);
    assert.equal(response.status, 400);
    await rejection;
    assert.equal(endpoint.received.length, 0);
  } finally {
    await endpoint.close();
  }
});

test("loopback login honors a fixed registered redirect URI", async () => {
  // Reserve then release a port so the fixed bind is unlikely to collide.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const endpoint = await fakeTokenEndpoint();
  try {
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const config: OAuthClientConfig = {
      authorizeUrl: "https://provider.example/authorize",
      tokenUrl: endpoint.url,
      clientId: "client-123",
      scopes: "a b",
      redirectUri,
    };
    const flow = await startLoopbackLogin(config, { timeoutMs: 30_000 });
    assert.equal(flow.redirectUri, redirectUri);
    const authorize = new URL(flow.authorizeUrl);
    assert.equal(authorize.searchParams.get("redirect_uri"), redirectUri);
    const response = await fetch(
      `${redirectUri}?code=the-code&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
    );
    assert.equal(response.status, 200);
    const tokens = await flow.completed;
    assert.equal(tokens.accessToken, "fresh-access");
    assert.equal(endpoint.received[0].redirect_uri, redirectUri);
  } finally {
    await endpoint.close();
  }
});

test("code-paste login uses the hosted redirect and exchanges the pasted CODE#STATE", async () => {
  const endpoint = await fakeTokenEndpoint();
  try {
    const config: OAuthClientConfig = {
      authorizeUrl: "https://provider.example/authorize",
      tokenUrl: endpoint.url,
      clientId: "client-123",
      scopes: "a b",
      redirectUri: "https://provider.example/oauth/code/callback",
      loginFlow: "code-paste",
      authorizeParams: { code: "true" },
    };
    const flow = await startCodePasteLogin(config, { timeoutMs: 30_000 });
    const authorize = new URL(flow.authorizeUrl);
    assert.equal(authorize.searchParams.get("code"), "true");
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://provider.example/oauth/code/callback");
    const state = authorize.searchParams.get("state");
    assert.equal(typeof state, "string");

    flow.submit(`the-code#${state}`);
    const tokens = await flow.completed;
    assert.equal(tokens.accessToken, "fresh-access");

    const body = endpoint.received[0];
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.code, "the-code");
    assert.equal(body.state, state);
    assert.equal(body.redirect_uri, "https://provider.example/oauth/code/callback");
    const expectedChallenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
    assert.equal(authorize.searchParams.get("code_challenge"), expectedChallenge);
  } finally {
    await endpoint.close();
  }
});

test("code-paste login accepts a bare code and forwards the verifier as state", async () => {
  const endpoint = await fakeTokenEndpoint();
  try {
    const config: OAuthClientConfig = {
      authorizeUrl: "https://provider.example/authorize",
      tokenUrl: endpoint.url,
      clientId: "client-123",
      scopes: "a b",
      redirectUri: "https://provider.example/oauth/code/callback",
      loginFlow: "code-paste",
      authorizeParams: { code: "true" },
    };
    const flow = await startCodePasteLogin(config, { timeoutMs: 30_000 });
    const state = new URL(flow.authorizeUrl).searchParams.get("state");
    flow.submit("just-the-code");
    await flow.completed;
    // documented convention: state carries the verifier value
    assert.equal(endpoint.received[0].state, state);
  } finally {
    await endpoint.close();
  }
});

test("refresh keeps the old refresh token when the endpoint does not rotate", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "new-access", expires_in: 60 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const config: OAuthClientConfig = {
      authorizeUrl: "https://provider.example/authorize",
      tokenUrl: `http://127.0.0.1:${port}/token`,
      clientId: "client-123",
      scopes: "a b",
    };
    const tokens = await refreshTokens(config, "old-refresh");
    assert.equal(tokens.accessToken, "new-access");
    assert.equal(tokens.refreshToken, "old-refresh");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
