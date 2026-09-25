import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { pageCount } from "./pdf/split.js";
import { renderPagePng } from "./pdf/extract.js";
import { buildErrorReport } from "./pdf/report.js";
import { startAnalyse, startImplement, step } from "./pipeline.js";
import {
  CLOUD, STORAGE_PROBLEM, acquireLock, deleteJob, hasFile, listSummaries, loadJob, putFile, readBlob, readFile, releaseLock,
  saveJob, signedDownloadUrl,
} from "./storage.js";
import { authRouter, loadSession, requireUser } from "./auth.js";
import { adminRouter, pagesThisMonth } from "./admin.js";
import type { Job } from "./types.js";

// One step must finish inside the function limit (vercel.json maxDuration); the lock outlives it slightly.
const STEP_LOCK_MS = Number(process.env.STEP_LOCK_MS || 330_000);
const MAX_UPLOAD = 200 * 1024 * 1024;

export const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD } });
app.use(express.json({ limit: "1mb" }));
app.use(loadSession);

const running = (job: Job) => job.phase === "analysing" || job.phase === "implementing";

/** Owners see their own modules; admins see everyone's. */
async function withJob(req: express.Request, res: express.Response): Promise<Job | undefined> {
  const job = await loadJob(String(req.params.id));
  const user = req.user!;
  if (!job || (job.ownerId !== user.id && user.role !== "admin")) {
    res.status(404).json({ error: "Module not found." });
    return undefined;
  }
  return job;
}

/** Wrap async handlers so a thrown error becomes a JSON 500 instead of a hung request. */
const h = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((e: Error) => {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
  };

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);

app.get("/api/config", (_req, res) => {
  res.json({
    hasKey: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    storage: CLOUD ? "cloud" : "local",
    storageProblem: STORAGE_PROBLEM,
  });
});

// Everything below needs a signed-in user.
app.use("/api", (req, res, next) => (req.path === "/config" ? next() : requireUser(req, res, next)));

/** Browser → Blob direct upload (bypasses the 4.5 MB serverless request limit). */
app.post("/api/blob-upload", h(async (req, res) => {
  if (!CLOUD) return res.status(400).json({ error: "Blob storage is not configured." });
  const result = await handleUpload({
    body: req.body as HandleUploadBody,
    request: req,
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: ["application/pdf"],
      maximumSizeInBytes: MAX_UPLOAD,
      addRandomSuffix: true,
    }),
  });
  res.json(result);
}));

async function createJob(req: express.Request, bytes: Uint8Array, fileName: string, ctx: Record<string, string>, blobUrl?: string): Promise<Job> {
  const job: Job = {
    id: crypto.randomUUID(),
    ownerId: req.user!.id,
    ownerEmail: req.user!.email,
    fileName,
    pageCount: await pageCount(bytes),
    context: { exam: ctx.exam, learner: ctx.learner, subject: ctx.subject },
    phase: "uploaded",
    events: [],
    errors: [],
    usage: { input: 0, output: 0 },
    files: {},
    createdAt: Date.now(),
  };
  if (blobUrl) job.files!["original.pdf"] = blobUrl;
  else await putFile(job, "original.pdf", bytes);
  await saveJob(job);
  return job;
}

app.post("/api/jobs", upload.single("file"), h(async (req, res) => {
  if (STORAGE_PROBLEM) return res.status(500).json({ error: STORAGE_PROBLEM });
  const body = req.body as Record<string, string>;
  if (!body.exam || !body.learner || !body.subject) return res.status(400).json({ error: "Select exam, class and subject." });

  let bytes: Uint8Array;
  let name: string;
  let blobUrl: string | undefined;
  if (req.file) {
    bytes = new Uint8Array(req.file.buffer);
    name = req.file.originalname;
  } else if (body.blobUrl && CLOUD) {
    // Only accept blobs from our own store.
    let host = "";
    try { host = new URL(body.blobUrl).hostname; } catch { /* invalid */ }
    if (!host.endsWith(".blob.vercel-storage.com")) return res.status(400).json({ error: "Invalid upload URL." });
    bytes = await readBlob(body.blobUrl);
    name = body.fileName || "module.pdf";
    blobUrl = body.blobUrl;
  } else {
    return res.status(400).json({ error: "Upload a PDF module." });
  }
  if (!Buffer.from(bytes.subarray(0, 5)).toString().startsWith("%PDF")) return res.status(400).json({ error: "That file is not a PDF." });
  try {
    res.json(await createJob(req, bytes, name, body, blobUrl));
  } catch (e) {
    res.status(400).json({ error: `Could not open PDF: ${(e as Error).message}` });
  }
}));

/** The signed-in user's modules, newest first, plus their monthly quota position. */
app.get("/api/jobs", h(async (req, res) => {
  const all = await listSummaries();
  const user = req.user!;
  res.json({
    jobs: all.filter((j) => j.ownerId === user.id),
    quota: user.monthlyPageQuota,
    pagesThisMonth: pagesThisMonth(user.id, all),
  });
}));

app.delete("/api/jobs/:id", h(async (req, res) => {
  const job = await withJob(req, res);
  if (!job) return;
  if (running(job)) return res.status(409).json({ error: "Wait for the run to finish before deleting." });
  await deleteJob(job);
  res.json({ ok: true });
}));

app.get("/api/jobs/:id", h(async (req, res) => {
  const job = await withJob(req, res);
  if (job) res.json(job);
}));

app.patch("/api/jobs/:id", h(async (req, res) => {
  const job = await withJob(req, res);
  if (!job) return;
  if (running(job)) return res.status(409).json({ error: "Job is running." });
  const { exam, learner, subject } = req.body as Record<string, string>;
  job.context = { exam: exam || job.context.exam, learner: learner || job.context.learner, subject: subject || job.context.subject };
  await saveJob(job);
  res.json(job);
}));

app.post("/api/jobs/:id/analyse", h(async (req, res) => {
  const job = await withJob(req, res);
  if (!job) return;
  if (running(job)) return res.status(409).json({ error: "This job is already running." });
  const user = req.user!;
  if (user.monthlyPageQuota > 0) {
    const used = pagesThisMonth(user.id, (await listSummaries()).filter((j) => j.id !== job.id));
    if (used + job.pageCount > user.monthlyPageQuota) {
      return res.status(403).json({
        error: `This module has ${job.pageCount} pages, but your monthly quota has ${Math.max(0, user.monthlyPageQuota - used)} of ${user.monthlyPageQuota} pages left. Ask an administrator to raise it.`,
      });
    }
  }
  job.lastAnalysedAt = Date.now();
  await startAnalyse(job);
  res.json(job);
}));

app.post("/api/jobs/:id/implement", h(async (req, res) => {
  const job = await withJob(req, res);
  if (!job) return;
  if (running(job)) return res.status(409).json({ error: "This job is already running." });
  if (!job.errors.some((e) => e.accepted && e.status !== "rejected")) return res.status(400).json({ error: "No accepted errors to implement." });
  await startImplement(job);
  res.json(job);
}));

/**
 * Advance a running job by one unit. The browser calls this in a loop, so no single
 * request runs longer than one chunk of work (serverless time limits). A lock stops two
 * tabs from running the same step twice.
 */
app.post("/api/jobs/:id/step", h(async (req, res) => {
  const id = String(req.params.id);
  let job = await withJob(req, res);
  if (!job) return;
  if (!running(job)) return res.json(job);
  if (!(await acquireLock(id, STEP_LOCK_MS))) return res.status(409).json({ busy: true, job });
  try {
    job = (await loadJob(id))!; // re-read under the lock
    if (running(job)) await step(job);
  } finally {
    await releaseLock(id);
  }
  res.json(job);
}));

/** Editor overrides before implementing: accept/reject, or edit the replacement text. */
app.patch("/api/jobs/:id/errors/:eid", h(async (req, res) => {
  const job = await withJob(req, res);
  if (!job) return;
  if (running(job)) return res.status(409).json({ error: "Job is running." });
  const err = job.errors.find((e) => e.id === req.params.eid);
  if (!err) return res.status(404).json({ error: "Error not found" });
  const { accepted, corrected, original } = req.body as { accepted?: boolean; corrected?: string; original?: string };
  if (typeof accepted === "boolean") err.accepted = accepted;
  if (typeof corrected === "string") err.corrected = corrected;
  if (typeof original === "string") err.original = original;
  // Keep the downloadable report in sync with editor decisions.
  await putFile(job, "report.pdf", await buildErrorReport(job));
  await saveJob(job);
  res.json(err);
}));

app.post("/api/jobs/:id/errors/bulk", h(async (req, res) => {
  const job = await withJob(req, res);
  if (!job) return;
  if (running(job)) return res.status(409).json({ error: "Job is running." });
  const { accepted } = req.body as { accepted: boolean };
  for (const e of job.errors) if (e.status !== "rejected") e.accepted = !!accepted;
  await putFile(job, "report.pdf", await buildErrorReport(job));
  await saveJob(job);
  res.json({ ok: true });
}));

const stem = (job: Job) => job.fileName.replace(/\.pdf$/i, "");

async function sendPdf(req: express.Request, res: express.Response, name: string, label: string) {
  const job = await withJob(req, res);
  if (!job) return;
  if (!hasFile(job, name)) return res.status(404).json({ error: "Not generated yet." });
  // Large files: send the browser straight to a short-lived signed blob URL.
  const signed = await signedDownloadUrl(job, name);
  if (signed) return res.redirect(302, signed);
  const bytes = await readFile(job, name);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${`${stem(job)} - ${label}.pdf`.replace(/[^\w.\- ]/g, "_")}"`);
  res.end(Buffer.from(bytes));
}

app.get("/api/jobs/:id/report.pdf", h((req, res) => sendPdf(req, res, "report.pdf", "Error Report")));
app.get("/api/jobs/:id/final.pdf", h((req, res) => sendPdf(req, res, "final.pdf", "Corrected")));

app.get("/api/jobs/:id/page/:which/:n.png", h(async (req, res) => {
  const job = await withJob(req, res);
  if (!job) return;
  const name = req.params.which === "final" ? "final.pdf" : "original.pdf";
  if (!hasFile(job, name)) return res.status(404).end();
  const png = renderPagePng(await readFile(job, name), Number(req.params.n), 1.4);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=60");
  res.end(Buffer.from(png));
}));

/** Local development only: serve the UI from /public (Vercel serves it from its CDN). */
export function withStatic(root = path.resolve("public")) {
  const local = express();
  if (fs.existsSync(root)) local.use(express.static(root));
  local.use(app);
  return local;
}

export default app;
