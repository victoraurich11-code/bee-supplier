#!/usr/bin/env node
// Limpeza agressiva: apaga drafts lixo (sem barcode E sem stock) + drafts Depau.
// Mantém drafts PT em construção, drafts Teletech/Tek4life e drafts sem-sup que tenham
// barcode ou stock (provavelmente em construção).

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
const EXECUTE = process.env.EXECUTE === '1';

async function shopifyGQL(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

console.log(`MODO: ${EXECUTE ? '🔴 EXECUTE' : '🟢 DRY-RUN'}\n`);

console.log('A carregar drafts...');
const drafts = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:100, after:$c, query:"status:draft"){
      pageInfo{hasNextPage endCursor}
      edges{node{
        id title tags
        variants(first:25){edges{node{barcode inventoryQuantity}}}
      }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    const totalStock = pe.node.variants.edges.reduce((s, v) => s + (v.node.inventoryQuantity || 0), 0);
    const hasBarcode = pe.node.variants.edges.some(v => (v.node.barcode || '').trim());
    const supTag = (pe.node.tags || []).find(t => t.startsWith('sup:')) || '';
    drafts.push({ id: pe.node.id, title: pe.node.title, totalStock, hasBarcode, supTag });
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

// Filtrar:
//   A) lixo: sem barcode E sem stock E sem tag sup:
//   B) Depau drafts (todos)
const trash = drafts.filter(p => !p.hasBarcode && p.totalStock === 0);
const depau = drafts.filter(p => p.supTag === 'sup:sup_depau_mnrarxzm');
// Unir (sem duplicar)
const toDeleteIds = new Set();
const toDelete = [];
for (const p of [...trash, ...depau]) {
  if (!toDeleteIds.has(p.id)) {
    toDeleteIds.add(p.id);
    toDelete.push(p);
  }
}

console.log(`\nDrafts total:     ${drafts.length}`);
console.log(`Lixo (sem bc/stk): ${trash.length}`);
console.log(`Depau drafts:      ${depau.length}`);
console.log(`A apagar (union):  ${toDelete.length}\n`);

console.log('Amostra (primeiros 20 a apagar):');
toDelete.slice(0, 20).forEach(p => {
  console.log(`  • ${p.title.slice(0, 80)} ${p.supTag ? `[${p.supTag.replace('sup:','')}]` : ''} stock ${p.totalStock}`);
});

if (!EXECUTE) {
  console.log('\n→ DRY-RUN. EXECUTE=1 para correr.');
  process.exit(0);
}

console.log('\nA apagar...');
let ok = 0, fail = 0;
for (const p of toDelete) {
  try {
    const r = await shopifyGQL(`mutation($id:ID!){
      productDelete(input:{id:$id}){deletedProductId userErrors{message}}
    }`, { id: p.id });
    if (r.productDelete.userErrors.length) throw new Error(r.productDelete.userErrors.map(e => e.message).join('; '));
    ok++;
    if (ok % 50 === 0) console.log(`  ... ${ok}/${toDelete.length}`);
  } catch (e) {
    console.log(`  ✗ ${p.title.slice(0, 70)} — ${e.message}`);
    fail++;
  }
  await new Promise(r => setTimeout(r, 350));
}

console.log(`\nResumo: ${ok}/${toDelete.length} apagados (falhas: ${fail})`);
