import crypto from "node:crypto";
import express from "express";
import {
  clearLoginFailures, getUser, getUserByEmail, listUsers, loginFailures, saveUser, sessionSecret,
} from "./storage.js";
import type { PublicUser, Role, User } from "./types.js";

const COOKIE = "mqa_session";
const SESSION_DAYS = 7;
const MAX_FAILS = 8;

// ------------------------------------------------------------------ passwords (scrypt)

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 200) return "Password is too long.";
  return null;
}

// ------------------------------------------------------------------ sessions (HMAC-signed cookie)

interface Session { uid: string; v: number; exp: number }

const sign = (data: string) => crypto.createHmac("sha256", sessionSecret()).update(data).digest("base64url");

function encodeSession(s: Session): string {
  const data = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${data}.${sign(data)}`;
}

function decodeSession(token: string | undefined): Session | null {
  if (!token) return null;
  const [data, mac] = token.split(".");
  if (!data || !mac) return null;
  const good = Buffer.from(sign(data));
  const given = Buffer.from(mac);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString()) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function readCookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function setSessionCookie(req: express.Request, res: express.Response, user: User) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" || !!process.env.VERCEL;
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeSession({ uid: user.id, v: user.sessionVersion, exp })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}

function clearSessionCookie(res: express.Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export const publicUser = ({ passwordHash: _p, sessionVersion: _v, ...u }: User): PublicUser => u;

// ------------------------------------------------------------------ bootstrap

/**
 * The first admin comes from ADMIN_EMAIL / ADMIN_PASSWORD (recommended, required on Vercel).
 * Locally, with no users at all, the login screen offers a one-time "create admin" form instead.
 */
let seeded = false;
async function ensureAdmin(): Promise<void> {
  if (seeded) return;
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password && !(await getUserByEmail(email))) {
    await saveUser(newUser({ email, name: "Administrator", role: "admin", password }));
  }
  seeded = true;
}

export async function setupAllowed(): Promise<boolean> {
  await ensureAdmin();
  if (process.env.VERCEL && !process.env.ALLOW_SETUP) return false; // never let the first internet visitor claim admin
  return (await listUsers()).length === 0;
}

export function newUser(o: { email: string; name: string; role: Role; password: string; quota?: number }): User {
  return {
    id: crypto.randomUUID(),
    email: o.email.trim().toLowerCase(),
    name: o.name.trim() || o.email,
    role: o.role,
    status: "active",
    passwordHash: hashPassword(o.password),
    sessionVersion: 1,
    monthlyPageQuota: o.quota ?? 0,
    createdAt: Date.now(),
  };
}

// ------------------------------------------------------------------ middleware

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

/** Attach req.user when a valid session cookie is present and the account is still active. */
export async function loadSession(req: express.Request, _res: express.Response, next: express.NextFunction) {
  try {
    await ensureAdmin();
    const s = decodeSession(readCookie(req, COOKIE));
    if (s) {
      const user = await getUser(s.uid);
      if (user && user.status === "active" && user.sessionVersion === s.v) req.user = user;
    }
    next();
  } catch (e) {
    next(e);
  }
}

const MUST_CHANGE = "Choose a new password before continuing.";

export function requireUser(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  if (req.user.mustChangePassword) return res.status(403).json({ error: MUST_CHANGE, mustChangePassword: true });
  next();
}

export function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  if (req.user.mustChangePassword) return res.status(403).json({ error: MUST_CHANGE, mustChangePassword: true });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admins only." });
  next();
}

// ------------------------------------------------------------------ routes

export const authRouter = express.Router();

authRouter.get("/me", async (req, res) => {
  if (req.user) return res.json({ user: publicUser(req.user), setup: false });
  const setup = await setupAllowed();
  // Deployed with no accounts and no ADMIN_EMAIL/ADMIN_PASSWORD: tell the operator what to set.
  const needsAdminEnv = !setup && !!process.env.VERCEL && (await listUsers()).length === 0;
  res.json({ user: null, setup, needsAdminEnv });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });
  if ((await loginFailures(email, false)) >= MAX_FAILS) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }
  const user = await getUserByEmail(email);
  const ok = user ? verifyPassword(password, user.passwordHash) : (hashPassword(password), false); // equalise timing
  if (!user || !ok) {
    await loginFailures(email, true);
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  if (user.status !== "active") return res.status(403).json({ error: "This account is disabled. Contact your administrator." });
  await clearLoginFailures(email);
  user.lastLoginAt = Date.now();
  await saveUser(user);
  setSessionCookie(req, res, user);
  res.json({ user: publicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** One-time local setup: create the first admin when no accounts exist. */
authRouter.post("/setup", async (req, res) => {
  if (!(await setupAllowed())) return res.status(403).json({ error: "Setup is closed." });
  const { email, name, password } = req.body as Record<string, string>;
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const user = newUser({ email, name: name || "Administrator", role: "admin", password });
  user.lastLoginAt = Date.now();
  await saveUser(user);
  setSessionCookie(req, res, user);
  res.json({ user: publicUser(user) });
});

authRouter.post("/password", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  const { current, next } = req.body as { current?: string; next?: string };
  const user = req.user!;
  if (!current || !verifyPassword(current, user.passwordHash)) return res.status(400).json({ error: "Current password is incorrect." });
  const pwErr = passwordProblem(next);
  if (pwErr) return res.status(400).json({ error: pwErr });
  user.passwordHash = hashPassword(next!);
  user.sessionVersion++; // sign out other devices
  user.mustChangePassword = false;
  await saveUser(user);
  setSessionCookie(req, res, user);
  res.json({ user: publicUser(user) });
});
