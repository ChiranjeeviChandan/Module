import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { del, get, issueSignedToken, presignUrl, put } from "@vercel/blob";
import type { Job, JobSummary, ProgressEvent, User } from "./types.js";

/**
 * Two backends behind one interface:
 *  - local: job JSON + PDFs on disk (for `npm start`)
 *  - cloud: job JSON in Upstash Redis, PDFs in a private Vercel Blob store (for Vercel)
 */
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const CLOUD = !!(process.env.BLOB_READ_WRITE_TOKEN && redisUrl && redisToken);

/** On Vercel without storage configured nothing can persist between requests. */
export const STORAGE_PROBLEM =
  process.env.VERCEL && !CLOUD
    ? "Storage is not configured. Add a Vercel Blob store and an Upstash Redis database to this project (Storage tab), then redeploy."
    : null;

const redis = CLOUD ? new Redis({ url: redisUrl!, token: redisToken! }) : null;

const DATA_DIR = path.resolve(process.env.DATA_DIR || "data/jobs");
const USERS_FILE = path.join(path.dirname(DATA_DIR), "users.json");
const localDir = (id: string) => path.join(DATA_DIR, id);

const validId = (id: string) => /^[a-z0-9-]{8,64}$/i.test(id);

// ------------------------------------------------------------------ jobs

export async function loadJob(id: string): Promise<Job | undefined> {
  if (!validId(id)) return undefined;
  if (redis) return (await redis.get<Job>(`job:${id}`)) ?? undefined;
  const f = path.join(localDir(id), "job.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Job) : undefined;
}

export async function saveJob(job: Job): Promise<void> {
  if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
  const summary = summarize(job);
  if (redis) {
    await Promise.all([redis.set(`job:${job.id}`, job), redis.hset("jobsummaries", { [job.id]: summary })]);
    return;
  }
  fs.mkdirSync(localDir(job.id), { recursive: true });
  fs.writeFileSync(path.join(localDir(job.id), "job.json"), JSON.stringify(job, null, 1));
  fs.writeFileSync(path.join(localDir(job.id), "summary.json"), JSON.stringify(summary));
}

export function summarize(job: Job): JobSummary {
  const valid = job.errors.filter((e) => e.status !== "rejected");
  const categories: Record<string, number> = {};
  for (const e of valid) categories[e.category] = (categories[e.category] ?? 0) + 1;
  return {
    id: job.id,
    ownerId: job.ownerId ?? "",
    ownerEmail: job.ownerEmail ?? "",
    fileName: job.fileName,
    pageCount: job.pageCount,
    context: job.context,
    phase: job.phase,
    errors: {
      total: valid.length,
      critical: valid.filter((e) => e.severity === "critical").length,
      major: valid.filter((e) => e.severity === "major").length,
      minor: valid.filter((e) => e.severity === "minor").length,
      rejected: job.errors.length - valid.length,
    },
    categories,
    verdict: job.validation?.verdict,
    usage: job.usage,
    createdAt: job.createdAt,
    updatedAt: Date.now(),
    lastAnalysedAt: job.lastAnalysedAt,
  };
}

export async function listSummaries(): Promise<JobSummary[]> {
  if (redis) {
    const all = await redis.hgetall<Record<string, JobSummary>>("jobsummaries");
    return Object.values(all ?? {}).sort((a, b) => b.createdAt - a.createdAt);
  }
  if (!fs.existsSync(DATA_DIR)) return [];
  const out: JobSummary[] = [];
  for (const id of fs.readdirSync(DATA_DIR)) {
    const sf = path.join(DATA_DIR, id, "summary.json");
    const jf = path.join(DATA_DIR, id, "job.json");
    try {
      if (fs.existsSync(sf)) out.push(JSON.parse(fs.readFileSync(sf, "utf8")));
      else if (fs.existsSync(jf)) out.push(summarize(JSON.parse(fs.readFileSync(jf, "utf8"))));
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteJob(job: Job): Promise<void> {
  if (redis) {
    const urls = Object.values(job.files ?? {}).filter((u) => u.startsWith("https://"));
    if (urls.length) await del(urls).catch((e) => console.warn("blob delete failed", e));
    await Promise.all([redis.del(`job:${job.id}`), redis.hdel("jobsummaries", job.id)]);
    return;
  }
  fs.rmSync(localDir(job.id), { recursive: true, force: true });
}

// ------------------------------------------------------------------ users

function readLocalUsers(): User[] {
  return fs.existsSync(USERS_FILE) ? (JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) as User[]) : [];
}
function writeLocalUsers(users: User[]) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 1));
}

export async function listUsers(): Promise<User[]> {
  if (redis) return Object.values((await redis.hgetall<Record<string, User>>("users")) ?? {});
  return readLocalUsers();
}

export async function getUser(id: string): Promise<User | undefined> {
  if (redis) return (await redis.hget<User>("users", id)) ?? undefined;
  return readLocalUsers().find((u) => u.id === id);
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const e = email.trim().toLowerCase();
  if (redis) {
    const id = await redis.hget<string>("useremails", e);
    return id ? getUser(id) : undefined;
  }
  return readLocalUsers().find((u) => u.email === e);
}

export async function saveUser(user: User, previousEmail?: string): Promise<void> {
  if (redis) {
    if (previousEmail && previousEmail !== user.email) await redis.hdel("useremails", previousEmail);
    await Promise.all([redis.hset("users", { [user.id]: user }), redis.hset("useremails", { [user.email]: user.id })]);
    return;
  }
  const users = readLocalUsers().filter((u) => u.id !== user.id);
  users.push(user);
  writeLocalUsers(users);
}

export async function removeUser(user: User): Promise<void> {
  if (redis) {
    await Promise.all([redis.hdel("users", user.id), redis.hdel("useremails", user.email)]);
    return;
  }
  writeLocalUsers(readLocalUsers().filter((u) => u.id !== user.id));
}

// ------------------------------------------------------------------ login throttling

const localFails = new Map<string, { n: number; until: number }>();

/** Returns the number of recent failures (after recording this one, if `record`). */
export async function loginFailures(email: string, record: boolean): Promise<number> {
  const key = `loginfail:${email.toLowerCase()}`;
  if (redis) {
    if (!record) return Number((await redis.get<number>(key)) ?? 0);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 15 * 60);
    return n;
  }
  const cur = localFails.get(key);
  const live = cur && cur.until > Date.now() ? cur : { n: 0, until: Date.now() + 15 * 60_000 };
  if (record) live.n++;
  localFails.set(key, live);
  return live.n;
}

export async function clearLoginFailures(email: string) {
  const key = `loginfail:${email.toLowerCase()}`;
  if (redis) await redis.del(key);
  else localFails.delete(key);
}

// ------------------------------------------------------------------ session secret

/** Signing key for session cookies: SESSION_SECRET, else a stable fallback. */
export function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.BLOB_READ_WRITE_TOKEN) return `derived:${process.env.BLOB_READ_WRITE_TOKEN}`;
  const f = path.join(path.dirname(DATA_DIR), ".session-secret");
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(f, "utf8");
}

export async function progress(job: Job, stage: string, message: string, pct?: number) {
  const ev: ProgressEvent = { at: Date.now(), stage, message, pct };
  job.events.push(ev);
  await saveJob(job);
}

// ------------------------------------------------------------------ step lock (one worker per job)

const localLocks = new Map<string, number>();

export async function acquireLock(id: string, ms: number): Promise<boolean> {
  if (redis) return (await redis.set(`lock:${id}`, Date.now(), { nx: true, px: ms })) === "OK";
  const until = localLocks.get(id) ?? 0;
  if (until > Date.now()) return false;
  localLocks.set(id, Date.now() + ms);
  return true;
}

export async function releaseLock(id: string) {
  if (redis) await redis.del(`lock:${id}`);
  else localLocks.delete(id);
}

// ------------------------------------------------------------------ files

export async function putFile(job: Job, name: string, data: Uint8Array, contentType = "application/pdf") {
  job.files ??= {};
  if (CLOUD) {
    const res = await put(`jobs/${job.id}/${name}`, Buffer.from(data), {
      access: "private",
      addRandomSuffix: true, // new URL per version → never a stale CDN copy
      contentType,
    });
    job.files[name] = res.url;
    return;
  }
  fs.mkdirSync(localDir(job.id), { recursive: true });
  fs.writeFileSync(localPath(job, name), data);
  job.files[name] = "local";
}

const localPath = (job: Job, name: string) => path.join(localDir(job.id), name);

export const hasFile = (job: Job, name: string) =>
  !!job.files?.[name] || (!CLOUD && fs.existsSync(localPath(job, name)));

export async function readFile(job: Job, name: string): Promise<Uint8Array> {
  const ref = job.files?.[name];
  if (ref && ref !== "local") return readBlob(ref);
  if (!CLOUD && fs.existsSync(localPath(job, name))) return new Uint8Array(fs.readFileSync(localPath(job, name)));
  throw new Error(`${name} has not been generated yet.`);
}

export async function readBlob(url: string): Promise<Uint8Array> {
  const res = await get(url, { access: "private" });
  if (!res || res.statusCode !== 200 || !res.stream) throw new Error("File not found in blob storage.");
  return new Uint8Array(await new Response(res.stream).arrayBuffer());
}

/** Short-lived direct link for large downloads (serverless responses are capped at 4.5 MB). */
export async function signedDownloadUrl(job: Job, name: string): Promise<string | null> {
  const ref = job.files?.[name];
  if (!ref || ref === "local") return null;
  try {
    const pathname = new URL(ref).pathname.slice(1);
    const validUntil = Date.now() + 10 * 60 * 1000;
    const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: "get", pathname, access: "private", validUntil });
    return presignedUrl;
  } catch (e) {
    console.warn("presign failed, falling back to proxying", e);
    return null;
  }
}
