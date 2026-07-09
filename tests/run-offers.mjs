#!/usr/bin/env node
// Harness do modelo DONO FIXO — cenários sintéticos.
//
// Cobre as falhas reportadas em produção (jul 2026), na versão simplificada
// pedida pelo Victor (2026-07-09): um produto pertence a UM fornecedor (tag
// sup:) e só esse upload lhe mexe. Sem handover, sem posse de preço, sem
// alertas de troca. O que fica: zero automático de ausentes com travões,
// proteção de mudança de EAN, drafts no matching e herança de identidade.
//
// Uso: node tests/run-offers.mjs

import { classifyAbsences, doAnalysis, suggestIdentityFromAlerts } from './lib/upload-logic.mjs';

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
const TELETECH = { id: 'teletech', name: 'Teletech', active: true, absencePolicy: 'zero', pricingMode: 'manual' };
const DEPAU    = { id: 'depau',    name: 'Depau',    active: true, absencePolicy: 'zero', pricingMode: 'automatico', priceType: 'pvp', rounding: 'none' };
const SUPPLIERS = [TELETECH, DEPAU];

const mkProduct = (n, { tags = [], stock = 0, sku = '', barcode = '', status = 'ACTIVE', title = null } = {}) => ({
  id: `gid://shopify/Product/${n}`,
  title: title || `Produto ${n}`,
  status, tags,
  variants: [{ id: `gid://shopify/ProductVariant/${n}`, sku, barcode, stock, price: '100.00', inventoryItemId: `gid://shopify/InventoryItem/${n}` }],
});
const VID = (n) => `gid://shopify/ProductVariant/${n}`;

// ─── A. Ausência da listagem do DONO → zero automático ────────────────────────
section('A. Ausência da listagem do dono → zero automático (era o "não zera")');
{
  const products = [
    mkProduct(1, { tags: ['sup:teletech'], stock: 9, barcode: '111' }),   // ausente, com stock → ZERO
    mkProduct(2, { tags: ['sup:teletech'], stock: 5, barcode: '222' }),   // presente no upload → ok
    mkProduct(3, { tags: ['sup:teletech'], stock: 0, barcode: '333' }),   // ausente, já a zero → no-op
    mkProduct(4, { tags: ['sup:depau'],    stock: 7, barcode: '444' }),   // doutro dono → upload Teletech ignora
  ];
  const r = classifyAbsences({
    supplier: TELETECH, shopifyProducts: products,
    processedSkus: { skus: new Set(), barcodes: new Set(['222']), total: 100 },
  });
  check('produto ausente com stock vai para zero automático', r.toZero.length === 1 && r.toZero[0].product.id === 'gid://shopify/Product/1', JSON.stringify(r.toZero.map(z=>z.product.id)));
  check('produto presente não é tocado', !r.missing.some(m => m.id === 'gid://shopify/Product/2'));
  check('produto já a zero é no-op (sem repetição diária de alertas)', r.alreadyZero.length === 1 && r.toZero.every(z => z.product.id !== 'gid://shopify/Product/3'));
  check('produto doutro fornecedor NUNCA entra no ciclo deste', !r.missing.some(m => m.id === 'gid://shopify/Product/4'));
}

// ─── B. Dono fixo no upload: outro fornecedor não toca nem reclama ────────────
section('B. Dono fixo: upload de outro fornecedor não mexe no produto');
{
  const owned = mkProduct(1, { tags: ['sup:teletech'], stock: 5, barcode: '111' });
  const orphan = mkProduct(2, { tags: [], stock: 3, barcode: '222' });
  const result = doAnalysis({
    parsedRows: [
      { Nome: 'Produto 1', EAN: '111', Stock: '9', Preco: '60' },
      { Nome: 'Produto 2', EAN: '222', Stock: '4', Preco: '30' },
    ],
    colMap: { name: 'Nome', sku: '__SKU__', barcode: 'EAN', stock: 'Stock', price: 'Preco' },
    supplier: DEPAU,
    suppliers: SUPPLIERS,
    shopifyProducts: [owned, orphan],
    decisions: [],
  });
  const r1 = result.found.find(f => f.shopifyVariantId === VID(1));
  const r2 = result.found.find(f => f.shopifyVariantId === VID(2));
  check('produto da Teletech aparece marcado "pertence a teletech" no upload Depau', r1?.managedBy === 'teletech');
  check('produto sem dono fica livre para este fornecedor reclamar', r2 && !r2.managedBy);
}

// ─── C. Travões de segurança ───────────────────────────────────────────────────
section('C. Travões: mapeamento partido, cobertura baixa, zeragem em massa');
{
  const products = Array.from({ length: 20 }, (_, i) => mkProduct(i + 1, { tags: ['sup:teletech'], stock: 3, barcode: `b${i + 1}` }));
  // Nada bateu → broken mapping
  const r1 = classifyAbsences({
    supplier: TELETECH, shopifyProducts: products,
    processedSkus: { skus: new Set(), barcodes: new Set(), total: 300 },
  });
  check('0 matches em 20 tagged → aborta (broken-mapping), nada vai a zero', r1.guard === 'broken-mapping' && r1.toZero.length === 0);

  // Cobertura baixa → exige confirmação
  const r2 = classifyAbsences({
    supplier: TELETECH, shopifyProducts: products,
    processedSkus: { skus: new Set(), barcodes: new Set(['b1']), total: 100 },
    uploadHistory: [{ supplierId: 'teletech', total: 400 }, { supplierId: 'teletech', total: 380 }],
  });
  check('cobertura 26% → guard low-coverage-confirm', r2.guard === 'low-coverage-confirm');

  // Zeragem em massa → massBrake
  const r3 = classifyAbsences({
    supplier: TELETECH, shopifyProducts: products,
    processedSkus: { skus: new Set(), barcodes: new Set(['b1']), total: 100 },
  });
  check(`19 zeros de 20 com stock → massBrake ativo`, r3.massBrake === true && r3.toZero.length === 19);
}

// ─── D. Mudança de EAN protege de zero ─────────────────────────────────────────
section('D. Produto ausente mas ficheiro traz o mesmo nome com EAN novo → protegido');
{
  const products = [
    mkProduct(1, { tags: ['sup:teletech'], stock: 6, barcode: '111', title: 'Apple iPhone 17 Pro Max 256GB - Deep Blue' }),
    mkProduct(2, { tags: ['sup:teletech'], stock: 2, barcode: '221' }),
  ];
  const r = classifyAbsences({
    supplier: TELETECH, shopifyProducts: products,
    processedSkus: { skus: new Set(), barcodes: new Set(['999']), total: 100 },
    isNewRows: [{ name: 'Apple iPhone 17 Pro Max 256GB - Deep Blue', barcode: '112', stockVal: 31 }],
  });
  check('iPhone com EAN novo vai para eanChange, não para zero',
    r.eanChange.length === 1 && r.eanChange[0].product.id === 'gid://shopify/Product/1' &&
    r.toZero.every(z => z.product.id !== 'gid://shopify/Product/1'));
  check('o outro produto (sem candidato) vai a zero normalmente', r.toZero.some(z => z.product.id === 'gid://shopify/Product/2'));
}

// ─── E. Política 'manter' só vigia ─────────────────────────────────────────────
section('E. Política "manter e vigiar" nunca zera');
{
  const MANTER = { ...TELETECH, absencePolicy: 'manter' };
  const products = [mkProduct(1, { tags: ['sup:teletech'], stock: 9, barcode: '111' }), mkProduct(2, { tags: ['sup:teletech'], stock: 1, barcode: '222' })];
  const r = classifyAbsences({
    supplier: MANTER, shopifyProducts: products,
    processedSkus: { skus: new Set(), barcodes: new Set(['222']), total: 100 },
  });
  check('ausente com política manter → vigilância, zero vazio', r.watched.length === 1 && r.toZero.length === 0);
}

// ─── F. Drafts entram no matching mas não no ciclo de ausências ────────────────
section('F. Draft criado pela app é encontrado pelo upload seguinte');
{
  const draft = mkProduct(9, { tags: ['sup:depau'], stock: 0, barcode: '777', status: 'DRAFT' });
  const result = doAnalysis({
    parsedRows: [{ Nome: 'Portátil HP 250R G10', EAN: '777', Stock: '12', Preco: '576,87' }],
    colMap: { name: 'Nome', sku: '__SKU__', barcode: 'EAN', stock: 'Stock', price: 'Preco' },
    supplier: DEPAU,
    suppliers: SUPPLIERS,
    shopifyProducts: [draft],
    decisions: [],
  });
  check('linha do ficheiro bate no draft pelo EAN', result.found.length === 1 && result.found[0].shopifyVariantId === VID(9));
  check('draft NÃO entra no ciclo de ausências (health check só ACTIVE)', (() => {
    const r = classifyAbsences({
      supplier: DEPAU, shopifyProducts: [draft],
      processedSkus: { skus: new Set(), barcodes: new Set(), total: 10 },
    });
    return r.missing.length === 0;
  })());
}

// ─── G. Split de variantes herda identidade dos alertas ───────────────────────
section('G. Produto criado sem EAN herda identidade do alerta do fornecedor');
{
  const alerts = [
    { type: 'new_product', dismissed: false, suppId: 'teletech', name: 'Samsung Galaxy Fit 3 40mm - Grey', barcode: '8806095362151', sku: '8806095362151', stock: 9, price: 39.9 },
    { type: 'new_product', dismissed: false, suppId: 'teletech', name: 'Samsung Galaxy Fit 3 40mm - Silver', barcode: '8806095362199', sku: '8806095362199', stock: 4, price: 39.9 },
    { type: 'new_product', dismissed: true,  suppId: 'teletech', name: 'Samsung Galaxy Fit 3 40mm - Pink', barcode: '8806095362222', sku: '8806095362222', stock: 2, price: 39.9 },
  ];
  const hit = suggestIdentityFromAlerts('Samsung Galaxy Fit 3 40mm - Grey', alerts);
  check('G1: split "Fit 3 Grey" herda o EAN do alerta certo (não o Silver)', hit?.alert.barcode === '8806095362151' && hit.score === 100);
  const miss = suggestIdentityFromAlerts('Produto Completamente Diferente XYZ', alerts);
  check('G2: sem correspondência forte → não inventa identidade', miss === null);
  const colorGuard = suggestIdentityFromAlerts('Samsung Galaxy Fit 3 40mm - Gold', alerts);
  check('G3: cor diferente não herda EAN de outra cor', colorGuard === null);
  const dismissed = suggestIdentityFromAlerts('Samsung Galaxy Fit 3 40mm - Pink', alerts);
  check('G4: alertas dispensados não são fonte de identidade', dismissed === null);
}

// ─── Resultado ─────────────────────────────────────────────────────────────────
console.log('\n' + BOLD('═'.repeat(74)));
if (failures === 0) {
  console.log(`${PASS} ${BOLD('Todos os cenários do modelo dono fixo passaram.')}`);
} else {
  console.log(`${FAIL} ${BOLD(failures + ' cenário(s) falharam.')}`);
  process.exitCode = 1;
}
