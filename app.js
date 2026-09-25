const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const SUBJECTS = {
  "JEE Main": ["Physics", "Chemistry", "Mathematics"],
  "JEE Advanced": ["Physics", "Chemistry", "Mathematics"],
  "NEET-UG": ["Physics", "Chemistry", "Biology", "Botany", "Zoology"],
};
const AGENT_NAME = { concept: "Subject expert", solver: "Independent solver", language: "Copy editor", syllabus: "Syllabus auditor" };
const REVIEW_AGENTS = [
  ["Subject expert", "Theory, formulas, facts"],
  ["Independent solver", "Questions & answer keys"],
  ["Copy editor", "Language & typography"],
  ["Syllabus auditor", "Scope & consistency"],
  ["Chief verifier", "Validates every finding", "lead"],
];
const IMPLEMENT_AGENTS = [
  ["Typesetter", "Fixes into original pages"],
  ["Second reviewer", "Checks corrected pages"],
  ["Repair", "Moves flagged fixes"],
  ["Assembler", "Corrigendum & markers"],
  ["Final validation", "Verdict & report", "lead"],
];

let job = null;
let file = null;
let config = { storage: "local" };
let driving = false;
let view = "topic";
let setupOpen = false;

const val = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
const busy = () => job && (job.phase === "analysing" || job.phase === "implementing");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtK = (n) => (n > 9999 ? `${Math.round(n / 1000)}k` : String(n));

// ------------------------------------------------------------------ setup
fetch("/api/config").then((r) => r.json()).then((c) => {
  config = c;
  const warn = c.storageProblem || (!c.hasKey && "The server has no ANTHROPIC_API_KEY. You can upload, but analysis will not run until the key is set.");
  $("#key-warning").textContent = warn || "";
  $("#key-warning").dataset.ok = warn ? "" : "1";
  $("#key-warning").hidden = !warn || !me;
}).catch(() => {});

function renderSubjects(selected) {
  const list = SUBJECTS[val("exam")] || [];
  $("#subject").innerHTML = list.length
    ? list.map((s) => `<label><input type="radio" name="subject" value="${s}" ${s === selected ? "checked" : ""}/><span>${s}</span></label>`).join("")
    : `<span class="placeholder">Choose an exam first</span>`;
}

$("#exam").addEventListener("change", () => { renderSubjects(val("subject")); refreshSetup(); });
$("#learner").addEventListener("change", refreshSetup);
$("#subject").addEventListener("change", refreshSetup);

const drop = $("#drop");
$("#file").addEventListener("change", (e) => pickFile(e.target.files[0]));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); pickFile(e.dataTransfer.files[0]); });

function pickFile(f) {
  if (!f) return;
  if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) return alert("Please choose a PDF file.");
  if (busy()) return;
  file = f;
  if (job && job.fileName !== f.name) job = null;
  drop.classList.add("has-file");
  $("#drop-title").textContent = f.name;
  $("#drop-sub").textContent = `${(f.size / 1048576).toFixed(1)} MB · click to replace`;
  refreshSetup();
}

function refreshSetup() {
  const have = file || job;
  const missing = [!have && "a PDF", !val("exam") && "exam", !val("learner") && "class", !val("subject") && "subject"].filter(Boolean);
  const ready = !missing.length;
  $("#analyse").disabled = !ready || busy();
  $("#setup-hint").textContent = busy()
    ? "Review in progress…"
    : ready
      ? "4 specialist agents review every page, then a chief verifier checks each finding."
      : `Still needed: ${missing.join(", ")}`;
  if (!job || job.phase === "uploaded") setStep(ready ? "analyse" : have ? "configure" : "upload");
}

$("#analyse").addEventListener("click", async () => {
  $("#analyse").disabled = true;
  try {
    const ctx = { exam: val("exam"), learner: val("learner"), subject: val("subject") };
    if (file && (!job || job.fileName !== file.name)) {
      job = await uploadModule(file, ctx);
      history.replaceState(null, "", `#job=${job.id}`);
      workspaceKey = job.id;
    } else if (job) {
      job = await api(`/api/jobs/${job.id}`, { method: "PATCH", json: ctx });
    }
    job = await api(`/api/jobs/${job.id}/analyse`, { method: "POST" });
    render();
    drive();
    setTimeout(() => $("#progress").scrollIntoView({ block: "start" }), 150);
  } catch (e) {
    alert(e.message);
    refreshSetup();
  }
});

// ------------------------------------------------------------------ server
async function api(url, { method = "GET", json, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: json ? { "Content-Type": "application/json" } : undefined,
    body: json ? JSON.stringify(json) : body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    showAuth(false); // session expired or account disabled
    throw new Error("Please sign in again.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Local: multipart to the server. Cloud: straight from the browser into private Blob storage. */
async function uploadModule(f, ctx) {
  const hint = $("#setup-hint");
  if (config.storage !== "cloud") {
    const fd = new FormData();
    fd.append("file", f);
    Object.entries(ctx).forEach(([k, v]) => fd.append(k, v));
    hint.textContent = "Uploading…";
    return api("/api/jobs", { method: "POST", body: fd });
  }
  const { upload } = await import("./vendor/blob-upload.js");
  const blob = await upload(`uploads/${f.name.replace(/[^\w.\- ]/g, "_")}`, f, {
    access: "private",
    handleUploadUrl: "/api/blob-upload",
    contentType: "application/pdf",
    multipart: f.size > 8 * 1024 * 1024,
    onUploadProgress: ({ percentage }) => (hint.textContent = `Uploading… ${Math.round(percentage)}%`),
  });
  hint.textContent = "Reading PDF…";
  return api("/api/jobs", { method: "POST", json: { blobUrl: blob.url, fileName: f.name, ...ctx } });
}

/**
 * Work runs in short server steps (serverless time limits), driven from this tab.
 * A second poller keeps the progress display fresh while a long step is in flight.
 */
async function drive() {
  if (driving || !job) return;
  driving = true;
  const id = job.id;
  const poll = setInterval(async () => {
    try {
      const fresh = await api(`/api/jobs/${id}`);
      if (driving && fresh.events.length >= job.events.length) { job = fresh; render(); }
    } catch { /* transient */ }
  }, 4000);
  try {
    let networkErrors = 0;
    while (busy() && job.id === id) {
      const res = await fetch(`/api/jobs/${id}/step`, { method: "POST" }).catch(() => null);
      const data = res ? await res.json().catch(() => null) : null;
      if (res?.ok && data) {
        job = data;
        networkErrors = 0;
        render();
      } else if (res?.status === 409 && data?.job) {
        job = data.job; // another tab or a previous request is running this step
        render();
        await sleep(5000);
      } else {
        // Timeout (504) or network blip: the server records attempts and skips a unit that keeps failing.
        if (++networkErrors > 20) throw new Error("Lost contact with the server. Reload the page to resume.");
        await sleep(Math.min(3000 * networkErrors, 15000));
        job = await api(`/api/jobs/${id}`).catch(() => job);
      }
    }
  } catch (e) {
    alert(e.message);
  } finally {
    clearInterval(poll);
    driving = false;
    render();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
addEventListener("beforeunload", (e) => {
  if (busy()) { e.preventDefault(); e.returnValue = ""; }
});

// ------------------------------------------------------------------ render
function setStep(active) {
  const order = ["upload", "configure", "analyse", "review", "implement", "final"];
  const ai = order.indexOf(active);
  $$("#stepper li").forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.className = i < ai || (active === "final" && job?.phase === "implemented") ? "done" : i === ai ? "active" : "";
  });
}

function renderSetupSummary() {
  const collapsed = !!job && job.phase !== "uploaded" && !setupOpen;
  $("#setup").classList.toggle("collapsed", collapsed);
  $("#summary").hidden = !collapsed;
  $("#setup-grid").hidden = collapsed;
  if (!collapsed) return;
  $("#sum-name").textContent = job.fileName;
  $("#sum-meta").textContent = `${job.pageCount} page${job.pageCount > 1 ? "s" : ""} · ${job.context.exam} · ${job.context.learner} · ${job.context.subject}`;
  $("#sum-edit").disabled = busy();
}
$("#sum-edit").addEventListener("click", () => { setupOpen = true; renderSetupSummary(); });

function render() {
  if (!job) return;
  const running = busy();
  if (running) setupOpen = false;
  $$("#setup input").forEach((el) => (el.disabled = running));
  refreshSetup();
  renderSetupSummary();

  renderProgress(running);

  const hasResults = ["analysed", "implementing", "implemented"].includes(job.phase) || (job.phase === "failed" && job.errors.length);
  $("#results").hidden = !hasResults;
  $("#dock").hidden = !hasResults || job.phase === "implementing";
  if (hasResults) renderResults();

  $("#final").hidden = job.phase !== "implemented";
  if (job.phase === "implemented") renderFinal();

  if (job.phase === "analysing") setStep("analyse");
  else if (job.phase === "implementing") setStep("implement");
  else if (job.phase === "analysed") setStep("review");
  else if (job.phase === "implemented") setStep("final");
}

function renderProgress(running) {
  const implementMode = job.phase === "implementing" || job.phase === "implemented" ||
    (job.phase === "failed" && job.events.some((e) => e.stage === "patch"));
  $("#progress").hidden = !(running || job.phase === "failed" || job.events.length);
  $("#progress").classList.toggle("running", running);
  $("#progress-title").textContent = implementMode ? "Implementation & second review" : "Multi-agent review";

  const lastPct = [...job.events].reverse().find((e) => typeof e.pct === "number");
  const pct = lastPct ? lastPct.pct : 0;
  $("#bar-fill").style.width = `${pct}%`;
  $("#progress-pct").textContent = job.phase === "failed" ? "Failed" : `${pct}%`;
  $("#progress-pct").style.color = job.phase === "failed" ? "var(--crit)" : "";
  const latest = job.events[job.events.length - 1];
  const usage = job.usage.input ? ` · ${fmtK(job.usage.input)} in / ${fmtK(job.usage.output)} out tokens` : "";
  $("#progress-status").textContent = (running ? latest?.message ?? "Starting…" : job.phase === "failed" ? "Stopped with an error" : "Complete") + usage +
    (running ? " · Keep this tab open; closing it pauses the run (reopen the link to resume)." : "");

  // Agent cards
  const roster = implementMode ? IMPLEMENT_AGENTS : REVIEW_AGENTS;
  const msgs = job.events.map((e) => e.message);
  const stageSeen = (s) => job.events.some((e) => e.stage === s);
  $("#agents").innerHTML = roster.map(([name, desc, extra], i) => {
    let state = "";
    if (implementMode) {
      const stages = ["patch", "second-review", "repair", "assemble", "done"];
      const failedHere = name === "Second reviewer" && msgs.some((m) => m.startsWith("Second review failed"));
      if (failedHere) state = "error";
      else if (job.phase === "implemented") state = "done";
      else if (stageSeen(stages[i])) state = stages.slice(i + 1).some(stageSeen) ? "done" : "working";
    } else {
      const label = name === "Chief verifier" ? "Verifier" : name;
      const failed = msgs.some((m) => m.startsWith(`${label} failed`));
      if (failed) state = "error";
      else if (job.phase === "analysed" || job.phase === "implemented") state = "done";
      else if (running) state = "working";
    }
    return `<div class="agent ${extra ?? ""} ${state}"><i></i><b>${name}</b><small>${desc}</small></div>`;
  }).join("");

  $("#log").innerHTML = job.events.slice().reverse().map((e) =>
    `<li class="${/\bfailed\b|errored|WARNING/.test(e.message) ? "bad" : ""}"><time>${new Date(e.at).toLocaleTimeString()}</time><span>${esc(e.message)}</span></li>`,
  ).join("");
  let fail = $("#progress .failbox");
  if (job.phase === "failed") {
    if (!fail) { fail = document.createElement("div"); fail.className = "failbox"; $("#bar-fill").parentElement.after(fail); }
    fail.textContent = friendlyError(job.errorMessage);
  } else fail?.remove();
}

function friendlyError(msg = "Failed") {
  if (/credit balance is too low/i.test(msg)) return "The Anthropic account has no API credit. Add credits under Plans & Billing in the Anthropic Console, then click Analyse again.";
  if (/anthropic-workspace-id/i.test(msg)) return "This API key needs a workspace. Start the server with ANTHROPIC_WORKSPACE_ID set.";
  if (/API key is invalid|authentication/i.test(msg)) return "The Anthropic API key was rejected. Check the key the server was started with.";
  if (/rate limit|429|overloaded|529/i.test(msg)) return "The API is busy or rate-limited. Wait a minute and try again.";
  if (/restarted/i.test(msg)) return msg;
  return msg;
}

function renderResults() {
  const valid = job.errors.filter((e) => e.status !== "rejected");
  const rejected = job.errors.filter((e) => e.status === "rejected");
  const n = (s) => valid.filter((e) => e.severity === s).length;
  $("#results-sub").textContent = `${job.fileName} · ${job.pageCount} page${job.pageCount > 1 ? "s" : ""} · ${job.context.exam} · ${job.context.learner} · ${job.context.subject}`;
  $("#incomplete").hidden = !job.incompletePages?.length;
  $("#incomplete").textContent = job.incompletePages?.length
    ? `Pages ${job.incompletePages.join(", ")} were not fully reviewed because an agent call failed. Run Analyse again to cover them.`
    : "";
  $("#tiles").innerHTML = [
    ["lead", valid.length, "Validated errors"],
    ["crit", n("critical"), "Critical"],
    ["major", n("major"), "Major"],
    ["minor", n("minor"), "Minor"],
    ["", `${new Set(valid.map((e) => e.page)).size}<small style="font-size:14px;color:var(--muted);font-weight:500"> / ${job.pageCount}</small>`, "Pages affected"],
    ["", rejected.length, "Rejected by verifier"],
  ].map(([c, v, l]) => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`).join("");
  $("#dl-report").href = `/api/jobs/${job.id}/report.pdf`;

  const cats = [...new Set(job.errors.map((e) => e.category))].sort();
  const cur = $("#f-cat").value;
  $("#f-cat").innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option ${c === cur ? "selected" : ""}>${c}</option>`).join("");

  const acc = valid.filter((e) => e.accepted).length;
  $("#accepted-count").textContent = `${acc} of ${valid.length} correction${valid.length === 1 ? "" : "s"} selected`;
  $("#implement").disabled = busy() || !acc;
  $("#implement").textContent = job.phase === "implemented" ? "Re-implement errors" : "Implement all errors";
  $("#accept-all").disabled = $("#accept-none").disabled = busy();

  renderGroups();
}

function renderGroups() {
  const sev = $("#f-sev").value;
  const cat = $("#f-cat").value;
  const q = $("#f-q").value.toLowerCase();
  let list = job.errors.filter((e) => (view === "rejected" ? e.status === "rejected" : e.status !== "rejected"));
  if (view === "question") list = list.filter((e) => e.question);
  list = list.filter((e) => (!sev || e.severity === sev) && (!cat || e.category === cat) &&
    (!q || `${e.original} ${e.corrected} ${e.explanation} ${e.id}`.toLowerCase().includes(q)));

  const keyOf = {
    topic: (e) => [e.chapter, e.topic].filter(Boolean).join(" › ") || "Unlabelled",
    chapter: (e) => e.chapter || "Unlabelled",
    page: (e) => `Page ${e.page}`,
    question: (e) => `${e.question} · page ${e.page}`,
    rejected: (e) => `Page ${e.page}`,
  }[view];
  const groups = new Map();
  for (const e of list.sort((a, b) => a.page - b.page)) {
    const k = keyOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const box = $("#groups");
  box.innerHTML = "";
  if (!list.length) {
    const msg = !job.errors.length ? "No errors found in this module."
      : view === "rejected" ? "The verifier did not reject any findings."
      : view === "question" ? "No errors inside questions."
      : "Nothing matches these filters.";
    box.innerHTML = `<p class="empty">${msg}</p>`;
    return;
  }
  for (const [k, es] of groups) {
    const g = document.createElement("div");
    g.className = "group";
    g.innerHTML = `<h3>${esc(k)} <span>${es.length} error${es.length > 1 ? "s" : ""}</span></h3>`;
    es.forEach((e) => g.appendChild(card(e)));
    box.appendChild(g);
  }
}

/** Word-level diff so the exact change stands out. */
function diffHtml(a, b) {
  const A = a.split(/(\s+)/).filter(Boolean);
  const B = b.split(/(\s+)/).filter(Boolean);
  const m = A.length, n = B.length;
  if (m * n > 250000) return [esc(a), esc(b)];
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, left = "", right = "";
  while (i < m || j < n) {
    if (i < m && j < n && A[i] === B[j]) { left += esc(A[i]); right += esc(B[j]); i++; j++; }
    else if (j < n && (i === m || L[i][j + 1] >= L[i + 1][j])) { right += /^\s+$/.test(B[j]) ? B[j] : `<ins>${esc(B[j])}</ins>`; j++; }
    else { left += /^\s+$/.test(A[i]) ? A[i] : `<del>${esc(A[i])}</del>`; i++; }
  }
  return [left, right];
}

function card(e) {
  const el = $("#tpl-error").content.firstElementChild.cloneNode(true);
  el.classList.add(e.severity);
  el.classList.toggle("off", e.status !== "rejected" && !e.accepted);
  const cb = el.querySelector("input");
  cb.checked = e.accepted;
  cb.disabled = e.status === "rejected" || busy();
  cb.addEventListener("change", () => patchError(e, { accepted: cb.checked }));
  el.querySelector(".eid").textContent = e.id;
  const sev = el.querySelector(".sev");
  sev.textContent = e.severity;
  sev.classList.add(e.severity);
  el.querySelector(".cat").textContent = e.category.replace(/-/g, " ");
  el.querySelector(".loc").textContent = `Page ${e.page}${e.question ? " · " + e.question : ""}`;
  el.querySelector(".by").textContent = AGENT_NAME[e.agent] || e.agent;
  const ap = el.querySelector(".applied");
  if (e.applied) {
    const label = { patched: "Typeset in place", corrigendum: "In corrigendum", failed: "Not applied" }[e.applied];
    ap.textContent = e.secondReview === "issue" ? `${label} · flagged` : e.secondReview === "confirmed" ? `${label} · verified` : label;
    ap.classList.add(e.secondReview === "issue" ? "issue" : e.applied);
  } else ap.remove();

  const [l, r] = diffHtml(e.original, e.corrected);
  el.querySelector(".orig").innerHTML = l;
  const corr = el.querySelector(".corr");
  corr.innerHTML = r;
  const editable = e.status !== "rejected" && !busy();
  corr.contentEditable = String(editable);
  if (!editable) el.querySelector(".lbl em").remove();
  corr.addEventListener("focus", () => (corr.textContent = e.corrected));
  corr.addEventListener("blur", () => {
    const v = corr.textContent;
    if (v !== e.corrected) patchError(e, { corrected: v });
    else corr.innerHTML = diffHtml(e.original, e.corrected)[1];
  });
  el.querySelector(".why").textContent = e.explanation;
  el.querySelector(".vnote").textContent = e.verifierNote ? `Verifier: ${e.verifierNote}` : "";
  el.querySelector(".rnote").textContent = [e.applyNote, e.secondReviewNote && `Second review: ${e.secondReviewNote}`].filter(Boolean).join(" · ");
  el.querySelector(".view").addEventListener("click", () => openViewer(e.page, e.applied ? "final" : "original"));
  return el;
}

async function patchError(e, body) {
  try {
    Object.assign(e, await api(`/api/jobs/${job.id}/errors/${e.id}`, { method: "PATCH", json: body }));
    renderResults();
  } catch (err) {
    alert(err.message);
  }
}

$("#views").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  view = b.dataset.view;
  $$("#views button").forEach((x) => x.classList.toggle("on", x === b));
  renderGroups();
});
["#f-sev", "#f-cat"].forEach((s) => $(s).addEventListener("change", renderGroups));
$("#f-q").addEventListener("input", renderGroups);
$("#accept-all").addEventListener("click", () => bulk(true));
$("#accept-none").addEventListener("click", () => bulk(false));
async function bulk(accepted) {
  await api(`/api/jobs/${job.id}/errors/bulk`, { method: "POST", json: { accepted } });
  job.errors.forEach((e) => { if (e.status !== "rejected") e.accepted = accepted; });
  renderResults();
}

$("#implement").addEventListener("click", async () => {
  const acc = job.errors.filter((e) => e.accepted && e.status !== "rejected").length;
  if (!confirm(`Typeset ${acc} correction${acc === 1 ? "" : "s"} into the module and run the second review?`)) return;
  try {
    job = await api(`/api/jobs/${job.id}/implement`, { method: "POST" });
    render();
    drive();
    setTimeout(() => $("#progress").scrollIntoView({ block: "start" }), 150);
  } catch (e) {
    alert(e.message);
  }
});

function renderFinal() {
  const v = job.validation;
  if (!v) return;
  $("#dl-final").href = `/api/jobs/${job.id}/final.pdf`;
  $("#dl-report-2").href = `/api/jobs/${job.id}/report.pdf`;
  const meta = {
    pass: ["✓", "Final validation passed"],
    "pass-with-notes": ["!", "Passed with notes"],
    fail: ["×", "Needs editor attention"],
  }[v.verdict];
  $("#verdict").innerHTML = `<div class="verdict ${v.verdict}"><span class="icon">${meta[0]}</span><div><h2>${meta[1]}</h2><p>${esc(v.summary)}</p></div></div>`;
  $("#final-tiles").innerHTML = [
    ["lead", v.totalAccepted, "Corrections applied"],
    ["ok", v.patched, "Typeset in place"],
    [v.corrigendum ? "major" : "", v.corrigendum, "In corrigendum"],
    ["ok", v.confirmed, "Verified by 2nd review"],
    [v.issues ? "crit" : "", v.issues, "Flagged by 2nd review"],
    [v.failed ? "crit" : "", v.failed, "Failed"],
  ].map(([c, n, l]) => `<div class="stat ${c}"><b>${n}</b><span>${l}</span></div>`).join("");
  $("#new-issues").innerHTML = v.newIssues.length
    ? `<h3>Layout notes from the second review</h3><ul>${v.newIssues.map((i) => `<li>Page ${i.page}: ${esc(i.description)} <button class="link" data-page="${i.page}">View</button></li>`).join("")}</ul>`
    : "";
  $$("#new-issues button").forEach((b) => b.addEventListener("click", () => openViewer(Number(b.dataset.page), "final")));
}

// ------------------------------------------------------------------ page viewer
let viewerPage = 1;
function openViewer(page, which) {
  viewerPage = page;
  $("#viewer-tabs [data-which=final]").disabled = job.phase !== "implemented";
  showViewer(job.phase === "implemented" ? which : "original");
  $("#viewer").showModal();
}
function showViewer(which) {
  $("#viewer-title").textContent = `Page ${viewerPage}`;
  $$("#viewer-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.which === which));
  const img = $("#viewer-img");
  $("#viewer-spin").hidden = false;
  img.style.opacity = ".25";
  img.onload = () => { $("#viewer-spin").hidden = true; img.style.opacity = "1"; };
  img.src = `/api/jobs/${job.id}/page/${which}/${viewerPage}.png?t=${Date.now()}`;
}
$("#viewer-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && !b.disabled) showViewer(b.dataset.which);
});
$("#viewer-close").addEventListener("click", () => $("#viewer").close());
$("#viewer").addEventListener("click", (e) => { if (e.target === $("#viewer")) $("#viewer").close(); });

// ------------------------------------------------------------------ restore
function check(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
  if (el) el.checked = true;
}

async function restoreWorkspace() {
  const id = new URLSearchParams(location.hash.slice(1)).get("job");
  if (!id) return refreshSetup();
  try {
    job = await api(`/api/jobs/${id}`);
    check("exam", job.context.exam);
    check("learner", job.context.learner);
    renderSubjects(job.context.subject);
    drop.classList.add("has-file");
    $("#drop-title").textContent = job.fileName;
    $("#drop-sub").textContent = `${job.pageCount} page${job.pageCount > 1 ? "s" : ""} · uploaded`;
    render();
    if (busy()) drive(); // resume a run that was interrupted (closed tab, reload)
  } catch {
    history.replaceState(null, "", "#new");
    refreshSetup();
  }
}

// ------------------------------------------------------------------ auth + routing
let me = null;
let workspaceKey = null; // which workspace state is loaded ("new" or a job id)

function showOnly(id) {
  for (const v of ["view-auth", "view-workspace", "view-modules", "view-admin"]) $(`#${v}`).hidden = v !== id;
  $("#nav").hidden = $("#usermenu").hidden = id === "view-auth";
  $$("#nav a").forEach((a) => a.classList.toggle("on", `view-${a.dataset.nav}` === id));
  $("#key-warning").hidden = id === "view-auth" || !$("#key-warning").textContent.trim() || $("#key-warning").dataset.ok === "1";
}

function route() {
  if (!me) return;
  const h = location.hash;
  if (h.startsWith("#admin")) {
    if (me.role !== "admin") { location.hash = "#new"; return; }
    showOnly("view-admin");
    return loadAdmin(h.split("/")[1] || "overview");
  }
  if (h === "#modules") {
    showOnly("view-modules");
    return loadMyModules();
  }
  const id = new URLSearchParams(h.slice(1)).get("job");
  const key = id || "new";
  if (workspaceKey !== null && workspaceKey !== key && !(job && job.id === id)) {
    location.reload(); // fresh workspace state for a different module
    return;
  }
  showOnly("view-workspace");
  if (workspaceKey === null) {
    workspaceKey = key;
    restoreWorkspace();
  } else if (job && !id) {
    history.replaceState(null, "", `#job=${job.id}`);
  }
}
addEventListener("hashchange", route);

function setMe(user) {
  me = user;
  $("#me-name").textContent = user.name;
  $("#me-role").textContent = user.role === "admin" ? "Administrator" : "Member";
  $("#me-email").textContent = user.email;
  $("#me-avatar").textContent = (user.name || user.email).trim().slice(0, 1).toUpperCase();
  $("#nav-admin").hidden = user.role !== "admin";
}

let setupMode = false;
function showAuth(setup) {
  me = null;
  setupMode = !!setup;
  showOnly("view-auth");
  $("#auth-title").textContent = setup ? "Create the admin account" : "Sign in";
  $("#auth-sub").textContent = setup
    ? "No accounts exist yet. This first account becomes the administrator."
    : "Use the account your administrator created for you.";
  $("#f-name-wrap").hidden = !setup;
  $("#auth-submit").textContent = setup ? "Create admin account" : "Sign in";
  $("#f-password").autocomplete = setup ? "new-password" : "current-password";
  $("#auth-error").hidden = true;
  setTimeout(() => $(setup ? "#f-name" : "#f-email").focus(), 50);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#auth-error");
  err.hidden = true;
  $("#auth-submit").disabled = true;
  try {
    const body = { email: $("#f-email").value, password: $("#f-password").value, name: $("#f-name").value };
    const res = await fetch(setupMode ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Sign-in failed.");
    $("#f-password").value = "";
    startApp(data.user);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $("#auth-submit").disabled = false;
  }
});

function startApp(user) {
  setMe(user);
  if (!location.hash || location.hash === "#") history.replaceState(null, "", "#new");
  route();
  if (user.mustChangePassword) openPasswordDialog(true);
}

// user menu
$("#me-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#me-menu").hidden = !$("#me-menu").hidden; });
addEventListener("click", () => ($("#me-menu").hidden = true));
$("#me-logout").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.href = location.pathname;
});
$("#me-password").addEventListener("click", () => openPasswordDialog(false));

function openPasswordDialog(forced) {
  const dlg = $("#dlg-password");
  const f = $("#password-form");
  f.reset();
  f.querySelector(".form-error").hidden = true;
  $("#pw-sub").textContent = forced ? "Your administrator set a temporary password. Choose your own to continue." : "";
  $("#pw-cancel").hidden = forced;
  dlg.dataset.forced = forced ? "1" : "";
  dlg.showModal();
}
$("#dlg-password").addEventListener("cancel", (e) => { if ($("#dlg-password").dataset.forced) e.preventDefault(); });
$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const errEl = f.querySelector(".form-error");
  try {
    const data = await api("/api/auth/password", { method: "POST", json: { current: f.current.value, next: f.next.value } });
    const wasForced = $("#dlg-password").dataset.forced;
    setMe(data.user);
    $("#dlg-password").close();
    if (wasForced) route(); // data requests were blocked until now
  } catch (ex) {
    errEl.textContent = ex.message;
    errEl.hidden = false;
  }
});
document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// ------------------------------------------------------------------ my modules
const PHASE_LABEL = {
  uploaded: "Uploaded", analysing: "Analysing…", analysed: "Reviewed", implementing: "Implementing…", implemented: "Corrected", failed: "Failed",
};
export const phasePill = (p, verdict) => {
  const cls = p === "failed" ? "issue" : p === "implemented" ? (verdict === "fail" ? "corrigendum" : "patched") : p === "analysed" ? "" : "running";
  return `<span class="pill ${cls}">${PHASE_LABEL[p] ?? p}</span>`;
};
export const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

async function loadMyModules() {
  const box = $("#modules-table");
  box.innerHTML = `<tbody><tr><td class="empty">Loading…</td></tr></tbody>`;
  try {
    const { jobs, quota, pagesThisMonth } = await api("/api/jobs");
    $("#modules-sub").textContent = `${jobs.length} module${jobs.length === 1 ? "" : "s"}`;
    const q = $("#my-quota");
    q.hidden = !quota;
    if (quota) {
      const pct = Math.min(100, Math.round((pagesThisMonth / quota) * 100));
      q.innerHTML = `<div class="quota-row"><span>Monthly quota</span><b>${pagesThisMonth} / ${quota} pages</b></div><div class="bar"><div style="width:${pct}%"></div></div>`;
    }
    box.innerHTML = jobs.length
      ? `<thead><tr><th>Module</th><th>Exam · subject</th><th class="num">Pages</th><th>Status</th><th class="num">Errors</th><th>Created</th><th></th></tr></thead><tbody>${jobs.map((j) => `
        <tr>
          <td><a href="#job=${j.id}" class="strong">${esc(j.fileName)}</a></td>
          <td>${esc(j.context.exam)} · ${esc(j.context.subject)}<br><small class="muted">${esc(j.context.learner)}</small></td>
          <td class="num">${j.pageCount}</td>
          <td>${phasePill(j.phase, j.verdict)}</td>
          <td class="num">${j.errors.total ? `${j.errors.total} <small class="muted">(${j.errors.critical} crit)</small>` : "—"}</td>
          <td><small>${when(j.createdAt)}</small></td>
          <td class="actions"><button class="link danger" data-del="${j.id}" ${j.phase === "analysing" || j.phase === "implementing" ? "disabled" : ""}>Delete</button></td>
        </tr>`).join("")}</tbody>`
      : `<tbody><tr><td class="empty">No modules yet. <a href="#new">Upload your first module →</a></td></tr></tbody>`;
    box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this module, its reports and the corrected PDF? This can't be undone.")) return;
      try { await api(`/api/jobs/${b.dataset.del}`, { method: "DELETE" }); loadMyModules(); } catch (ex) { alert(ex.message); }
    }));
  } catch (ex) {
    box.innerHTML = `<tbody><tr><td class="empty">${esc(ex.message)}</td></tr></tbody>`;
  }
}

// ------------------------------------------------------------------ admin (lazy-loaded)
let adminMod = null;
async function loadAdmin(tab) {
  adminMod ??= await import("./admin.js");
  adminMod.show(tab, { api, esc, when, phasePill, me: () => me });
}

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    const { user, setup, needsAdminEnv } = await (await fetch("/api/auth/me")).json();
    if (user) startApp(user);
    else showAuth(setup);
    $("#auth-hint").textContent = needsAdminEnv
      ? "No accounts exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in the Vercel project's environment variables, then redeploy."
      : "";
  } catch {
    showAuth(false);
  }
})();
