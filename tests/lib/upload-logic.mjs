// Transcrição das funções de upload em index.html.
// Estado: COM os fixes da branch fix/aliases-and-multi-ean aplicados.
// Cada secção anota a linha original no index.html e identifica os fixes aplicados.

// ─── Normalização (index.html:4977-4980) ──────────────────────────────────────
export function normSku(s) { return (s || '').toString().trim().toLowerCase(); }
export function normBarcode(s) { return (s || '').toString().trim().toLowerCase(); }
export function normSkuLoose(s) { return normSku(s).replace(/[\s\-_./]/g, ''); }

// ─── Similaridade de nomes (index.html:2262-2295) ─────────────────────────────
// FIX SG#6: tokens-chave (capacidade, tier Pro/Max/Ultra/Plus/Mini, cor) são
// desqualificadores — se diferem entre A e B, similaridade = 0. Evita que o
// detector mescle 256GB com 512GB ou Black com White.
const COLOR_WORDS = new Set([
  'black','white','blue','violet','gold','silver','pink','red','green','yellow','orange','purple',
  'gray','grey','midnight','starlight','charcoal','titanium','natural','desert','cosmic','deep',
  'navy','ice','icy','beige','cobalt','shadow','rose','peach','mint','sky','space','jet','phantom',
  'graphite','sierra','teal','lavender','coral','almond','olive','sand','clay','onyx','platinum'
]);
function _suffixAfterDash(origLower) {
  const m = (origLower || '').match(/\s-\s(.+)$/);
  if (!m) return '';
  return (m[1].match(/[a-z0-9]+/g) || []).sort().join('|');
}
function _keyTokens(orig, stripped) {
  const s = stripped;
  const caps = (s.match(/\b\d+\s*(gb|tb)\b/g) || []).map(t => t.replace(/\s+/g, '')).sort().join('|');
  const tier = (s.match(/\b(pro|max|ultra|plus|mini)\b/g) || []).sort().join('|');
  const colors = (s.match(/\b[a-z]{3,}\b/g) || []).filter(w => COLOR_WORDS.has(w)).sort().join('|');
  const gen = [];
  (s.match(/\biphone\s*\d+e?\b/g) || []).forEach(x => gen.push(x.replace(/\s+/g, '')));
  (s.match(/\b[sa]\d{2,4}e?\b/g) || []).forEach(x => gen.push(x));
  (s.match(/\bnote\s*\d+\b/g) || []).forEach(x => gen.push(x.replace(/\s+/g, '')));
  const model = gen.sort().join('|');
  const suffix = _suffixAfterDash(orig);
  return { caps, tier, colors, model, suffix };
}
export function nameSimilarity(a, b) {
  const ao = (a || '').toLowerCase();
  const bo = (b || '').toLowerCase();
  const as = ao.replace(/[^a-z0-9\s]/g, '').trim();
  const bs = bo.replace(/[^a-z0-9\s]/g, '').trim();
  if (as === bs) return 100;
  const ka = _keyTokens(ao, as), kb = _keyTokens(bo, bs);
  if (ka.caps !== kb.caps) return 0;
  if (ka.tier !== kb.tier) return 0;
  if (ka.colors !== kb.colors) return 0;
  if (ka.model !== kb.model) return 0;
  if (ka.suffix && kb.suffix && ka.suffix !== kb.suffix) return 0;
  const wa = new Set(as.split(/\s+/).filter(w => w.length > 2 || /^\d/.test(w)));
  const wb = new Set(bs.split(/\s+/).filter(w => w.length > 2 || /^\d/.test(w)));
  let common = 0; wa.forEach(w => { if (wb.has(w)) common++; });
  return Math.round((common / Math.max(wa.size, wb.size, 1)) * 100);
}

// ─── Detecção de duplicados (index.html:2272-2351) ────────────────────────────
export function detectDuplicates(rows, colMap) {
  const { name: nc, sku: sc, barcode: bc, stock: stc, price: pc } = colMap;
  const items = rows.map((row, i) => ({
    idx: i,
    name: (row[nc] || '').toString().trim(),
    sku: (row[sc] || '').toString().trim(),
    barcode: (row[bc] || '').toString().trim(),
    stock: parseInt(String(row[stc] || '0').replace(/[^0-9]/g, '')) || 0,
    cost: parseFloat(String(row[pc] || '0').replace(',', '.')) || 0,
  })).filter(x => x.name);

  const groups = [];
  const used = new Set();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const a = items[i];
    const cluster = [a];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const b = items[j];
      const score = nameSimilarity(a.name, b.name);
      if (score < 88) continue;
      const maxCost = Math.max(a.cost, b.cost);
      if (maxCost > 0 && Math.abs(a.cost - b.cost) / maxCost > 0.15) continue;
      cluster.push(b);
      used.add(j);
    }
    if (cluster.length > 1) {
      used.add(i);
      groups.push({ items: cluster, score: nameSimilarity(cluster[0].name, cluster[1].name) });
    }
  }
  return groups;
}

// ─── Núcleo do doAnalysis (index.html:2125-2249) ─────────────────────────────
// FIX SG#2: merge preserva TODOS os barcodes/SKUs do grupo em _altBarcodes/_altSkus.
// FIX SG#1: lookup consulta findCanonicalForRow se direct lookup falha.
// Aliases passados como argumento porque o módulo é puro (sem state global).
export function doAnalysis({ parsedRows, colMap, supplier, shopifyProducts, decisions = [], productAliases = [], productCanonicals = {} }) {
  const { name: nc, sku: sc, barcode: bc, stock: stc, price: pc } = colMap;

  // Apply merges (FIX SG#2 — preserva todos os EANs/SKUs)
  const skipIdxs = new Set();
  const extraRows = [];
  decisions.forEach(d => {
    if (d.decision === true) {
      d.items.forEach(x => skipIdxs.add(x.idx));
      const mergedStock = d.items.reduce((a, x) => a + x.stock, 0);
      const minCost = Math.min(...d.items.map(x => x.cost));
      const altBarcodes = d.items.map(x => (x.barcode || '').toString().trim()).filter(Boolean);
      const altSkus     = d.items.map(x => (x.sku || '').toString().trim()).filter(Boolean);
      extraRows.push({
        [nc]: d.items[0].name,
        [sc]: d.items[0].sku,
        [bc]: d.items[0].barcode,
        [stc]: String(mergedStock),
        [pc]: String(minCost),
        _altBarcodes: altBarcodes,
        _altSkus: altSkus,
        _mergedFrom: altBarcodes,
      });
      (d.unselectedItems || []).forEach(x => {
        skipIdxs.add(x.idx);
        extraRows.push({
          [nc]: x.name, [sc]: x.sku, [bc]: x.barcode,
          [stc]: String(x.stock), [pc]: String(x.cost),
        });
      });
    }
  });

  const effectiveRows = [
    ...parsedRows.filter((_, i) => !skipIdxs.has(i)),
    ...extraRows,
  ];

  // Indexação do cache Shopify
  const skuMap = {}, barcodeMap = {};
  shopifyProducts.forEach(p => {
    p.variants.forEach(v => {
      if (v.sku) skuMap[v.sku.trim().toLowerCase()] = { product: p, variant: v };
      if (v.barcode) barcodeMap[v.barcode.trim()] = { product: p, variant: v };
    });
  });

  // FIX SG#1: helper para consultar canónicos+aliases (réplica do findCanonicalForRow)
  function findCanonicalForRow({ suppId, sku, barcode }) {
    const skuN = normSku(sku);
    const skuL = normSkuLoose(sku);
    const bcN = normBarcode(barcode);
    let exact = null, loose = null, bcHit = null;
    for (const a of productAliases) {
      const aSku = normSku(a.sku), aSkuL = normSkuLoose(a.sku), aBc = normBarcode(a.barcode);
      if (skuN && aSku === skuN && (a.suppId === suppId || !a.suppId)) { exact = a; break; }
      if (!loose && skuL && aSkuL && aSkuL === skuL && (a.suppId === suppId || !a.suppId)) loose = a;
      if (!bcHit && bcN && aBc === bcN) bcHit = a;
    }
    const hit = exact || loose || bcHit;
    if (!hit) return null;
    const canonical = productCanonicals[hit.canonicalId] || null;
    return canonical ? { canonical, alias: hit, matchedBy: exact ? 'sku' : loose ? 'sku-loose' : 'barcode' } : null;
  }

  const found = [], notFound = [], isNew = [];
  const knownSkus = new Set(), knownBarcodes = new Set();

  effectiveRows.forEach(row => {
    const name = (row[nc] || '').toString().trim();
    if (!name) return;
    const sku = (row[sc] || '').toString().trim();
    const barcode = (row[bc] || '').toString().trim();
    const stockVal = parseInt(String(row[stc] || '0').replace(/[^0-9]/g, '')) || 0;
    const costRaw = parseFloat(String(row[pc] || '0').replace(',', '.')) || 0;

    const altBarcodes = Array.isArray(row._altBarcodes) ? row._altBarcodes : [];
    const altSkus     = Array.isArray(row._altSkus)     ? row._altSkus     : [];

    // FIX SG#2: regista TODOS os SKUs/barcodes em knownSkus/knownBarcodes
    if (sku) knownSkus.add(sku.toLowerCase());
    altSkus.forEach(s => { if (s) knownSkus.add(s.toLowerCase()); });
    if (barcode) knownBarcodes.add(barcode);
    altBarcodes.forEach(b => { if (b) knownBarcodes.add(b); });

    // FIX SG#2: tenta SKU primário → barcode primário → alt SKUs → alt barcodes
    // FIX SG#1: se ainda não houver match, consulta canónicos+aliases
    let match = null, matchedBy = null;
    const trySku = (s) => {
      const k = (s || '').toLowerCase();
      if (k && skuMap[k]) { match = skuMap[k]; matchedBy = 'SKU'; }
    };
    const tryBc = (b) => {
      if (b && barcodeMap[b]) { match = barcodeMap[b]; matchedBy = 'BARCODE'; }
    };
    if (sku) trySku(sku);
    if (!match && barcode) tryBc(barcode);
    if (!match) { for (const s of altSkus) { trySku(s); if (match) { matchedBy = 'SKU-alt'; break; } } }
    if (!match) { for (const b of altBarcodes) { tryBc(b); if (match) { matchedBy = 'BARCODE-alt'; break; } } }
    if (!match) {
      const hit = findCanonicalForRow({ suppId: supplier.id, sku, barcode });
      if (hit?.canonical?.shopifyVariantId) {
        const vid = hit.canonical.shopifyVariantId;
        for (const p of shopifyProducts) {
          const v = p.variants.find(x => x.id === vid);
          if (v) { match = { product: p, variant: v }; matchedBy = 'ALIAS-' + hit.matchedBy; break; }
        }
      }
    }

    const rec = {
      name, sku, barcode, stockVal, costRaw,
      mergedFrom: row._mergedFrom || null,
    };
    if (match) {
      found.push({
        ...rec,
        matchedBy,
        shopifyProductId: match.product.id,
        shopifyVariantId: match.variant.id,
        shopifyTitle: match.product.title,
        shopifySku: match.variant.sku,
        shopifyBarcode: match.variant.barcode,
        currentStock: match.variant.stock,
      });
    } else if (sku || barcode) {
      isNew.push(rec);
    } else {
      notFound.push(rec);
    }
  });

  return {
    found, isNew, notFound,
    knownSkus, knownBarcodes,
    uploadTotal: effectiveRows.filter(r => (r[nc] || '').toString().trim()).length,
  };
}

// ─── Health check pós-upload (index.html:836-888) ─────────────────────────────
// FIX SG#5: respeita supplier.isInStockList — quando true, NUNCA escala para zerar,
// apenas marca contadores sem agravar.
export function runPostUploadHealthCheck({ supplier, shopifyProducts, processedSkus, uploadHistory = [] }) {
  const supplierId = supplier.id;
  const suppTag = `sup:${supplierId}`;
  const taggedProducts = shopifyProducts.filter(p => p.tags && p.tags.includes(suppTag));
  if (!taggedProducts.length) return { missing: [], coveragePct: 100, avgExpected: 0, action: 'no-tagged' };

  const missing = taggedProducts.filter(p => {
    return !p.variants.some(v => {
      const sku = (v.sku || '').trim().toLowerCase();
      const bc = (v.barcode || '').trim();
      return (sku && processedSkus.skus.has(sku)) || (bc && processedSkus.barcodes.has(bc));
    });
  });

  if (!missing.length) return { missing: [], coveragePct: 100, avgExpected: 0, action: 'all-updated' };

  // FIX SG#5
  if (supplier.isInStockList) {
    return { missing, coveragePct: 0, avgExpected: 0, action: 'in-stock-list-preserve' };
  }

  const hist = uploadHistory.filter(h => h.supplierId === supplierId).slice(0, 5);
  const avgExpected = hist.length ? Math.round(hist.reduce((a, h) => a + (h.total || 0), 0) / hist.length) : 0;
  const uploadSize = processedSkus.total;
  const coveragePct = avgExpected > 0 ? Math.round((uploadSize / avgExpected) * 100) : 100;

  if (coveragePct < 70 && avgExpected > 50) {
    return { missing, coveragePct, avgExpected, action: 'partial-modal' };
  }
  return { missing, coveragePct, avgExpected, action: 'zero-modal' };
}
