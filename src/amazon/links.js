/**
 * What a Y or N on a WhatsApp card does. Shared by the listener (replies in
 * the self-chat) and the dashboard (the same buttons), so both behave the same.
 */
import { loadLedger, saveLedger } from '../landing/store.js';
import { getCard, recordReply } from '../notify/outbox.js';
import { markSellerboardDone } from '../sellerboard/tasks.js';

const PO_IN_NAME = /\bPO-\d{1,5}\b/i;

export async function applyCardReply(db, cardId, reply, { actor, client = null } = {}) {
  const card = getCard(db, cardId);
  if (!card) throw new Error(`No card ${cardId}`);
  if (['superseded', 'no longer needed'].includes(card.reply)) return { ok: false, message: `That card is out of date (${card.reply}): see the Sellerboard page.` };
  if (card.reply) return { ok: false, message: `Already answered (${card.reply}) by ${card.replied_by}.` };
  const yes = /^y(es)?$/i.test(String(reply).trim());
  recordReply(db, cardId, yes ? 'Y' : 'N', actor);
  const p = card.payload;
  if (p?.action === 'sellerboard') {
    if (!yes) return { ok: true, message: 'Still on the Sellerboard list.' };
    markSellerboardDone(db, { shipment: p.shipment, product: p.product, values: { date: p.date, units: p.units, cost: p.cost }, actor, cardId });
    return { ok: true, message: `Marked as in Sellerboard: ${p.shipment}, ${p.cost} for ${p.units} units from ${p.date}.` };
  }
  if (!yes) return { ok: true, message: 'Left unlinked. Link it on the Shipments page.' };

  if (p?.action !== 'link') return { ok: true, message: 'Noted.' };

  const ledger = loadLedger(db);
  const shipment = structuredClone(ledger.shipments.find((s) => s.id === p.shipment));
  if (!shipment) return { ok: false, message: `${p.shipment} is no longer on file.` };
  const order = ledger.orders.find((o) => o.po === p.po);
  if (!order) return { ok: false, message: `${p.po} is no longer on file.` };

  let linked = 0;
  for (const item of shipment.items) {
    if (!item.po && p.products.includes(item.product)) {
      item.po = p.po;
      linked++;
    }
  }
  saveLedger(db, { shipments: [shipment] }, { actor });

  // Write the PO into the shipment's name too, so Seller Central shows it.
  let renamed = null;
  if (client && !PO_IN_NAME.test(shipment.name || '')) {
    try {
      const ref = await client.findInboundShipment(shipment.marketplace, shipment.id);
      if (ref) {
        const name = `${p.po} ${shipment.name || ref.name || ''}`.trim().slice(0, 200);
        await client.updateShipmentName(shipment.marketplace, ref, name);
        shipment.name = name;
        saveLedger(db, { shipments: [shipment] }, { actor });
        renamed = name;
      }
    } catch (err) {
      return { ok: true, linked, message: `Linked ${linked} line(s) to ${p.po}, but renaming on Amazon failed: ${err.message}` };
    }
  }
  return { ok: true, linked, renamed, message: `Linked ${linked} line(s) to ${p.po}${renamed ? ` and renamed it “${renamed}” on Amazon` : ''}.` };
}
