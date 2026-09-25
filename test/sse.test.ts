import assert from "node:assert/strict";
import test from "node:test";
import { sseEvents } from "../src/host/sse.ts";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

test("sseEvents parses event/data pairs", async () => {
  const body = streamOf(
    'event: message_start\ndata: {"n":1}\n\n' +
      'event: content_block_delta\ndata: {"n":2}\n\n' +
      "data: {\"n\":3}\n\n",
  );
  const events = [];
  for await (const event of sseEvents(body)) events.push(event);
  assert.deepEqual(events, [
    { event: "message_start", data: { n: 1 } },
    { event: "content_block_delta", data: { n: 2 } },
    { event: "message", data: { n: 3 } },
  ]);
});

test("sseEvents splits across chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const pieces = ['event: a\ndata: {"x"', ':1}\n\nevent: b\ndata: {"y":2}', "\n\n"];
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  const events = [];
  for await (const event of sseEvents(body)) events.push(event);
  assert.deepEqual(events, [
    { event: "a", data: { x: 1 } },
    { event: "b", data: { y: 2 } },
  ]);
});

test("sseEvents ignores comments and malformed data", async () => {
  const body = streamOf(": keepalive\n\nevent: bad\ndata: {not json}\n\nevent: ok\ndata: 1\n\n");
  const events = [];
  for await (const event of sseEvents(body)) events.push(event);
  assert.deepEqual(events, [{ event: "ok", data: 1 }]);
});

test("sseEvents handles CRLF line endings", async () => {
  const body = streamOf('event: x\r\ndata: {"ok":true}\r\n\r\n');
  const events = [];
  for await (const event of sseEvents(body)) events.push(event);
  assert.deepEqual(events, [{ event: "x", data: { ok: true } }]);
});
