# Module QA (JEE / NEET)

Staff sign in, upload a PDF study module, pick the exam, class and subject, and click **Analyse module**. Claude agents review every page and produce an error log (by topic, chapter, page and question) plus a downloadable error-report PDF. **Implement all errors** typesets the accepted fixes into the original PDF, keeping its design. An independent second reviewer then checks the corrected pages, final validation runs, and you download the corrected module.

---

## Deploy on Vercel

### 1. Put the code in a Git repo
Unzip, then push the folder to a new GitHub, GitLab or Bitbucket repository. Or deploy straight from the folder with the Vercel CLI (`npx vercel`).

### 2. Import the project
In Vercel, click **Add New → Project** and import the repository. The included `vercel.json` sets the build, so leave the framework preset on **Other** and don't change the build settings.

### 3. Connect storage (required)
Serverless functions keep no files between requests, so the app needs two stores. In the project, open the **Storage** tab and:

- **Create a Blob store** (Vercel Blob). This adds `BLOB_READ_WRITE_TOKEN`.
- **Add Upstash for Redis** from the Marketplace (the free plan is enough to start). This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

Connect both to **Production** and **Preview**.

### 4. Add environment variables
Under **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key |
| `ANTHROPIC_WORKSPACE_ID` | only if your key is not scoped to a workspace (`wrkspc_…`) |
| `ADMIN_EMAIL` | email for the first administrator account |
| `ADMIN_PASSWORD` | its initial password (8+ characters); change it after first sign-in |
| `SESSION_SECRET` | a long random string, e.g. output of `openssl rand -hex 32` |
| `CLAUDE_MODEL` | optional; default `claude-opus-5` |

### 5. Deploy
Redeploy after adding storage and variables, since environment changes need a new deployment. Open the site: the yellow banner at the top disappears once the key and storage are all detected.

### 6. Sign in and add your team
Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then open **Admin → Users → + Add user** for each person. You'll get a temporary password to send them; they must choose their own at first sign-in.

### Plan and time limits
- Each request does one small unit of work: map the structure, review 4 pages with the 4 agents, verify those findings, or second-review a group of corrected pages. `vercel.json` sets `maxDuration: 300`, which is the Hobby plan maximum.
- On **Pro** you can raise `maxDuration` to `800` for extra headroom. If a unit still times out, it is retried twice, then skipped, and its pages are reported as **not fully reviewed**. They are never silently passed.
- **The open browser tab drives the run.** Closing the tab pauses it; reopening the job link (the URL has `#job=…`) resumes it where it stopped.

### Privacy
- Everything requires sign-in. Users see only their own modules; admins see everyone's.
- Uploaded modules and generated PDFs are stored as **private** blobs. Downloads use short-lived signed links.
- Modules are kept until a user or admin deletes them.

---

## Accounts

| | User | Admin |
|---|---|---|
| Upload, analyse, implement, download | own modules | any module |
| **My modules** history | ✓ | ✓ |
| **Admin → Overview**: users, modules, pages, errors by category, API spend (month / all-time), activity chart, top users, running jobs | | ✓ |
| **Admin → Users**: add, edit name/email, change role, disable/enable, monthly page quota, reset password, delete (optionally with their modules) | | ✓ |
| **Admin → All modules**: search every module, open, delete | | ✓ |

How accounts are protected:
- **Passwords** are hashed with scrypt and never stored or shown in plain text. Temporary passwords set by an admin must be changed at first sign-in, and nothing else works until they are.
- **Sessions** are signed cookies (HttpOnly, SameSite=Lax, Secure on Vercel) lasting 7 days. Changing or resetting a password, or disabling an account, signs that user out everywhere.
- **Brute force:** 8 failed sign-ins lock that email out for 15 minutes.
- **Lockout protection:** you can't disable, demote or delete yourself, and the last active admin can't be removed.
- **Monthly page quota** (0 = unlimited) caps how many pages each user can send for analysis per calendar month. Use it to control API spend.

**The first admin:**
- On Vercel it comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, and it is created only if that email doesn't already exist. Changing the variable later won't reset an existing password; use another admin for that.
- Locally, if those variables aren't set and there are no accounts yet, the sign-in page offers a one-time **Create the admin account** form instead.

---

## Run locally

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_WORKSPACE_ID=wrkspc_...   # only if needed
npm start                                   # http://localhost:5173
```

Locally, accounts are stored in `data/users.json` and modules in `data/jobs/`; no cloud storage is needed. The first time you open the app you'll create the admin account. `npm run sample` writes a one-page test module with planted errors. `npm run selftest` checks the PDF typesetting offline, with no API calls.

---

## How it works

**Analyse**
1. MuPDF extracts each page's text with exact character positions, fonts and colours.
2. A structure mapper labels every page with its chapter, topic and question numbers.
3. For each chunk of pages, four specialist agents run in parallel. Each sees the rendered pages (equations and diagrams) plus the exact text:
   - **Subject expert**: theory, formulas, facts
   - **Independent solver**: re-solves every question and checks answer keys
   - **Copy editor**: language and typography
   - **Syllabus auditor**: current exam and class scope, consistency
4. A **chief verifier** re-checks every finding and rejects false positives and duplicates.
5. The error report PDF is built. Before implementing, you can untick findings or edit a correction.

**Implement all errors**
1. The old wrong text is redacted, so it is really removed from the page. The fix is typeset in its place with matching size, weight, style and colour. Backgrounds, images and diagrams are untouched.
2. Fixes that can't be placed faithfully go to an appended **Corrigendum** with `[C#]` margin markers. This covers equations drawn as images, figure labels, and replacements far longer than the original.
3. An independent **second reviewer** reads the corrected pages. Any patch it flags is moved to the corrigendum.
4. **Final validation** gives PASS, PASS WITH NOTES, or NEEDS EDITOR ATTENTION. If the second review couldn't run, it is never PASS.

## Project layout

```
api/index.ts        Vercel function entry (all /api/* routes)
src/app.ts          Express routes, shared by Vercel and local
src/auth.ts         Sign-in, sessions, password hashing, route guards
src/admin.ts        Admin dashboard + user management API
src/server.ts       Local server (npm start)
src/pipeline.ts     Resumable analyse / implement steps
src/prompts.ts      Agent instructions
src/storage.ts      Local disk  ↔  Upstash Redis + Vercel Blob
src/pdf/            Extraction, in-place patching, reports
public/             Web UI (served by Vercel's CDN); admin.js = dashboard
client/             Source of public/vendor/blob-upload.js (npm run build)
```

## Limits worth knowing
- **PDF input only.** Scanned pages are reviewed from images, but their fixes can only go to the corrigendum.
- **Fonts.** Replacement text uses the bundled DejaVu fonts, matched for style, not the module's own subset font.
- **Licence.** `mupdf` is AGPL-3.0. That's fine for internal use; offering the app to outside users requires complying with AGPL or buying a commercial MuPDF licence.
