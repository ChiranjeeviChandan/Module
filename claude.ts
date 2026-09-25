import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    // Keys that are not scoped to a workspace must name one on every request.
    const ws = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic({ maxRetries: 4, defaultHeaders: ws ? { "anthropic-workspace-id": ws } : undefined });
  }
  return client;
}

export interface Usage {
  input: number;
  output: number;
}

export interface JsonCallOptions {
  system: string;
  /** PDF bytes to attach before the prompt (the model sees page images + text). */
  pdf?: Uint8Array;
  prompt: string;
  schema: Record<string, unknown>;
  effort?: Effort;
  maxTokens?: number;
  usage?: Usage;
}

/**
 * One structured-output call. Streams (large PDFs + long outputs) and returns the
 * parsed JSON that the schema guarantees. Refusals are re-routed server-side via
 * `fallbacks: "default"`; if the whole chain refuses we throw.
 */
export async function callJson<T>(opts: JsonCallOptions): Promise<T> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (opts.pdf) {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from(opts.pdf).toString("base64"),
      },
    });
  }
  content.push({ type: "text", text: opts.prompt });

  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: opts.effort ?? "high",
      format: { type: "json_schema", schema: opts.schema },
    },
    system: opts.system,
    messages: [{ role: "user", content }],
  });
  const msg = await stream.finalMessage();

  if (opts.usage) {
    opts.usage.input +=
      msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
    opts.usage.output += msg.usage.output_tokens;
  }
  if (msg.stop_reason === "refusal") {
    throw new Error(`Model declined this request (${msg.stop_details?.category ?? "unspecified"}).`);
  }
  if (msg.stop_reason === "max_tokens") {
    throw new Error("Model output hit max_tokens; try a smaller page chunk.");
  }
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text) as T;
}
