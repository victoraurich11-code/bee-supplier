#!/usr/bin/env node
// Lista produtos archived e draft com diagnóstico para decidir limpeza.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';

async function shopifyGQL(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()).data;
}

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

console.log('A carregar produtos archived + draft...');
const products = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:100, after:$c, query:"status:archived OR status:draft"){
      pageInfo{hasNextPage endCursor}
      edges{node{
        id title status vendor productType createdAt updatedAt
        tags
        variants(first:25){edges{node{id sku barcode inventoryQuantity}}}
      }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) products.push(pe.node);
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

const archived = products.filter(p => p.status === 'ARCHIVED');
const drafts = products.filter(p => p.status === 'DRAFT');

console.log(`\nArchived: ${archived.length}  ·  Drafts: ${drafts.length}\n`);

// ─── ARCHIVED ─────────────────────────────────────────────────────────────────
console.log(BOLD('═══════════════════════════════════════════════════════════════════════'));
console.log(BOLD(`ARCHIVED (${archived.length})`));
console.log(BOLD('═══════════════════════════════════════════════════════════════════════'));

// Classificação:
//   SAFE — sem barcode em nenhuma variante E stock total = 0 (candidatos a delete)
//   HOLDS_STOCK — alguma variante tem stock > 0
//   HOLDS_BARCODE — alguma variante ainda tem barcode (pode estar a roubar matching)
const a_safe = [], a_stock = [], a_bc = [];
for (const p of archived) {
  const totalStock = p.variants.edges.reduce((s, v) => s + (v.node.inventoryQuantity || 0), 0);
  const hasBarcode = p.variants.edges.some(v => (v.node.barcode || '').trim());
  if (hasBarcode) a_bc.push({ p, totalStock });
  else if (totalStock > 0) a_stock.push({ p, totalStock });
  else a_safe.push({ p, totalStock });
}

console.log(`\n${PASS} SAFE a apagar (${a_safe.length}) — sem barcode E stock 0`);
a_safe.slice(0, 30).forEach(({ p }) => {
  const t = (p.tags || []).filter(x => x.startsWith('sup:')).join(', ') || DIM('(sem sup:)');
  console.log(`   • ${p.title.slice(0, 80)}`);
  console.log(`     ${t}  ${DIM('· criado ' + p.createdAt.slice(0, 10) + ' · ' + p.variants.edges.length + ' variante(s)')}`);
});
if (a_safe.length > 30) console.log(DIM(`   …e mais ${a_safe.length - 30}`));

console.log(`\n${WARN} CONTÊM BARCODE (${a_bc.length}) — não devem ser apagados sem ver`);
a_bc.forEach(({ p, totalStock }) => {
  console.log(`   • ${p.title.slice(0, 80)} ${DIM(`(stock ${totalStock})`)}`);
  for (const v of p.variants.edges.slice(0, 3)) {
    if (v.node.barcode) console.log(`     barcode ${v.node.barcode}  stock ${v.node.inventoryQuantity}`);
  }
});

console.log(`\n${WARN} CONTÊM STOCK > 0 SEM BARCODE (${a_stock.length}) — verificar antes de apagar`);
a_stock.forEach(({ p, totalStock }) => {
  console.log(`   • ${p.title.slice(0, 80)} ${DIM(`(stock ${totalStock})`)}`);
});

// ─── DRAFTS ───────────────────────────────────────────────────────────────────
console.log('\n' + BOLD('═══════════════════════════════════════════════════════════════════════'));
console.log(BOLD(`DRAFTS (${drafts.length})`));
console.log(BOLD('═══════════════════════════════════════════════════════════════════════'));

// Classificação:
//   ES — título parece em espanhol (heurística: "Altavoz", "Tableta", "Ratón", "/", numerais com /)
//   NEW_PT — título PT, em construção
//   ORPHAN — sem variantes ou sem nada útil
const isSpanish = (s) => /\b(Altavoz|Tableta|Bater[íi]a|Cargador|Ratón|Auriculares|Funda|Cubierta|Pulsera|Imp(resora|resión)|Para)\b/i.test(s)
                          || /\/[A-Z]/.test(s);
const d_es = [], d_ptnew = [], d_other = [];
for (const p of drafts) {
  if (isSpanish(p.title)) d_es.push(p);
  else d_other.push(p);
}

console.log(`\nDraft "ES" (provavelmente espanhol, candidato a apagar): ${d_es.length}`);
d_es.slice(0, 50).forEach(p => {
  const totalStock = p.variants.edges.reduce((s, v) => s + (v.node.inventoryQuantity || 0), 0);
  const bc = p.variants.edges.map(v => v.node.barcode).filter(Boolean);
  console.log(`   • ${p.title.slice(0, 80)} ${DIM(`(stock ${totalStock}, ${bc.length} barcode(s))`)}`);
});
if (d_es.length > 50) console.log(DIM(`   …e mais ${d_es.length - 50}`));

console.log(`\nOutros drafts (${d_other.length}):`);
d_other.slice(0, 50).forEach(p => {
  const totalStock = p.variants.edges.reduce((s, v) => s + (v.node.inventoryQuantity || 0), 0);
  const bc = p.variants.edges.map(v => v.node.barcode).filter(Boolean);
  console.log(`   • ${p.title.slice(0, 80)} ${DIM(`(stock ${totalStock}, ${bc.length} barcode(s))`)}`);
});

// ─── RESUMO ───────────────────────────────────────────────────────────────────
console.log('\n' + BOLD('═══ RESUMO ═══'));
console.log(`  Archived total:           ${archived.length}`);
console.log(`    SAFE a apagar:          ${a_safe.length}   ← prontos`);
console.log(`    com barcode:            ${a_bc.length}   ← rever`);
console.log(`    com stock sem barcode:  ${a_stock.length}   ← rever`);
console.log(`  Drafts total:             ${drafts.length}`);
console.log(`    espanhol (candidatos):  ${d_es.length}`);
console.log(`    outros:                 ${d_other.length}`);
