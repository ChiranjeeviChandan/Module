import * as mupdf from "mupdf";

/**
 * All geometry here is MuPDF page space: origin at the top-left of the page's
 * crop box, y growing downwards, units = PDF points.
 */
export interface Char {
  c: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baseline: number;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  color: [number, number, number]; // 0..1 sRGB
}

export interface Line {
  chars: Char[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  blockX1: number; // right edge of the text block (column / box) this line sits in
}

export interface PageText {
  page: number; // 1-indexed
  width: number;
  height: number;
  lines: Line[];
  text: string;
  rightEdge: number; // furthest right any line of text reaches (≈ text-block margin)
}

export function openPdf(data: Uint8Array): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(data, "application/pdf").asPDF();
  if (!doc) throw new Error("Not a PDF document");
  return doc;
}

function toRgb(c: number[]): [number, number, number] {
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) {
    const [C, M, Y, K] = c;
    return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
  }
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

export function extractPage(doc: mupdf.PDFDocument, pageNo: number): PageText {
  const page = doc.loadPage(pageNo - 1);
  const [bx0, by0, bx1, by1] = page.getBounds();
  const st = page.toStructuredText("preserve-whitespace,preserve-spans");
  const lines: Line[] = [];
  let cur: Char[] = [];
  let blockX1 = 0;
  st.walk({
    beginTextBlock(bbox) {
      blockX1 = bbox[2] - bx0;
    },
    beginLine() {
      cur = [];
    },
    onChar(c, origin, font, size, quad, color) {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const name = font.getName();
      const lname = name.toLowerCase();
      cur.push({
        c,
        x0: Math.min(...xs) - bx0,
        x1: Math.max(...xs) - bx0,
        y0: Math.min(...ys) - by0,
        y1: Math.max(...ys) - by0,
        baseline: origin[1] - by0,
        size,
        font: name,
        bold: font.isBold() || /bold|black|heavy|semibold|demi/.test(lname),
        italic: font.isItalic() || /italic|oblique/.test(lname),
        mono: font.isMono() || /mono|courier/.test(lname),
        serif: (font.isSerif() || /serif|times|roman|georgia|cambria|garamond|minion/.test(lname)) &&
          !/sans|arial|helvetica|calibri|verdana|segoe|roboto/.test(lname),
        color: toRgb(color as number[]),
      });
    },
    endLine() {
      if (!cur.length) return;
      lines.push({
        chars: cur,
        x0: Math.min(...cur.map((c) => c.x0)),
        x1: Math.max(...cur.map((c) => c.x1)),
        y0: Math.min(...cur.map((c) => c.y0)),
        y1: Math.max(...cur.map((c) => c.y1)),
        blockX1,
      });
    },
  });
  st.destroy();
  page.destroy();
  const text = lines.map((l) => l.chars.map((c) => c.c).join("")).join("\n");
  const rightEdge = lines.reduce((m, l) => Math.max(m, l.x1), 0);
  return { page: pageNo, width: bx1 - bx0, height: by1 - by0, lines, text, rightEdge };
}

export function extractPages(data: Uint8Array, start = 1, end = Infinity): PageText[] {
  const doc = openPdf(data);
  try {
    const out: PageText[] = [];
    for (let p = start; p <= Math.min(end, doc.countPages()); p++) out.push(extractPage(doc, p));
    return out;
  } finally {
    doc.destroy();
  }
}

export function renderPagePng(data: Uint8Array, pageNo: number, scale = 1.5): Uint8Array {
  const doc = openPdf(data);
  try {
    const page = doc.loadPage(pageNo - 1);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = pix.asPNG();
    pix.destroy();
    page.destroy();
    return png;
  } finally {
    doc.destroy();
  }
}
