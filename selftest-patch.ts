// Offline check of extraction + in-place patching + report rendering (no API calls).
import fs from "node:fs";
import { extractPages, renderPagePng } from "../src/pdf/extract.js";
import { patchPdf, drawMarkers, appendPdf } from "../src/pdf/patch.js";
import { buildErrorReport, buildCorrigendum } from "../src/pdf/report.js";
import type { Job, ReviewError } from "../src/types.js";

const out = process.argv[2] || "samples/out";
fs.mkdirSync(out, { recursive: true });
const src = new Uint8Array(fs.readFileSync("samples/sample-physics-module.pdf"));
const pages = await extractPages(src);
console.log(pages[0].text);

const mk = (id: string, original: string, corrected: string, extra: Partial<ReviewError> = {}): ReviewError => ({
  id, page: 1, chapter: "Motion in a Straight Line", topic: "3.1", question: "", category: "conceptual", severity: "critical",
  original, corrected, explanation: "test", confidence: 0.95, agent: "concept", status: "validated", accepted: true, ...extra,
});
const errs = [
  mk("E-001", "displacement is s = ut + at²", "displacement is s = ut + ½at²"),
  mk("E-002", "v² = u² + as", "v² = u² + 2as"),
  mk("E-003", "gives the accelaration of the particle", "gives the displacement of the particle", { category: "conceptual" }),
  mk("E-004", "g ≈ 9.8 m/s in", "g ≈ 9.8 m/s² in", { category: "units-notation" }),
  mk("E-005", "covers a distance h = gt² in time t", "covers a distance h = ½gt² in time t"),
  mk("E-006", "Q1. (C)", "Q1. (B)", { category: "answer-key", question: "Q1" }),
  mk("E-007", "Figure 3.4 arrow label", "should point downward", { category: "diagram-reference" }),
];
const res = await patchPdf(src, errs);
for (const e of errs) { const o = res.outcomes.get(e.id)!; e.applied = o.applied; e.applyNote = o.note; console.log(e.id, o.applied, o.note); }
const corr = errs.filter((e) => e.applied === "corrigendum");
let pdf = await drawMarkers(res.pdf, corr.flatMap((e, i) => { const a = res.outcomes.get(e.id)!.anchor; return a ? [{ ...a, label: `[C${i + 1}]` }] : []; }));
const job: Job = { id: "t", fileName: "sample.pdf", pageCount: 1, context: { exam: "JEE Main", learner: "Class 11", subject: "Physics" }, phase: "implemented", events: [], errors: errs, usage: { input: 0, output: 0 }, createdAt: 0 };
pdf = await appendPdf(pdf, await buildCorrigendum(job, corr));
fs.writeFileSync(`${out}/final.pdf`, pdf);
fs.writeFileSync(`${out}/report.pdf`, await buildErrorReport(job));
fs.writeFileSync(`${out}/before.png`, await renderPagePng(src, 1, 1.4));
fs.writeFileSync(`${out}/after.png`, await renderPagePng(pdf, 1, 1.4));
const after = await extractPages(pdf);
console.log("---- after ----\n" + after[0].text);
