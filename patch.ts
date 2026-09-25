import fs from "node:fs";
import { createRequire } from "node:module";
import * as mupdf from "mupdf";
import { PDFDocument, PDFFont, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { extractPages, openPdf, type Char, type PageText } from "./extract.js";
import type { ReviewError } from "../types.js";

const require = createRequire(import.meta.url);
const FONT_DIR = require.resolve("dejavu-fonts-ttf/package.json").replace(/package\.json$/, "ttf/");

// ---------------------------------------------------------------------------
// Locating a quoted snippet on a page (character-exact, via MuPDF quads)
// ---------------------------------------------------------------------------

const CHAR_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-",
  "·": ".", "∙": ".", "⋅": ".",
};

/** Normalise one glyph for matching: compatibility forms, quote/dash variants, no whitespace. */
function norm(ch: string): string {
  return Array.from(ch.normalize("NFKC"))
    .map((c) => CHAR_MAP[c] ?? c)
    .join("")
    .replace(/\s+/g, "");
}

interface Ref {
  line: number;
  idx: number; // char index within the line
}

export interface Segment {
  line: number;
  first: number; // char index of first matched char
  last: number; // char index of last matched char
  x0: number;
  x1: number;
  baseline: number;
  size: number;
  style: Char;
  restText: string; // text after the match on this line
  lineX1: number;
  roomX1: number; // how far right new text may run without re-flowing (margin if the match ends the line)
}

export function locate(page: PageText, needle: string): Segment[] | null {
  for (const fold of [false, true]) {
    let n = Array.from(needle).map(norm).join("");
    if (fold) n = n.toLowerCase();
    if (!n) return null;
    let flat = "";
    const refs: Ref[] = [];
    page.lines.forEach((line, li) =>
      line.chars.forEach((ch, idx) => {
        const c = norm(ch.c);
        for (const cc of Array.from(fold ? c.toLowerCase() : c)) {
          flat += cc;
          refs.push({ line: li, idx });
        }
      }),
    );
    const at = flat.indexOf(n);
    if (at >= 0) return toSegments(page, refs.slice(at, at + n.length));
  }
  return null;
}

function toSegments(page: PageText, hit: Ref[]): Segment[] {
  const byLine = new Map<number, number[]>();
  for (const r of hit) {
    if (!byLine.has(r.line)) byLine.set(r.line, []);
    byLine.get(r.line)!.push(r.idx);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([li, idxs]) => {
      const line = page.lines[li];
      const first = Math.min(...idxs);
      const last = Math.max(...idxs);
      const chars = line.chars.slice(first, last + 1);
      // Style from the most common size in the span (ignores sub/superscripts).
      const sizes = chars.map((c) => c.size).sort((a, b) => a - b);
      const size = sizes[Math.floor(sizes.length / 2)];
      const style = chars.find((c) => Math.abs(c.size - size) < 0.01 && c.c.trim()) ?? chars[0];
      return {
        line: li,
        first,
        last,
        x0: chars[0].x0,
        x1: Math.max(...chars.map((c) => c.x1)),
        baseline: style.baseline,
        size,
        style,
        restText: line.chars.slice(last + 1).map((c) => c.c).join(""),
        lineX1: line.x1,
        roomX1: line.chars.slice(last + 1).some((c) => c.c.trim())
          ? Math.max(...chars.map((c) => c.x1))
          : Math.max(line.x1, line.blockX1),
      };
    });
}

// ---------------------------------------------------------------------------
// Fonts (DejaVu covers Greek, sub/superscripts, arrows and maths operators)
// ---------------------------------------------------------------------------

const FONT_FILES = [
  "DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf",
  "DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSerif-Italic.ttf", "DejaVuSerif-BoldItalic.ttf",
  "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf",
];

function fontFileFor(s: Pick<Char, "bold" | "italic" | "serif" | "mono">): string {
  if (s.mono) return s.bold ? "DejaVuSansMono-Bold.ttf" : "DejaVuSansMono.ttf";
  if (s.serif) return `DejaVuSerif${s.bold && s.italic ? "-BoldItalic" : s.bold ? "-Bold" : s.italic ? "-Italic" : ""}.ttf`;
  return `DejaVuSans${s.bold && s.italic ? "-BoldOblique" : s.bold ? "-Bold" : s.italic ? "-Oblique" : ""}.ttf`;
}

async function embedFonts(doc: PDFDocument, files: Iterable<string>): Promise<Map<string, PDFFont>> {
  doc.registerFontkit(fontkit);
  const out = new Map<string, PDFFont>();
  for (const f of files) out.set(f, await doc.embedFont(fs.readFileSync(FONT_DIR + f), { subset: true }));
  return out;
}

// ---------------------------------------------------------------------------
// Fitting the corrected text into the located segments
// ---------------------------------------------------------------------------

interface Placement {
  seg: Segment;
  text: string;
  size: number;
  spacing: number; // word-space scale (1 = natural)
  coverTo: number; // last char index on the line to remove (extends into the line tail when re-flowing)
}

function tokens(text: string) {
  return text.split(/(\s+)/).filter((w) => w.length);
}

export function textWidth(font: PDFFont, text: string, size: number, spacing: number): number {
  const space = font.widthOfTextAtSize(" ", size) * spacing;
  return tokens(text.trim()).reduce((w, t) => w + (/^\s/.test(t) ? space * t.length : font.widthOfTextAtSize(t, size)), 0);
}

// Least visible adjustments first: tighter word spaces, then re-flowing the line tail, then ≤10 % smaller type.
const ATTEMPTS = [
  { scale: 1, spacing: 1, extend: false }, { scale: 1, spacing: 0.8, extend: false }, { scale: 1, spacing: 0.65, extend: false },
  { scale: 1, spacing: 1, extend: true }, { scale: 1, spacing: 0.8, extend: true },
  { scale: 0.95, spacing: 0.65, extend: false }, { scale: 0.95, spacing: 0.8, extend: true },
  { scale: 0.9, spacing: 0.65, extend: false }, { scale: 0.9, spacing: 0.65, extend: true },
];

function layout(segs: Segment[], corrected: string, font: PDFFont): Placement[] | null {
  const lastIdx = segs.length - 1;
  const last = segs[lastIdx];
  const hasTail = !!last.restText.trim();
  for (const { scale, spacing, extend } of ATTEMPTS) {
    if (extend && !hasTail) continue; // nothing to re-flow
    const words = tokens(corrected + (extend ? last.restText : ""));
    const out: Placement[] = [];
    let wi = 0;
    let ok = true;
    for (let s = 0; s <= lastIdx && ok; s++) {
      const seg = segs[s];
      const isLast = s === lastIdx;
      let size = seg.size * scale;
      const room = isLast && extend ? Math.max(seg.lineX1, seg.roomX1) : seg.roomX1;
      const cap = room - seg.x0 + 0.5;
      let text = "";
      if (isLast) {
        text = words.slice(wi).join("");
        wi = words.length;
        // The last line only shrinks if it has to, even when earlier lines did.
        if (textWidth(font, text, seg.size, spacing) <= cap) size = seg.size;
        ok = textWidth(font, text, size, spacing) <= cap;
      } else {
        while (wi < words.length) {
          const cand = text + words[wi];
          if (text.trim() && textWidth(font, cand, size, spacing) > cap) break;
          text = cand;
          wi++;
        }
      }
      out.push({ seg, text: text.trim(), size, spacing, coverTo: isLast && extend ? Number.MAX_SAFE_INTEGER : seg.last });
    }
    if (ok && wi >= words.length) return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface Outcome {
  applied: "patched" | "corrigendum";
  note: string;
  /** Where the text was found (MuPDF page space), so a corrigendum marker can point at it. */
  anchor?: { page: number; y: number; size: number };
}

export interface PatchResult {
  pdf: Uint8Array;
  outcomes: Map<string, Outcome>;
}

interface Draw {
  page: number;
  x: number;
  baseline: number;
  text: string;
  size: number;
  spacing: number;
  fontFile: string;
  color: [number, number, number];
}

/**
 * Typeset corrections into the original PDF:
 *   1. find each `original` span character-exactly on its page;
 *   2. fit `corrected` into the same line boxes (same size, else ≤14 % smaller, else re-flow the line tail);
 *   3. truly redact the old glyphs with MuPDF (background, images and vector art untouched);
 *   4. draw the new text with the matching weight/style/colour via pdf-lib.
 * Anything that cannot be placed faithfully is routed to the corrigendum instead.
 */
export async function patchPdf(
  original: Uint8Array,
  errors: ReviewError[],
  forceCorrigendum: Set<string> = new Set(),
): Promise<PatchResult> {
  const pages = extractPages(original);
  const outcomes = new Map<string, Outcome>();
  const measure = await embedFonts(await PDFDocument.create(), FONT_FILES);
  const probe = await PDFDocument.load(original, { ignoreEncryption: true });
  const rotated = new Set(probe.getPages().flatMap((p, i) => (p.getRotation().angle % 360 ? [i + 1] : [])));

  const redactions = new Map<number, [number, number, number, number][]>();
  const draws: Draw[] = [];
  const used = new Map<string, [number, number][]>(); // "page:line" → covered char ranges

  for (const err of [...errors].sort((a, b) => a.page - b.page)) {
    if (!err.original.trim()) {
      outcomes.set(err.id, { applied: "corrigendum", note: "No printable anchor text." });
      continue;
    }
    // Stated page first, then neighbours (reviewers occasionally drift by one).
    let segs: Segment[] | null = null;
    let pg: PageText | undefined;
    for (const cand of [err.page, err.page + 1, err.page - 1]) {
      const p = pages[cand - 1];
      if (p && (segs = locate(p, err.original))) {
        pg = p;
        break;
      }
    }
    if (!segs || !pg) {
      outcomes.set(err.id, { applied: "corrigendum", note: "Original text not found in the PDF text layer (equation, figure or image)." });
      continue;
    }
    const anchor = { page: pg.page, y: segs[0].baseline, size: segs[0].size };
    const fail = (note: string) => outcomes.set(err.id, { applied: "corrigendum", note, anchor });

    if (forceCorrigendum.has(err.id)) { fail("In-place patch failed second review; moved to corrigendum."); continue; }
    if (rotated.has(pg.page)) { fail("Page is rotated; listed in corrigendum."); continue; }

    const fontFile = fontFileFor(segs[0].style);
    const placed = layout(segs, err.corrected, measure.get(fontFile)!);
    if (!placed) { fail("Corrected text does not fit the original layout; listed in corrigendum."); continue; }

    const clash = placed.some((p) =>
      (used.get(`${pg!.page}:${p.seg.line}`) ?? []).some(([a, b]) => p.seg.first <= b && a <= p.coverTo),
    );
    if (clash) { fail("Overlaps another correction on the same line; listed in corrigendum."); continue; }

    for (const p of placed) {
      const key = `${pg.page}:${p.seg.line}`;
      used.set(key, [...(used.get(key) ?? []), [p.seg.first, p.coverTo]]);
      const line = pg.lines[p.seg.line];
      const gone = line.chars.slice(p.seg.first, Math.min(p.coverTo, line.chars.length - 1) + 1);
      // Tight box per glyph run: centre band only, so neighbours above/below are untouched.
      const rects = redactions.get(pg.page) ?? [];
      for (const ch of gone) {
        if (!ch.c.trim()) continue;
        const h = ch.y1 - ch.y0;
        const w = ch.x1 - ch.x0;
        rects.push([ch.x0 + w * 0.2, ch.y0 + h * 0.3, ch.x1 - w * 0.2, ch.y1 - h * 0.3]);
      }
      redactions.set(pg.page, rects);
      if (p.text) {
        draws.push({ page: pg.page, x: p.seg.x0, baseline: p.seg.baseline, text: p.text, size: p.size, spacing: p.spacing, fontFile, color: p.seg.style.color });
      }
    }
    outcomes.set(err.id, { applied: "patched", note: pg.page === err.page ? "Typeset in place." : `Typeset in place on page ${pg.page}.`, anchor });
  }

  // Redact old glyphs (text only — images and line art stay exactly as they were).
  const mdoc = openPdf(original);
  let redacted: Uint8Array;
  try {
    for (const [pageNo, rects] of redactions) {
      const page = mdoc.loadPage(pageNo - 1);
      for (const r of rects) page.createAnnotation("Redact").setRect(r);
      page.applyRedactions(
        false,
        mupdf.PDFPage.REDACT_IMAGE_NONE,
        mupdf.PDFPage.REDACT_LINE_ART_NONE,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
      page.destroy();
    }
    redacted = new Uint8Array(mdoc.saveToBuffer("compress").asUint8Array());
  } finally {
    mdoc.destroy();
  }

  // Draw the corrected text.
  const doc = await PDFDocument.load(redacted, { ignoreEncryption: true });
  const fonts = await embedFonts(doc, new Set(draws.map((d) => d.fontFile)));
  const pdfPages = doc.getPages();
  for (const d of draws) {
    const page = pdfPages[d.page - 1];
    const box = page.getCropBox();
    const font = fonts.get(d.fontFile)!;
    const opts = { y: box.y + box.height - d.baseline, size: d.size, font, color: rgb(...d.color) };
    if (d.spacing === 1) {
      page.drawText(d.text, { ...opts, x: box.x + d.x });
      continue;
    }
    // Tightened word spacing: set word by word.
    let x = box.x + d.x;
    for (const t of tokens(d.text)) {
      if (/^\s/.test(t)) x += font.widthOfTextAtSize(" ", d.size) * d.spacing * t.length;
      else {
        page.drawText(t, { ...opts, x });
        x += font.widthOfTextAtSize(t, d.size);
      }
    }
  }
  return { pdf: await doc.save(), outcomes };
}

/** Small "[C#]" tags in the right margin pointing readers to the corrigendum. */
export async function drawMarkers(data: Uint8Array, markers: { page: number; y: number; size: number; label: string }[]): Promise<Uint8Array> {
  if (!markers.length) return data;
  const doc = await PDFDocument.load(data, { ignoreEncryption: true });
  const font = (await embedFonts(doc, ["DejaVuSans-Bold.ttf"])).get("DejaVuSans-Bold.ttf")!;
  const pages = doc.getPages();
  for (const m of markers) {
    const page = pages[m.page - 1];
    if (!page) continue;
    const box = page.getCropBox();
    const size = Math.max(6, Math.min(8, m.size * 0.7));
    const w = font.widthOfTextAtSize(m.label, size);
    const x = box.x + box.width - w - 10;
    const y = box.y + box.height - m.y;
    page.drawRectangle({ x: x - 2, y: y - 2, width: w + 4, height: size + 3, color: rgb(1, 0.95, 0.75) });
    page.drawText(m.label, { x, y, size, font, color: rgb(0.7, 0.15, 0.1) });
  }
  return doc.save();
}

/** Append pages (e.g. a corrigendum) from another PDF. */
export async function appendPdf(base: Uint8Array, extra: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(base, { ignoreEncryption: true });
  const src = await PDFDocument.load(extra);
  for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
  return doc.save();
}
