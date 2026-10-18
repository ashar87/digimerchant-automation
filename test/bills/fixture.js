// Made-up shipment IDs and amounts, laid out like the agent's "Shipping fee bills" sheet.
// What a reader returns for a bill like the agent's: two shipments, each with a
// domestic fee row under it (no FBA ID), then the service fee and a rate difference.
export const RAW = {
  rows: [
    { date: '2026-09-17', fbaId: 'FBA99TEST0B1', tracking: '111', cartons: 2, chargedWeight: 24, service: 'USA airline included tax', country: 'USA', amount: 1000, product: 'gold flakes' },
    { date: '2026-09-17', fbaId: null, country: 'domestic shipping fee', amount: 50 },
    { date: '2026-09-24', fbaId: 'FBA99TESTZC3', tracking: '222', cartons: 1, chargedWeight: 15.5, service: 'USA airline included tax', country: 'USA', amount: 900, product: 'silver paper' },
    { date: '2026-09-24', fbaId: null, country: 'domestic shipping fee', amount: 50 },
    { fbaId: null, description: '1% of Annie service fee', amount: 20 },
    { fbaId: null, description: 'Last time payment rate difference', amount: -100 },
  ],
  totalRmb: 1920,
  totalUsd: 300,
  rmbPerUsd: 6.4,
};
