# Design: Guardian-like diagrams from hand-drawn PNGs

Status: design document. Nothing here is built yet. It extends the
existing sketch formalization pipeline toward the visual language
the landing page and How it works page now use, so design diagrams
and product pages share one recognizable style.

## Problem

Design work for Barter starts as hand-drawn sketches on a tablet
(`ideation/handdrawn/*.png`). `ideation/formalize.mjs` already turns
a sketch into a Mermaid sequence diagram, a spec, and a raw
transcript, using three Muse Spark passes. The output is accurate
but visually generic: default Mermaid rendering looks like every
other project's diagrams.

Meanwhile the public pages have settled into a distinct visual
system (Gelasio type, hairline rules, one red accent, hard shadows,
pure white or near-black ground). Diagrams that judges and
contributors see in the README and How it works page should look
like they belong to the same product.

## Goal

From a hand-drawn PNG, generate a publication-ready diagram in the
Barter house style, with the same trust properties as the current
pipeline: Spark proposes the semantics, deterministic code renders
and enforces style, and every generated artefact keeps provenance
back to the sketch.

Non-goals: freeform illustration, photorealistic rendering, and
replacing Mermaid as the diffable source format. The Mermaid (or an
equivalent intermediate representation) stays; the Guardian-like
rendering is a view over it.

## Existing pipeline (already working)

`node ideation/formalize.mjs [input.png]` runs three Spark passes:

1. Transcribe: a vision model reads the sketch into structured
   JSON (participants left to right, messages top to bottom).
2. Synthesize: a text model turns the transcript plus repository
   context into Mermaid `sequenceDiagram` source and a Markdown
   spec.
3. Critic: the model re-checks the Mermaid against the transcript
   and the image, and returns a corrected final version.

Outputs land in `ideation/formalized/`: `<tag>.mmd` (source),
`<tag>.html` (standalone viewer), `<tag>.md` (spec with code
mapping), `<tag>.transcript.json` (raw transcript, the provenance
record). Any change here must preserve this loop and its outputs;
the new work adds a rendering stage, it does not replace the
pipeline.

## Proposed addition: a style stage after synthesize

Add a fourth stage between synthesize and critic:

1. Interpret: Spark maps the formalized source into a small
   diagram intermediate representation (below), choosing the
   diagram kind: flow, sequence, timeline, or ladder.
2. Render: deterministic code renders the representation to SVG
   and HTML using only the house style tokens. Spark never emits
   pixels, coordinates, or colors.
3. Style lint: code rejects or repairs output that breaks the
   rules (unknown colors, missing labels, more than six nodes,
   labels over five words, arrows without verbs).
4. Critic (existing pass, extended): checks the rendered diagram
   against the transcript for meaning, and against the style rules
   for form. Returns corrections to the representation, never to
   the rendered artefacts directly.

This is the same propose-and-dispose shape as the vendor agents:
the model suggests within a written style policy, code enforces
it, and failures fall back to the plain Mermaid render.

## House style tokens (from the live pages)

- Type: Gelasio for everything, italic for quotations and prices
  being spoken about, roman for keyphrases and labels.
- Ground: `#ffffff` light, `#131313` dark. Diagrams ship in pairs
  or use `prefers-color-scheme`, matching the pages.
- Ink: `#1c1c1a` light, `#ecece7` dark.
- Accent: exactly one red, `#C70000` light, `#ff5147` dark. Used
  for the proof element, the final price, and the active step.
  Never for decoration elsewhere.
- Rules: 1px to 1.5px hairlines separate regions. No gradients,
  no rounded cards, no drop shadows except the hard 3px offset
  shadow on interactive-looking elements.
- Kicker: a short red bold label above a diagram when it needs a
  title, the way the quote card does.
- Motion (HTML only): a left-to-right border pulse through flow
  steps, six-second loop, disabled under
  `prefers-reduced-motion`. Static SVG and print get the first
  frame only.

## Diagram intermediate representation

Keep it deliberately small. One JSON object:

```json
{
  "kind": "timeline",
  "title": "What the protocol makes possible",
  "steps": [
    { "label": "Your agent finds a price online", "value": "$17.19" },
    { "label": "Proof generated", "note": "a provable presentation", "accent": "proof" },
    { "label": "Vendors verify the proof", "value": "verified" },
    { "label": "Multiple rounds of counter-offers", "value": "$16.65" },
    { "label": "Best price locked", "value": "$15.67", "accent": "final" }
  ]
}
```

Kinds and their rules:

- `flow`: three to five boxes, left to right, arrows labelled with
  verbs. For the high-level system picture.
- `sequence`: participants across the top, messages top to
  bottom, one loop block maximum. The current Mermaid output maps
  here directly.
- `timeline`: steps top to bottom, optional value at right,
  optional bar showing relative size. The landing page ladder is
  this kind, hand-built today.
- `ladder`: a timeline where every value is a price and bars are
  scaled to it. For negotiation outcomes from a real session.

Labels are sentences or sentence fragments, never noun clusters
like "Presentation Verification Module". Every arrow or step must
answer: who does what. Prices keep their currency formatting from
the source data; the renderer never invents numbers.

## Inputs, outputs, provenance

Command shape (new tool, sibling of formalize.mjs):

```sh
node ideation/guardianize.mjs ideation/handdrawn/v0.png --kind sequence
```

Outputs, next to the existing ones in `ideation/formalized/`:

- `<tag>.diagram.json`: the intermediate representation.
- `<tag>.svg`: static, embeddable in README and GitHub.
- `<tag>.html`: standalone viewer with dark mode and the motion
  pass.
- The existing `<tag>.transcript.json` remains the provenance
  record; the diagram JSON references its source PNG and
  transcript by filename.

If any stage fails, the tool still emits the plain Mermaid render
and says so. A diagram is never silently half-styled.

## Accessibility and honesty rules

- No information carried by the red accent alone; the proof and
  final steps also carry distinct labels.
- Every rendered diagram has a text alternative: the steps list
  from the representation, verbatim.
- Numbers come only from the transcript or from session data the
  operator passes in. The critic pass explicitly checks rendered
  numbers against the transcript.
- Generated diagrams state their source ("Formalized from
  handdrawn/v0.png") the way v1.md already does.

## Build order

1. Renderer only: hand-write one diagram JSON for the How it
   works flow, render SVG and HTML, and compare against the
   hand-built page section. This validates the style tokens
   without any model involvement.
2. Style lint plus the SVG embed in the README. Retire no
   existing output.
3. The interpret stage and critic extension, so a fresh sketch
   can go PNG to styled diagram in one command.
4. A session-to-ladder path: read a completed session from the
   landing API and emit the ladder diagram from real events.
   This is the diagram most worth automating, since the demo
   generates the data continuously.

## Open questions

- Should the SVG be generated at commit time and checked in, or
  generated in the docs build? Checking in keeps GitHub rendering
  trivial and diffs reviewable; start there.
- How much layout freedom does the interpret stage get? Start
  with none beyond kind selection and step ordering. Add layout
  hints only if real sketches demand them.
- Does the critic compare rendered pixels against the sketch, or
  only the representation against the transcript? Start with the
  representation; pixel comparison is expensive and the transcript
  already carries the meaning.
