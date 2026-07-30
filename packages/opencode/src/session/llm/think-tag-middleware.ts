import type {
  JSONObject,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider"

// MiniMax-M3 (via the OpenAI-compatible Chat Completions endpoint) emits
// chain-of-thought inline as `顕...` tags in text content rather than as
// structured `reasoning_content` on the response. Without a parser the
// thinking is rendered fully expanded inside the text part; this middleware
// splits any text-delta stream at those tag boundaries and re-emits the
// content as reasoning-start / reasoning-delta / reasoning-end events so the
// rest of the opencode pipeline (and the TUI) can collapse them as usual.
//
// Surfacing rules:
// - We never mutate deltas that do not contain a tag boundary. They pass
//   through unchanged so non-M3 traffic is unaffected.
// - If a stream opens `顕` but never closes `</顕`, we flush the rest of the
//   buffered content as a final reasoning-delta and emit a matching
//   reasoning-end. Better to leak a half-baked block than to drop legitimate
//   output silently.
// - Reasoning IDs are synthesised on first emit; the upstream model does not
//   know we are splitting, so it never issues a reasoning-start.

type ProviderMetadata = Record<string, JSONObject> | undefined

// Pre-compiled and case-insensitive so we stay safe across minor formatting
// drift in the model output (e.g. `顕` vs `<ThInK>`).
const THINK_OPEN_RE = /<\s*think\s*>/i
const THINK_CLOSE_RE = /<\s*\/\s*think\s*>/i

type State = {
  // Whether the parser is currently inside a 顕... region.
  inReasoning: boolean
  // Buffer of text-delta content that may straddle a tag boundary.
  pending: string
  // ID carried by upstream text-start / text-delta for the current block.
  textID: string | null
  // ID synthesised for the current reasoning block. We emit an id when we
  // open, and reuse it for every delta until we close.
  reasoningID: string | null
  // Counter for synthesised IDs. The TUI expects unique per-part strings.
  idCounter: number
}

function freshState(): State {
  return {
    inReasoning: false,
    pending: "",
    textID: null,
    reasoningID: null,
    idCounter: 0,
  }
}

function nextReasoningID(state: State): string {
  state.idCounter += 1
  return `reasoning-${state.idCounter}`
}

// Build a stream part object with an optional `providerMetadata` field.
// The `SharedV3ProviderMetadata` type is optional in the V3 spec, so we omit
// the field entirely when undefined to avoid emitting literal `undefined`
// values that downstream consumers do not always expect.
function withMeta(meta: ProviderMetadata, body: Record<string, unknown>): Record<string, unknown> {
  if (meta) return { ...body, providerMetadata: meta }
  return body
}

// Process a freshly buffered text delta and emit zero or more output parts.
// The function is pure: it takes the current state plus a chunk of text and
// returns the parts to enqueue downstream plus the next state.
//
// The state machine is intentionally minimal:
// - Text mode: scan for `顕`. When found, switch to reasoning mode and emit
//   the prefix as a text-delta (skipping it when empty).
// - Reasoning mode: scan for `</顕>`. When found, switch back to text mode
//   and emit any remaining text after the close as a text-delta.
//
// To avoid a long buffer-delay we hold back at most the single trailing `<`
// from each chunk - enough to resolve a streamed `顕` split across two
// deltas, never enough to feel laggy.
function processTextChunk(
  state: State,
  chunk: string,
  meta: ProviderMetadata,
): { next: State; out: LanguageModelV3StreamPart[] } {
  let text = state.pending + chunk
  const out: LanguageModelV3StreamPart[] = []
  let s = state

  while (text.length > 0) {
    if (!s.inReasoning) {
      const open = text.search(THINK_OPEN_RE)
      if (open === -1) {
        // No opening tag in this chunk. Hold back the tail starting at the
        // last `<` so a partial `<` or `<think` split across two deltas can
        // still resolve into a complete opening tag on the next call.
        const lastOpen = text.lastIndexOf("<")
        if (lastOpen === -1) {
          if (s.textID !== null && text.length > 0) {
            out.push({
              type: "text-delta",
              id: s.textID,
              delta: text,
              ...withMeta(meta, {}),
            } as LanguageModelV3StreamPart)
          }
          return { next: { ...s, pending: "" }, out }
        }
        const flush = text.slice(0, lastOpen)
        const remaining = text.slice(lastOpen)
        if (s.textID !== null && flush.length > 0) {
          out.push({
            type: "text-delta",
            id: s.textID,
            delta: flush,
            ...withMeta(meta, {}),
          } as LanguageModelV3StreamPart)
        }
        return { next: { ...s, pending: remaining }, out }
      }
      const openMatch = THINK_OPEN_RE.exec(text.slice(open))!
      const skipLen = openMatch[0].length
      const before = text.slice(0, open)
      const after = text.slice(open + skipLen)
      if (s.textID !== null && before.length > 0) {
        out.push({
          type: "text-delta",
          id: s.textID,
          delta: before,
          ...withMeta(meta, {}),
        } as LanguageModelV3StreamPart)
      }
      const reasoningID = nextReasoningID(s)
      out.push({
        type: "reasoning-start",
        id: reasoningID,
        ...withMeta(meta, {}),
      } as LanguageModelV3StreamPart)
      // Keep s.textID so we can resume emitting text-delta after the close
      // tag. The text part is logically one continuous stream from the
      // upstream model's perspective; we are only borrowing it to slot in
      // reasoning blocks.
      s = {
        ...s,
        inReasoning: true,
        reasoningID,
        pending: "",
      }
      text = after
      continue
    }
    // In reasoning mode. Scan for the closing tag.
    const close = text.search(THINK_CLOSE_RE)
    if (close === -1) {
      // Hold back the tail starting at the last `<` so a partial `</` or
      // `</thin` split across two deltas can still resolve into a complete
      // closing tag on the next call.
      const lastOpen = text.lastIndexOf("<")
      if (lastOpen === -1) {
        if (s.reasoningID !== null && text.length > 0) {
          out.push({
            type: "reasoning-delta",
            id: s.reasoningID,
            delta: text,
            ...withMeta(meta, {}),
          } as LanguageModelV3StreamPart)
        }
        return { next: { ...s, pending: "" }, out }
      }
      const flush = text.slice(0, lastOpen)
      const remaining = text.slice(lastOpen)
      if (s.reasoningID !== null && flush.length > 0) {
        out.push({
          type: "reasoning-delta",
          id: s.reasoningID,
          delta: flush,
          ...withMeta(meta, {}),
        } as LanguageModelV3StreamPart)
      }
      return { next: { ...s, pending: remaining }, out }
    }
    const closeMatch = THINK_CLOSE_RE.exec(text.slice(close))!
    const skipLen = closeMatch[0].length
    const before = text.slice(0, close)
    const after = text.slice(close + skipLen)
    if (s.reasoningID !== null && before.length > 0) {
      out.push({
        type: "reasoning-delta",
        id: s.reasoningID,
        delta: before,
        ...withMeta(meta, {}),
      } as LanguageModelV3StreamPart)
    }
    if (s.reasoningID !== null) {
      out.push({
        type: "reasoning-end",
        id: s.reasoningID,
        ...withMeta(meta, {}),
      } as LanguageModelV3StreamPart)
    }
    s = {
      ...s,
      inReasoning: false,
      reasoningID: null,
      pending: "",
    }
    text = after
    continue
  }

  return { next: { ...s, pending: "" }, out }
}

// Flush whatever is in the buffer when the stream ends. If we are still in
// reasoning mode (no closing tag arrived), emit a final reasoning-delta and a
// reasoning-end so the consumer sees a balanced event sequence. The pending
// buffer may also contain a stray `<` we held back; we flush it as text.
function flushPending(state: State, meta: ProviderMetadata): LanguageModelV3StreamPart[] {
  const out: LanguageModelV3StreamPart[] = []
  const tail = state.pending
  if (tail.length === 0) {
    if (state.inReasoning && state.reasoningID !== null) {
      out.push({
        type: "reasoning-end",
        id: state.reasoningID,
        ...withMeta(meta, {}),
      } as LanguageModelV3StreamPart)
    }
    return out
  }
  if (state.inReasoning && state.reasoningID !== null) {
    out.push({
      type: "reasoning-delta",
      id: state.reasoningID,
      delta: tail,
      ...withMeta(meta, {}),
    } as LanguageModelV3StreamPart)
    out.push({
      type: "reasoning-end",
      id: state.reasoningID,
      ...withMeta(meta, {}),
    } as LanguageModelV3StreamPart)
  } else if (state.textID !== null) {
    out.push({
      type: "text-delta",
      id: state.textID,
      delta: tail,
      ...withMeta(meta, {}),
    } as LanguageModelV3StreamPart)
  }
  return out
}

export function createThinkTagMiddleware(): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream }): Promise<LanguageModelV3StreamResult> => {
      const upstream = await doStream()
      const upstreamStream = upstream.stream
      const reader = upstreamStream.getReader()

      const state: State = freshState()
      let lastTextMeta: ProviderMetadata = undefined

      const output = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          try {
            while (true) {
              const { value, done } = await reader.read()
              if (done) {
                const flush = flushPending(state, lastTextMeta)
                for (const part of flush) controller.enqueue(part)
                controller.close()
                return
              }
              const part = value
              switch (part.type) {
                case "text-start":
                  state.textID = part.id
                  lastTextMeta = part.providerMetadata
                  controller.enqueue(part)
                  break
                case "text-delta": {
                  lastTextMeta = part.providerMetadata
                  const { next, out } = processTextChunk(state, part.delta, part.providerMetadata)
                  state.inReasoning = next.inReasoning
                  state.pending = next.pending
                  state.textID = next.textID
                  state.reasoningID = next.reasoningID
                  state.idCounter = next.idCounter
                  for (const outPart of out) controller.enqueue(outPart)
                  break
                }
                case "text-end": {
                  // We may still have an unflushed single `<` held back by
                  // the buffer. Flush it as a final text-delta before
                  // emitting end so we never lose characters.
                  if (state.pending.length > 0 && state.textID !== null) {
                    controller.enqueue({
                      type: "text-delta",
                      id: state.textID,
                      delta: state.pending,
                      ...withMeta(lastTextMeta, {}),
                    } as LanguageModelV3StreamPart)
                    state.pending = ""
                  }
                  controller.enqueue(part)
                  state.textID = null
                  break
                }
                case "reasoning-start":
                case "reasoning-delta":
                case "reasoning-end":
                  // The model itself emitted structured reasoning. Pass it
                  // through and discard any buffered state we were tracking
                  // for tag-handling. The model is now telling us where
                  // reasoning starts/ends, so our parser should not interfere.
                  state.pending = ""
                  controller.enqueue(part)
                  break
                default:
                  controller.enqueue(part)
                  break
              }
            }
          } catch (err) {
            controller.error(err)
            try {
              await reader.cancel()
            } catch {
              // ignore cancel failures
            }
          }
        },
        cancel(reason) {
          // Forward cancellation upstream so the connection closes.
          try {
            void reader.cancel(reason)
          } catch {
            // ignore
          }
        },
      })

      return {
        stream: output,
        ...(upstream.request ? { request: upstream.request } : {}),
      }
    },
  }
}

// Exposed for unit tests; not part of the public surface.
export const _testInternals = {
  processTextChunk,
  flushPending,
  freshState,
}