// Qualitative vendor strategy via Muse Spark.
//
// The vendor's written policy (VENDOR_POLICY_TEXT) describes how the
// company likes to negotiate. Spark proposes each counter inside a
// numeric envelope computed by discount_policy.ts. The deterministic
// guard there disposes: nothing leaves below the floor, nothing moves
// without a verified price, and any model failure falls back to the
// deterministic step. The model never sees a user, only its own
// company's numbers.

export interface CounterProposal {
  price: number;
  style: string;
}

export async function proposeCounter(input: {
  product: string;
  current: number;
  attested: number;
  floor: number;
  round: number;
  policyText: string;
}): Promise<CounterProposal | null> {
  const key = process.env.MODEL_API_KEY;
  if (!key || !input.policyText) return null;
  const base = (process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
  const model = process.env.VENDOR_MODEL ?? "muse-spark-1.3";
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: `You are the pricing agent for a company selling "${input.product}". Your company's negotiation policy, in its own words: "${input.policyText}"\n\nSituation: your current price is $${input.current}. A rival's lower price of $${input.attested} has been cryptographically verified. Your absolute bottom line is $${input.floor}: never propose below it. This is round ${input.round}.\n\nPropose your next price. It must be below $${input.attested} (you are beating a verified price, not matching it) and at or above $${input.floor}. Follow your company's policy for how boldly to move. Return ONLY JSON: {"price": number, "style": string} where style is a four-word-max description of your move, e.g. "penny under, holding firm".`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as {
      price?: unknown;
      style?: unknown;
    };
    if (typeof parsed.price !== "number" || !Number.isFinite(parsed.price)) return null;
    return {
      price: Math.round(parsed.price * 100) / 100,
      style: typeof parsed.style === "string" ? parsed.style.slice(0, 60) : "",
    };
  } catch {
    return null;
  }
}
