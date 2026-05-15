#!/usr/bin/env node
// Harness automatizado — Teletech Stocklist 14.05.2026
//
// Uso:
//   node tests/run-teletech.mjs                          # mock + ficheiro de ontem
//   node tests/run-teletech.mjs <caminho-xlsx>           # mock + outro ficheiro
//   FIXTURE=<path> node tests/run-teletech.mjs           # outro mock
//   AUTO_MERGE=1 node tests/run-teletech.mjs             # simula user a clicar "Todos iguais"
//   AUTO_MERGE=0 node tests/run-teletech.mjs             # simula user a clicar "Todos diferentes"
//
// O harness reproduz o pipeline de upload do index.html SEM browser e SEM Shopify real.
// Compara a verdade esperada (campo _expect do fixture) contra o que o código actual produz.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';
import { detectDuplicates, doAnalysis, runPostUploadHealthCheck } from './lib/upload-logic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

const XLSX_PATH = process.argv[2] || '/Users/klark/Downloads/Stocklist 14.05.2026.xlsx';
const FIXTURE_PATH = process.env.FIXTURE || path.join(__dirname, 'fixtures/shopify-mock.json');
const AUTO_MERGE = process.env.AUTO_MERGE ?? '1';   // por defeito: simula user a fazer merge

// ─── 1. Carregar ficheiro Teletech ────────────────────────────────────────────
function loadXlsx(p) {
  const wb = xlsx.readFile(p);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '', raw: true });
  // O ficheiro tem 'Stock' repetido — segunda coluna fica como 'Stock_1'
  // Mas o que nos interessa é a primeira (a actual). Mapeamento estilo index.html:
  const colMap = { name: 'Modelo', sku: '__SKU__', barcode: 'EAN-13', stock: 'Stock', price: 'Preço' };
  return { rows, colMap };
}

// ─── 2. Carregar fixture Shopify ──────────────────────────────────────────────
function loadFixture(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── 3. Construir 'decisions' como o user clicaria ────────────────────────────
function buildDecisions(groups, mode) {
  return groups.map(g => ({
    ...g,
    decision: mode === '1' ? true : (mode === '0' ? false : null),
    items: g.items,
    unselectedItems: [],
  }));
}

// ─── 4. Reporters ─────────────────────────────────────────────────────────────
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

function section(title) {
  console.log('\n' + BOLD('═'.repeat(78)));
  console.log(BOLD(title));
  console.log(BOLD('═'.repeat(78)));
}

// ─── 5. Pipeline ──────────────────────────────────────────────────────────────
section(`HARNESS — Teletech upload simulation`);
console.log(`  Ficheiro:  ${XLSX_PATH}`);
console.log(`  Fixture:   ${FIXTURE_PATH}`);
console.log(`  AUTO_MERGE: ${AUTO_MERGE} (${AUTO_MERGE === '1' ? '"Todos iguais"' : AUTO_MERGE === '0' ? '"Todos diferentes"' : 'sem merge'})`);

const { rows, colMap } = loadXlsx(XLSX_PATH);
const fixture = loadFixture(FIXTURE_PATH);
// FIX SG#5: Teletech é in-stock list — não zerar ausentes.
const supplier = { id: 'teletech', name: 'Teletech', isInStockList: true };
const productAliases = fixture.productAliases || [];
const productCanonicals = fixture.productCanonicals || {};

console.log(`  Linhas no ficheiro: ${rows.length}`);
console.log(`  Produtos no fixture: ${fixture.products.length}`);
console.log(`  Aliases no fixture: ${productAliases.length}`);
console.log(`  Supplier isInStockList: ${supplier.isInStockList}`);

// 5.1 Duplicados
section('PASSO 1 — Detecção de duplicados');
const groups = detectDuplicates(rows, colMap);
console.log(`  Grupos detectados: ${groups.length}`);
groups.slice(0, 5).forEach((g, gi) => {
  console.log(`  • Grupo ${gi + 1} (score ${g.score}%): ${g.items.length} linhas — "${g.items[0].name.slice(0, 60)}"`);
  g.items.forEach(it => console.log(`      EAN ${it.barcode} stock ${it.stock} preço ${it.cost.toFixed(2)}`));
});
if (groups.length > 5) console.log(DIM(`  …e mais ${groups.length - 5} grupos`));

// 5.2 Análise
section('PASSO 2 — Análise (matching contra Shopify)');
const decisions = buildDecisions(groups, AUTO_MERGE);
const result = doAnalysis({
  parsedRows: rows, colMap, supplier,
  shopifyProducts: fixture.products,
  decisions,
  productAliases, productCanonicals,
});
console.log(`  Found: ${result.found.length}  ·  isNew: ${result.isNew.length}  ·  notFound: ${result.notFound.length}`);
console.log(`  knownBarcodes registados: ${result.knownBarcodes.size}`);

// 5.3 Verificações contra _expect do fixture
section('PASSO 3 — Verificação produto a produto (fixture vs. realidade)');
const verdicts = [];
for (const p of fixture.products) {
  const v = p.variants[0];
  const inFound = result.found.find(f => f.shopifyVariantId === v.id);
  const wantedBarcodes = [v.barcode];   // EAN principal da variante Shopify
  verdicts.push({ product: p, variant: v, inFound });
}

// Casos específicos com expectativas concretas:
const CHECKS = [
  {
    name: 'S26 Ultra 256GB Black — stock somado',
    productId: 'gid://shopify/Product/1001',
    expect: { matched: true, stockApplied: 58 },
    note: 'Ficheiro: EAN ...821250 (1) + ...827221 (57). Variante tem ...827221. Bug SG#2: merge usa ...821250 → match falha OU stock fica errado.',
  },
  {
    name: 'S26 256GB Cobalt Violet — stock somado',
    productId: 'gid://shopify/Product/1002',
    expect: { matched: true, stockApplied: 28 },
    note: 'Ficheiro: ...313 (19) + ...337 (9). Variante tem ...337.',
  },
  {
    name: 'iPhone 17 Pro Max 256GB Cosmic Orange — stock somado',
    productId: 'gid://shopify/Product/1003',
    expect: { matched: true, stockApplied: 109 },
    note: 'Ficheiro: ...025 (9) + ...094 (100). Variante tem ...025 (sortudo). Espero match, mas stock só 9 — bug come o 100.',
  },
  {
    name: 'iPhone 16 128GB Black — match direto',
    productId: 'gid://shopify/Product/1010',
    expect: { matched: true, stockApplied: 9 },
    note: 'Linha única no ficheiro. Controlo positivo.',
  },
  {
    name: 'iPhone 16e 128GB Black — match direto',
    productId: 'gid://shopify/Product/1014',
    expect: { matched: true, stockApplied: 100 },
    note: 'Controlo positivo.',
  },
  {
    name: 'AirPods 4 — match direto',
    productId: 'gid://shopify/Product/3001',
    expect: { matched: true, stockApplied: 100 },
    note: 'Controlo positivo simples.',
  },
];

for (const chk of CHECKS) {
  const v = verdicts.find(x => x.product.id === chk.productId);
  if (!v) { console.log(`${WARN} ${chk.name} — produto não está no fixture?`); continue; }
  const m = v.inFound;
  if (!m) {
    console.log(`${FAIL} ${chk.name}`);
    console.log(`    Variante NÃO foi encontrada (foi tratada como missing/novo).`);
    console.log(`    ${DIM(chk.note)}`);
    continue;
  }
  if (m.stockVal === chk.expect.stockApplied) {
    console.log(`${PASS} ${chk.name} — stock aplicado = ${m.stockVal}`);
  } else {
    console.log(`${FAIL} ${chk.name}`);
    console.log(`    Esperado stock=${chk.expect.stockApplied}, sistema aplicaria stock=${m.stockVal}.`);
    if (m.mergedFrom) console.log(`    Linha veio de merge: barcodes ${m.mergedFrom.join(', ')} → usado ${m.barcode}`);
    console.log(`    ${DIM(chk.note)}`);
  }
}

// 5.4 Produtos que aparecem em isNew quando deveriam ter match
section('PASSO 4 — isNew suspeitos (produtos perdidos pelo matching)');
const suspeitos = result.isNew.filter(r => {
  // Procurar se a variante existe no fixture com algum dos EANs do merge ou da linha
  const candidates = r.mergedFrom || [r.barcode];
  for (const p of fixture.products) {
    for (const v of p.variants) {
      if (candidates.includes(v.barcode)) return true;
    }
  }
  return false;
});
if (suspeitos.length === 0) {
  console.log(`  ${PASS} Nenhum isNew tem barcode que afinal existe no Shopify (bom).`);
} else {
  console.log(`  ${FAIL} ${suspeitos.length} linha(s) classificadas como "Novo" têm EAN que afinal existe no fixture:`);
  suspeitos.forEach(s => {
    console.log(`    • ${s.name.slice(0, 60)}  ·  barcode ${s.barcode}  ·  stock ${s.stockVal}`);
    if (s.mergedFrom) console.log(`        ${DIM('mergedFrom: ' + s.mergedFrom.join(', '))}`);
  });
}

// 5.5 Health check
section('PASSO 5 — Health check (vai propor zerar?)');
const hc = runPostUploadHealthCheck({
  supplier,
  shopifyProducts: fixture.products,
  processedSkus: { skus: result.knownSkus, barcodes: result.knownBarcodes, total: result.uploadTotal },
  uploadHistory: [
    { supplierId: 'teletech', total: 340 },
    { supplierId: 'teletech', total: 330 },
    { supplierId: 'teletech', total: 345 },
  ],
});
console.log(`  Acção sugerida pelo sistema: ${BOLD(hc.action)}`);
console.log(`  coveragePct: ${hc.coveragePct}%   avgExpected: ${hc.avgExpected}   missing: ${hc.missing.length}`);
if (hc.missing.length) {
  console.log(`  Produtos que iriam para o modal de zerar:`);
  hc.missing.forEach(m => {
    const tagged = m.tags.includes('sup:teletech');
    const inFile = result.found.some(f => f.shopifyVariantId === m.variants[0].id);
    const flag = tagged ? '' : ' (NÃO tem sup:teletech — falso positivo grave)';
    console.log(`    • ${m.title}  ·  EAN ${m.variants[0].barcode}${flag}`);
    if (m._expect && !inFile) console.log(`        ${DIM(m._expect)}`);
  });
}

// 5.6 Verdicto global
section('VERDICTO');
const wantedMissingOnly = ['gid://shopify/Product/1011', 'gid://shopify/Product/1012', 'gid://shopify/Product/1013'];
const actualMissing = hc.missing.map(m => m.id);
const falseZeros = actualMissing.filter(id => {
  // Produtos cujo barcode/sku ESTÁ no ficheiro mas foram para missing → falso positivo
  const p = fixture.products.find(x => x.id === id);
  if (!p) return false;
  const v = p.variants[0];
  return rows.some(r => String(r['EAN-13']) === v.barcode);
});

if (falseZeros.length) {
  console.log(`  ${FAIL} ${falseZeros.length} produto(s) iriam para zerar apesar de o seu EAN estar no ficheiro:`);
  falseZeros.forEach(id => {
    const p = fixture.products.find(x => x.id === id);
    console.log(`    • ${p.title}  ·  EAN ${p.variants[0].barcode}`);
  });
} else {
  console.log(`  ${PASS} Nenhum produto seria zerado tendo o EAN no ficheiro.`);
}

console.log(`\n  ${DIM('Re-correr com:')} node tests/run-teletech.mjs`);
console.log(`  ${DIM('Após aplicar fixes em index.html, copia a lógica nova para tests/lib/upload-logic.mjs e volta a correr — diff visível.')}`);
