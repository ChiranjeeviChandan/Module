import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import type { Job, ReviewError, Severity } from "../types.js";

const require = createRequire(import.meta.url);
const FONT_DIR = require.resolve("dejavu-fonts-ttf/package.json").replace(/package\.json$/, "ttf/");

const INK = "#1c2230";
const MUTED = "#5b6475";
const RULE = "#d9dde5";
const ACCENT = "#2346c9";
const SEV: Record<Severity, string> = { critical: "#b3261e", major: "#b35c00", minor: "#4a6a1f" };

type Doc = PDFKit.PDFDocument;

function newDoc(): Doc {
  const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 52, right: 52 }, bufferPages: true });
  doc.registerFont("body", FONT_DIR + "DejaVuSans.ttf");
  doc.registerFont("bold", FONT_DIR + "DejaVuSans-Bold.ttf");
  doc.registerFont("serif", FONT_DIR + "DejaVuSerif.ttf");
  doc.registerFont("mono", FONT_DIR + "DejaVuSansMono.ttf");
  return doc;
}

function collect(doc: Doc): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const bufs: Buffer[] = [];
    doc.on("data", (b: Buffer) => bufs.push(b));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(bufs))));
    doc.on("error", reject);
  });
}

function footer(doc: Doc, label: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 36;
    doc.font("body").fontSize(7.5).fillColor(MUTED);
    doc.text(label, 52, y, { width: 300, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - 152, y, { width: 100, align: "right", lineBreak: false });
  }
}

function h1(doc: Doc, t: string) {
  doc.font("bold").fontSize(20).fillColor(INK).text(t);
  doc.moveDown(0.3);
}
function h2(doc: Doc, t: string) {
  ensure(doc, 60);
  doc.moveDown(0.6).font("bold").fontSize(13).fillColor(ACCENT).text(t);
  const y = doc.y + 2;
  doc.moveTo(52, y).lineTo(doc.page.width - 52, y).strokeColor(RULE).lineWidth(0.8).stroke();
  doc.moveDown(0.5);
}
function ensure(doc: Doc, h: number) {
  if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function kv(doc: Doc, pairs: [string, string][]) {
  doc.fontSize(9.5);
  for (const [k, v] of pairs) {
    doc.font("bold").fillColor(MUTED).text(`${k}: `, { continued: true });
    doc.font("body").fillColor(INK).text(v);
  }
}

function table(doc: Doc, cols: { label: string; width: number; align?: "left" | "right" }[], rows: string[][]) {
  const x0 = 52;
  const drawRow = (cells: string[], bold: boolean) => {
    doc.font(bold ? "bold" : "body").fontSize(8.5);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i].width - 8 }))) + 8;
    ensure(doc, h);
    const y = doc.y;
    let x = x0;
    cells.forEach((c, i) => {
      doc.fillColor(bold ? MUTED : INK).text(c, x + 4, y + 4, { width: cols[i].width - 8, align: cols[i].align ?? "left" });
      x += cols[i].width;
    });
    doc.moveTo(x0, y + h).lineTo(x, y + h).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.x = x0;
    doc.y = y + h;
  };
  drawRow(cols.map((c) => c.label), true);
  for (const r of rows) drawRow(r, false);
  doc.moveDown(0.5);
}

function errorCard(doc: Doc, e: ReviewError, n: number, opts: { showApply: boolean }) {
  doc.font("body").fontSize(9);
  const w = doc.page.width - 104 - 16;
  const est =
    40 +
    doc.heightOfString(e.original || "—", { width: w }) +
    doc.heightOfString(e.corrected || "—", { width: w }) +
    doc.heightOfString(e.explanation, { width: w });
  ensure(doc, Math.min(est, 320));
  const x = 52;
  const top = doc.y;
  doc.rect(x, top, 3, 14).fill(SEV[e.severity]);
  doc.font("bold").fontSize(9.5).fillColor(INK).text(`${n}. ${e.id}`, x + 10, top + 1, { continued: true });
  doc.font("body").fillColor(MUTED).text(
    `   p.${e.page} · ${e.severity.toUpperCase()} · ${e.category}${e.question ? " · " + e.question : ""} · conf ${(e.confidence * 100).toFixed(0)}%`,
  );
  doc.font("body").fontSize(8.5).fillColor(MUTED).text([e.chapter, e.topic].filter(Boolean).join(" › ") || "—", x + 10);
  doc.moveDown(0.25);
  const block = (label: string, text: string, colour: string, font = "serif") => {
    doc.font("bold").fontSize(8).fillColor(colour).text(label, x + 10);
    doc.font(font).fontSize(9.5).fillColor(INK).text(text || "—", x + 10, doc.y, { width: w });
    doc.moveDown(0.2);
  };
  block("ORIGINAL", e.original, "#b3261e");
  block("CORRECTED", e.corrected, "#1d7a3a");
  block("WHY", e.explanation, MUTED, "body");
  if (e.verifierNote) block("VERIFIER", e.verifierNote, MUTED, "body");
  if (opts.showApply && e.applied) {
    block("IMPLEMENTATION", `${e.applied}${e.applyNote ? " — " + e.applyNote : ""}${e.secondReview ? ` · second review: ${e.secondReview}${e.secondReviewNote ? " — " + e.secondReviewNote : ""}` : ""}`, MUTED, "body");
  }
  doc.moveDown(0.5);
}

function countBy<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Full error report: summary, chapter/topic/page/question roll-ups, then the log. */
export async function buildErrorReport(job: Job): Promise<Uint8Array> {
  const doc = newDoc();
  const done = collect(doc);
  const errs = job.errors.filter((e) => e.status !== "rejected");
  const rejected = job.errors.filter((e) => e.status === "rejected");

  h1(doc, "Academic QA — Error Report");
  kv(doc, [
    ["Module", job.fileName],
    ["Exam", job.context.exam],
    ["Class / learner", job.context.learner],
    ["Subject", job.context.subject],
    ["Pages", String(job.pageCount)],
    ["Generated", new Date().toLocaleString("en-IN")],
  ]);

  h2(doc, "Summary");
  const sev = (s: Severity) => errs.filter((e) => e.severity === s).length;
  kv(doc, [
    ["Validated errors", String(errs.length)],
    ["Critical / Major / Minor", `${sev("critical")} / ${sev("major")} / ${sev("minor")}`],
    ["Candidate findings rejected by verifier", String(rejected.length)],
    ["Pages with errors", `${new Set(errs.map((e) => e.page)).size} of ${job.pageCount}`],
  ]);
  if (job.incompletePages?.length) {
    doc.moveDown(0.3).font("bold").fontSize(9.5).fillColor("#b3261e")
      .text(`Incomplete review: an agent failed on page(s) ${job.incompletePages.join(", ")}. Those pages are not fully checked.`);
  }
  if (job.validation) {
    doc.moveDown(0.3);
    kv(doc, [
      ["Final validation", job.validation.verdict.toUpperCase()],
      ["Patched in place / corrigendum / failed", `${job.validation.patched} / ${job.validation.corrigendum} / ${job.validation.failed}`],
      ["Second review confirmed / flagged", `${job.validation.confirmed} / ${job.validation.issues}`],
    ]);
    doc.font("body").fontSize(9.5).fillColor(INK).text(job.validation.summary);
  }

  h2(doc, "By category");
  table(doc, [{ label: "Category", width: 380 }, { label: "Errors", width: 111, align: "right" }], countBy(errs, (e) => e.category).map(([k, v]) => [k, String(v)]));

  h2(doc, "Chapter-by-chapter");
  table(
    doc,
    [{ label: "Chapter", width: 260 }, { label: "Critical", width: 77, align: "right" }, { label: "Major", width: 77, align: "right" }, { label: "Minor", width: 77, align: "right" }],
    countBy(errs, (e) => e.chapter || "—").map(([ch]) => {
      const es = errs.filter((e) => (e.chapter || "—") === ch);
      return [ch, ...(["critical", "major", "minor"] as Severity[]).map((s) => String(es.filter((e) => e.severity === s).length))];
    }),
  );

  h2(doc, "Topic-by-topic");
  table(doc, [{ label: "Topic", width: 300 }, { label: "Chapter", width: 131 }, { label: "Errors", width: 60, align: "right" }],
    countBy(errs, (e) => `${e.topic || "—"}\u0000${e.chapter || "—"}`).map(([k, v]) => {
      const [t, c] = k.split("\u0000");
      return [t, c, String(v)];
    }),
  );

  h2(doc, "Page-by-page");
  table(doc, [{ label: "Page", width: 60 }, { label: "Errors", width: 60, align: "right" }, { label: "IDs", width: 371 }],
    [...new Set(errs.map((e) => e.page))].sort((a, b) => a - b).map((p) => {
      const es = errs.filter((e) => e.page === p);
      return [String(p), String(es.length), es.map((e) => e.id).join(", ")];
    }),
  );

  const qErrs = errs.filter((e) => e.question);
  if (qErrs.length) {
    h2(doc, "Question-by-question");
    table(doc, [{ label: "Question", width: 90 }, { label: "Page", width: 50, align: "right" }, { label: "Category", width: 110 }, { label: "Issue", width: 241 }],
      qErrs.sort((a, b) => a.page - b.page).map((e) => [e.question, String(e.page), e.category, e.explanation.slice(0, 160)]),
    );
  }

  h2(doc, "Error log");
  errs.sort((a, b) => a.page - b.page).forEach((e, i) => errorCard(doc, e, i + 1, { showApply: !!job.validation }));

  if (rejected.length) {
    h2(doc, "Rejected candidate findings");
    doc.font("body").fontSize(8.5).fillColor(MUTED).text("Raised by a review agent but overturned by the independent verifier. Listed for transparency; not implemented.");
    doc.moveDown(0.4);
    rejected.forEach((e, i) => errorCard(doc, e, i + 1, { showApply: false }));
  }

  footer(doc, `Error report · ${job.fileName}`);
  doc.end();
  return done;
}

/** Corrigendum pages appended to the corrected module for fixes that cannot be patched in place. */
export async function buildCorrigendum(job: Job, items: ReviewError[]): Promise<Uint8Array> {
  const doc = newDoc();
  const done = collect(doc);
  h1(doc, "Corrigendum");
  doc.font("body").fontSize(9.5).fillColor(MUTED).text(
    `The following corrections apply to this module but sit inside equations, figures or tightly set text that cannot be re-typeset in place. Markers [C#] in the margin point to each location where it could be found.`,
  );
  doc.moveDown(0.6);
  items.sort((a, b) => a.page - b.page).forEach((e, i) => {
    ensure(doc, 90);
    doc.font("bold").fontSize(10).fillColor(ACCENT).text(`[C${i + 1}]  Page ${e.page}${e.question ? " · " + e.question : ""}`);
    doc.font("body").fontSize(8.5).fillColor(MUTED).text([e.chapter, e.topic].filter(Boolean).join(" › "));
    doc.font("bold").fontSize(8).fillColor("#b3261e").text("FOR");
    doc.font("serif").fontSize(10).fillColor(INK).text(e.original || "—");
    doc.font("bold").fontSize(8).fillColor("#1d7a3a").text("READ");
    doc.font("serif").fontSize(10).fillColor(INK).text(e.corrected || "—");
    doc.moveDown(0.7);
  });
  footer(doc, "Corrigendum");
  doc.end();
  return done;
}
