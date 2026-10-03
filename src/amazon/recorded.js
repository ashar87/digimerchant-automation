/**
 * A stand-in for the SP-API client that answers from recorded responses, for
 * tests and for trying the sync before Amazon access exists.
 *
 * Recording shape:
 *   { shipments: { UK: [ShipmentData...], DE: [...], US: [...] },
 *     items:     { FBA...: [ItemData...] },
 *     inbound:   { FBA...: { inboundPlanId, shipmentId, name } } }
 */
export function recordedSpApi(recording) {
  const calls = [];
  return {
    calls,
    marketplaces: () => Object.keys(recording.shipments || {}),
    regions: () => [],
    async getShipments(marketplace, { ids } = {}) {
      calls.push(['getShipments', marketplace, ids ? 'ids' : 'range']);
      const all = recording.shipments?.[marketplace] || [];
      return ids ? all.filter((s) => ids.includes(s.ShipmentId)) : all;
    },
    async getShipmentItems(marketplace, shipmentId) {
      calls.push(['getShipmentItems', marketplace, shipmentId]);
      return recording.items?.[shipmentId] || [];
    },
    async findInboundShipment(marketplace, fbaId) {
      calls.push(['findInboundShipment', marketplace, fbaId]);
      return recording.inbound?.[fbaId] || null;
    },
    async updateShipmentName(marketplace, ref, name) {
      calls.push(['updateShipmentName', marketplace, ref.shipmentId, name]);
    },
  };
}
