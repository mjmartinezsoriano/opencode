import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createThinkTagMiddleware, _testInternals } from "../../src/session/llm/think-tag-middleware"
import { ProviderTransform } from "../../src/provider/transform"

// ---------- helpers ----------

function makeStream(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

// Extract the visible text from a stream of V3 parts. Concatenates text-delta
// deltas only; reasoning-deltas are deliberately ignored so the test can
// assert "no user-visible text was lost in the splitting".
function extractVisibleText(parts: LanguageModelV3StreamPart[]): string {
  let text = ""
  for (const p of parts) {
    if (p.type === "text-delta") text += p.delta
  }
  return text
}

// Concatenate the reasoning-delta deltas so we can assert reasoning content
// round-trips losslessly too.
function extractReasoningText(parts: LanguageModelV3StreamPart[]): string {
  let text = ""
  for (const p of parts) {
    if (p.type === "reasoning-delta") text += p.delta
  }
  return text
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ---------- unit tests for processTextChunk ----------

describe("think-tag-middleware / processTextChunk", () => {
  test("simple split: text then think then text", () => {
    const s0 = _testInternals.freshState()
    s0.textID = "txt-1"
    const { next, out } = _testInternals.processTextChunk(s0, "<think>hello</think>world", undefined)

    // First emit: text-delta "" is skipped (empty before tag), reasoning-start,
    // reasoning-delta "hello", reasoning-end. Then loop continues, the remaining
    // "world" becomes a text-delta reusing the original text ID.
    const types = out.map((p) => p.type)
    expect(types).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end", "text-delta"])
    expect(out[0]).toMatchObject({ type: "reasoning-start", id: "reasoning-1" })
    expect(out[1]).toMatchObject({ type: "reasoning-delta", id: "reasoning-1", delta: "hello" })
    expect(out[2]).toMatchObject({ type: "reasoning-end", id: "reasoning-1" })
    expect(out[3]).toMatchObject({ type: "text-delta", id: "txt-1", delta: "world" })
    expect(next.inReasoning).toBe(false)
    // The text ID is preserved across the reasoning block so the consumer can
    // reassemble the underlying text part if it needs to.
    expect(next.textID).toBe("txt-1")
    expect(next.reasoningID).toBeNull()
  })

  test("preamble before tag is preserved as text", () => {
    const s0 = _testInternals.freshState()
    s0.textID = "txt-1"
    const { out } = _testInternals.processTextChunk(s0, "preamble<think>hidden</think>done", undefined)
    expect(out[0]).toMatchObject({ type: "text-delta", id: "txt-1", delta: "preamble" })
    expect(out[out.length - 1]).toMatchObject({ type: "text-delta", id: "txt-1", delta: "done" })
  })

  test("multiple think blocks emit separate reasoning IDs", () => {
    const s0 = _testInternals.freshState()
    s0.textID = "txt-1"
    const { out } = _testInternals.processTextChunk(
      s0,
      "<think>first</think>mid<think>second</think>end",
      undefined,
    )
    const reasoningStarts = out.filter((p) => p.type === "reasoning-start")
    expect(reasoningStarts).toHaveLength(2)
    expect(reasoningStarts[0]).toMatchObject({ id: "reasoning-1" })
    expect(reasoningStarts[1]).toMatchObject({ id: "reasoning-2" })
    const reasoningEnds = out.filter((p) => p.type === "reasoning-end")
    expect(reasoningEnds).toHaveLength(2)
    expect(reasoningEnds[0]).toMatchObject({ id: "reasoning-1" })
    expect(reasoningEnds[1]).toMatchObject({ id: "reasoning-2" })
  })

  test("unclosed think block at end falls back to closing cleanly", () => {
    const s0 = _testInternals.freshState()
    s0.textID = "txt-1"
    const { next, out } = _testInternals.processTextChunk(s0, "<think>still thinking", undefined)
    // Streaming: the inner content is emitted as a reasoning-delta immediately
    // so the consumer still sees progress, and the parser stays open because
    // no closing tag was found.
    expect(out.some((p) => p.type === "reasoning-start")).toBe(true)
    const reasoningDelta = out.find((p) => p.type === "reasoning-delta") as { delta: string } | undefined
    expect(reasoningDelta?.delta).toBe("still thinking")
    expect(next.inReasoning).toBe(true)
    expect(next.pending).toBe("")

    // End-of-stream flushPending will close the open reasoning block.
    const finalFlush = _testInternals.flushPending(next, undefined)
    expect(finalFlush.some((p) => p.type === "reasoning-end")).toBe(true)
  })

  test("empty think block produces start+end without delta", () => {
    const s0 = _testInternals.freshState()
    s0.textID = "txt-1"
    const { out } = _testInternals.processTextChunk(s0, "<think></think>after", undefined)
    expect(out.some((p) => p.type === "reasoning-start")).toBe(true)
    expect(out.some((p) => p.type === "reasoning-end")).toBe(true)
    expect(out.some((p) => p.type === "reasoning-delta")).toBe(false)
    expect(out[out.length - 1]).toMatchObject({ type: "text-delta", id: "txt-1", delta: "after" })
  })

  test("think split across two deltas still resolves", async () => {
    const s0 = _testInternals.freshState()
    s0.textID = "txt-1"
    // First delta ends with `<`, second starts with `think>`. Holdback keeps
    // the trailing `<` in pending; the second call sees the full tag.
    const { next: n1, out: o1 } = _testInternals.processTextChunk(s0, "hello<", undefined)
    expect(o1).toHaveLength(1)
    expect(o1[0]).toMatchObject({ type: "text-delta", id: "txt-1", delta: "hello" })
    expect(n1.pending).toBe("<")

    const { out: o2 } = _testInternals.processTextChunk(n1, "think>body</think>world", undefined)
    const types = o2.map((p) => p.type)
    expect(types).toContain("reasoning-start")
    expect(types).toContain("reasoning-end")
    expect(types).toContain("text-delta")
    expect(o2.find((p) => p.type === "reasoning-delta")).toMatchObject({
      type: "reasoning-delta",
      delta: "body",
    })
    expect(o2[o2.length - 1]).toMatchObject({ type: "text-delta", id: "txt-1", delta: "world" })
  })

  test("case-insensitive tag matching", () => {
    const s0 = _testInternals.freshState()
    s0.textID = "txt-1"
    const { out } = _testInternals.processTextChunk(s0, "<ThInK>hidden</ThInK>done", undefined)
    expect(out.some((p) => p.type === "reasoning-start")).toBe(true)
    expect(out.some((p) => p.type === "reasoning-end")).toBe(true)
    expect(out[out.length - 1]).toMatchObject({ type: "text-delta", delta: "done" })
  })
})

// ---------- integration tests with the full middleware ----------

describe("think-tag-middleware / wrapStream", () => {
  test("passthrough when no think tag present", async () => {
    const middleware = createThinkTagMiddleware()
    const upstream = makeStream([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "plain text only" },
      { type: "text-end", id: "t1" },
    ] as LanguageModelV3StreamPart[])

    const result = await middleware.wrapStream!({
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () => Promise.resolve({ stream: upstream }),
      params: {} as never,
      model: {} as never,
    })

    const parts = await collect(result.stream)
    expect(parts).toHaveLength(3)
    expect(parts[0]).toMatchObject({ type: "text-start", id: "t1" })
    expect(parts[1]).toMatchObject({ type: "text-delta", id: "t1", delta: "plain text only" })
    expect(parts[2]).toMatchObject({ type: "text-end", id: "t1" })
  })

  test("full stream with one inline think block collapses correctly", async () => {
    const middleware = createThinkTagMiddleware()
    const upstream = makeStream([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "before " },
      { type: "text-delta", id: "t1", delta: "<think>secret thought</think>" },
      { type: "text-delta", id: "t1", delta: "after" },
      { type: "text-end", id: "t1" },
    ] as LanguageModelV3StreamPart[])

    const result = await middleware.wrapStream!({
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () => Promise.resolve({ stream: upstream }),
      params: {} as never,
      model: {} as never,
    })

    const parts = await collect(result.stream)
    expect(extractVisibleText(parts)).toBe("before after")
    expect(extractReasoningText(parts)).toBe("secret thought")
    // We expect: text-delta "before ", reasoning-start, reasoning-delta,
    // reasoning-end, text-delta "after", text-end.
    const types = parts.map((p) => p.type)
    expect(types).toEqual(["text-start", "text-delta", "reasoning-start", "reasoning-delta", "reasoning-end", "text-delta", "text-end"])
  })

  test("model already emitting reasoning-* is passed through untouched", async () => {
    const middleware = createThinkTagMiddleware()
    const upstream = makeStream([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "structured" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "answer" },
      { type: "text-end", id: "t1" },
    ] as LanguageModelV3StreamPart[])

    const result = await middleware.wrapStream!({
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () => Promise.resolve({ stream: upstream }),
      params: {} as never,
      model: {} as never,
    })

    const parts = await collect(result.stream)
    expect(parts).toHaveLength(6)
    expect(parts.map((p) => p.type)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end", "text-start", "text-delta", "text-end"])
  })

  test("stream ending inside think emits a clean reasoning-end", async () => {
    const middleware = createThinkTagMiddleware()
    const upstream = makeStream([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "<think>never closes" },
      { type: "text-end", id: "t1" },
    ] as LanguageModelV3StreamPart[])

    const result = await middleware.wrapStream!({
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () => Promise.resolve({ stream: upstream }),
      params: {} as never,
      model: {} as never,
    })

    const parts = await collect(result.stream)
    // text-end fires when the upstream says the text part is done, and the
    // end-of-stream flushPending emits a balancing reasoning-end so the
    // consumer does not hang waiting for it.
    const reasoningEnds = parts.filter((p) => p.type === "reasoning-end")
    expect(reasoningEnds.length).toBeGreaterThanOrEqual(1)
    // The text part itself must still be terminated by a text-end event.
    expect(parts.some((p) => p.type === "text-end")).toBe(true)
    // The reasoning content "never closes" must be visible in reasoning-deltas.
    expect(extractReasoningText(parts)).toBe("never closes")
  })
})

// ---------- invariant: total visible text is preserved across splitting ----------

describe("think-tag-middleware / invariants", () => {
  test("no character is lost or duplicated across a multi-chunk stream (sha256)", async () => {
    // Simulate a realistic M3 payload: small preamble, long think block, long
    // visible answer. Then verify the split preserves every byte.
    const preamble = "I'll work through this step by step. "
    const thinkBody = "Let me think about the implications. ".repeat(40)
    const visibleBody = "Here is my answer with a list:\n- one\n- two\n- three\n".repeat(20)

    const original = preamble + `<think>${thinkBody}</think>` + visibleBody
    const expectedTotal = preamble + thinkBody + visibleBody
    const expectedTotalHash = await sha256(expectedTotal)
    const expectedVisible = preamble + visibleBody

    const middleware = createThinkTagMiddleware()
    const upstream = makeStream([
      { type: "text-start", id: "t1" },
      // Split into many small deltas so the parser has to reassemble.
      ...chunked(original, 17).map(
        (delta) => ({ type: "text-delta", id: "t1", delta }) as LanguageModelV3StreamPart,
      ),
      { type: "text-end", id: "t1" },
    ])

    const result = await middleware.wrapStream!({
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: () => Promise.resolve({ stream: upstream }),
      params: {} as never,
      model: {} as never,
    })

    const parts = await collect(result.stream)

    // Walk the event stream and interleave text / reasoning deltas in their
    // actual emission order. That gives us a faithful reconstruction of
    // what the consumer will see end-to-end.
    const reconstructed: string[] = []
    let inReasoning = false
    for (const part of parts) {
      if (part.type === "reasoning-start") inReasoning = true
      if (part.type === "reasoning-end") inReasoning = false
      if (part.type === "text-delta" && !inReasoning) reconstructed.push(part.delta)
      if (part.type === "reasoning-delta" && inReasoning) reconstructed.push(part.delta)
    }
    const combined = reconstructed.join("")
    const combinedHash = await sha256(combined)

    // Invariant 1: every character the model emitted must be present in the
    // combined text+reasoning stream, in the original order, with the tags
    // removed. SHA-256 catches any out-of-order, duplicated or dropped byte.
    expect(combinedHash).toBe(expectedTotalHash)
    expect(combined).toBe(expectedTotal)

    // Invariant 2: the agent-visible content (text-deltas concatenated in
    // arrival order, skipping the in-reasoning segments) equals the original
    // payload with the think tags and body stripped out.
    expect(await sha256(extractVisibleText(parts))).toBe(await sha256(expectedVisible))

    // Invariant 3: the reasoning content equals the think body exactly.
    expect(extractReasoningText(parts)).toBe(thinkBody)
  })
})

function chunked(input: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < input.length; i += size) out.push(input.slice(i, i + size))
  return out
}

// ---------- gating: shouldParseThinkTags ----------

describe("ProviderTransform.shouldParseThinkTags", () => {
  function fakeModel(id: string, npm: string, providerID: string) {
    return { api: { id, npm }, providerID } as never
  }

  test("true for MiniMax-M3 via OpenAI-compatible", () => {
    expect(ProviderTransform.shouldParseThinkTags(fakeModel("MiniMax-M3", "@ai-sdk/openai-compatible", "minimax"))).toBe(true)
  })

  test("false for M3 via the Anthropic-compatible endpoint", () => {
    // Anthropic path already emits reasoning as separate blocks.
    expect(ProviderTransform.shouldParseThinkTags(fakeModel("MiniMax-M3", "@ai-sdk/anthropic", "minimax"))).toBe(false)
  })

  test("false for any non-M3 model", () => {
    expect(ProviderTransform.shouldParseThinkTags(fakeModel("claude-3-5-sonnet", "@ai-sdk/openai-compatible", "anthropic"))).toBe(false)
    expect(ProviderTransform.shouldParseThinkTags(fakeModel("gpt-4o", "@ai-sdk/openai", "openai"))).toBe(false)
  })

  test("false when the provider ID is not minimax", () => {
    expect(ProviderTransform.shouldParseThinkTags(fakeModel("MiniMax-M3", "@ai-sdk/openai-compatible", "custom"))).toBe(false)
  })

  test("case-insensitive model id matching", () => {
    expect(ProviderTransform.shouldParseThinkTags(fakeModel("minimax-m3", "@ai-sdk/openai-compatible", "minimax"))).toBe(true)
  })
})