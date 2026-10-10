/**
 * Which marketplace a European shipment belongs to, from the Amazon warehouse
 * it's going to.
 *
 * Amazon's inbound API ignores the marketplace for a pan-EU account: asking for
 * UK shipments returns the DE ones too, with nothing in the record saying which
 * is which, except the destination warehouse. Since Brexit the UK and EU have
 * separate warehouse networks, so the warehouse settles it. A code missing from
 * these lists is never guessed: the shipment is reported, and the code gets added.
 */
const UK = 'ABZ1 BHX1 BHX2 BHX3 BHX4 BHX5 BHX7 BHX8 BHX9 BRS1 BRS2 CWL1 EDI4 EMA1 EMA2 EMA3 EUK5 EXT1 GLA1 LBA1 LBA2 LBA3 LBA4 LBA8 LCY2 LCY3 LTN1 LTN2 LTN4 LTN7 LTN9 MAN1 MAN2 MAN3 MAN4 MME1 MME2 NCL1 NCL2';
// Germany, plus the Polish and Czech sites that take German stock.
const DE = 'BER3 BRE4 CGN1 DTM1 DTM2 DTM3 DUS2 DUS4 EDE4 EDE5 FRA1 FRA3 FRA7 HAJ1 HAM2 LEJ1 LEJ3 MUC3 PAD1 STR1 KTW1 LCJ2 POZ1 PRG2 SZZ1 WRO1 WRO2 WRO5';

const BY_CODE = new Map([...UK.split(' ').map((c) => [c, 'UK']), ...DE.split(' ').map((c) => [c, 'DE'])]);

/** 'UK', 'DE', or null when the warehouse isn't known (or isn't one of `allowed`). */
export function marketplaceForWarehouse(code, allowed = ['UK', 'DE']) {
  const m = BY_CODE.get(String(code || '').trim().toUpperCase());
  return m && allowed.includes(m) ? m : null;
}
