// Admin dashboard: overview, user management, all modules. Loaded on demand by app.js.
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

let ctx = null;
let bound = false;
const money = (n) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(n >= 100 ? 0 : 2)}`);
const num = (n) => Number(n || 0).toLocaleString();
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

export function show(tab, c) {
  ctx = c;
  if (!bound) bind();
  $$("#admin-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  for (const t of ["overview", "users", "modules"]) $(`#admin-${t}`).hidden = t !== tab;
  ({ overview, users, modules })[tab]?.();
}

function bind() {
  bound = true;
  $("#admin-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) location.hash = `#admin/${b.dataset.tab}`;
  });
  $("#user-form").addEventListener("submit", saveUserForm);
  $("#reset-form").addEventListener("submit", submitReset);
  $("#info-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#info-creds").textContent);
      $("#info-copy").textContent = "Copied ✓";
    } catch {
      getSelection().selectAllChildren($("#info-creds"));
    }
  });
}

/** Show sign-in details once, with a copy button, so the admin can pass them on. */
function showCredentials(title, email, password, note) {
  $("#info-title").textContent = title;
  $("#info-sub").textContent = note;
  $("#info-creds").textContent = `Sign-in: ${location.origin}\nEmail: ${email}\nTemporary password: ${password}`;
  $("#info-copy").textContent = "Copy";
  $("#dlg-info").showModal();
}

const loading = (el) => (el.innerHTML = `<div class="card"><p class="empty">Loading…</p></div>`);
const fail = (el, e) => (el.innerHTML = `<div class="card"><p class="empty">${ctx.esc(e.message)}</p></div>`);

// ------------------------------------------------------------------ overview
async function overview() {
  const el = $("#admin-overview");
  loading(el);
  let d;
  try { d = await ctx.api("/api/admin/overview"); } catch (e) { return fail(el, e); }
  $("#admin-sub").textContent = `Model ${d.model} · costs are estimates from token counts`;
  const { esc } = ctx;
  const maxDay = Math.max(1, ...d.days.map((x) => x.modules));
  const cats = Object.entries(d.errors.categories).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...cats.map((c) => c[1]));
  const split = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li><span>${esc(k)}</span><b>${v}</b></li>`).join("") || `<li class="muted">No data yet</li>`;

  el.innerHTML = `
    <div class="stats kpis">
      <div class="stat lead"><b>${num(d.users.active)}</b><span>Active users <small>/ ${d.users.total}</small></span></div>
      <div class="stat"><b>${num(d.modules.total)}</b><span>Modules</span></div>
      <div class="stat"><b>${num(d.modules.pages)}</b><span>Pages reviewed</span></div>
      <div class="stat crit"><b>${num(d.errors.total)}</b><span>Errors found <small>(${d.errors.critical} critical)</small></span></div>
      <div class="stat"><b>${money(d.usage.month.costUsd)}</b><span>API spend this month</span></div>
      <div class="stat"><b>${money(d.usage.costUsd)}</b><span>All-time · ${tok(d.usage.input + d.usage.output)} tokens</span></div>
    </div>

    <div class="grid2">
      <section class="card">
        <h3>Modules per day <span class="muted">last 14 days</span></h3>
        <div class="bars">${d.days.map((x) => `
          <div class="bar-col" title="${x.day}: ${x.modules} module(s), ${x.pages} page(s)">
            <span class="bar-val">${x.modules || ""}</span>
            <div class="bar-fill" style="height:${(x.modules / maxDay) * 100}%"></div>
            <span class="bar-lbl">${x.day.slice(8)}</span>
          </div>`).join("")}
        </div>
      </section>
      <section class="card">
        <h3>Errors by category</h3>
        ${cats.length ? `<ul class="hbars">${cats.map(([c, n]) => `
          <li><span>${esc(c.replace(/-/g, " "))}</span><div><i style="width:${(n / maxCat) * 100}%"></i></div><b>${n}</b></li>`).join("")}</ul>`
          : `<p class="empty">No errors recorded yet.</p>`}
        <div class="sev-split">
          <span class="pill critical">${d.errors.critical} critical</span>
          <span class="pill major">${d.errors.major} major</span>
          <span class="pill minor">${d.errors.minor} minor</span>
          <span class="pill">${d.errors.rejected} rejected by verifier</span>
        </div>
      </section>
    </div>

    <div class="grid3">
      <section class="card"><h3>By exam</h3><ul class="kv">${split(d.modules.exams)}</ul></section>
      <section class="card"><h3>By subject</h3><ul class="kv">${split(d.modules.subjects)}</ul></section>
      <section class="card"><h3>Status &amp; verdicts</h3><ul class="kv">${split(d.modules.phases)}${Object.entries(d.modules.verdicts).map(([k, v]) => `<li><span>verdict: ${esc(k)}</span><b>${v}</b></li>`).join("")}</ul></section>
    </div>

    <div class="grid2">
      <section class="card">
        <h3>Top users by spend</h3>
        ${d.topUsers.length ? `<table class="table compact"><thead><tr><th>User</th><th class="num">Modules</th><th class="num">Pages</th><th class="num">Spend</th></tr></thead><tbody>
          ${d.topUsers.map((u) => `<tr><td>${esc(u.name)}<br><small class="muted">${esc(u.email)}</small></td><td class="num">${u.modules}</td><td class="num">${u.pages}</td><td class="num">${money(u.costUsd)}</td></tr>`).join("")}
        </tbody></table>` : `<p class="empty">No users yet.</p>`}
      </section>
      <section class="card">
        <h3>Running now <span class="muted">${d.running.length}</span></h3>
        ${d.running.length ? `<ul class="kv">${d.running.map((j) => `<li><a href="#job=${j.id}">${esc(j.fileName)}</a><small class="muted">${esc(j.ownerEmail)}</small></li>`).join("")}</ul>`
          : `<p class="empty">Nothing running.</p>`}
        <p class="muted small">Users active in the last 7 days: <b>${d.users.activeLast7d}</b> · Admins: <b>${d.users.admins}</b></p>
      </section>
    </div>`;
}

// ------------------------------------------------------------------ users
async function users() {
  const el = $("#admin-users");
  loading(el);
  let list;
  try { ({ users: list } = await ctx.api("/api/admin/users")); } catch (e) { return fail(el, e); }
  const { esc, when } = ctx;
  const meId = ctx.me().id;
  $("#admin-sub").textContent = `${list.length} account${list.length === 1 ? "" : "s"}`;
  el.innerHTML = `
    <section class="card">
      <div class="card-head">
        <div><h2>Users</h2><p class="sub">Add people, set roles and quotas, disable access or reset passwords.</p></div>
        <button class="primary" id="add-user">+ Add user</button>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>User</th><th>Role</th><th>Status</th><th class="num">Quota / month</th><th class="num">Modules</th><th class="num">Spend</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${list.map((u) => {
          const self = u.id === meId;
          const q = u.monthlyPageQuota ? `${u.pagesThisMonth} / ${u.monthlyPageQuota}` : `${u.pagesThisMonth} / ∞`;
          return `<tr data-id="${u.id}" class="${u.status === "disabled" ? "off" : ""}">
            <td><b>${esc(u.name)}</b>${self ? ` <span class="pill">you</span>` : ""}<br><small class="muted">${esc(u.email)}</small>${u.mustChangePassword ? `<br><small class="warn-text">must change password</small>` : ""}</td>
            <td><select data-f="role" ${self ? "disabled" : ""}><option value="user" ${u.role === "user" ? "selected" : ""}>User</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option></select></td>
            <td><label class="switch" title="${u.status === "active" ? "Active: can sign in" : "Disabled: cannot sign in"}"><input type="checkbox" data-f="status" ${u.status === "active" ? "checked" : ""} ${self ? "disabled" : ""}/><span></span><em>${u.status === "active" ? "Active" : "Disabled"}</em></label></td>
            <td class="num">${q} <small class="muted">pages</small></td>
            <td class="num">${u.modules}<br><small class="muted">${u.errorsFound} errors</small></td>
            <td class="num">${money(u.costUsd)}</td>
            <td><small>${when(u.lastLoginAt)}</small></td>
            <td class="actions">
              <button class="link" data-a="edit">Edit</button>
              <button class="link" data-a="pw">Reset password</button>
              ${self ? "" : `<button class="link danger" data-a="del">Delete</button>`}
            </td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </section>`;

  $("#add-user").addEventListener("click", () => openUserForm(null));
  for (const tr of $$("tbody tr[data-id]", el)) {
    const u = list.find((x) => x.id === tr.dataset.id);
    $("[data-f=role]", tr).addEventListener("change", (e) => patchUser(u, { role: e.target.value }));
    $("[data-f=status]", tr).addEventListener("change", (e) => patchUser(u, { status: e.target.checked ? "active" : "disabled" }));
    $("[data-a=edit]", tr).addEventListener("click", () => openUserForm(u));
    $("[data-a=pw]", tr).addEventListener("click", () => resetPassword(u));
    $("[data-a=del]", tr)?.addEventListener("click", () => deleteUser(u));
  }
}

async function patchUser(u, body) {
  try { await ctx.api(`/api/admin/users/${u.id}`, { method: "PATCH", json: body }); } catch (e) { alert(e.message); }
  users();
}

let editing = null;
function openUserForm(u) {
  editing = u;
  const f = $("#user-form");
  f.reset();
  $(".form-error", f).hidden = true;
  $("#user-form-title").textContent = u ? `Edit ${u.name}` : "Add user";
  $("#user-pw-wrap").hidden = !!u;
  f.password.required = !u;
  if (u) {
    f.name.value = u.name;
    f.email.value = u.email;
    f.role.value = u.role;
    f.monthlyPageQuota.value = u.monthlyPageQuota;
    f.role.disabled = u.id === ctx.me().id;
  } else {
    f.role.disabled = false;
    f.password.value = suggestPassword();
  }
  $("#dlg-user").showModal();
}

function suggestPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = crypto.getRandomValues(new Uint32Array(12));
  return [...a].map((x) => chars[x % chars.length]).join("");
}

async function saveUserForm(e) {
  e.preventDefault();
  const f = e.target;
  const err = $(".form-error", f);
  const body = { name: f.name.value, email: f.email.value, role: f.role.value, monthlyPageQuota: Number(f.monthlyPageQuota.value) || 0 };
  try {
    if (editing) {
      if (editing.id === ctx.me().id) delete body.role;
      await ctx.api(`/api/admin/users/${editing.id}`, { method: "PATCH", json: body });
    } else {
      const pw = f.password.value;
      await ctx.api("/api/admin/users", { method: "POST", json: { ...body, password: pw } });
      $("#dlg-user").close();
      showCredentials("Account created", body.email.trim().toLowerCase(), pw, `Send these details to ${body.name || body.email}. They'll choose their own password at first sign-in. This password isn't shown again.`);
      return users();
    }
    $("#dlg-user").close();
    users();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
}

let resetting = null;
function resetPassword(u) {
  resetting = u;
  const f = $("#reset-form");
  f.reset();
  $(".form-error", f).hidden = true;
  $("#reset-title").textContent = `Reset password for ${u.name}`;
  f.password.value = suggestPassword();
  $("#dlg-reset").showModal();
}

async function submitReset(e) {
  e.preventDefault();
  const f = e.target;
  const pw = f.password.value;
  try {
    await ctx.api(`/api/admin/users/${resetting.id}/password`, { method: "POST", json: { password: pw } });
    $("#dlg-reset").close();
    showCredentials("Password reset", resetting.email, pw, `${resetting.name} has been signed out everywhere. Send them this temporary password.`);
    users();
  } catch (ex) {
    $(".form-error", f).textContent = ex.message;
    $(".form-error", f).hidden = false;
  }
}

async function deleteUser(u) {
  if (!confirm(`Delete the account ${u.email}? They will no longer be able to sign in.`)) return;
  const alsoModules = u.modules > 0 && confirm(`Also delete their ${u.modules} module(s) and generated PDFs?\n\nOK = delete modules too · Cancel = keep modules (visible to admins)`);
  try {
    await ctx.api(`/api/admin/users/${u.id}${alsoModules ? "?deleteModules=1" : ""}`, { method: "DELETE" });
    users();
  } catch (e) { alert(e.message); }
}

// ------------------------------------------------------------------ all modules
async function modules() {
  const el = $("#admin-modules");
  loading(el);
  let jobs;
  try { ({ jobs } = await ctx.api("/api/admin/jobs")); } catch (e) { return fail(el, e); }
  const { esc, when, phasePill } = ctx;
  $("#admin-sub").textContent = `${jobs.length} module${jobs.length === 1 ? "" : "s"} across all users`;
  el.innerHTML = `
    <section class="card">
      <div class="card-head">
        <div><h2>All modules</h2><p class="sub">Every module uploaded by any user. Open one to see its full error log.</p></div>
        <input type="search" id="am-q" placeholder="Search file, user, subject…" />
      </div>
      <div class="table-wrap"><table class="table" id="am-table"></table></div>
    </section>`;
  const render = () => {
    const q = $("#am-q").value.toLowerCase();
    const rows = jobs.filter((j) => !q || `${j.fileName} ${j.ownerEmail} ${j.context.exam} ${j.context.subject} ${j.context.learner}`.toLowerCase().includes(q));
    $("#am-table").innerHTML = rows.length
      ? `<thead><tr><th>Module</th><th>Owner</th><th>Exam · subject</th><th class="num">Pages</th><th>Status</th><th class="num">Errors</th><th class="num">Spend</th><th>Created</th><th></th></tr></thead><tbody>
        ${rows.map((j) => `<tr>
          <td><a class="strong" href="#job=${j.id}">${esc(j.fileName)}</a></td>
          <td><small>${esc(j.ownerEmail || "—")}</small></td>
          <td>${esc(j.context.exam)} · ${esc(j.context.subject)}<br><small class="muted">${esc(j.context.learner)}</small></td>
          <td class="num">${j.pageCount}</td>
          <td>${phasePill(j.phase, j.verdict)}</td>
          <td class="num">${j.errors.total}<br><small class="muted">${j.errors.critical}c · ${j.errors.major}M · ${j.errors.minor}m</small></td>
          <td class="num">${money(j.costUsd)}</td>
          <td><small>${when(j.createdAt)}</small></td>
          <td class="actions"><button class="link danger" data-del="${j.id}" ${j.phase === "analysing" || j.phase === "implementing" ? "disabled" : ""}>Delete</button></td>
        </tr>`).join("")}</tbody>`
      : `<tbody><tr><td class="empty">No modules${q ? " match" : " yet"}.</td></tr></tbody>`;
    $$("[data-del]", $("#am-table")).forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this module and all its files? This can't be undone.")) return;
      try {
        await ctx.api(`/api/jobs/${b.dataset.del}`, { method: "DELETE" });
        jobs = jobs.filter((j) => j.id !== b.dataset.del);
        render();
      } catch (e) { alert(e.message); }
    }));
  };
  $("#am-q").addEventListener("input", render);
  render();
}
