import assert from "node:assert/strict";
import test from "node:test";
import { attributionHeaders, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { ProviderSession } from "../src/host/store.ts";
import {
  buildCodexBody,
  codexAccountFromClaims,
  codexEffortOf,
  createCodexProvider,
  parseCodexModels,
  parseCodexUsageWindows,
} from "../src/host/providers/codex.ts";

const session: ProviderSession = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 60_000,
  accountId: "acc_123",
};

function optionsOf(partial: Partial<GenerateOptions>): GenerateOptions {
  return {
    provider: "codex",
    model: "gpt-5-codex",
    messages: [],
    ...partial,
  } as GenerateOptions;
}

const noImage = async (): Promise<{ data: Uint8Array; mediaType: string }> => {
  throw new Error("no image expected");
};

// ---------------------------------------------------------------------------
// Claim parsing.
// ---------------------------------------------------------------------------

test("codex account facts come from the auth claim namespace", () => {
  const facts = codexAccountFromClaims({
    email: "me@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acc_9", chatgpt_plan_type: "pro" },
  });
  assert.deepEqual(facts, { email: "me@example.com", accountId: "acc_9", plan: "pro" });
});

test("codex account facts tolerate missing claims", () => {
  assert.deepEqual(codexAccountFromClaims(undefined), {});
  assert.deepEqual(codexAccountFromClaims({ sub: "x" }), {});
});

test("codex effort mapping is strict", () => {
  assert.equal(codexEffortOf("high"), "high");
  assert.equal(codexEffortOf("nonsense"), undefined);
  assert.equal(codexEffortOf(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Catalog and usage parsers.
// ---------------------------------------------------------------------------

test("model catalog parses ids, names, and advertised tiers", () => {
  const { models, tiers } = parseCodexModels({
    data: [
      { id: "gpt-5-codex", display_name: "GPT-5 Codex", service_tier: "speed" },
      { id: "codex-mini-latest" },
      { not_a_model: true },
    ],
  });
  assert.deepEqual(models.map((m) => m.id), ["gpt-5-codex", "codex-mini-latest"]);
  assert.equal(models[1].name, "Codex Mini Latest");
  assert.equal(tiers.get("gpt-5-codex"), "speed");
});

test("usage windows parse flat and nested shapes", () => {
  assert.deepEqual(
    parseCodexUsageWindows({ primary: { used_percent: 42, resets_at: 1700000000 }, secondary: { utilization: 7 } }),
    [
      { id: "primary", label: "Primary window", usedPercent: 42, resetsAt: 1700000000000 },
      { id: "secondary", label: "Secondary window", usedPercent: 7 },
    ],
  );
  const nested = parseCodexUsageWindows({ rate_limits: { weekly: { percent_used: 50, reset_at: "2025-01-01T00:00:00Z" } } });
  assert.equal(nested.length, 1);
  assert.equal(nested[0].id, "weekly");
  assert.equal(nested[0].usedPercent, 50);
  assert.equal(nested[0].resetsAt, Date.parse("2025-01-01T00:00:00Z"));
});

// ---------------------------------------------------------------------------
// Request body assembly.
// ---------------------------------------------------------------------------

test("request body maps system, tools, effort, and modalities", async () => {
  const body = await buildCodexBody(
    optionsOf({
      system: "be brief",
      reasoningEffort: "high" as never,
      tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
      messages: [
        { role: "system", content: [{ type: "text", text: "extra" }] } as never,
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", attachment: {} as never },
            { type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "42" }] } as never,
          ],
        } as never,
        {
          role: "assistant",
          content: [
            { type: "text", text: "thinking out loud" },
            { type: "tool-call", id: "call_1", name: "read", arguments: '{"path":"a"}' },
          ],
        } as never,
      ],
    }),
    async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }),
  );

  assert.equal(body.model, "gpt-5-codex");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.instructions, "be brief\n\nextra");
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(body.tools, [{ type: "function", name: "read", description: "read a file", parameters: { type: "object" }, strict: false }]);
  assert.equal(body.parallel_tool_calls, false);

  const input = body.input as Array<Record<string, any>>;
  assert.deepEqual(input[0], {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "hello" },
      { type: "input_image", image_url: "data:image/png;base64,AQID" },
    ],
  });
  assert.deepEqual(input[1], { type: "function_call_output", call_id: "call_1", output: "42" });
  assert.deepEqual(input[2], { type: "message", role: "assistant", content: [{ type: "output_text", text: "thinking out loud" }] });
  assert.deepEqual(input[3], { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' });
});

test("unknown reasoning effort falls back to the provider default", async () => {
  const body = await buildCodexBody(optionsOf({ reasoningEffort: "bogus" as never }), noImage);
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
});

// ---------------------------------------------------------------------------
// Stream mapping (stubbed transport).
// ---------------------------------------------------------------------------

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

test("SSE stream maps to harness chunks with usage and stop", async () => {
  const sse =
    'event: response.created\ndata: {"response":{"id":"r1"}}\n\n' +
    'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"reasoning"}}\n\n' +
    'event: response.reasoning_summary_text.delta\ndata: {"output_index":0,"delta":"think "}\n\n' +
    'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"reasoning"}}\n\n' +
    'event: response.output_item.added\ndata: {"output_index":1,"item":{"type":"message","role":"assistant"}}\n\n' +
    'event: response.output_text.delta\ndata: {"output_index":1,"delta":"Hi"}\n\n' +
    'event: response.output_item.done\ndata: {"output_index":1,"item":{"type":"message"}}\n\n' +
    'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":5,"total_tokens":17}}}\n\n';

  const captured: { headers?: HeadersInit; body?: string } = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.headers = init?.headers;
    captured.body = String(init?.body);
    return new Response(sse, { status: 200 });
  }) as typeof fetch;

  try {
    const provider = createCodexProvider();
    const chunks = await collect(
      provider.stream(optionsOf({ messages: [{ role: "user", content: [{ type: "text", text: "hey" }] }] as never }), session, noImage),
    );
    assert.deepEqual(chunks, [
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "think " },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "think " } },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "Hi" },
      { type: "block-end", index: 1, block: { type: "text", text: "Hi" } },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 17 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);

    const headers = captured.headers as Record<string, string>;
    assert.equal(headers.originator, "codex_cli_rs");
    assert.equal(headers["openai-beta"], "responses=experimental");
    assert.equal(headers["chatgpt-account-id"], "acc_123");
    assert.match(headers["user-agent"], /^codex_cli_rs\/[\d.]+ /);
    const attribution = attributionHeaders();
    assert.ok(
      typeof attribution["user-agent"] === "string" && headers["user-agent"].includes(attribution["user-agent"]),
      "attribution stays in the UA",
    );
    assert.equal(typeof headers["session_id"], "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("function-call streams finish with tool-calls and stream failures throw", async () => {
  const callSse =
    'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"call_7","name":"read"}}\n\n' +
    'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{\\"p\\":1}"}\n\n' +
    'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"call_7","name":"read","arguments":"{\\"p\\":1}"}}\n\n' +
    'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n';

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(callSse, { status: 200 })) as typeof fetch;
    const provider = createCodexProvider();
    const chunks = await collect(provider.stream(optionsOf({}), session, noImage));
    const finish = chunks[chunks.length - 1];
    assert.deepEqual(finish, { type: "finish", reason: { kind: "tool-calls" } });
    const blockEnd = chunks.find((chunk) => chunk.type === "block-end");
    assert.deepEqual(blockEnd, {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id: "call_7", name: "read", arguments: '{"p":1}' },
    });

    globalThis.fetch = (async () =>
      new Response('event: response.failed\ndata: {"response":{"error":{"message":"boom"}}}\n\n', { status: 200 })) as typeof fetch;
    await assert.rejects(collect(provider.stream(optionsOf({}), session, noImage)), /boom/);

    globalThis.fetch = (async () => new Response("nope", { status: 429 })) as typeof fetch;
    await assert.rejects(collect(provider.stream(optionsOf({}), session, noImage)), /429/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("max-output truncation maps to the max-tokens finish reason", async () => {
  const sse =
    'event: response.completed\ndata: {"response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch;
    const provider = createCodexProvider();
    const chunks = await collect(provider.stream(optionsOf({}), session, noImage));
    assert.deepEqual(chunks[chunks.length - 1], { type: "finish", reason: { kind: "max-tokens" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
