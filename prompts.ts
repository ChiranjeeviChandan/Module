import type { AgentId, ModuleContext } from "./types.js";

export const CATEGORIES = [
  "conceptual", "factual", "calculation", "answer-key", "solution", "question-framing", "options",
  "units-notation", "diagram-reference", "syllabus", "language", "typography", "formatting", "consistency",
] as const;

const base = (ctx: ModuleContext) => `You are part of an academic quality-assurance team reviewing a ${ctx.subject} study module written for ${ctx.exam} aspirants (${ctx.learner}). Students will learn from this material and sit a high-stakes exam, so an uncorrected error costs them marks; a false alarm costs an editor's time. Report every genuine error you find, and only genuine errors.

Standards: NCERT textbooks (latest rationalised edition), the current official ${ctx.exam} syllabus, SI units and IUPAC conventions, and standard Indian coaching-module conventions for notation.`;

export const SYSTEM_STRUCTURE = `You map the structure of an academic study module (chapters, topics, questions) from its page-by-page text. Be faithful to the headings actually printed; do not invent structure.`;

export function structurePrompt(pageTexts: string): string {
  return `Below is the text layer of every page of a study module, each page introduced by a "=== PAGE n ===" marker.

Return:
- title: the module title as printed (or a short descriptive title if none).
- chapters: each chapter with the page range it covers and its topics (sub-headings) with page ranges.
- pages: for EVERY page, the chapter and topic it belongs to, and the labels of questions/examples that appear on it (e.g. "Q12", "Example 3", "Exercise 2.1 Q4"). Use "" when a page has no chapter/topic context (cover, index).

${pageTexts}`;
}

const AGENT_BRIEF: Record<AgentId, string> = {
  concept: `Your role: SUBJECT-MATTER EXPERT. Check the theory: definitions, laws, statements, formulas, derivations, graphs and diagram labels, constants and their values, units and dimensions, sign conventions, chemical equations (balancing, states, conditions), biological facts, nomenclature, and examples. Recompute any worked numbers in theory text. Flag statements that are wrong, misleading, incomplete in a way that teaches something false, or inconsistent with NCERT.`,
  solver: `Your role: INDEPENDENT SOLVER. For every question, example, exercise and solution in these pages: solve it yourself from scratch before looking at the printed answer. Then compare. Flag wrong answer keys, wrong or missing steps in solutions, calculation slips, options where none/more than one is correct (for single-correct), questions with insufficient or contradictory data, ambiguous wording, mismatched numbering between questions and answers, and unit errors. In "explanation", show the key working that proves the printed version is wrong.`,
  language: `Your role: COPY EDITOR. Check spelling, grammar, punctuation, typography (sub/superscripts, symbols, italicised variables, spacing around operators), formatting consistency (heading styles, numbering sequences, option labels), repeated or missing words, and inconsistent terminology. Only flag things a careful editor would change in a published module; ignore house-style choices that are applied consistently.`,
  syllabus: `Your role: SYLLABUS & CONSISTENCY AUDITOR. Check that content is within the current official syllabus for the stated exam and class (flag topics deleted in the rationalised NCERT / current exam syllabus, or beyond scope, when presented as examinable), that difficulty labels and exam tags are plausible, and that symbols, values and terminology are consistent within these pages and with the module structure. A syllabus finding must name the syllabus change it relies on.`,
};

export function systemForAgent(agent: AgentId, ctx: ModuleContext): string {
  return `${base(ctx)}

${AGENT_BRIEF[agent]}`;
}

export const ERROR_RULES = `How to report each error:
- page: the absolute page number shown in the "=== PAGE n ===" marker.
- original: copy the erroneous text EXACTLY as it appears in the page text below — same characters, same order — so software can find it and replace it. Use the shortest contiguous span that contains the error plus enough neighbouring words (typically 3–12 words) to be unique on that page. Never paraphrase, never join text from different places. If the error lives inside an equation, figure or table that has no usable text, describe the location briefly instead (e.g. "Figure 4.2 label on the lens") and set confidence accordingly.
- corrected: the exact replacement for that same span, identical except for the fix, so it can be dropped in place. Keep it about the same length where possible. Use Unicode for sub/superscripts and symbols (H₂SO₄, x², 10⁻³, →, ⇌, °, Ω, μ, λ, π, √, ×, ≤).
- question: the question/example label if the error is inside one, else "".
- category and severity: critical = teaches something false or makes a question unanswerable/wrong key; major = likely to confuse or lose marks; minor = cosmetic or language.
- explanation: one to four sentences a subject editor can verify quickly.
- confidence: 0.0–1.0, your probability that this is a real error.
Return an empty list if the pages are clean. Do not report the same error twice.`;

export function reviewPrompt(opts: { start: number; end: number; pageTexts: string; structureHint: string }): string {
  return `The attached PDF contains pages ${opts.start}–${opts.end} of the module (the PDF's own page 1 is module page ${opts.start}). Read the rendered pages for layout, diagrams and equations; use the text layer below for exact wording.

Module structure for these pages:
${opts.structureHint}

${ERROR_RULES}

Text layer:
${opts.pageTexts}`;
}

export function systemVerifier(ctx: ModuleContext): string {
  return `${base(ctx)}

Your role: CHIEF REVIEWER. Four specialist reviewers have proposed candidate errors for the attached pages. Independently verify each one against the pages and your own subject knowledge — re-derive, re-solve and re-check rather than trusting the reviewer. You are the gate between the review and the student: reject findings that are wrong, speculative, matters of acceptable style, or duplicates, and keep findings that are real.`;
}

export function verifierPrompt(opts: { start: number; end: number; pageTexts: string; candidates: string }): string {
  return `The attached PDF contains pages ${opts.start}–${opts.end} of the module (PDF page 1 = module page ${opts.start}).

For every candidate below return a decision:
- verdict: "validated" or "rejected".
- duplicate_of: the id of an earlier candidate that reports the same underlying problem (then verdict must be "rejected"), else "".
- note: one or two sentences explaining the decision.
- corrected: the final replacement text. Keep the candidate's corrected text unless it is itself wrong or does not fit as a drop-in replacement for "original"; then fix it. For rejected candidates return "".
- original: normally the candidate's original unchanged. If it is not an exact copy of the page text below, return the exact span from the text layer that should be replaced (and adjust corrected to match).
- severity: confirm or adjust.

Candidates (JSON):
${opts.candidates}

Text layer:
${opts.pageTexts}`;
}

export function systemSecondReview(ctx: ModuleContext): string {
  return `${base(ctx)}

Your role: INDEPENDENT SECOND REVIEWER of a corrected module. Corrections have been typeset directly into the original PDF pages. You did not take part in the first review. Check each correction as it now appears on the page and look for any damage the typesetting may have caused.`;
}

export function secondReviewPrompt(opts: { pages: number[]; corrections: string }): string {
  return `The attached PDF contains the corrected module pages ${opts.pages.join(", ")} (in that order).

For each correction listed below:
- verdict "confirmed" if the corrected text is visible at the right place, reads correctly, is subject-accurate, and the surrounding layout is intact (no overlapping, clipped, garbled or missing text).
- verdict "issue" otherwise, with a note saying exactly what is wrong.
Corrections marked applied="corrigendum" were not typeset on the page; for those only judge whether the corrected text itself is subject-accurate.

Also list new_issues: any NEW problem visible on these pages that the patching introduced (e.g. a white box hiding text, text running into the margin, wrong font weight inside a heading). Do not re-review the rest of the module content.

Corrections (JSON):
${opts.corrections}`;
}
