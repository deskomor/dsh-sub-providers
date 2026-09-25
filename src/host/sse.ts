/**
 * Minimal Server-Sent Events reader over a fetch body. Yields `event`/`data`
 * pairs as parsed JSON. Shared by all provider wire implementations.
 */

export interface SseEvent {
  event: string;
  data: unknown;
}

function parseEvent(raw: string): SseEvent | undefined {
  let event = "message";
  let dataText = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataText += line.slice("data:".length).trim();
  }
  if (dataText.length === 0) return undefined;
  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return undefined;
  }
}

/** Iterate the SSE events of a streaming fetch response body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted === true) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Event boundaries are blank lines; tolerate CRLF framing.
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary !== null) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const parsed = parseEvent(raw);
        if (parsed !== undefined) yield parsed;
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
