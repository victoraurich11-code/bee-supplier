#!/usr/bin/env node
// Harness do motor multi-fornecedor (supplierOffers) — cenários sintéticos.
//
// Cobre as 3 falhas reportadas em produção (2026-07):
//   A. "atualiza stock mas não zera" → ausência agora zera automaticamente
//   B. "novos DEPAU ficam esgotados" → drafts entram no matching (testado via status)
//   C. "listagens sobrepõem-se"      → prioridade entre ofertas, sem flip-flop
//
// Uso: node tests/run-offers.mjs

import { makeOfferEngine, classifyAbsences, doAnalysis } from './lib/upload-logic.mjs';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? PASS : FAIL} ${name}${!cond && detail ? '\n    ' + detail : ''}`);
  if (!cond) failures++;
}
function section(t) { console.log('\n' + BOLD('── ' + t + ' ' + '─'.repeat(Math.max(0, 70 - t.length)))); }

// ─── Cenário base ──────────────────────────────────────────────────────────────
const TELETECH = { id: 'teletech', name: 'Teletech', active: true, priority: 10, absencePolicy: 'zero', pricingMode: 'manual' };
const DEPAU    = { id: 'depau',    name: 'Depau',    active: true, priority: 20, absencePolicy: 'zero', pricingMode: 'automatico', priceType: 'pvp', rounding: 'none' };
const SUPPLIERS = [TELETECH, DEPAU];

const mkProduct = (n, { tags = [], stock = 0, sku = '', barcode = '', status = 'ACTIVE' } = {}) => ({
  id: `gid://shopify/Product/${n}`,
  title: `Produto ${n}`,
  status, tags,
  variants: [{ id: `gid://shopify/ProductVariant/${n}`, sku, barcode, stock, price: '100.00', inventoryItemId: `gid://shopify/InventoryItem/${n}` }],
});
const VID = (n) => `gid://shopify/ProductVariant/${n}`;
const nowISO = new Date().toISOString();

// ─── A. Ausência zera (era o bug "não zera") ──────────────────────────────────
section('A. Ausência da listagem → zero automático');
{
  const engine = makeOfferEngine(SUPPLIERS, {
    [`teletech::${VID(1)}`]: { suppId: 'teletech', variantId: VID(1), stock: 9, cost: 50, lastSeen: nowISO },
  });
  const products = [
    mkProduct(1, { tags: ['sup:teletech'], stock: 9, barcode: '111' }),   // ausente, com stock → ZERO
    mkProduct(2, { tags: ['sup:teletech'], stock: 5, barcode: '222' }),   // presente no upload → ok
    mkProduct(3, { tags: ['sup:teletech'], stock: 0, barcode: '333' }),   // ausente, já a zero → no-op
  ];
  const r = classifyAbsences({
    supplier: TELETECH, suppliers: SUPPLIERS, shopifyProducts: products, engine,
    processedSkus: { skus: new Set(), barcodes: new Set(['222']), total: 100 },
  });
  check('produto ausente com stock vai para zero automático', r.toZero.length === 1 && r.toZero[0].product.id === 'gid://shopify/Product/1', JSON.stringify(r.toZero.map(z=>z.product.id)));
  check('produto presente não é tocado', !r.missing.some(m => m.id === 'gid://shopify/Product/2'));
  check('produto já a zero é no-op (sem repetição diária de alertas)', r.alreadyZero.length === 1 && r.toZero.every(z => z.product.id !== 'gid://shopify/Product/3'));
  check('oferta do fornecedor ficou a 0 após ausência', engine.offers[`teletech::${VID(1)}`].stock === 0);
}

// ─── B. Handover: outro fornecedor tem stock ───────────────────────────────────
section('B. Ausente na Teletech mas Depau tem stock → handover (não zera)');
{
  const engine = makeOfferEngine(SUPPLIERS, {
    [`teletech::${VID(1)}`]: { suppId: 'teletech', variantId: VID(1), stock: 4, cost: 50, lastSeen: nowISO },
    [`depau::${VID(1)}`]:    { suppId: 'depau',    variantId: VID(1), stock: 7, cost: 60, lastSeen: nowISO },
  });
  const products = [mkProduct(1, { tags: ['sup:teletech', 'sup:depau'], stock: 4, barcode: '111' })];
  const r = classifyAbsences({
    supplier: TELETECH, suppliers: SUPPLIERS, shopifyProducts: products, engine,
    processedSkus: { skus: new Set(), barcodes: new Set(), total: 100 },
  });
  check('não zera: entrega ao Depau', r.toZero.length === 0 && r.toHandover.length === 1);
  check('handover leva o stock do Depau (7)', r.toHandover[0]?.offer.stock === 7 && r.toHandover[0]?.offer.suppId === 'depau');
}

// ─── C. Prioridade no upload: Depau não rouba produto gerido pela Teletech ────
section('C. Upload Depau de produto gerido pela Teletech → não aplica (sem flip-flop)');
{
  const offers = {
    [`teletech::${VID(1)}`]: { suppId: 'teletech', variantId: VID(1), stock: 5, cost: 50, lastSeen: nowISO },
  };
  const engine = makeOfferEngine(SUPPLIERS, offers);
  // Simula o doAnalysis: quem ganharia se o Depau tivesse 9 hoje?
  const winner = engine.resolveEffectiveOffer(VID(1), { depau: 9 });
  check('Teletech (prioridade 10) continua a gerir contra Depau (20)', winner?.suppId === 'teletech');

  // Teletech esgota (oferta 0) → agora o Depau ganha
  engine.markOfferAbsent('teletech', VID(1));
  const winner2 = engine.resolveEffectiveOffer(VID(1), { depau: 9 });
  check('Teletech a 0 → Depau assume', winner2?.suppId === 'depau' && winner2.stock === 9);

  // Oferta Teletech velha (>7 dias sem upload) não conta
  const engine3 = makeOfferEngine(SUPPLIERS, {
    [`teletech::${VID(2)}`]: { suppId: 'teletech', variantId: VID(2), stock: 5, cost: 50, lastSeen: new Date(Date.now() - 9 * 86400000).toISOString() },
  });
  const winner3 = engine3.resolveEffectiveOffer(VID(2), { depau: 3 });
  check('oferta com mais de 7 dias deixa de contar (fornecedor parado)', winner3?.suppId === 'depau');
}

// ─── D. Travões de segurança ───────────────────────────────────────────────────
section('D. Travões: mapeamento partido, cobertura baixa, zeragem em massa');
{
  const engine = makeOfferEngine(SUPPLIERS, {});
  const products = Array.from({ length: 20 }, (_, i) => mkProduct(i + 1, { tags: ['sup:teletech'], stock: 3, barcode: `b${i + 1}` }));
  // Nada bateu → broken mapping
  const r1 = classifyAbsences({
    supplier: TELETECH, suppliers: SUPPLIERS, shopifyProducts: products, engine: makeOfferEngine(SUPPLIERS, {}),
    processedSkus: { skus: new Set(), barcodes: new Set(), total: 300 },
  });
  check('0 matches em 20 tagged → aborta (broken-mapping), nada vai a zero', r1.guard === 'broken-mapping' && r1.toZero.length === 0);

  // Cobertura baixa → exige confirmação
  const r2 = classifyAbsences({
    supplier: TELETECH, suppliers: SUPPLIERS, shopifyProducts: products, engine: makeOfferEngine(SUPPLIERS, {}),
    processedSkus: { skus: new Set(), barcodes: new Set(['b1']), total: 100 },
    uploadHistory: [{ supplierId: 'teletech', total: 400 }, { supplierId: 'teletech', total: 380 }],
  });
  check('cobertura 26% → guard low-coverage-confirm', r2.guard === 'low-coverage-confirm');

  // Zeragem em massa → massBrake
  const r3 = classifyAbsences({
    supplier: TELETECH, suppliers: SUPPLIERS, shopifyProducts: products, engine: makeOfferEngine(SUPPLIERS, {}),
    processedSkus: { skus: new Set(), barcodes: new Set(['b1']), total: 100 },
  });
  check(`19 zeros de 20 com stock → massBrake ativo`, r3.massBrake === true && r3.toZero.length === 19);
}

// ─── E. Mudança de EAN protege de zero ─────────────────────────────────────────
section('E. Produto ausente mas ficheiro traz o mesmo nome com EAN novo → protegido');
{
  const engine = makeOfferEngine(SUPPLIERS, {});
  const products = [
    mkProduct(1, { tags: ['sup:teletech'], stock: 6, barcode: '111' }),
    mkProduct(2, { tags: ['sup:teletech'], stock: 2, barcode: '221' }),
  ];
  products[0].title = 'Apple iPhone 17 Pro Max 256GB - Deep Blue';
  const r = classifyAbsences({
    supplier: TELETECH, suppliers: SUPPLIERS, shopifyProducts: products, engine,
    processedSkus: { skus: new Set(), barcodes: new Set(['999']), total: 100 },
    isNewRows: [{ name: 'Apple iPhone 17 Pro Max 256GB - Deep Blue', barcode: '112', stockVal: 31 }],
  });
  check('iPhone com EAN novo vai para eanChange, não para zero',
    r.eanChange.length === 1 && r.eanChange[0].product.id === 'gid://shopify/Product/1' &&
    r.toZero.every(z => z.product.id !== 'gid://shopify/Product/1'));
  check('o outro produto (sem candidato) vai a zero normalmente', r.toZero.some(z => z.product.id === 'gid://shopify/Product/2'));
}

// ─── F. Drafts entram no matching (novos DEPAU deixam de ficar órfãos) ────────
section('F. Draft criado pela app é encontrado pelo upload seguinte');
{
  const draft = mkProduct(9, { tags: ['sup:depau'], stock: 0, barcode: '777', status: 'DRAFT' });
  const result = doAnalysis({
    parsedRows: [{ Nome: 'Portátil HP 250R G10', EAN: '777', Stock: '12', Preco: '576,87' }],
    colMap: { name: 'Nome', sku: '__SKU__', barcode: 'EAN', stock: 'Stock', price: 'Preco' },
    supplier: DEPAU,
    shopifyProducts: [draft],
    decisions: [],
  });
  check('linha do ficheiro bate no draft pelo EAN', result.found.length === 1 && result.found[0].shopifyVariantId === VID(9));
  check('draft NÃO entra no ciclo de ausências (health check só ACTIVE)', (() => {
    const r = classifyAbsences({
      supplier: DEPAU, suppliers: SUPPLIERS, shopifyProducts: [draft], engine: makeOfferEngine(SUPPLIERS, {}),
      processedSkus: { skus: new Set(), barcodes: new Set(), total: 10 },
    });
    return r.missing.length === 0;
  })());
}

// ─── Resultado ─────────────────────────────────────────────────────────────────
console.log('\n' + BOLD('═'.repeat(74)));
if (failures === 0) {
  console.log(`${PASS} ${BOLD('Todos os cenários do motor multi-fornecedor passaram.')}`);
} else {
  console.log(`${FAIL} ${BOLD(failures + ' cenário(s) falharam.')}`);
  process.exitCode = 1;
}
