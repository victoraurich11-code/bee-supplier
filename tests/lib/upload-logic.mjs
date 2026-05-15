// Transcrição **fiel** das funções do upload em index.html (estado actual, COM os bugs).
// Cada export anota a linha original no index.html para auditoria.
// Quando aplicarmos os fixes em index.html, este módulo é actualizado em paralelo
// (ou criamos `upload-logic-fixed.mjs`) para o harness comparar.

// ─── Normalização (index.html:4977-4980) ──────────────────────────────────────
export function normSku(s) { return (s || '').toString().trim().toLowerCase(); }
export function normBarcode(s) { return (s || '').toString().trim().toLowerCase(); }
export function normSkuLoose(s) { return normSku(s).replace(/[\s\-_./]/g, ''); }

// ─── Similaridade de nomes (index.html:2262-2270) ─────────────────────────────
export function nameSimilarity(a, b) {
  a = (a || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  b = (b || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (a === b) return 100;
  const wa = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wb = new Set(b.split(/\s+/).filter(w => w.length > 2));
  let common = 0; wa.forEach(w => { if (wb.has(w)) common++; });
  return Math.round((common / Math.max(wa.size, wb.size, 1)) * 100);
}

// ─── Detecção de duplicados (index.html:2272-2351) ────────────────────────────
// Versão small-catalog (n²); abaixo de 400 linhas é suficiente.
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

// ─── Núcleo do doAnalysis com merge dos duplicados (index.html:2125-2249) ─────
// `decisions[gi].decision`: true = merge selecionados | false = todos separados
// `decisions[gi].items`: linhas que entram no merge
// `decisions[gi].unselectedItems`: linhas NÃO incluídas no merge (re-inseridas como linhas separadas)
//
// 🐛 SG#2 — ver linha 2137 do index.html: o merge guarda apenas
//    `d.items[0].barcode`, descartando os outros EANs do grupo.
//    Reproduzimos o bug fielmente.
export function doAnalysis({ parsedRows, colMap, supplier, shopifyProducts, decisions = [] }) {
  const { name: nc, sku: sc, barcode: bc, stock: stc, price: pc } = colMap;

  // Aplicar merges (replica index.html:2129-2148)
  const skipIdxs = new Set();
  const extraRows = [];
  decisions.forEach(d => {
    if (d.decision === true) {
      d.items.forEach(x => skipIdxs.add(x.idx));
      const mergedStock = d.items.reduce((a, x) => a + x.stock, 0);
      const minCost = Math.min(...d.items.map(x => x.cost));
      extraRows.push({
        [nc]: d.items[0].name,
        [sc]: d.items[0].sku,
        [bc]: d.items[0].barcode,   // 🐛 só o primeiro barcode sobrevive
        [stc]: String(mergedStock),
        [pc]: String(minCost),
        _mergedFrom: d.items.map(x => x.barcode),  // só para o report do harness
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

  // Indexação do cache Shopify (index.html:2151-2157)
  const skuMap = {}, barcodeMap = {};
  shopifyProducts.forEach(p => {
    p.variants.forEach(v => {
      if (v.sku) skuMap[v.sku.trim().toLowerCase()] = { product: p, variant: v };
      if (v.barcode) barcodeMap[v.barcode.trim()] = { product: p, variant: v };
    });
  });

  const found = [], notFound = [], isNew = [];
  const knownSkus = new Set(), knownBarcodes = new Set();

  effectiveRows.forEach(row => {
    const name = (row[nc] || '').toString().trim();
    if (!name) return;
    const sku = (row[sc] || '').toString().trim();
    const barcode = (row[bc] || '').toString().trim();
    const stockVal = parseInt(String(row[stc] || '0').replace(/[^0-9]/g, '')) || 0;
    const costRaw = parseFloat(String(row[pc] || '0').replace(',', '.')) || 0;

    if (sku) knownSkus.add(sku.toLowerCase());
    if (barcode) knownBarcodes.add(barcode);   // 🐛 SG#2: linha merged só regista o primeiro barcode

    let match = null, matchedBy = null;
    if (sku && skuMap[sku.toLowerCase()]) { match = skuMap[sku.toLowerCase()]; matchedBy = 'SKU'; }
    else if (barcode && barcodeMap[barcode]) { match = barcodeMap[barcode]; matchedBy = 'BARCODE'; }

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
// Devolve { missing[], coveragePct, avgExpected, action }
// action: 'all-updated' | 'partial-modal' | 'zero-modal'
export function runPostUploadHealthCheck({ supplierId, shopifyProducts, processedSkus, uploadHistory = [] }) {
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

  const hist = uploadHistory.filter(h => h.supplierId === supplierId).slice(0, 5);
  const avgExpected = hist.length ? Math.round(hist.reduce((a, h) => a + (h.total || 0), 0) / hist.length) : 0;
  const uploadSize = processedSkus.total;
  const coveragePct = avgExpected > 0 ? Math.round((uploadSize / avgExpected) * 100) : 100;

  if (coveragePct < 70 && avgExpected > 50) {
    return { missing, coveragePct, avgExpected, action: 'partial-modal' };
  }
  return { missing, coveragePct, avgExpected, action: 'zero-modal' };
}
