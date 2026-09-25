import { PDFDocument } from "pdf-lib";

export async function pageCount(data: Uint8Array): Promise<number> {
  return (await PDFDocument.load(data, { ignoreEncryption: true })).getPageCount();
}

export async function subsetPdf(data: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(data, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, pages.map((n) => n - 1))) out.addPage(p);
  return out.save();
}
