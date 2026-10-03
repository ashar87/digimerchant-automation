/**
 * Suggests which product an invoice line is, from its description. Only a
 * suggestion: the person checking the invoice confirms it. Never picks
 * between two equally good matches.
 */

export function guessKind(description = '') {
  const d = String(description);
  if (/service\s*fee|服务费|手续费|bank\s*fee/i.test(d)) return 'fee';
  if (/rate\s*diff|exchange|汇率|payment\s*difference|差额/i.test(d)) return 'adjustment';
  if (/labou?r|人工|packing\s*fee|包装费|sticker|贴标/i.test(d)) return 'labour';
  if (/sample|样品|sourcing|inspection|验货|bag|袋|R&D/i.test(d)) return 'expense';
  return 'goods';
}

const FEATURES = [
  ['pack', /(\d{2,4})\s*(pcs|pc|sheets|张)\b/i],
  ['purity', /(\d{2})\s*%/],
  ['size', /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i],
];
const WORDS = ['gold', 'silver', 'rose', 'copper', 'edible', 'imitation', 'nail', 'foil', 'flake', 'garland', 'leaf', 'paper', '24k'];

function features(text = '') {
  const t = String(text).toLowerCase();
  const out = new Map();
  for (const [name, re] of FEATURES) {
    const m = re.exec(t);
    if (m) out.set(name, m.slice(1, 3).filter(Boolean).join('x').replace(/x(pcs|pc|sheets|张)$/, ''));
  }
  for (const w of WORDS) if (t.includes(w)) out.set(w, true);
  return out;
}

export function suggestProduct(description, products, marketplace) {
  const pool = products.filter((p) => !marketplace || p.marketplace === marketplace);
  const d = String(description || '').toLowerCase().trim();
  if (!d) return null;
  const exact = pool.filter((p) => (p.aliases || []).some((a) => a.toLowerCase() === d) || [p.sku, p.asin, p.fnsku].filter(Boolean).some((id) => d.includes(id.toLowerCase())));
  if (exact.length === 1) return exact[0].id;

  const want = features(d);
  if (!want.size) return null;
  const scored = pool
    .map((p) => {
      const have = features([p.name, p.code, ...(p.aliases || [])].join(' '));
      let score = 0;
      for (const [k, v] of want) {
        if (!have.has(k)) continue;
        if (have.get(k) === v) score += k === 'pack' ? 5 : k === 'purity' ? 3 : 1;
        else if (k === 'pack' || k === 'purity') score -= 5; // a different pack size is a different product
      }
      return { id: p.id, score };
    })
    .filter((x) => x.score >= 5)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].id;
}
