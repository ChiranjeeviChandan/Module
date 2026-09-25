import express from "express";
import { hashPassword, newUser, passwordProblem, publicUser, requireAdmin } from "./auth.js";
import { MODEL } from "./claude.js";
import { deleteJob, getUser, getUserByEmail, listSummaries, listUsers, loadJob, removeUser, saveUser } from "./storage.js";
import type { JobSummary, Role, User } from "./types.js";

/** USD per million tokens (input, output) — for the dashboard's cost estimate only. */
const PRICING: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
  "claude-fable-5-1": [10, 50],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};
export function costUsd(usage: { input: number; output: number }): number {
  const [i, o] = PRICING[MODEL] ?? PRICING["claude-opus-5"];
  return (usage.input * i + usage.output * o) / 1_000_000;
}

export const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

/** Pages a user has sent for analysis this calendar month. */
export function pagesThisMonth(userId: string, jobs: JobSummary[]): number {
  const since = monthStart();
  return jobs.filter((j) => j.ownerId === userId && (j.lastAnalysedAt ?? 0) >= since).reduce((n, j) => n + j.pageCount, 0);
}

function userStats(u: User, jobs: JobSummary[]) {
  const mine = jobs.filter((j) => j.ownerId === u.id);
  const usage = mine.reduce((a, j) => ({ input: a.input + j.usage.input, output: a.output + j.usage.output }), { input: 0, output: 0 });
  return {
    ...publicUser(u),
    modules: mine.length,
    pages: mine.reduce((n, j) => n + j.pageCount, 0),
    pagesThisMonth: pagesThisMonth(u.id, jobs),
    errorsFound: mine.reduce((n, j) => n + j.errors.total, 0),
    usage,
    costUsd: costUsd(usage),
  };
}

export const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get("/overview", async (_req, res) => {
  const [jobs, users] = await Promise.all([listSummaries(), listUsers()]);
  const usage = jobs.reduce((a, j) => ({ input: a.input + j.usage.input, output: a.output + j.usage.output }), { input: 0, output: 0 });
  const phases: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const exams: Record<string, number> = {};
  const subjects: Record<string, number> = {};
  for (const j of jobs) {
    phases[j.phase] = (phases[j.phase] ?? 0) + 1;
    exams[j.context.exam] = (exams[j.context.exam] ?? 0) + 1;
    subjects[j.context.subject] = (subjects[j.context.subject] ?? 0) + 1;
    for (const [c, n] of Object.entries(j.categories)) categories[c] = (categories[c] ?? 0) + n;
  }
  // Modules created per day, last 14 days.
  const days: { day: string; modules: number; pages: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = d.getTime() + 86400_000;
    const inDay = jobs.filter((j) => j.createdAt >= d.getTime() && j.createdAt < next);
    days.push({ day: d.toISOString().slice(0, 10), modules: inDay.length, pages: inDay.reduce((n, j) => n + j.pageCount, 0) });
  }
  const since = monthStart();
  const monthJobs = jobs.filter((j) => j.createdAt >= since);
  const monthUsage = monthJobs.reduce((a, j) => ({ input: a.input + j.usage.input, output: a.output + j.usage.output }), { input: 0, output: 0 });

  res.json({
    model: MODEL,
    users: {
      total: users.length,
      active: users.filter((u) => u.status === "active").length,
      admins: users.filter((u) => u.role === "admin").length,
      activeLast7d: users.filter((u) => (u.lastLoginAt ?? 0) > Date.now() - 7 * 86400_000).length,
    },
    modules: {
      total: jobs.length,
      pages: jobs.reduce((n, j) => n + j.pageCount, 0),
      phases,
      exams,
      subjects,
      verdicts: jobs.reduce<Record<string, number>>((a, j) => (j.verdict ? { ...a, [j.verdict]: (a[j.verdict] ?? 0) + 1 } : a), {}),
    },
    errors: {
      total: jobs.reduce((n, j) => n + j.errors.total, 0),
      critical: jobs.reduce((n, j) => n + j.errors.critical, 0),
      major: jobs.reduce((n, j) => n + j.errors.major, 0),
      minor: jobs.reduce((n, j) => n + j.errors.minor, 0),
      rejected: jobs.reduce((n, j) => n + j.errors.rejected, 0),
      categories,
    },
    usage: { ...usage, costUsd: costUsd(usage), month: { ...monthUsage, costUsd: costUsd(monthUsage) } },
    days,
    topUsers: users.map((u) => userStats(u, jobs)).sort((a, b) => b.costUsd - a.costUsd).slice(0, 5),
    running: jobs.filter((j) => j.phase === "analysing" || j.phase === "implementing"),
  });
});

adminRouter.get("/jobs", async (_req, res) => {
  res.json({ jobs: (await listSummaries()).map((j) => ({ ...j, costUsd: costUsd(j.usage) })) });
});

adminRouter.get("/users", async (_req, res) => {
  const [jobs, users] = await Promise.all([listSummaries(), listUsers()]);
  res.json({ users: users.sort((a, b) => a.createdAt - b.createdAt).map((u) => userStats(u, jobs)) });
});

const ROLES: Role[] = ["admin", "user"];
const emailOk = (e: unknown): e is string => typeof e === "string" && /^\S+@\S+\.\S+$/.test(e.trim());

adminRouter.post("/users", async (req, res) => {
  const { email, name, role, password, monthlyPageQuota } = req.body as Record<string, unknown>;
  if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email." });
  if (!ROLES.includes(role as Role)) return res.status(400).json({ error: "Choose a role." });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (await getUserByEmail(email)) return res.status(409).json({ error: "An account with that email already exists." });
  const user = newUser({ email, name: String(name ?? ""), role: role as Role, password: password as string, quota: Math.max(0, Number(monthlyPageQuota) || 0) });
  user.mustChangePassword = true;
  await saveUser(user);
  res.json({ user: publicUser(user) });
});

/** Guard against locking everyone out: at least one active admin must remain. */
async function wouldRemoveLastAdmin(target: User, change: { role?: Role; status?: string; deleting?: boolean }) {
  if (target.role !== "admin" || target.status !== "active") return false;
  const losesAdmin = change.deleting || (change.role && change.role !== "admin") || (change.status && change.status !== "active");
  if (!losesAdmin) return false;
  const admins = (await listUsers()).filter((u) => u.role === "admin" && u.status === "active");
  return admins.length <= 1;
}

adminRouter.patch("/users/:id", async (req, res) => {
  const user = await getUser(String(req.params.id));
  if (!user) return res.status(404).json({ error: "User not found." });
  const { name, email, role, status, monthlyPageQuota } = req.body as Record<string, unknown>;
  if (role !== undefined && !ROLES.includes(role as Role)) return res.status(400).json({ error: "Invalid role." });
  if (status !== undefined && status !== "active" && status !== "disabled") return res.status(400).json({ error: "Invalid status." });
  if (user.id === req.user!.id && ((role && role !== "admin") || status === "disabled")) {
    return res.status(400).json({ error: "You can't remove your own admin access or disable yourself." });
  }
  if (await wouldRemoveLastAdmin(user, { role: role as Role | undefined, status: status as string | undefined })) {
    return res.status(400).json({ error: "At least one active admin must remain." });
  }
  const previousEmail = user.email;
  if (email !== undefined) {
    if (!emailOk(email)) return res.status(400).json({ error: "Enter a valid email." });
    const e = email.trim().toLowerCase();
    const other = await getUserByEmail(e);
    if (other && other.id !== user.id) return res.status(409).json({ error: "Another account uses that email." });
    user.email = e;
  }
  if (typeof name === "string") user.name = name.trim() || user.email;
  if (role) user.role = role as Role;
  if (status && status !== user.status) {
    user.status = status as User["status"];
    if (status === "disabled") user.sessionVersion++; // sign them out everywhere
  }
  if (monthlyPageQuota !== undefined) user.monthlyPageQuota = Math.max(0, Number(monthlyPageQuota) || 0);
  await saveUser(user, previousEmail);
  res.json({ user: publicUser(user) });
});

adminRouter.post("/users/:id/password", async (req, res) => {
  const user = await getUser(String(req.params.id));
  if (!user) return res.status(404).json({ error: "User not found." });
  const { password } = req.body as { password?: string };
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  user.passwordHash = hashPassword(password!);
  user.sessionVersion++;
  user.mustChangePassword = user.id !== req.user!.id;
  await saveUser(user);
  res.json({ ok: true });
});

adminRouter.delete("/users/:id", async (req, res) => {
  const user = await getUser(String(req.params.id));
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.id === req.user!.id) return res.status(400).json({ error: "You can't delete your own account." });
  if (await wouldRemoveLastAdmin(user, { deleting: true })) return res.status(400).json({ error: "At least one active admin must remain." });
  let deletedModules = 0;
  if (req.query.deleteModules === "1") {
    for (const s of (await listSummaries()).filter((j) => j.ownerId === user.id)) {
      const job = await loadJob(s.id);
      if (job) { await deleteJob(job); deletedModules++; }
    }
  }
  await removeUser(user);
  res.json({ ok: true, deletedModules });
});
