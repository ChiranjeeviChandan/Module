import { callJson } from "./claude.js";
import { extractPages, type PageText } from "./pdf/extract.js";
import { subsetPdf } from "./pdf/split.js";
import { appendPdf, drawMarkers, patchPdf } from "./pdf/patch.js";
import { buildCorrigendum, buildErrorReport } from "./pdf/report.js";
import {
  CATEGORIES, SYSTEM_STRUCTURE, reviewPrompt, secondReviewPrompt, structurePrompt, systemForAgent,
  systemSecondReview, systemVerifier, verifierPrompt,
} from "./prompts.js";
import { CLOUD, progress, putFile, readFile, saveJob } from "./storage.js";
import type { AgentId, AnalyseRun, Candidate, ImplementRun, Job, ModuleStructure, ReviewError, Severity } from "./types.js";

// Smaller units on serverless so each step fits comfortably inside the function time limit.
const PAGES_PER_CHUNK = Number(process.env.PAGES_PER_CHUNK || (CLOUD ? 4 : 6));
const REVIEW2_GROUP = CLOUD ? 6 : 8;
const MAX_ATTEMPTS = 3;
const AGENTS: AgentId[] = ["concept", "solver", "language", "syllabus"];
const AGENT_LABEL: Record<AgentId, string> = {
  concept: "Subject expert",
  solver: "Independent solver",
  language: "Copy editor",
  syllabus: "Syllabus auditor",
};

// ---------------------------------------------------------------------------
// JSON schemas for structured outputs
// ---------------------------------------------------------------------------

const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string" };
const int = { type: "integer" };
const SEVERITY = { type: "string", enum: ["critical", "major", "minor"] };

const STRUCTURE_SCHEMA = obj({
  title: str,
  chapters: {
    type: "array",
    items: obj({
      name: str,
      startPage: int,
      endPage: int,
      topics: { type: "array", items: obj({ name: str, startPage: int, endPage: int }) },
    }),
  },
  pages: { type: "array", items: obj({ page: int, chapter: str, topic: str, questions: { type: "array", items: str } }) },
});

const REVIEW_SCHEMA = obj({
  errors: {
    type: "array",
    items: obj({
      page: int,
      question: str,
      category: { type: "string", enum: [...CATEGORIES] },
      severity: SEVERITY,
      original: str,
      corrected: str,
      explanation: str,
      confidence: { type: "number" },
    }),
  },
});

const VERIFY_SCHEMA = obj({
  decisions: {
    type: "array",
    items: obj({
      id: str,
      verdict: { type: "string", enum: ["validated", "rejected"] },
      duplicate_of: str,
      note: str,
      original: str,
      corrected: str,
      severity: SEVERITY,
    }),
  },
});

const SECOND_SCHEMA = obj({
  reviews: { type: "array", items: obj({ id: str, verdict: { type: "string", enum: ["confirmed", "issue"] }, note: str }) },
  new_issues: { type: "array", items: obj({ page: int, description: str }) },
});

type RawError = Omit<Candidate, "cid" | "agent">;
type Decision = { id: string; verdict: "validated" | "rejected"; duplicate_of: string; note: string; original: string; corrected: string; severity: Severity };

const pageBlock = (p: PageText) => `=== PAGE ${p.page} ===\n${p.text}`;
const errMsg = (e: unknown) => (e as Error).message ?? String(e);

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

export async function startAnalyse(job: Job) {
  const chunks: AnalyseRun["chunks"] = [];
  for (let s = 1; s <= job.pageCount; s += PAGES_PER_CHUNK) chunks.push({ start: s, end: Math.min(job.pageCount, s + PAGES_PER_CHUNK - 1) });
  job.phase = "analysing";
  job.errors = [];
  job.validation = undefined;
  job.incompletePages = [];
  job.events = [];
  job.errorMessage = undefined;
  job.usage = { input: 0, output: 0 };
  job.run = { kind: "analyse", stage: "structure", chunks, chunk: 0, candidates: [], attempts: 0, seq: 0, calls: 0, failures: [] };
  await progress(job, "start", `Starting review of ${job.pageCount} page(s) in ${chunks.length} chunk(s)`, 1);
}

export async function startImplement(job: Job) {
  const todo = job.errors.filter((e) => e.accepted && e.status !== "rejected");
  const pages = [...new Set(todo.map((e) => e.page))].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (let i = 0; i < pages.length; i += REVIEW2_GROUP) groups.push(pages.slice(i, i + REVIEW2_GROUP));
  for (const e of job.errors) {
    delete e.applied; delete e.applyNote; delete e.secondReview; delete e.secondReviewNote;
  }
  job.phase = "implementing";
  job.validation = undefined;
  job.errorMessage = undefined;
  job.run = { kind: "implement", stage: "patch", groups, group: 0, attempts: 0, newIssues: [], reviewFailures: 0 };
  await progress(job, "patch", `Preparing ${todo.length} correction(s)`, 2);
}

/**
 * Advance the job by one unit of work. Each unit is small enough for one serverless
 * invocation; a unit that keeps getting killed is skipped after MAX_ATTEMPTS and the
 * affected pages are reported as incomplete rather than silently dropped.
 */
export async function step(job: Job): Promise<void> {
  const run = job.run;
  if (!run) return;
  run.attempts++;
  await saveJob(job);
  try {
    if (run.kind === "analyse") await stepAnalyse(job, run);
    else await stepImplement(job, run);
  } catch (e) {
    job.phase = "failed";
    job.errorMessage = errMsg(e);
    job.run = undefined;
    await saveJob(job);
  }
}

// ---------------------------------------------------------------------------
// ANALYSE
// ---------------------------------------------------------------------------

async function stepAnalyse(job: Job, run: AnalyseRun) {
  const original = await readFile(job, "original.pdf");
  const chunk = run.chunks[run.chunk];
  const tooManyTries = run.attempts > MAX_ATTEMPTS;

  if (run.stage === "structure") {
    if (!tooManyTries) {
      await progress(job, "structure", "Mapping chapters, topics and questions", 3);
      const pages = extractPages(original);
      const empty = pages.filter((p) => p.text.replace(/\s/g, "").length < 20).length;
      if (empty > pages.length * 0.5) {
        await progress(job, "structure", `${empty} of ${pages.length} pages have no selectable text (scanned?). Review uses page images; fixes will go to the corrigendum.`);
      }
      const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
      // For very long modules the structure pass only needs the top of each page (headings).
      const text = pages.map((p) => (totalChars > 600_000 ? { ...p, text: p.text.slice(0, 1500) } : p)).map(pageBlock).join("\n\n");
      try {
        job.structure = await callJson<ModuleStructure>({
          system: SYSTEM_STRUCTURE, prompt: structurePrompt(text), schema: STRUCTURE_SCHEMA, effort: "medium", usage: job.usage,
        });
        await progress(job, "structure", `Found ${job.structure.chapters.length} chapter(s), ${job.structure.chapters.reduce((n, c) => n + c.topics.length, 0)} topic(s)`, 6);
      } catch (e) {
        if (isFatal(e)) throw e;
        job.structure = { title: job.fileName, chapters: [], pages: [] };
        await progress(job, "structure", `Structure mapping failed (${errMsg(e)}); continuing without chapter/topic labels.`, 6);
      }
    } else {
      job.structure = { title: job.fileName, chapters: [], pages: [] };
      await progress(job, "structure", "Structure mapping kept timing out; continuing without chapter/topic labels.", 6);
    }
    Object.assign(run, { stage: "review", attempts: 0 });
    await saveJob(job);
    return;
  }

  const pageInfo = (n: number) => job.structure?.pages.find((p) => p.page === n);
  const pct = (extra: number) => 6 + Math.round(((run.chunk + extra) / run.chunks.length) * 88);
  const markIncomplete = (why: string) => {
    const set = new Set(job.incompletePages ?? []);
    for (let p = chunk.start; p <= chunk.end; p++) set.add(p);
    job.incompletePages = [...set].sort((a, b) => a - b);
    run.failures.push(why);
  };

  if (run.stage === "review") {
    if (tooManyTries) {
      run.calls++;
      markIncomplete("review timed out repeatedly");
      await progress(job, "review", `Pages ${chunk.start}–${chunk.end}: review timed out ${MAX_ATTEMPTS} times; skipped (marked not fully reviewed)`, pct(1));
      return advanceChunk(job, run);
    }
    await progress(job, "review", `Reviewing pages ${chunk.start}–${chunk.end} with 4 specialist agents`, pct(0.1));
    const pages = extractPages(original, chunk.start, chunk.end);
    const pdf = await subsetPdf(original, pages.map((p) => p.page));
    const pageTexts = pages.map(pageBlock).join("\n\n");
    const structureHint = pages.map((p) => {
      const info = pageInfo(p.page);
      return `- page ${p.page}: ${[info?.chapter, info?.topic].filter(Boolean).join(" › ") || "(no heading)"}${info?.questions.length ? ` — questions: ${info.questions.join(", ")}` : ""}`;
    }).join("\n");

    const results = await Promise.all(AGENTS.map(async (agent) => {
      run.calls++;
      try {
        const out = await callJson<{ errors: RawError[] }>({
          system: systemForAgent(agent, job.context), pdf,
          prompt: reviewPrompt({ start: chunk.start, end: chunk.end, pageTexts, structureHint }),
          schema: REVIEW_SCHEMA, effort: agent === "language" ? "medium" : "high", usage: job.usage,
        });
        return out.errors.map((e) => ({ ...e, agent }));
      } catch (e) {
        if (isFatal(e)) throw e;
        job.events.push({ at: Date.now(), stage: "review", message: `${AGENT_LABEL[agent]} failed on pages ${chunk.start}–${chunk.end}: ${errMsg(e)}` });
        markIncomplete(errMsg(e));
        return [];
      }
    }));
    run.candidates = results.flat().map((e) => ({
      ...e,
      page: Math.min(Math.max(e.page, chunk.start), chunk.end),
      cid: `c${++run.seq}`,
    }));
    Object.assign(run, { stage: "verify", attempts: 0 });
    await progress(job, "review", `Pages ${chunk.start}–${chunk.end}: ${run.candidates.length} candidate finding(s); verifying`, pct(0.6));
    return;
  }

  if (run.stage === "verify") {
    const candidates = run.candidates;
    let decisions: Map<string, Decision> | null = null;
    if (candidates.length && !tooManyTries) {
      run.calls++;
      try {
        const pages = extractPages(original, chunk.start, chunk.end);
        const v = await callJson<{ decisions: Decision[] }>({
          system: systemVerifier(job.context),
          pdf: await subsetPdf(original, pages.map((p) => p.page)),
          prompt: verifierPrompt({
            start: chunk.start, end: chunk.end,
            pageTexts: pages.map(pageBlock).join("\n\n"),
            candidates: JSON.stringify(candidates.map((c) => ({
              id: c.cid, reviewer: AGENT_LABEL[c.agent], page: c.page, question: c.question, category: c.category,
              severity: c.severity, original: c.original, corrected: c.corrected, explanation: c.explanation, confidence: c.confidence,
            })), null, 1),
          }),
          schema: VERIFY_SCHEMA, effort: "high", usage: job.usage,
        });
        decisions = new Map(v.decisions.map((d) => [d.id, d]));
      } catch (e) {
        if (isFatal(e)) throw e;
        job.events.push({ at: Date.now(), stage: "verify", message: `Verifier failed on pages ${chunk.start}–${chunk.end}: ${errMsg(e)}. Findings kept as unverified.` });
        markIncomplete(errMsg(e));
      }
    } else if (candidates.length) {
      markIncomplete("verification timed out repeatedly");
    }

    for (const c of candidates) {
      const d = decisions?.get(c.cid);
      const info = pageInfo(c.page);
      const validated = d?.verdict === "validated";
      job.errors.push({
        id: c.cid, page: c.page, chapter: info?.chapter ?? "", topic: info?.topic ?? "", question: c.question,
        category: c.category, severity: d?.severity ?? c.severity,
        original: (validated && d?.original) || c.original,
        corrected: (validated && d?.corrected) || c.corrected,
        explanation: c.explanation, confidence: c.confidence, agent: c.agent,
        status: d ? d.verdict : "pending",
        verifierNote: d ? (d.duplicate_of ? `Duplicate of another finding. ${d.note}` : d.note) : "Not verified (verifier error).",
        accepted: validated,
      } satisfies ReviewError);
    }
    const valid = decisions ? [...decisions.values()].filter((d) => d.verdict === "validated").length : 0;
    job.events.push({ at: Date.now(), stage: "review", message: `Pages ${chunk.start}–${chunk.end}: ${candidates.length} candidate(s) → ${valid} validated`, pct: pct(1) });
    run.candidates = [];
    return advanceChunk(job, run);
  }

  // finalize
  if (run.calls > 0 && run.failures.length >= run.calls) {
    throw new Error(`Review failed — every agent call errored. First error: ${run.failures[0]}`);
  }
  const sevRank: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };
  job.errors.sort((a, b) => a.page - b.page || sevRank[a.severity] - sevRank[b.severity]);
  let n = 0;
  let r = 0;
  for (const e of job.errors) e.id = e.status === "rejected" ? `R-${String(++r).padStart(3, "0")}` : `E-${String(++n).padStart(3, "0")}`;
  await progress(job, "report", "Building the error report PDF", 97);
  await putFile(job, "report.pdf", await buildErrorReport(job));
  job.phase = "analysed";
  job.run = undefined;
  const partial = job.incompletePages?.length
    ? ` — WARNING: ${job.incompletePages.length} page(s) not fully reviewed (pages ${job.incompletePages.join(", ")}); re-run Analyse`
    : "";
  await progress(job, "done", `Analysis complete: ${n} validated error(s), ${r} rejected candidate(s)${partial}`, 100);
}

async function advanceChunk(job: Job, run: AnalyseRun) {
  run.chunk++;
  run.attempts = 0;
  run.stage = run.chunk < run.chunks.length ? "review" : "finalize";
  await saveJob(job);
}

/** Errors no retry can fix (bad key, no credit): stop the whole run with a clear message. */
function isFatal(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  const msg = errMsg(e);
  return status === 401 || status === 403 || /credit balance|anthropic-workspace-id|authentication method/i.test(msg);
}

// ---------------------------------------------------------------------------
// IMPLEMENT ALL ERRORS
// ---------------------------------------------------------------------------

async function stepImplement(job: Job, run: ImplementRun) {
  const todo = job.errors.filter((e) => e.accepted && e.status !== "rejected");
  const original = await readFile(job, "original.pdf");

  if (run.stage === "patch") {
    await progress(job, "patch", `Typesetting ${todo.length} correction(s) into the original pages`, 5);
    const res = await patchPdf(original, todo);
    for (const e of todo) {
      const o = res.outcomes.get(e.id);
      e.applied = o?.applied ?? "failed";
      e.applyNote = o?.note ?? "No outcome recorded.";
    }
    await putFile(job, "patched.pdf", res.pdf);
    const nPatched = todo.filter((e) => e.applied === "patched").length;
    Object.assign(run, { stage: run.groups.length ? "review2" : "assemble", attempts: 0 });
    await progress(job, "patch", `${nPatched} typeset in place, ${todo.length - nPatched} routed to corrigendum`, 30);
    return;
  }

  if (run.stage === "review2") {
    const group = run.groups[run.group];
    const items = todo.filter((e) => group.includes(e.page));
    const pct = () => 30 + Math.round(((run.group + 1) / run.groups.length) * 50);
    if (run.attempts > MAX_ATTEMPTS) {
      run.reviewFailures++;
      job.events.push({ at: Date.now(), stage: "second-review", message: `Second review failed for pages ${group.join(", ")}: timed out repeatedly` });
    } else {
      await progress(job, "second-review", `Second review of corrected page(s) ${group.join(", ")}`, 30 + Math.round((run.group / run.groups.length) * 50));
      try {
        const patched = await readFile(job, "patched.pdf");
        const out = await callJson<{ reviews: { id: string; verdict: "confirmed" | "issue"; note: string }[]; new_issues: { page: number; description: string }[] }>({
          system: systemSecondReview(job.context),
          pdf: await subsetPdf(patched, group),
          prompt: secondReviewPrompt({
            pages: group,
            corrections: JSON.stringify(items.map((e) => ({ id: e.id, page: e.page, applied: e.applied, original: e.original, corrected: e.corrected, reason: e.explanation })), null, 1),
          }),
          schema: SECOND_SCHEMA, effort: "high", usage: job.usage,
        });
        for (const rv of out.reviews) {
          const e = items.find((x) => x.id === rv.id);
          if (e) { e.secondReview = rv.verdict; e.secondReviewNote = rv.note; }
        }
        run.newIssues.push(...out.new_issues);
      } catch (e) {
        if (isFatal(e)) throw e;
        run.reviewFailures++;
        job.events.push({ at: Date.now(), stage: "second-review", message: `Second review failed for pages ${group.join(", ")}: ${errMsg(e)}` });
      }
    }
    run.group++;
    run.attempts = 0;
    if (run.group >= run.groups.length) run.stage = "assemble";
    job.events.push({ at: Date.now(), stage: "second-review", message: `Second review: ${run.group}/${run.groups.length} page group(s) checked`, pct: pct() });
    await saveJob(job);
    return;
  }

  // assemble: repair flagged patches, corrigendum, markers, validation, report
  const badPatches = todo.filter((e) => e.applied === "patched" && e.secondReview === "issue");
  let patched = await readFile(job, "patched.pdf");
  let outcomes: Awaited<ReturnType<typeof patchPdf>>["outcomes"] | null = null;
  if (badPatches.length) {
    await progress(job, "repair", `Moving ${badPatches.length} flagged patch(es) to the corrigendum and re-typesetting`, 82);
    const res = await patchPdf(original, todo, new Set(badPatches.map((e) => e.id)));
    patched = res.pdf;
    outcomes = res.outcomes;
    for (const e of todo) {
      const o = res.outcomes.get(e.id);
      e.applied = o?.applied ?? "failed";
      e.applyNote = o?.note ?? "No outcome recorded.";
    }
    for (const e of badPatches) e.secondReviewNote = `${e.secondReviewNote} → resolved by moving to corrigendum.`;
  }

  const corr = todo.filter((e) => e.applied === "corrigendum").sort((a, b) => a.page - b.page);
  let finalPdf = patched;
  if (corr.length) {
    await progress(job, "assemble", `Appending corrigendum (${corr.length} item(s))`, 88);
    // Anchors come from the patch pass; recompute if the repair pass didn't run.
    if (!outcomes) outcomes = (await patchPdf(original, todo)).outcomes;
    const markers = corr.flatMap((e, i) => {
      const a = outcomes!.get(e.id)?.anchor;
      return a ? [{ ...a, label: `[C${i + 1}]` }] : [];
    });
    finalPdf = await drawMarkers(finalPdf, markers);
    finalPdf = await appendPdf(finalPdf, await buildCorrigendum(job, corr));
  }
  await putFile(job, "final.pdf", finalPdf);

  const resolvedPages = new Set(badPatches.map((e) => e.page));
  const outstanding = todo.filter((e) => e.secondReview === "issue" && e.applied !== "patched" && !badPatches.includes(e));
  const openNew = run.newIssues.filter((i) => !resolvedPages.has(i.page));
  const failed = todo.filter((e) => e.applied === "failed").length;
  const confirmed = todo.filter((e) => e.secondReview === "confirmed").length;
  const unreviewed = todo.filter((e) => !e.secondReview);
  const verdict = outstanding.length || failed || unreviewed.length
    ? "fail"
    : openNew.length || badPatches.length || corr.length ? "pass-with-notes" : "pass";
  job.validation = {
    totalAccepted: todo.length,
    patched: todo.filter((e) => e.applied === "patched").length,
    corrigendum: corr.length,
    failed,
    confirmed,
    issues: todo.filter((e) => e.secondReview === "issue").length,
    newIssues: openNew,
    verdict,
    summary: [
      `${todo.length} accepted correction(s): ${todo.length - corr.length - failed} typeset in place, ${corr.length} in the corrigendum.`,
      `Independent second review confirmed ${confirmed}.`,
      badPatches.length ? `${badPatches.length} in-place patch(es) were flagged and moved to the corrigendum.` : "",
      outstanding.length ? `${outstanding.length} correction(s) still need an editor: ${outstanding.map((e) => e.id).join(", ")}.` : "",
      unreviewed.length ? `Second review could not run for ${unreviewed.length} correction(s) (${unreviewed.map((e) => e.id).join(", ")}); implement again to re-check.` : "",
      openNew.length ? `${openNew.length} layout note(s) raised on pages ${[...new Set(openNew.map((i) => i.page))].join(", ")}.` : "",
    ].filter(Boolean).join(" "),
  };
  await progress(job, "report", "Updating the error report with implementation results", 96);
  await putFile(job, "report.pdf", await buildErrorReport(job));
  job.phase = "implemented";
  job.run = undefined;
  await progress(job, "done", `Final document ready — validation: ${verdict.toUpperCase()}`, 100);
}
