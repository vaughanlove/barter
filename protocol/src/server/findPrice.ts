import type { Loose } from "./store";

// --- JEV price classifier (Muse Spark) -------------------------------------
// Finds the selling price on an arbitrary product page so the proof can
// anchor on the right number. This locates and labels; it never attests.
// The TLSNotary proof is still what vendors trust.
export async function findPrice(body: Loose): Promise<{ status: number; out: Loose }> {
  const key = process.env.MODEL_API_KEY;
  if (!key) return { status: 503, out: { error: "MODEL_API_KEY not configured" } };
  const rawUrl = String(body.url ?? "");
  const product = String(body.product ?? "");
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return { status: 400, out: { error: "url must be a full https URL" } };
  }
  if (target.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(target.hostname)) {
    return { status: 400, out: { error: "url must be a public https URL" } };
  }
  let pageRes: Response;
  try {
    pageRes = await fetch(target, {
      headers: { "User-Agent": "barter-price-finder/0.1", "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
  } catch (err) {
    const e = err as { cause?: { message?: string; code?: string }; message?: string };
    const cause = e?.cause?.message ?? e?.cause?.code ?? "";
    return { status: 200, out: { price: null, error: `page fetch failed: ${e?.message ?? "network"} ${cause}`.trim() } };
  }
  if (!pageRes.ok) {
    return { status: 200, out: { price: null, error: `page fetch failed: HTTP ${pageRes.status}` } };
  }
  const pageHtml = (await pageRes.text()).slice(0, 1_000_000);
  const fullText = pageHtml
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  // The price rarely sits in the first chunk of a store page. Send the
  // classifier windows around every money-shaped token instead.
  const windows: string[] = [];
  for (const m of fullText.matchAll(/\$\s?\d[\d,]*\.?\d{0,2}|"price"\s*:\s*"?\d[\d,]*\.?\d{0,2}"?/g)) {
    windows.push(fullText.slice(Math.max(0, (m.index ?? 0) - 180), (m.index ?? 0) + 180));
    if (windows.length >= 40) break;
  }
  const text = (windows.length ? windows.join("\n---\n") : fullText).slice(0, 14_000);
  const base = (process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
  const model = process.env.JEV_MODEL ?? "muse-spark-1.3";
  const prompt = `You are the JEV price classifier. Find the current selling price of the product "${product}" in this page text. Return ONLY JSON: {"price": number|null, "currency": string, "snippet": string, "confidence": number}. price is in dollars as a plain number (convert integer cents only when the page clearly prices in cents). snippet is the exact short page text the price came from. Choose the one-time purchase price for a single unit of the named product, the default variant a buyer gets by clicking buy. Avoid subscriptions, multipacks, bundles, refills, other products, shipping, and was/now strikethrough originals.\n\nPAGE TEXT:\n${text}`;
  const useResponses = (process.env.META_PROTOCOL ?? "") === "responses";
  const res = await fetch(useResponses ? `${base}/responses` : `${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(
      useResponses
        ? { model, input: prompt, max_output_tokens: 3000, text: { format: { type: "json_object" } } }
        : {
            model,
            max_tokens: 3000,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: prompt }],
          },
    ),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res || !res.ok) {
    const detail = res ? (await res.text().catch(() => "")).slice(0, 240) : "";
    return { status: 200, out: { price: null, error: `classifier call failed: HTTP ${res?.status ?? "network"} ${detail}`.trim() } };
  }
  const data = (await res.json().catch(() => ({}))) as Loose;
  let parsed: Loose = {};
  try {
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const output = data.output as Array<{ content?: Array<{ type?: string; text?: string }> }> | undefined;
    const content =
      choices?.[0]?.message?.content ??
      (data.output_text as string | undefined) ??
      (Array.isArray(output)
        ? output.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text
        : undefined) ??
      "{}";
    parsed = JSON.parse(content) as Loose;
  } catch {
    /* fall through with empty */
  }
  return {
    status: 200,
    out: {
      price: typeof parsed.price === "number" ? parsed.price : null,
      currency: parsed.currency ?? "USD",
      snippet: String(parsed.snippet ?? "").slice(0, 300),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      url: target.toString(),
      classifier: "jev-spark",
      model,
    },
  };
}
