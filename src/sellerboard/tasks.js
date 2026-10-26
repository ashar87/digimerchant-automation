/**
 * Sellerboard has no automatic import, so batches are typed in by hand. This
 * keeps the list of what's to do:
 *
 *   add     Amazon has started receiving a shipment: add the batch.
 *   update  Ashar added it, the shipment has since closed, and its cost, units
 *           or date no longer match what he typed: change the batch.
 *   done    Sellerboard has what the dashboard has (or what it had when he
 *           added it, while Amazon is still counting).
 *
 * Each add or update sends a WhatsApp card; "Y #id" there, or Done on the
 * dashboard, marks it done with the figures the card or the page showed.
 * Shipments typed into Sellerboard by hand before this existed stay out.
 */
import { loadLedger } from '../landing/store.js';
import { computeLandingCosts } from '../landing/engine.js';
import { fmtRmb, D } from '../landing/money.js';
import { enqueue, recordReply, getCard } from '../notify/outbox.js';
import { config } from '../config.js';
import { ACCOUNTS, buildFeed } from './feed.js';

const sym = (currency) => (currency === 'USD' ? '$' : '£');
const n = (v) => fmtRmb(D(v));

/** What Sellerboard should hold for a batch: the three figures that matter there. */
const target = (r) => ({ date: r.startDate, units: Number(r.quantity), cost: r.cost });
const entered = (row) => ({ date: row.entered_date, units: row.entered_units, cost: row.entered_cost });
const same = (a, b) => a.date === b.date && a.units === b.units && a.cost === b.cost;

export function sellerboardCard({ state, sku, marketplace, shipment, account, currency, now, was = null, closed = false, link = config.dashboardUrl }) {
  const head = state === 'add'
    ? `📥 Add to Sellerboard (${ACCOUNTS[account].label} account)`
    : `✏️ Update Sellerboard (${ACCOUNTS[account].label} account)${closed ? `: ${shipment} closed` : ''}`;
  const lines = [head, `${sku} · ${marketplace} · ${shipment}`];
  if (state === 'add' || !was) {
    lines.push(`Batch date ${now.date} · ${n(now.units)} units · ${sym(currency)}${now.cost}`);
  } else {
    if (was.date !== now.date) lines.push(`Batch date ${was.date} → ${now.date}`);
    else lines.push(`Batch date ${now.date}`);
    if (was.cost !== now.cost) lines.push(`Cost ${sym(currency)}${was.cost} → ${sym(currency)}${now.cost}`);
    if (was.units !== now.units) lines.push(`Units ${n(was.units)} → ${n(now.units)}`);
  }
  if (link) lines.push(`${link.replace(/\/$/, '')}/sellerboard`);
  return lines.join('\n');
}

const parse = (row) => row && { ...row, target: { date: row.batch_date, units: row.units, cost: row.cost }, entered: row.entered_cost === null ? null : entered(row) };

export function sellerboardTasks(db) {
  return db.prepare('SELECT * FROM sellerboard_batches ORDER BY state, account, marketplace, sku, shipment').all().map(parse);
}

export function sellerboardTask(db, shipment, product) {
  return parse(db.prepare('SELECT * FROM sellerboard_batches WHERE shipment = ? AND product = ?').get(shipment, product));
}

function closeCard(db, cardId, reply, actor) {
  if (cardId && !getCard(db, cardId)?.reply) recordReply(db, cardId, reply, actor);
}

/**
 * Brings the list up to date with the landing costs and queues a card for each
 * new thing to do. Returns the number of cards queued.
 */
export function refreshSellerboardTasks(db, { ledger = loadLedger(db), result = computeLandingCosts(ledger), now = new Date(), link = config.dashboardUrl } = {}) {
  const rows = buildFeed(ledger, result, { catalog: null }).rows;
  const at = now.toISOString();
  const insert = db.prepare(`INSERT INTO sellerboard_batches (shipment, product, account, marketplace, sku, batch_date, units, cost, state, updated_at)
    VALUES (@shipment, @product, @account, @marketplace, @sku, @date, @units, @cost, 'add', @at)`);
  const setTarget = db.prepare('UPDATE sellerboard_batches SET account = @account, marketplace = @marketplace, sku = @sku, batch_date = @date, units = @units, cost = @cost, updated_at = @at WHERE shipment = @shipment AND product = @product');
  const setState = db.prepare('UPDATE sellerboard_batches SET state = ?, card_id = ?, updated_at = ? WHERE shipment = ? AND product = ?');
  const card = (r, state, was) =>
    enqueue(db, {
      kind: 'sellerboard',
      needsReply: true,
      dedupeKey: `sellerboard:${state}:${r.shipment}:${r.product}:${r.startDate}:${r.quantity}:${r.cost}`,
      text: sellerboardCard({ state, sku: r.sku, marketplace: r.marketplace, shipment: r.shipment, account: r.account, currency: r.currency, now: target(r), was, closed: r.closed, link }),
      payload: { action: 'sellerboard', state, shipment: r.shipment, product: r.product, ...target(r) },
    });
  let queued = 0;

  db.transaction(() => {
    const seen = new Set();
    for (const r of rows) {
      seen.add(`${r.shipment}|${r.product}`);
      const values = { ...target(r), shipment: r.shipment, product: r.product, account: r.account, marketplace: r.marketplace, sku: r.sku, at };
      const row = sellerboardTask(db, r.shipment, r.product);
      if (!row) {
        insert.run(values);
        const id = card(r, 'add');
        setState.run('add', id, at, r.shipment, r.product);
        if (id) queued++;
        continue;
      }
      const moved = !same(row.target, target(r));
      if (moved) setTarget.run(values);
      // Not added yet but the figures moved (a courier bill replacing an estimate): a
      // fresh card, so what's typed in is right first time.
      if (row.state === 'add') {
        if (moved) {
          closeCard(db, row.card_id, 'superseded', 'dashboard');
          const id = card(r, 'add');
          setState.run('add', id, at, r.shipment, r.product);
          if (id) queued++;
        }
        continue;
      }
      const has = row.entered;
      if (same(has, target(r))) {
        if (row.state === 'update') {
          closeCard(db, row.card_id, 'no longer needed', 'dashboard');
          setState.run('done', null, at, r.shipment, r.product);
        }
        continue;
      }
      // Sellerboard has other figures. Only worth changing once Amazon has closed the
      // shipment: until then the count, and so the cost, can still move.
      if (!r.closed) continue;
      if (row.state === 'update' && same(row.target, target(r))) continue;
      closeCard(db, row.card_id, 'superseded', 'dashboard');
      const id = card(r, 'update', has);
      setState.run('update', id, at, r.shipment, r.product);
      if (id) queued++;
    }
    // A batch that dropped out before it was added (cost no longer known, marked as
    // typed by hand) comes off the list. Ones in Sellerboard stay.
    for (const row of sellerboardTasks(db).filter((x) => x.state === 'add' && !seen.has(`${x.shipment}|${x.product}`))) {
      closeCard(db, row.card_id, 'no longer needed', 'dashboard');
      db.prepare('DELETE FROM sellerboard_batches WHERE shipment = ? AND product = ?').run(row.shipment, row.product);
    }
  })();
  return queued;
}

/**
 * Records that Sellerboard now holds a batch. `values` are the figures typed in:
 * the card's when answered on WhatsApp, else the batch's current ones.
 */
export function markSellerboardDone(db, { shipment, product, values = null, actor, cardId = null, now = new Date() }) {
  const row = sellerboardTask(db, shipment, product);
  if (!row) throw new Error(`${shipment} isn’t on the Sellerboard list.`);
  const v = values || row.target;
  // Done either way: if the figures typed in are out of date, the next refresh asks again.
  db.prepare('UPDATE sellerboard_batches SET state = ?, entered_date = ?, entered_units = ?, entered_cost = ?, done_at = ?, done_by = ?, card_id = NULL, updated_at = ? WHERE shipment = ? AND product = ?')
    .run('done', v.date, v.units, v.cost, now.toISOString(), actor, now.toISOString(), shipment, product);
  if (row.card_id && row.card_id !== cardId) closeCard(db, row.card_id, 'Y', actor);
  return { ...row, entered: v };
}

/**
 * Records a batch as already in Sellerboard with the figures typed in, without
 * a card: for batches entered before this list existed. `product` is the
 * product id or its SKU; missing figures are taken as the dashboard's.
 */
export function recordEntered(db, { shipment, product, cost = null, units = null, date = null, actor, ledger = loadLedger(db), result = computeLandingCosts(ledger), now = new Date() }) {
  const r = buildFeed(ledger, result, { catalog: null }).rows.find((x) => x.shipment === shipment && (x.product === product || x.sku === product));
  if (!r) throw new Error(`${shipment} ${product} isn’t a batch Sellerboard should hold yet (see the held-back list).`);
  if (!sellerboardTask(db, r.shipment, r.product)) {
    db.prepare(`INSERT INTO sellerboard_batches (shipment, product, account, marketplace, sku, batch_date, units, cost, state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'add', ?)`).run(r.shipment, r.product, r.account, r.marketplace, r.sku, r.startDate, Number(r.quantity), r.cost, now.toISOString());
  }
  const t = target(r);
  return markSellerboardDone(db, { shipment: r.shipment, product: r.product, values: { date: date || t.date, units: units ?? t.units, cost: cost ? Number(cost).toFixed(2) : t.cost }, actor, now });
}
