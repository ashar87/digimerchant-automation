// The task board: New / In progress / Done, one tap to move a task along.
import { html, select } from '../html.js';
import { text, required, date } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { enc, poOptions } from './common.js';
import { versionField, assertFresh } from '../versions.js';
import { today, shortDate } from '../../util/time.js';
import { config } from '../../config.js';
import { STATUSES, PEOPLE, PRIORITIES, DONE_DAYS, statusLabel, listTasks, getTask, saveTask, deleteTask, nextTaskRef, taskHistory, tasksForPo } from '../../tasks/board.js';

const FILTERS = ['assignee', 'source', 'overdue', 'q'];

const isOverdue = (t, day = today()) => t.status !== 'done' && t.due && t.due < day;

/** Same-site path to return to after a move; anything else falls back to the board. */
function safeBack(v, fallback = '/tasks') {
  const s = String(v || '');
  return /^\/(?![/\\])/.test(s) ? s : fallback;
}

function withParams(path, params) {
  const u = new URL(path, 'http://x');
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return u.pathname + u.search;
}

function readFilters(url) {
  const p = url.searchParams;
  return {
    assignee: PEOPLE.includes(p.get('assignee')) ? p.get('assignee') : '',
    source: ['whatsapp', 'manual'].includes(p.get('source')) ? p.get('source') : '',
    overdue: p.get('overdue') === '1' ? '1' : '',
    q: (p.get('q') || '').trim(),
  };
}

function matches(t, f, day) {
  if (f.assignee && t.assignee !== f.assignee) return false;
  if (f.source && (t.source || 'manual') !== f.source) return false;
  if (f.overdue && !isOverdue(t, day)) return false;
  if (f.q) {
    const hay = [t.ref, t.title, t.notes, t.po, t.sourceChat].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const byUrgency = (day) => (a, b) =>
  Number(isOverdue(b, day)) - Number(isOverdue(a, day)) ||
  (a.due || '9999').localeCompare(b.due || '9999') ||
  (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
  (b.createdAt || '').localeCompare(a.createdAt || '');

function moveButtons(t, back) {
  const btn = (status, label, cls = '') => html`<button name="status" value="${status}"${cls ? html` class="${cls}"` : ''}>${label}</button>`;
  return html`<form class="inline t-move" method="post" action="/tasks/${enc(t.ref)}/move">${versionField(t)}<input type="hidden" name="back" value="${back}">${
    t.status === 'new' ? html`${btn('in_progress', 'Start')} ${btn('done', 'Done', 'ghost')}` : t.status === 'in_progress' ? btn('done', 'Mark done') : btn('new', 'Reopen', 'ghost')
  }</form>`;
}

function taskMeta(t, day) {
  const bits = [];
  if (t.assignee) bits.push(html`<span>${t.assignee}</span>`);
  if (t.due) bits.push(isOverdue(t, day) ? html`<span class="badge bad">Overdue · ${shortDate(t.due)}</span>` : html`<span>Due ${shortDate(t.due)}</span>`);
  if (t.priority === 'high') bits.push(html`<span class="badge warn">High</span>`);
  if (t.po) bits.push(html`<a href="/orders/${enc(t.po)}">${t.po}</a>`);
  if (t.source === 'whatsapp') bits.push(html`<span>WhatsApp</span>`);
  return html`<div class="t-meta small muted">${bits.map((b, i) => html`${i ? ' · ' : ''}${b}`)}</div>`;
}

function taskCard(t, back, day) {
  return html`<li class="task"><div><a class="t-title" href="/tasks/${enc(t.ref)}">${t.title}</a> <span class="muted small">${t.ref}</span></div>
${taskMeta(t, day)}${moveButtons(t, back)}</li>`;
}

export function boardPage(ctx) {
  const day = today();
  const f = readFilters(ctx.url);
  const older = ctx.url.searchParams.get('older') === '1';
  const col = STATUSES.some((s) => s.value === ctx.url.searchParams.get('col')) ? ctx.url.searchParams.get('col') : 'new';
  const back = ctx.url.pathname + ctx.url.search;
  const all = listTasks(ctx.db);
  const shown = all.filter((t) => matches(t, f, day));
  const filtered = FILTERS.some((k) => f[k]);
  const cutoff = new Date(Date.now() - DONE_DAYS * 864e5).toISOString();

  const columns = STATUSES.map((s) => {
    let tasks = shown.filter((t) => t.status === s.value);
    let hidden = 0;
    if (s.value === 'done') {
      tasks.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
      if (!older) {
        const recent = tasks.filter((t) => (t.doneAt || '') >= cutoff);
        hidden = tasks.length - recent.length;
        tasks = recent;
      }
    } else tasks.sort(byUrgency(day));
    return { ...s, tasks, hidden };
  });

  const body = html`
<h1>Tasks</h1>
<p class="sub">From WhatsApp once approved, or added here. Done tasks stay on the board for ${DONE_DAYS} days.</p>
<p><a class="button" href="/tasks/new">Add a task</a></p>
<details class="filters-box"${filtered ? html` open` : ''}><summary>${filtered ? 'Filters (on)' : 'Filter or search'}</summary>
<form class="filters card" method="get" action="/tasks">
  <div><label for="f-assignee">Assigned to</label>${select('assignee', [{ value: '', label: 'Anyone' }, ...PEOPLE], f.assignee, { attrs: 'id="f-assignee"' })}</div>
  <div><label for="f-source">From</label>${select('source', [{ value: '', label: 'Anywhere' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'manual', label: 'Added here' }], f.source, { attrs: 'id="f-source"' })}</div>
  <div><label for="f-q">Search</label><input id="f-q" name="q" value="${f.q}" type="search"></div>
  <label class="check"><input type="checkbox" name="overdue" value="1"${f.overdue ? html` checked` : ''}> Overdue only</label>
  <input type="hidden" name="col" value="${col}">
  <button class="ghost">Filter</button>${filtered ? html` <a href="/tasks?col=${col}">Clear</a>` : ''}
</form></details>
${filtered ? html`<p class="muted small">Showing ${shown.length} of ${all.length} tasks.</p>` : ''}
<nav class="seg" aria-label="Task status">${columns.map(
    (c) => html`<a href="${withParams(back, { col: c.value })}"${c.value === col ? html` class="on" aria-current="true"` : ''}>${c.label} <span class="muted">${c.tasks.length}</span></a>`
  )}</nav>
<div class="board">${columns.map(
    (c) => html`<section class="col${c.value === col ? ' sel' : ''}" aria-labelledby="col-${c.value}">
<h2 id="col-${c.value}">${c.label} <span class="muted small">${c.tasks.length}</span></h2>
${c.tasks.length ? html`<ul class="tasks">${c.tasks.map((t) => taskCard(t, back, day))}</ul>` : html`<p class="muted small">Nothing here.</p>`}
${c.hidden ? html`<p class="small"><a href="${withParams(back, { older: '1', col: 'done' })}">Show older (${c.hidden})</a></p>` : ''}
${c.value === 'done' && older ? html`<p class="small"><a href="${withParams(back, { older: '' })}">Hide older</a></p>` : ''}
</section>`
  )}</div>`;
  return { title: 'Tasks', body };
}

function taskForm(ctx, t, { po } = {}) {
  const ledger = ctx.data.ledger;
  const assignee = t?.assignee || (PEOPLE.includes(ctx.actor) ? ctx.actor : PEOPLE[0]);
  return html`<form class="card" method="post" action="/tasks${t ? `/${enc(t.ref)}` : ''}">${t ? versionField(t) : ''}
<label for="t-title">Task (required)</label><input id="t-title" name="title" value="${t?.title || ''}" required maxlength="300" style="width:100%">
<div class="grid" style="margin-top:10px">
  <div><label for="t-assignee">Assigned to</label>${select('assignee', PEOPLE, assignee, { attrs: 'id="t-assignee"' })}</div>
  <div><label for="t-status">Status</label>${select('status', STATUSES, t?.status || 'new', { attrs: 'id="t-status"' })}</div>
  <div><label for="t-due">Due</label><input id="t-due" type="date" name="due" value="${t?.due || ''}"></div>
  <div><label for="t-priority">Priority</label>${select('priority', [{ value: '', label: 'None' }, ...PRIORITIES], t?.priority || '', { attrs: 'id="t-priority"' })}</div>
  <div><label for="t-po">Linked PO</label>${select('po', [{ value: '', label: 'None' }, ...poOptions(ledger)], t?.po || po || '', { attrs: 'id="t-po"' })}</div>
</div>
<label for="t-notes">Notes</label><textarea id="t-notes" name="notes" rows="4" style="width:100%">${t?.notes || ''}</textarea>
<p><button>${t ? 'Save task' : 'Add task'}</button> <a href="/tasks">Cancel</a></p></form>`;
}

export function newTaskPage(ctx) {
  const po = ctx.url.searchParams.get('po');
  return { title: 'New task', body: html`<p class="muted small"><a href="/tasks">Tasks</a></p><h1>New task</h1>${taskForm(ctx, null, { po })}` };
}

const FIELDS = [
  ['title', 'Task'],
  ['status', 'Status', statusLabel],
  ['assignee', 'Assigned to'],
  ['due', 'Due', (d) => (d ? shortDate(d) : 'none')],
  ['priority', 'Priority'],
  ['po', 'PO'],
];

const when = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function historyList(db, ref) {
  const trail = taskHistory(db, ref);
  const lines = trail.map((a, i) => {
    if (a.action === 'create' || i === 0) return { ...a, what: a.task?.source === 'whatsapp' ? 'Added from WhatsApp' : 'Added' };
    const prev = trail[i - 1].task || {};
    const changes = FIELDS.filter(([k]) => (prev[k] ?? null) !== (a.task?.[k] ?? null)).map(([k, label, fmt]) => `${label}: ${fmt ? fmt(prev[k]) : prev[k] || 'none'} → ${fmt ? fmt(a.task?.[k]) : a.task?.[k] || 'none'}`);
    if ((prev.notes ?? null) !== (a.task?.notes ?? null)) changes.push('Notes changed');
    return { ...a, what: changes.join('; ') || 'Saved, nothing changed' };
  });
  if (!lines.length) return '';
  return html`<h2>History</h2><ul class="small">${lines.reverse().map((l) => html`<li>${when(l.at)} · ${l.actor} · ${l.what}</li>`)}</ul>`;
}

function findTask(ctx) {
  const t = getTask(ctx.db, ctx.params[0]);
  if (!t) throw notFound(`Task ${ctx.params[0]}`);
  return t;
}

export function taskPage(ctx) {
  const t = findTask(ctx);
  const source =
    t.source === 'whatsapp'
      ? html`<div class="card small"><b>From WhatsApp</b>${t.sourceChat ? html` · ${t.sourceChat}` : ''}${t.sourceQuote ? html`<blockquote class="muted">“${t.sourceQuote}”</blockquote>` : ''}</div>`
      : '';
  return {
    title: `${t.ref} · ${t.title}`,
    body: html`<p class="muted small"><a href="/tasks">Tasks</a></p><h1>${t.title} <span class="muted small">${t.ref}</span></h1>
${source}${taskForm(ctx, t)}${historyList(ctx.db, t.ref)}
<p><a class="danger-link" href="/tasks/${enc(t.ref)}/delete">Delete this task…</a></p>`,
  };
}

function fromForm(ctx) {
  const f = ctx.form;
  const title = required(text(f, 'title'), 'Task');
  if (title.length > 300) throw new HttpError(400, 'Keep the task under 300 characters; put detail in the notes.');
  const assignee = text(f, 'assignee');
  if (!PEOPLE.includes(assignee)) throw new HttpError(400, `Assign the task to ${PEOPLE.join(' or ')}.`);
  const status = text(f, 'status') || 'new';
  if (!STATUSES.some((s) => s.value === status)) throw new HttpError(400, `Unknown status "${status}"`);
  const priority = text(f, 'priority');
  if (priority && !PRIORITIES.includes(priority)) throw new HttpError(400, `Priority must be ${PRIORITIES.join(', ')} or blank`);
  const po = text(f, 'po');
  if (po && !ctx.data.ledger.orders.some((o) => o.po === po)) throw new HttpError(400, `There's no order ${po}`);
  return { title, assignee, status, due: date(f.get('due'), 'Due'), priority, po, notes: text(f, 'notes') };
}

export function saveTaskForm(ctx) {
  if (!ctx.params[0]) {
    const task = saveTask(ctx.db, { ...fromForm(ctx), ref: nextTaskRef(ctx.db), source: 'manual' }, { actor: ctx.actor });
    return { redirect: `/tasks?ok=${enc(`${task.ref} added.`)}` };
  }
  const existing = findTask(ctx);
  assertFresh(ctx, 'task', existing.ref, existing, `/tasks/${enc(existing.ref)}`);
  saveTask(ctx.db, { ...existing, ...fromForm(ctx) }, { actor: ctx.actor, action: 'edit' });
  return { redirect: `/tasks/${enc(existing.ref)}?ok=${enc('Saved.')}` };
}

export function moveTask(ctx) {
  const t = findTask(ctx);
  const back = safeBack(ctx.form.get('back'));
  assertFresh(ctx, 'task', t.ref, t, back);
  const status = ctx.form.get('status');
  if (!STATUSES.some((s) => s.value === status)) throw new HttpError(400, `Unknown status "${status}"`);
  saveTask(ctx.db, { ...t, status }, { actor: ctx.actor, action: 'move' });
  return { redirect: withParams(back, { ok: `${t.ref} moved to ${statusLabel(status)}.` }) };
}

export function deleteTaskPage(ctx) {
  const t = findTask(ctx);
  return {
    title: `Delete ${t.ref}?`,
    body: html`<h1>Delete ${t.ref}?</h1><p>“${t.title}” will be removed from the board. Its history stays in the audit log.</p>
<form method="post" action="/tasks/${enc(t.ref)}/delete">${versionField(t)}<button class="danger">Delete task</button> <a href="/tasks/${enc(t.ref)}">Keep it</a></form>`,
  };
}

export function deleteTaskForm(ctx) {
  const t = findTask(ctx);
  assertFresh(ctx, 'task', t.ref, t, `/tasks/${enc(t.ref)}`);
  deleteTask(ctx.db, t.ref, { actor: ctx.actor });
  return { redirect: `/tasks?ok=${enc(`${t.ref} deleted.`)}` };
}

/** "Tasks for this PO", on the order page. */
export function poTasksSection(ctx, po) {
  const day = today();
  const tasks = tasksForPo(ctx.db, po);
  const back = `/orders/${enc(po)}`;
  return html`<h2>Tasks for this PO</h2>
${tasks.length ? html`<ul class="tasks">${tasks.map((t) => html`<li class="task"><div><a class="t-title" href="/tasks/${enc(t.ref)}">${t.title}</a> <span class="muted small">${t.ref}</span> <span class="badge${t.status === 'done' ? ' ok' : t.status === 'in_progress' ? ' wait' : ''}">${statusLabel(t.status)}</span></div>${taskMeta(t, day)}${moveButtons(t, back)}</li>`)}</ul>` : html`<p class="muted small">None yet.</p>`}
<p><a href="/tasks/new?po=${enc(po)}">Add a task for ${po}</a></p>`;
}

/** Inbox lines: overdue tasks need someone; new ones are worth a glance. */
export function inboxTaskItems(db) {
  const day = today();
  const open = listTasks(db).filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => isOverdue(t, day));
  const fresh = open.filter((t) => t.status === 'new');
  const items = [];
  if (overdue.length) items.push({ tone: 'error', title: `${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}: ${overdue.slice(0, 3).map((t) => `${t.ref} ${t.title}`).join('; ')}${overdue.length > 3 ? '…' : ''}`, href: '/tasks?overdue=1', count: true });
  if (fresh.length) items.push({ tone: 'info', title: `${fresh.length} new task${fresh.length === 1 ? '' : 's'} not started yet`, href: '/tasks?col=new', count: false });
  return items;
}
