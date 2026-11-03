import { setDefaultResultOrder } from "node:dns";
import { chat } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { z } from "zod";

// Match the landing service: prefer IPv4 egress for the Meta API.
setDefaultResultOrder("ipv4first");

// Qualitative vendor strategy via Muse Spark, on TanStack AI.
//
// The vendor's written policy (VENDOR_POLICY_TEXT) describes how the
// company likes to negotiate. Spark proposes each counter inside a
// numeric envelope computed by discount_policy.ts. The deterministic
// guard there disposes: nothing leaves below the floor, nothing moves
// without a verified price, and any model failure falls back to the
// deterministic step. The model never sees a user, only its own
// company's numbers.
//
// TanStack AI wiring: the Meta API is an OpenAI-compatible Chat
// Completions endpoint, so the generic compatible adapter points at it
// (META_API_BASE_URL, default https://api.meta.ai/v1) with the vendor's
// MODEL_API_KEY. Structured output runs in JSON-object mode
// (response_format: json_object, the mode the Meta API supports), so
// the wire format matches the previous direct fetch, while TanStack AI
// validates the reply against the schema before it reaches the guard.

export const VENDOR_MODEL = process.env.VENDOR_MODEL ?? "muse-spark-1.3";
export const VENDOR_RUNTIME = process.env.VENDOR_AGENT_RUNTIME ?? "TanStack AI";

const CounterProposalSchema = z.object({
  price: z.number().meta({ description: "Proposed next price in USD" }),
  style: z.string().meta({
    description: "Four-word-max description of the move, e.g. 'penny under, holding firm'",
  }),
});

export interface CounterProposal {
  price: number;
  style: string;
  model: string;
  runtime: string;
}

export function isVendorModelConfigured(): boolean {
  return Boolean(process.env.MODEL_API_KEY);
}

// One TanStack AI text adapter for this vendor's Muse Spark model.
// Returns null when no model key is configured; callers fall back to
// deterministic behavior. Built per call so env (and test doubles for
// global fetch) are always read fresh.
export function createVendorTextAdapter() {
  const key = process.env.MODEL_API_KEY;
  if (!key) return null;
  const base = (process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
  const model = process.env.VENDOR_MODEL ?? "muse-spark-1.3";
  return openaiCompatibleText(model, {
    name: "meta",
    baseURL: base,
    apiKey: key,
    api: "chat-completions",
    // Preserve the previous direct-fetch behavior: one attempt, 15s.
    timeout: 15_000,
    maxRetries: 0,
  });
}

export async function proposeCounter(input: {
  product: string;
  current: number;
  attested: number;
  floor: number;
  round: number;
  policyText: string;
  context?: string;
}): Promise<CounterProposal | null> {
  if (!input.policyText) return null;
  const adapter = createVendorTextAdapter();
  if (!adapter) return null;
  const model = process.env.VENDOR_MODEL ?? "muse-spark-1.3";
  try {
    const proposal = await chat({
      adapter,
      messages: [
        {
          role: "user",
          content: `You are the pricing agent for a company selling "${input.product}". Your company's negotiation policy, in its own words: "${input.policyText}"\n\nSituation: your current price is $${input.current}. A rival's lower price of $${input.attested} has been cryptographically verified. Your absolute bottom line is $${input.floor}: never propose below it. This is round ${input.round}.${input.context ? `\n\nCompany state to weigh: ${input.context}` : ""}\n\nPropose your next price. It must be below $${input.attested} (you are beating a verified price, not matching it) and at or above $${input.floor}. Follow your company's policy for how boldly to move. Return ONLY JSON: {"price": number, "style": string} where style is a four-word-max description of your move, e.g. "penny under, holding firm".`,
        },
      ],
      threadId: "vendor-counter-proposal",
      outputSchema: CounterProposalSchema,
      modelOptions: {
        max_tokens: 2000,
        response_format: { type: "json_object" },
      },
    });
    if (typeof proposal.price !== "number" || !Number.isFinite(proposal.price)) return null;
    return {
      price: Math.round(proposal.price * 100) / 100,
      style: typeof proposal.style === "string" ? proposal.style.slice(0, 60) : "",
      model,
      runtime: process.env.VENDOR_AGENT_RUNTIME ?? "TanStack AI",
    };
  } catch {
    return null;
  }
}
