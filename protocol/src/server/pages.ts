import {
  genKeyphrase,
  listEvents,
  listProofs,
  type Loose,
  type SessionRec,
} from "./store";

// Page templates ported verbatim from the prototype (parity pass):
// same markup, styles, copy, and client scripts, served by TanStack
// Start server routes.

export const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

export const STYLE = `
  body{font-family:Gelasio,Georgia,'Times New Roman',serif;max-width:680px;margin:76px auto;padding:0 20px;color:#1c1c1a;background:#ffffff}
  h1{font-size:40px;margin:0 0 16px;line-height:1.15;font-weight:700}
  .lede{font-size:17px;line-height:1.55;color:#3d3d38}
  .say{background:#fff;border:1.5px solid #1c1c1a;padding:16px 18px;font-size:16.5px;line-height:1.5;margin:22px 0}
  label{display:block;font-size:13px;letter-spacing:.03em;margin:16px 0 6px;color:#6b6b66}
  input{font:inherit;font-size:15.5px;padding:8px 10px;width:100%;border:1px solid #b9b6aa;background:#fff;color:#1c1c1a;box-sizing:border-box}
  pre{white-space:pre-wrap;background:#1c1c1a;color:#f2f0e9;padding:16px;font-size:13.5px;line-height:1.55;overflow-x:auto}
  button{font:inherit;font-size:14.5px;padding:9px 16px;margin:10px 8px 0 0;border:1.5px solid #1c1c1a;background:#1c1c1a;color:#fff;cursor:pointer}
  button.secondary{background:#fff;color:#1c1c1a}
  .row{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-top:8px}
  small, .note{color:#6b6b66;font-size:13px;line-height:1.5}
  code{background:#efede6;padding:1px 5px}
  .ev{border-left:3px solid #2563eb;padding:4px 10px;margin:8px 0;background:#fff;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
  .best{background:#1c1c1a;color:#fbfaf7;padding:18px;margin:22px 0}
  .best .price{font-size:32px}
  .badge{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;border:1px solid #1c1c1a;padding:1px 6px}
  li{margin:6px 0;line-height:1.5}
  .cardwrap{position:relative;margin:58px 0 54px}
  .grules{display:flex;flex-direction:column;gap:3px}
  .grules i{display:block;height:1px;background:#1c1c1a}
  .kicker{color:#C70000;font-weight:700;font-size:17px;padding-top:12px}
  .pullquote{position:relative;padding:16px 0 28px;font-size:36px;font-style:italic;line-height:45px}
  .pullquote::before{content:"\\201C";position:absolute;left:-34px;top:14px;font-size:64px;line-height:64px;color:#C70000;font-weight:700;font-style:normal}
  .pullquote .roman{font-style:normal}
  .pullquote #rotator{border-bottom:1.5px solid #1c1c1a}
  .qrule{height:1px;background:#1c1c1a}
  .underquote{display:flex;gap:24px;align-items:center;padding-top:16px}
  .underquote .note{flex:1;font-size:15px;line-height:23px}
  .copybtn{flex:none;margin:0;background:#1c1c1a;color:#ffffff;border:1px solid #1c1c1a;box-shadow:3px 3px 0 #1c1c1a;font-size:14px;padding:9px 16px;cursor:pointer}
  .howbtn{display:inline-block;margin-top:14px;background:#1c1c1a;color:#ffffff;border:1px solid #1c1c1a;box-shadow:3px 3px 0 #1c1c1a;font-size:14px;line-height:16px;padding:9px 16px;text-decoration:none}
  .howbtn:hover{background:#C70000;border-color:#C70000}
  .ladder{margin:66px 0 0;border-top:1.5px solid #1c1c1a;padding-top:18px}
  .ladder h2{font-size:21px;margin:0 0 6px}
  .ladder .lcap{font-size:14.5px;color:#6b6b66;line-height:1.5;margin:10px 0 0}
  .lsteps{list-style:none;margin:14px 0 0;padding:0}
  .lstep{display:flex;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid #e3e1d8;font-size:15px}
  .lstep .lname{flex:1}
  .licon{vertical-align:-3px;margin-right:7px}
  .lbar{height:9px;background:#1c1c1a;flex:none}
  .lstep .lprice{font-weight:700;white-space:nowrap}
  .lstep .lnote{font-size:12.5px;color:#6b6b66;white-space:nowrap}
  .lstep .lsub{display:block;font-size:12.5px;line-height:1.45;color:#6b6b66;margin-top:2px}
  .lstep.loopstep{position:relative;padding-right:34px}
  .looparrow{position:absolute;right:8px;top:58%;font-size:24px;line-height:1;color:#C70000}
  .lstep.best .lprice{color:#C70000;margin-left:auto;margin-right:6px}
  .lstep.best .lbar{background:#C70000}
  .lstep.best .licon{margin-left:4px}
  .pflow{display:flex;align-items:stretch;gap:10px;margin:16px 0 0}
  .pnode{flex:1;border:1px solid #1c1c1a;padding:12px 14px;display:flex;flex-direction:column;gap:4px;justify-content:center}
  .pnode .ptag{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b6b66}
  .pnode strong{font-size:16px}
  .pnode .pprice{font-size:20px;font-weight:700}
  .pnode .psub, .plock .psub{display:block;font-size:13px;line-height:1.45;color:#6b6b66}
  .pnode.proof{align-items:flex-start}
  .parrow{align-self:center;font-size:22px;color:#C70000;flex:none}
  .pvendors{flex:1.2;display:flex;flex-direction:column;gap:6px;justify-content:center}
  .pvrow{display:flex;justify-content:space-between;border:1px solid #d8d5c9;padding:8px 12px;font-size:14.5px}
  .plock{display:flex;gap:14px;align-items:center;margin-top:14px;border:1.5px solid #1c1c1a;padding:12px 14px}
  .plock strong{font-size:17px;color:#C70000}
  @media (max-width: 640px){ .pflow{flex-direction:column} .parrow{transform:rotate(90deg)} }
  .faq{margin-top:74px;border-top:1.5px solid #1c1c1a;padding-top:12px}
  .vendors{margin-top:54px;padding-top:18px;border-top:1px solid #d8d5c9;font-size:12.5px;color:#8a877c}
  .vendors a{color:#6b6b66;text-underline-offset:3px}
  .vendors a:hover{color:#1c1c1a}
  .faq h2{font-size:21px;margin:14px 0 6px}
  .faq details{border-bottom:1px solid #d8d5c9;padding:10px 0}
  .faq summary{cursor:pointer;font-size:16.5px}
  .faq details p{margin:8px 0 4px}
  .rotator{border-bottom:2px solid #1c1c1a;white-space:nowrap}
  @media (prefers-reduced-motion: reduce){ .rotator{border-bottom-style:dotted} }
  @media (max-width: 640px){
    body{margin:30px auto;padding:0 16px}
    h1{font-size:36px}
    .lede{font-size:18px;line-height:1.6}
    .cardwrap{margin:30px 0}
    .pullquote{font-size:29px;line-height:38px;padding-left:26px}
    .pullquote::before{left:-4px;font-size:48px;line-height:48px}
    .underquote{flex-direction:column;align-items:flex-start;gap:12px}
    .lbar{display:none}
    .rotator{white-space:normal}
    .faq summary{font-size:18.5px;padding:4px 0}
    .faq details p{font-size:15.5px}
    label{font-size:14.5px}
    input{font-size:17px;padding:11px 12px}
    button{font-size:16px;padding:12px 18px}
    small, .note{font-size:14.5px}
  }
  @media (prefers-color-scheme: dark){
    body{background:#131313;color:#ecece7}
    .lede{color:#c9c9c1}
    small, .note, .underquote .note{color:#a9a9a1}
    a{color:#ecece7}
    code{background:#2a2a26;color:#ecece7}
    .grules i, .qrule{background:#ecece7}
    .pullquote #rotator{border-bottom-color:#ecece7}
    .kicker{color:#ff5147}
    .pullquote::before{color:#ff5147}
    .ladder{border-top-color:#ecece7}
    .ladder .lcap{color:#a9a9a1}
    .lstep{border-bottom-color:#2c2c28}
    .lstep .lnote{color:#a9a9a1}
    .lstep .lsub{color:#a9a9a1}
    .looparrow{color:#ff5147}
    .lbar{background:#ecece7}
    .lstep.best .lprice{color:#ff5147}
    .lstep.best .lbar{background:#ff5147}
    .pnode{border-color:#ecece7}
    .pnode .ptag, .pnode .psub, .plock .psub{color:#a9a9a1}
    .pvrow{border-color:#3a3a34}
    .plock{border-color:#ecece7}
    .plock strong{color:#ff5147}
    .pnode svg, .plock svg{stroke:#ff5147}
    .faq{border-top-color:#ecece7}
    .faq details{border-bottom-color:#3a3a34}
    .vendors{border-top-color:#3a3a34;color:#8f8f89}
    .vendors a{color:#b9b9b1}
    .vendors a:hover{color:#ffffff}
    .copybtn{background:#ecece7;color:#131313;border-color:#ecece7;box-shadow:3px 3px 0 #ecece7}
    .howbtn{background:#ecece7;color:#131313;border-color:#ecece7;box-shadow:3px 3px 0 #ecece7}
    .howbtn:hover{background:#ff5147;border-color:#ff5147;color:#131313}
    input{background:#1c1c1a;color:#ecece7;border-color:#4a4a44}
  }
`;

// Reference run linked as public evidence.
export const REFERENCE_SESSION = "817390";

export const landingPage = (base: string, _missing = false): string => {
  const phrase = genKeyphrase();
  const since = Date.now();
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gelasio:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<title>Barter</title><style>${STYLE}</style>
<h1>Ask your agent to barter for you.</h1>
<p class="lede">Bring your own agent. Point it at barter.computer and it learns
a protocol for turning a price into a verifiable proof, then uses
that proof to barter with vendors selling the same product.
No app to install and prices sourced directly from a real vendor.
Bartering vendor agents can verify the proof and competing price
are real with
<a href="https://github.com/tlsnotary/tlsn">TLSNotary</a>. In the
demo the companies are simulated. The product search, the
proofs, the verification, and the negotiation are real.</p>
<div class="cardwrap">
<div class="grules"><i></i><i></i><i></i><i></i></div>
<div class="kicker">Say this to your agent</div>
<div class="pullquote">
<div>Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me</div>
<div>the best price on <span class="rotator" id="rotator">carpe deodorant</span>.</div>
<div>Keyphrase: <span class="roman">${phrase}&rdquo;</span></div>
</div>
<div class="qrule"></div>
<div class="underquote">
<p class="note">Leave this page open after you send it. It jumps to your agent&rsquo;s session by itself.</p>
<button class="copybtn" onclick="navigator.clipboard.writeText('Go to ${esc(base.replace(/^https?:\/\//, ""))} and find me the best price on [your item]. Keyphrase: ${phrase}');this.textContent='Copied'">Copy prompt</button>
</div>
</div>
<div class="ladder">
<h2>What the protocol makes possible</h2>
<ol class="lsteps">
<li class="lstep"><span class="lname">Your agent finds a price online<span class="lsub">A true search for the real product. The proof it generates is real, and anyone can validate it.</span></span><span class="lbar" style="width:142px"></span><span class="lprice">$59.99</span></li>
<li class="lstep"><span class="lname"><svg class="licon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#C70000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>Proof generated: a provable presentation of that price</span><span class="lnote">TLSNotary presentation</span></li>
<li class="lstep loopstep"><span class="lname">Vendors stocking the product verify the proof</span><span class="lnote">TLSNotary verification</span><span class="looparrow" aria-hidden="true">&#8597;</span></li>
<li class="lstep loopstep"><span class="lname">Multiple rounds of counter-offers, each backed by its own proof</span><span class="lprice">&darr; lower each round</span></li>
<li class="lstep best"><span class="lname"><svg class="licon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#C70000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Best price locked, awaiting your approval</span><span class="lbar" style="width:129px"></span><span class="lprice">$54.56</span></li>
</ol>
<p class="lcap">Prices from a real run. The vendors are any company agents; the proof is what lets strangers negotiate without trusting each other&rsquo;s claims. <a href="/s/${REFERENCE_SESSION}">See this run</a></p>
<a class="howbtn" href="/how-it-works">How it works</a>
</div>
<div class="faq">
<h2>Questions</h2>
<details><summary>What do I say to my agent?</summary><p class="note">Copy the prompt above, finish the sentence with whatever you want, deodorant, a laptop, anything, and send it as-is. The three-word keyphrase at the end ties your agent's run to this page.</p></details>
<details><summary>What happens next?</summary><p class="note">Leave this page open. Your agent finds the product online, proves the price with TLSNotary, and barters two vendors against each other. This page jumps to the live session by itself.</p></details>
<details><summary>Do I need an app or an account?</summary><p class="note">No. Your agent learns the whole protocol from this site's <code>/llms.txt</code>. Nothing to install, nothing to sign up for.</p></details>
<details><summary>What is the keyphrase for?</summary><p class="note">It is how this page recognises your agent's run among all sessions. Three spoken words, easy to say out loud and hard to mix up.</p></details>
<details><summary>Will it buy anything on its own?</summary><p class="note">Never. The run ends at the best offer and waits. Nothing is bought before you approve it.</p></details>
<details><summary>Nothing happened. What now?</summary><p class="note">Ask your agent for the session link, or tell it the keyphrase again and ask it to follow the protocol at <code>/llms.txt</code>.</p></details>
</div>
<footer class="vendors">Simulated vendors: <a href="https://basecamp.barter.computer">Basecamp Supply</a> · <a href="https://ridgeline.barter.computer">Ridgeline Outfitters</a></footer>
<script>
(function rotate() {
  const el = document.getElementById('rotator');
  if (!el) return;
  const words = ['carpe deodorant', "Annie's white cheddar", 'a case of Moretti'];
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let wi = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function scrambleTo(next) {
    const from = el.textContent;
    const steps = 14;
    let step = 0;
    const tick = () => {
      step++;
      const p = step / steps;
      const len = Math.round(from.length + (next.length - from.length) * p);
      let out = '';
      for (let i = 0; i < len; i++) {
        const done = i < next.length * p * p;
        out += done ? next[i] : (next[i] === ' ' ? ' ' : chars[Math.floor(Math.random() * chars.length)]);
      }
      el.textContent = out || ' ';
      if (step < steps) setTimeout(tick, 35);
      else { el.textContent = next; setTimeout(cycle, 2000); }
    };
    tick();
  }
  function cycle() {
    wi = (wi + 1) % words.length;
    if (reduced) { el.textContent = words[wi]; setTimeout(cycle, 2000); }
    else scrambleTo(words[wi]);
  }
  setTimeout(cycle, 2000);
})();
async function poll() {
  try {
    const r = await fetch('/api/handoff?phrase=' + encodeURIComponent('${phrase}') + '&since=${since}');
    if (r.ok) { const d = await r.json(); location.href = d.url; return; }
  } catch {}
  setTimeout(poll, 2500);
}
poll();
</script>`;
};

export const howItWorksPage = (base: string): string => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gelasio:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<title>How Barter works</title><style>${STYLE}
  .flow{display:flex;gap:8px;align-items:stretch;margin:18px 0}
  .fbox{flex:1;border:1.5px solid #1c1c1a;padding:10px 12px;font-size:14px;line-height:1.45}
  .fbox b{display:block;font-size:15px;margin-bottom:4px}
  .farrow{align-self:center;color:#C70000;font-size:20px;flex:none}
  .steps{margin:12px 0;padding-left:22px;line-height:1.6;font-size:15.5px}
  .steps li{margin:7px 0}
  .trust{border:1.5px solid #1c1c1a;padding:14px 16px;margin:18px 0;font-size:15px;line-height:1.6}
  .back{font-size:14px}
  h2{font-size:22px;margin:30px 0 8px}
  p, li{line-height:1.6}
  @keyframes flowpulse{ 0%,18%{border-color:#C70000;box-shadow:3px 3px 0 #C70000} 30%,100%{border-color:#1c1c1a;box-shadow:none} }
  .flow .fbox{animation:flowpulse 6s ease-in-out infinite}
  .flow .fbox:nth-child(3){animation-delay:1.2s}
  .flow .fbox:nth-child(5){animation-delay:2.4s}
  .flow .fbox:nth-child(7){animation-delay:3.6s}
  @media (max-width:640px){ .flow{flex-direction:column} .farrow{transform:rotate(90deg)} }
  @media (prefers-color-scheme: dark){ .fbox,.trust{border-color:#ecece7} .flow .fbox{animation-name:flowpulse-dark} @keyframes flowpulse-dark{ 0%,18%{border-color:#ff5147;box-shadow:3px 3px 0 #ff5147} 30%,100%{border-color:#ecece7;box-shadow:none} } }
  @media (prefers-reduced-motion: reduce){ .flow .fbox{animation:none} }
</style>
<p class="back"><a href="/">&larr; Barter</a></p>
<h1>How Barter works</h1>
<p class="lede">Barter is a protocol, not a store. Your own agent learns it from
<a href="/llms.txt">one text file</a>, proves a real price, and barters with
company agents who only move on prices they can verify themselves. The result
is a negotiated price your agent could not simply claim into existence.</p>

<h2>The flow</h2>
<div class="flow">
<div class="fbox"><b>Your personal agent</b>Finds one real price online and proves it.</div>
<div class="farrow">&rarr;</div>
<div class="fbox"><b>Proof</b>A TLSNotary presentation: these bytes came from that host.</div>
<div class="farrow">&rarr;</div>
<div class="fbox"><b>Company agents</b>Verify the proof themselves, then quote and counter.</div>
<div class="farrow">&rarr;</div>
<div class="fbox"><b>Session record</b>Every step written down as it happens. Best offer waits for you.</div>
</div>

<h2>One barter round</h2>
<ol class="steps">
<li>The personal agent proves the lower current quote and stores that proof in the session record.</li>
<li>It presents the proof to the other vendor.</li>
<li>That vendor verifies the presentation itself and reads the price from the verified transcript, never from a claim.</li>
<li>Its policy decides the counter, subject to a hard floor. The new quote is proved and carried back the same way.</li>
<li>Rounds alternate until a vendor holds at its floor or four exchanges pass. The record closes with the best price and an approval request.</li>
</ol>

<h2>How the personal agent follows the protocol</h2>
<p>The agent is the entrypoint. There is no product form on this site. A run
adheres to the published specification: create a session first, prove one
reference price (one is enough), open conversations with both vendors using
that proof, store every proof when it is presented, report each quote and
counter to the session record, and finish with the best price, the full
session link, and a question asking approval. Chat stays minimal because the
session record is the detailed account. A three-word keyphrase in the prompt
lets the open landing page follow the same run.</p>
<p>No compatible agent handy? The reference client <code>pap</code> in the
public repository runs the same protocol end to end.</p>

<h2>How the vendors are set up</h2>
<p>Today the two companies are simulated, on purpose: the protocol is the
product being demonstrated, not their stock. Each vendor is the same agent
build on its own domain, with its own discovery document, written negotiation
policy, opening markup, and discount ceiling.</p>
<ol class="steps">
<li><a href="https://basecamp.barter.computer">Basecamp Supply</a>: lean stock on a two-week restock cycle. Opens at the proven price plus 5%, can discount up to 8%, moves a cent at a time, and spends a small promo pool slowly.</li>
<li><a href="https://ridgeline.barter.computer">Ridgeline Outfitters</a>: deep stock on a four-week restock cycle. Opens 3% under the proven price, can discount up to 12%, and moves in bold steps to win the sale before the next reload lands.</li>
</ol>
<p>For each counter, Muse Spark may propose a price in the company's written
style, weighing stock cover, restock timing, discount already used, and promo
budget remaining. Deterministic code disposes: no verified proof means no
movement, nothing goes below the floor, pool limits hold, and a hard-coded
fallback takes over if the model is unavailable. Any requested item is quoted
from the proven price; there is no fixed catalogue behind the demo.</p>

<div class="trust">
<b>What a proof does and does not say.</b> A presentation proves a response
came from a named host over TLS. It does not prove the item is in stock, that
the price is wise, or what checkout will finally charge. In this demo the
prover and notary run in one service; in production the notary would be an
independent operator. The protocol does not change.
</div>

<h2>Limitations</h2>
<ol class="steps">
<li>The companies, their stock pictures, and the purchase step are simulated. The proving, verification, negotiation, and session record are real.</li>
<li>Prover and notary currently run in one service. A production deployment separates the notary operator from the prover.</li>
<li>Proofs are generated serially and take seconds each. TLSNotary works over TLS 1.2 with small, uncompressed responses, so API-shaped pages prove far better than full HTML.</li>
<li>The starting price comes from a page your agent chooses. Product variants and pack sizes can change what that price means, so check the anchor in the session record.</li>
<li>Agent behaviour varies. Some agents follow the specification end to end, some improvise, and some stop early. The session record shows what actually happened either way.</li>
<li>When Muse Spark is unavailable, vendor counters come from a deterministic fallback, and the decision trace in the record says which path decided.</li>
<li>Session links are public to anyone who has them, and the demo endpoints are unauthenticated. That is demo scope, not a production posture.</li>
<li>Nothing is bought through Barter. A run ends at a best offer, outside checkout, waiting for a person to approve it.</li>
</ol>

<h2>See it</h2>
<p><a href="/s/${REFERENCE_SESSION}">A completed run, with proofs and counters in the record</a> ·
<a href="/llms.txt">The protocol specification agents read</a> ·
<a href="https://github.com/vaughanlove/barter">Code and architecture diagrams</a></p>
<footer class="vendors">Simulated vendors: <a href="https://basecamp.barter.computer">Basecamp Supply</a> · <a href="https://ridgeline.barter.computer">Ridgeline Outfitters</a></footer>`;

type Ev = { type?: string } & Loose;

function eventCall(e: Ev): string {
  const type = e.type ?? (e.event as string) ?? "event";
  const args: string[] = [];
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") args.push(`${k}=${typeof v === "number" ? v : `"${v}"`}`);
  };
  put("vendor", e.vendor ?? e.provider);
  put("url", e.url);
  put("host", e.host);
  if (typeof e.attestedPrice === "number") args.push(`attests=$${e.attestedPrice}`);
  put("round", e.round);
  put("conversation", e.conversationId);
  if (typeof e.price === "number") args.push(`price=$${e.price}`);
  put("hash", e.hash);
  return `${String(type).replace(/^(vendor|muse|notary)\./, "")}(${args.join(", ")})`;
}

function movementOf(e: Ev, lastPrice: number | null): { tag: string; cls: string; price: number | null } {
  const price = typeof e.price === "number" ? e.price : null;
  if (price === null || lastPrice === null) return { tag: "stayed", cls: "flat", price };
  if (price < lastPrice) return { tag: `down $${(Math.round((lastPrice - price) * 100) / 100).toFixed(2)}`, cls: "down", price };
  if (price > lastPrice) return { tag: `up $${(Math.round((price - lastPrice) * 100) / 100).toFixed(2)}`, cls: "up", price };
  return { tag: "stayed", cls: "flat", price };
}

function describeEvent(e: Ev): string {
  const type = String(e.type ?? "event");
  const who = (e.vendor as string) ?? (e.provider as string) ?? "The vendor";
  const price = typeof e.price === "number" ? `$${e.price}` : "its price";
  const attested = typeof e.attestedPrice === "number" ? `$${e.attestedPrice}` : "a lower price";
  if (type === "quote") return `${who} quoted ${price}.`;
  if (type === "proof") return `Proof generated: a TLSNotary proof attesting ${attested}${e.host ? ` from ${e.host}` : ""}.`;
  if (type === "barter") return `The personal agent presented a verified proof to ${who}${typeof e.price === "number" ? `, and the recorded result was ${price}` : ""}.`;
  if (type === "vendor.quote.issued") return `${who} issued a quote at ${price}.`;
  if (type === "vendor.offer.countered") return `${who} countered at ${price} after checking a verified ${attested} offer.`;
  if (type === "vendor.offer.floor") return `${who} reached its bottom line at ${price} after checking a verified ${attested} offer.`;
  if (type === "vendor.offer.held") return `${who} held at ${price} after checking a verified ${attested} offer.`;
  if (type === "vendor.proof.rejected") return `${who} rejected the proof and kept its price at ${price}.`;
  if (type === "best") return `${who} had the best recorded offer at ${price}.`;
  if (type === "done") return "The run ended and waited for approval. Nothing was bought.";
  return `${type} was recorded.`;
}

function eventDetailLines(e: Ev, proofs: Array<{ hash?: string; attested_price?: number | null; host?: string; path?: string; verdict?: string }> = []): string[] {
  const type = String(e.type ?? "event");
  const lines: string[] = [];
  if (e.ts || e.t) lines.push(`When: ${e.ts ?? e.t}`);
  lines.push(`Actor: ${type.startsWith("vendor.") ? ((e.vendor as string) ?? (e.provider as string) ?? "Vendor agent") : "Personal agent or session record"}`);
  lines.push(`What happened: ${describeEvent(e)}`);
  if (e.reason) lines.push(`Decision note: ${e.reason}`);
  if (e.note) lines.push(`Vendor note: ${e.note}`);
  if (e.style) lines.push(`Move style: ${e.style}`);
  if (e.source) lines.push(`Decision source: ${e.source}`);
  if (e.model) lines.push(`Model behind the decision: Muse Spark (${e.model})${e.modelProvider ? ` by ${e.modelProvider}` : ""}`);
  if (e.runtime) lines.push(`Vendor agent runtime: ${e.runtime}`);
  if (typeof e.stockUnits === "number") lines.push(`Stock picture: about ${e.stockUnits} units${e.stockPosture ? ` (${e.stockPosture})` : ""}. Simulated for this demo company.`);
  if (typeof e.discountUsedPct === "number") lines.push(`Discount picture: ${e.discountUsedPct}% of the opening ask used${typeof e.headroomToCeilingPct === "number" ? `, ${e.headroomToCeilingPct}% of headroom left above the bottom line` : ""}.`);
  if (typeof e.promoPoolRemainingPct === "number") lines.push(`Promo pool: ${e.promoPoolRemainingPct}% remaining this month.`);
  if (type === "proof") {
    const proof =
      proofs.find((pr) => String(pr.hash).startsWith(String(e.hash ?? ""))) ??
      proofs.find((pr) => pr.attested_price === e.attestedPrice && (!e.host || pr.host === e.host));
    if (proof) {
      lines.push(`Stored proof verdict: ${proof.verdict ?? "presented"}`);
      if (proof.host) lines.push(`Proof source: https://${proof.host}${proof.path ?? ""}`);
      if (proof.hash) lines.push(`Proof hash: ${String(proof.hash).slice(0, 16)}...`);
    }
  }
  if (!e.reason && !e.note && !e.message) {
    lines.push("Conversation trace: no natural-language message is recorded for this step. The agents exchanged structured protocol data, and the fields below are the trace.");
  }
  const hidden = new Set(["type", "ts", "t", "presentationB64"]);
  const fields = Object.entries(e)
    .filter(([k, v]) => !hidden.has(k) && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  if (fields.length) lines.push(`Recorded fields: ${fields.join(" · ")}`);
  return lines;
}

function decisionSummaryHtml(rec: SessionRec): string {
  const decisions = listEvents(rec.id).filter((e) =>
    ["vendor.offer.countered", "vendor.offer.floor", "vendor.offer.held"].includes(String(e.type)),
  );
  if (!decisions.length) return "";
  const spark = decisions.filter((e) => e.model || String(e.source ?? "").startsWith("Muse Spark"));
  const fallback = decisions.length - spark.length;
  const models = [...new Set(spark.map((e) => e.model).filter(Boolean))];
  const sparkText = spark.length
    ? `<strong>${spark.length} proposed by Muse Spark</strong>${models.length ? ` (${esc(models.join(", "))})` : ""}`
    : "none proposed by Muse Spark";
  const fallbackText = fallback ? ` · ${fallback} by deterministic fallback` : "";
  return `<p class="receipt-note">Vendor decisions in this receipt: ${sparkText}${fallbackText}</p>`;
}

const ROW_LABELS: Record<string, string> = {
  proof: "PROOF MADE",
  barter: "PROOF SENT",
  quote: "QUOTE",
  "vendor.quote.issued": "QUOTE",
  "vendor.offer.countered": "COUNTER",
  "vendor.offer.floor": "FLOOR",
  "vendor.offer.held": "HELD",
  "vendor.proof.rejected": "REJECTED",
  best: "BEST",
  done: "DONE",
};

function rowSentence(e: Ev): string {
  const type = String(e.type ?? "event");
  if (type === "barter") {
    const who = (e.vendor as string) ?? (e.provider as string) ?? "the vendor";
    return `Proof submitted to ${who}${typeof e.price === "number" ? `: it countered at $${e.price}` : ""}.`;
  }
  return describeEvent(e);
}

function pricePathHtml(events: Ev[]): string {
  const steps: string[] = [];
  for (const e of events) {
    const type = String(e.type ?? "event");
    if (type === "proof" && typeof e.attestedPrice === "number" && !steps.length) {
      steps.push(`$${e.attestedPrice} found${e.host ? ` at ${e.host}` : ""}`);
    } else if (
      ["quote", "vendor.offer.countered", "vendor.offer.floor", "vendor.offer.held"].includes(type) &&
      typeof e.price === "number"
    ) {
      steps.push(`$${e.price} ${((e.vendor as string) ?? (e.provider as string) ?? "").split(" ")[0]}`.trim());
    }
  }
  if (steps.length < 2) return "";
  const chips = steps.map((s) => `<span class="ppchip">${esc(s)}</span>`).join('<span class="pparrow">&rarr;</span>');
  return `<div class="pricepath"><span class="pplabel">Price path</span>${chips}</div>`;
}

function treeRowsHtml(rec: SessionRec): { rows: string; pricePath: string; lastPrice: number | null; count: number } {
  const events = listEvents(rec.id) as Ev[];
  const proofs = listProofs(rec.id);
  let lastPrice: number | null = null;
  let lastKey = "";
  let barterRound = 0;
  const seenProofs = new Set<string>();
  const agentQuotePrices = new Set(
    events.filter((e) => e.type === "quote" && typeof e.price === "number").map((e) => e.price),
  );
  const rows = events.map((e) => {
    const type = String(e.type ?? "event");
    // One row per fact. The vendor lifecycle chatters: creation and
    // its quote are the same quote the agent also posts (the agent
    // version carries vendor and url, so it wins), a received proof
    // is already announced by the stored proof row, and a verified
    // proof is that same row's verdict badge (its price field is the
    // vendor's old price, which would read as a spurious increase).
    if (type === "vendor.conversation.created") return "";
    if (type === "vendor.proof.received") return "";
    if (type === "vendor.proof.verified") return "";
    if (type === "vendor.quote.issued" && agentQuotePrices.has(e.price as number)) return "";
    // The same step can arrive twice (agent event + vendor OTEL copy,
    // or rows stored before the dedup fix). Show each call once.
    const key = `${eventCall(e)}|${e.price ?? ""}|${e.attestedPrice ?? ""}`;
    if (key === lastKey) return "";
    lastKey = key;
    // The same proof is reported as an agent proof event and again as a
    // stored-proof copy with different fields. One row per proof.
    if (type === "proof") {
      const sig = `${e.host ?? ""}|${e.attestedPrice ?? ""}`;
      if (seenProofs.has(sig)) return "";
      seenProofs.add(sig);
    }
    const mv = movementOf(e, lastPrice);
    if (mv.price !== null) lastPrice = mv.price;
    const verdict =
      type === "proof"
        ? (proofs.find((pr) => String(pr.hash).startsWith(String(e.hash ?? "")))?.verdict ?? "")
        : "";
    const detail = eventDetailLines(e, proofs).map((line) => esc(line)).join("<br>");
    const sparkTag =
      e.model || String(e.source ?? "").startsWith("Muse Spark") ? `<span class="ttag spark">SPARK</span>` : "";
    const heading = type === "barter" ? `<div class="tround">Barter round ${++barterRound}</div>` : "";
    const label = ROW_LABELS[type] ?? type.split(".")[0].toUpperCase();
    return `${heading}<div class="trow" data-type="${esc(type)}" data-price="${e.price ?? ""}" data-attested="${e.attestedPrice ?? ""}" tabindex="0" role="button" aria-expanded="false" title="Inspect this action"><span class="ttag">${esc(label)}</span><span class="tcall">${esc(rowSentence(e))}</span>${sparkTag}${verdict ? `<span class="ttag verdict">${esc(verdict)}</span>` : ""}<span class="tmove ${mv.cls}">${mv.price !== null ? esc(mv.tag) : ""}</span></div><div class="tdetail" hidden>${detail}</div>`;
  });
  return { rows: rows.join(""), pricePath: pricePathHtml(events), lastPrice, count: rows.filter(Boolean).length };
}

export const sessionPage = (rec: SessionRec, _base: string): string => {
  const tree = treeRowsHtml(rec);
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Barter: ${esc(rec.product || rec.id)}</title><style>${STYLE}
  .tree{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;border:1.5px solid #1c1c1a;background:#fff;margin:22px 0}
  .troot{display:flex;gap:8px;align-items:center;padding:7px 10px;border-bottom:1.5px solid #1c1c1a;background:#1c1c1a;color:#fbfaf7}
  .tchildren{margin-left:14px;border-left:1px solid #d8d5c9;padding:4px 0 6px}
  .pricepath{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:16px 0 4px;font-size:13.5px}
  .pplabel{font-weight:700;margin-right:2px}
  .ppchip{border:1px solid #1c1c1a;padding:2px 8px;background:#fff}
  .pparrow{color:#C70000;font-weight:700}
  .tround{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.08em;font-weight:700;color:#C70000;padding:10px 10px 2px}
  .trow{display:flex;gap:8px;align-items:center;padding:4px 10px;line-height:1.5}
  .trow:hover{background:#f4f2ea}
  .ttag{font-size:10px;letter-spacing:.06em;border:1px solid #1c1c1a;padding:0 5px;flex:none}
  .ttag.verdict{background:#1c1c1a;color:#fbfaf7}
  .ttag.spark{color:#C70000;border-color:#C70000;font-weight:700}
  .receipt-note{font-size:13.5px;line-height:1.55;color:#55534c;border:1px solid #d8d5c9;padding:9px 12px;margin:14px 0}
  .tcall{font-family:Gelasio,Georgia,'Times New Roman',serif;font-size:14.5px}
  .tmove{margin-left:auto;flex:none;font-size:11px}
  .tmove.down{color:#137333}.tmove.up{color:#b3261e}.tmove.flat{color:#6b6b66}
  .trow[role="button"]{cursor:pointer}
  .trow.active{background:#efede6;box-shadow:inset 3px 0 #1c1c1a}
  .tdetail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;background:#f4f2ea;border-bottom:1px solid #d8d5c9;padding:8px 12px 9px 42px;white-space:normal}
  @media (prefers-color-scheme: dark){
    .tree{background:#161614;border-color:#ecece7}
    .tchildren{border-left-color:#3a3a34}
    .trow:hover{background:#24241f}
    .trow.active{background:#24241f;box-shadow:inset 3px 0 #ecece7}
    .tdetail{background:#1d1d1a;border-bottom-color:#3a3a34}
    .ttag{border-color:#ecece7}
    .ttag.verdict{background:#ecece7;color:#131313}
    .receipt-note{color:#a9a9a1;border-color:#3a3a34}
    .ppchip{background:#1d1d1a;border-color:#ecece7}
    .tround{color:#ff5147}
  }
</style>
<h1>${esc(rec.product || "Your barter")}</h1>
<p class="lede">Session ${rec.id} · <span id="statusText">${esc(rec.status)}</span>${rec.budget != null ? ` · budget $${rec.budget}` : ""}${rec.keyphrase ? ` · keyphrase <code>${esc(rec.keyphrase)}</code>` : ""}</p>
<div id="bestSlot">${rec.best_price != null ? `<div class="best"><div>Best offer${rec.best_vendor ? ` from ${esc(rec.best_vendor)}` : ""}</div><div class="price">$${rec.best_price}</div></div>` : ""}</div>
${decisionSummaryHtml(rec)}
${tree.pricePath}
<div class="tree">
<div class="troot"><span class="ttag">SESSION</span><span class="tcall">session(product="${esc(rec.product)}", status="<span id="rootStatus">${esc(rec.status)}</span>")</span><span class="tmove flat" id="callCount">${tree.count} calls</span></div>
<div class="tchildren" id="tchildren">${tree.rows || `<div class="trow"><span class="tcall">waiting for the agent to start</span></div>`}</div>
</div>
<script>
let lastPrice = ${tree.lastPrice ?? "null"};
const treeEl = document.getElementById('tchildren');
function escHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function detailLines(d){
  const type = String(d.type || 'event');
  const who = d.vendor || d.provider || 'The vendor';
  const lines = [];
  if (d.t) lines.push('When: ' + d.t);
  lines.push('Actor: ' + (type.startsWith('vendor.') ? who : 'Personal agent or session record'));
  if (type === 'vendor.offer.countered') lines.push('What happened: ' + who + ' countered at $' + d.price + ' after checking a verified $' + d.attestedPrice + ' offer.');
  else if (type === 'proof') lines.push('What happened: Proof generated: a TLSNotary proof attesting $' + d.attestedPrice + (d.host ? ' from ' + d.host : '') + '.');
  else lines.push('What happened: ' + type + ' was recorded.');
  if (d.reason) lines.push('Decision note: ' + d.reason);
  if (d.note) lines.push('Vendor note: ' + d.note);
  if (d.style) lines.push('Move style: ' + d.style);
  if (d.source) lines.push('Decision source: ' + d.source);
  if (d.model) lines.push('Model behind the decision: Muse Spark (' + d.model + ')' + (d.modelProvider ? ' by ' + d.modelProvider : ''));
  if (d.runtime) lines.push('Vendor agent runtime: ' + d.runtime);
  if (typeof d.stockUnits === 'number') lines.push('Stock picture: about ' + d.stockUnits + ' units' + (d.stockPosture ? ' (' + d.stockPosture + ')' : '') + '. Simulated for this demo company.');
  if (typeof d.discountUsedPct === 'number') lines.push('Discount picture: ' + d.discountUsedPct + '% of the opening ask used' + (typeof d.headroomToCeilingPct === 'number' ? ', ' + d.headroomToCeilingPct + '% of headroom left above the bottom line' : '') + '.');
  if (typeof d.promoPoolRemainingPct === 'number') lines.push('Promo pool: ' + d.promoPoolRemainingPct + '% remaining this month.');
  if (!d.reason && !d.note && !d.message) lines.push('Conversation trace: no natural-language message is recorded for this step. The agents exchanged structured protocol data, and the fields below are the trace.');
  const fields = Object.entries(d).filter(([k,v]) => !['type','t','presentationB64'].includes(k) && v !== undefined && v !== null && v !== '').map(([k,v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v));
  if (fields.length) lines.push('Recorded fields: ' + fields.join(' · '));
  return lines;
}
function detailElement(d){
  const detail = document.createElement('div');
  detail.className = 'tdetail';
  detail.hidden = true;
  detail.textContent = detailLines(d).join('\\n');
  detail.style.whiteSpace = 'pre-wrap';
  return detail;
}
function setRowOpen(row, open){
  const detail = row.nextElementSibling;
  row.classList.toggle('active', open);
  row.setAttribute('aria-expanded', String(open));
  if (detail && detail.classList.contains('tdetail')) detail.hidden = !open;
}
function toggleRow(row){ setRowOpen(row, row.getAttribute('aria-expanded') !== 'true'); }
treeEl.addEventListener('click', e => {
  const row = e.target.closest('.trow[data-type]');
  if (row) toggleRow(row);
});
treeEl.addEventListener('keydown', e => {
  const row = e.target.closest('.trow[data-type]');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(row); }
});
const ROW_LABELS = { proof: 'PROOF MADE', barter: 'PROOF SENT', quote: 'QUOTE', 'vendor.quote.issued': 'QUOTE', 'vendor.offer.countered': 'COUNTER', 'vendor.offer.floor': 'FLOOR', 'vendor.offer.held': 'HELD', 'vendor.proof.rejected': 'REJECTED', best: 'BEST', done: 'DONE' };
let barterRound = treeEl.querySelectorAll('.tround').length;
function rowSentence(d){
  const t = String(d.type || 'event');
  const who = d.vendor || d.provider || 'The vendor';
  const price = typeof d.price === 'number' ? '$' + d.price : 'its price';
  const attested = typeof d.attestedPrice === 'number' ? '$' + d.attestedPrice : 'a lower price';
  if (t === 'proof') return 'Proof generated: a TLSNotary proof attesting ' + attested + (d.host ? ' from ' + d.host : '') + '.';
  if (t === 'barter') return 'Proof submitted to ' + who + (typeof d.price === 'number' ? ': it countered at ' + price : '') + '.';
  if (t === 'quote') return who + ' quoted ' + price + '.';
  if (t === 'vendor.offer.countered') return who + ' countered at ' + price + ' after checking a verified ' + attested + ' offer.';
  if (t === 'vendor.offer.floor') return who + ' reached its bottom line at ' + price + ' after checking a verified ' + attested + ' offer.';
  if (t === 'vendor.offer.held') return who + ' held at ' + price + ' after checking a verified ' + attested + ' offer.';
  if (t === 'vendor.proof.rejected') return who + ' rejected the proof and kept its price at ' + price + '.';
  if (t === 'best') return who + ' had the best recorded offer at ' + price + '.';
  if (t === 'done') return 'The run ended and waited for approval. Nothing was bought.';
  return t + ' was recorded.';
}
function appendRow(d){
  const rawType = String(d.type || 'event');
  if (rawType === 'vendor.proof.received' || rawType === 'vendor.conversation.created' || rawType === 'vendor.proof.verified') return;
  if (rawType === 'proof') {
    for (const old of treeEl.querySelectorAll('[data-type="proof"]')) {
      if (old.dataset.attested === String(d.attestedPrice ?? '')) return;
    }
  }
  const price = typeof d.price === 'number' ? d.price : null;
  if (rawType === 'vendor.quote.issued' && price !== null) {
    for (const old of treeEl.querySelectorAll('[data-type="quote"]')) {
      if (Number(old.dataset.price) === price) return;
    }
  }
  if (rawType === 'quote' && price !== null) {
    for (const old of treeEl.querySelectorAll('[data-type="vendor.quote.issued"]')) {
      if (Number(old.dataset.price) === price) old.remove();
    }
  }
  let mv = '', cls = 'flat';
  if (price !== null && lastPrice !== null) {
    if (price < lastPrice) { mv = 'down $' + (lastPrice - price).toFixed(2); cls = 'down'; }
    else if (price > lastPrice) { mv = 'up $' + (price - lastPrice).toFixed(2); cls = 'up'; }
    else mv = 'stayed';
  }
  if (price !== null) lastPrice = price;
  const type = String(d.type || 'event');
  const args = [];
  if (d.vendor || d.provider) args.push('vendor="' + (d.vendor || d.provider) + '"');
  if (d.url) args.push('url="' + d.url + '"');
  if (d.host) args.push('host="' + d.host + '"');
  if (typeof d.attestedPrice === 'number') args.push('attests=$' + d.attestedPrice);
  if (d.round) args.push('round=' + d.round);
  if (price !== null) args.push('price=$' + price);
  const div = document.createElement('div');
  div.className = 'trow';
  div.dataset.type = rawType;
  div.dataset.price = price ?? '';
  div.tabIndex = 0;
  div.setAttribute('role', 'button');
  div.setAttribute('aria-expanded', 'false');
  div.title = 'Inspect this action';
  const sparkTag = (d.model || String(d.source || '').startsWith('Muse Spark')) ? '<span class="ttag spark">SPARK</span>' : '';
  if (rawType === 'barter') {
    const h = document.createElement('div');
    h.className = 'tround';
    h.textContent = 'Barter round ' + (++barterRound);
    treeEl.appendChild(h);
  }
  div.dataset.attested = d.attestedPrice ?? '';
  div.innerHTML = '<span class="ttag">' + escHtml(ROW_LABELS[rawType] || type.split('.')[0].toUpperCase()) + '</span><span class="tcall">' + escHtml(rowSentence(d)) + '</span>' + sparkTag + '<span class="tmove ' + cls + '">' + escHtml(mv) + '</span>';
  treeEl.appendChild(div);
  treeEl.appendChild(detailElement(d));
  const cc = document.getElementById('callCount');
  if (cc) cc.textContent = treeEl.querySelectorAll('.trow').length + ' calls';
  if (type === 'best' && price !== null) {
    const slot = document.getElementById('bestSlot');
    const vendor = d.vendor || d.provider || '';
    slot.innerHTML = '<div class="best"><div>Best offer' + (vendor ? ' from ' + escHtml(vendor) : '') + '</div><div class="price">$' + price + '</div></div>';
    for (const el of [document.getElementById('statusText'), document.getElementById('rootStatus')]) if (el) el.textContent = 'best';
  }
  if (type === 'done') {
    for (const el of [document.getElementById('statusText'), document.getElementById('rootStatus')]) if (el) el.textContent = 'done';
  }
}
new EventSource('/sessions/${rec.id}/stream?live=1').onmessage = e => appendRow(JSON.parse(e.data));
</script>`;
};

export const panelPage = `<!doctype html><meta charset="utf-8">
<title>Barter control panel</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f6f8;color:#1d2733;margin:0}
  header{padding:16px 20px;border-bottom:1px solid #d9e0e8;background:#fff;display:flex;justify-content:space-between;align-items:baseline}
  h1{font-size:17px;margin:0;font-weight:600}
  header span{color:#68798c;font-size:12.5px}
  .layout{display:grid;grid-template-columns:250px 1fr;min-height:calc(100vh - 53px)}
  aside{border-right:1px solid #d9e0e8;background:#eef2f5;padding:12px;overflow-y:auto}
  .sess{display:block;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:8px;color:#1d2733;padding:9px 10px;cursor:pointer;font:inherit;margin-bottom:6px}
  .sess:hover{background:#fff}.sess.active{background:#fff;border-color:#9db8d2;box-shadow:0 1px 3px rgba(29,39,51,.08)}
  .sess b{font-size:13.5px}.sess small{display:block;color:#68798c;margin-top:3px;font-size:11.5px}
  main{padding:14px 18px;overflow-y:auto}
  .line{display:flex;gap:10px;padding:7px 10px;border-left:3px solid #b7c9da;background:#fff;border-top:1px solid #e3e9ee;border-right:1px solid #e3e9ee;border-bottom:1px solid #e3e9ee;border-radius:0 6px 6px 0;margin-bottom:6px;align-items:baseline}
  .line .time{color:#8192a5;font-size:11.5px;white-space:nowrap}
  .dot{width:8px;height:8px;border-radius:50%;flex:none;position:relative;top:-1px}
  .quote{background:#2563eb}.proof{background:#d97706}.offer{background:#059669}.reject{background:#dc2626}.other{background:#64748b}
  .msg{font-size:13.5px}.detail{color:#68798c;font-size:12px;white-space:pre-wrap;word-break:break-word}
  .empty{color:#8192a5;padding:18px 4px;font-size:13px}
</style>
<header><h1>Barter — control panel</h1><span id="status">connecting…</span></header>
<div class="layout">
  <aside id="sessions"><div class="empty">No sessions yet.<br>Run a demo session or point a service's OTEL endpoint here.</div></aside>
  <main id="log"><div class="empty">Select a session.</div></main>
</div>
<script>
const sessionsEl = document.getElementById('sessions');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const bySession = new Map();
let selected = null;

const CATEGORY = [
  [/quote/i, 'quote'], [/proof|verif|attest/i, 'proof'],
  [/offer|counter|floor|best/i, 'offer'], [/reject|held|fail|error/i, 'reject'],
];
const cat = (name) => (CATEGORY.find(([re]) => re.test(name)) || [null, 'other'])[1];
const label = (name) => name.replace(/^(vendor|muse|notary)\\./, '').replace(/[._]/g, ' ');

function renderSessions() {
  const ids = [...bySession.keys()].reverse();
  if (!ids.length) return;
  sessionsEl.innerHTML = '';
  for (const id of ids) {
    const logs = bySession.get(id);
    const last = logs[logs.length - 1];
    const prices = logs.filter(l => typeof l.price === 'number').map(l => l.price);
    const btn = document.createElement('button');
    btn.className = 'sess' + (id === selected ? ' active' : '');
    btn.innerHTML = '<b>' + id + '</b><small>' + logs.length + ' events' +
      (prices.length ? ' · now $' + prices[prices.length - 1] : '') +
      '<br>' + label(last.event) + ' · ' + new Date(last.t).toLocaleTimeString() + '</small>';
    btn.onclick = () => { selected = id; renderSessions(); renderLog(); };
    sessionsEl.appendChild(btn);
  }
}

function renderLog() {
  const logs = bySession.get(selected) || [];
  if (!logs.length) { logEl.innerHTML = '<div class="empty">No events for this session yet.</div>'; return; }
  logEl.innerHTML = '';
  for (const l of logs) {
    const { t, sessionId, event, ...rest } = l;
    const div = document.createElement('div');
    div.className = 'line';
    const parts = [];
    if (typeof rest.price === 'number') parts.push('$' + rest.price);
    if (typeof rest.attestedPrice === 'number') parts.push('attested $' + rest.attestedPrice);
    if (rest.provider) parts.push(rest.provider);
    if (rest.reason) parts.push(rest.reason);
    if (rest.round) parts.push('round ' + rest.round);
    div.innerHTML = '<span class="time">' + new Date(t).toLocaleTimeString() + '</span>' +
      '<span class="dot ' + cat(event) + '"></span>' +
      '<span><span class="msg">' + label(event) + (parts.length ? ' — ' + parts.join(' · ') : '') + '</span>' +
      '<div class="detail">' + JSON.stringify(rest) + '</div></span>';
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function addLog(log) {
  if (!bySession.has(log.sessionId)) bySession.set(log.sessionId, []);
  bySession.get(log.sessionId).push(log);
  if (!selected) selected = log.sessionId;
  renderSessions();
  if (log.sessionId === selected) renderLog();
}

fetch('/api/sessions').then(r => r.json()).then(({ sessions }) => {
  for (const s of sessions) bySession.set(s.id, s.logs);
  if (sessions.length) selected = sessions[sessions.length - 1].id;
  renderSessions(); renderLog();
});
const es = new EventSource('/panel/stream');
es.onopen = () => statusEl.textContent = 'live';
es.onerror = () => statusEl.textContent = 'reconnecting…';
es.onmessage = (e) => { const d = JSON.parse(e.data); if (d.kind === 'log') addLog(d.log); };
</script>`;
