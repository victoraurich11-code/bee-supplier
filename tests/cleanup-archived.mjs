#!/usr/bin/env node
// Limpeza de archived em 2 acções:
//   APAGAR: archived SAFE (sem barcode, sem stock) + "marketing antigos" (S26/iPhone 17 substituídos)
//   REACTIVAR: tablets (produtos viáveis que estavam acidentalmente archived)
//
// DRY-RUN por defeito. EXECUTE=1 para correr.

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

// Padrões para distinguir "marketing antigo" (apagar) vs "tablet" (reactivar)
// Marketing antigo: títulos com travessão "—" + mensagem promocional (em vez de spec)
const MARKETING_PATTERNS = [
  /Standard de Performance/i,
  /Potência e Inovação/i,
  /Equilíbrio Perfeito/i,
  /Flagship que a Colmeia/i,
  /Topo da Colmeia/i,
  /Colmeia sem Limites/i,
  /Inteligência sem Compromissos/i,
];
const isTablet = (title) => /^Tablet /i.test(title);
const isMarketing = (title) => MARKETING_PATTERNS.some(re => re.test(title));

console.log(`MODO: ${EXECUTE ? '🔴 EXECUTE' : '🟢 DRY-RUN'}\n`);

console.log('A carregar archived...');
const archived = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:100, after:$c, query:"status:archived"){
      pageInfo{hasNextPage endCursor}
      edges{node{
        id title
        variants(first:25){edges{node{id sku barcode inventoryQuantity}}}
      }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    const totalStock = pe.node.variants.edges.reduce((s, v) => s + (v.node.inventoryQuantity || 0), 0);
    const hasBarcode = pe.node.variants.edges.some(v => (v.node.barcode || '').trim());
    archived.push({ id: pe.node.id, title: pe.node.title, totalStock, hasBarcode });
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

// Categorizar
const toDeleteSafe = archived.filter(p => !p.hasBarcode && p.totalStock === 0);
const toDeleteMarketing = archived.filter(p => isMarketing(p.title) && (p.hasBarcode || p.totalStock > 0));
const toReactivate = archived.filter(p => isTablet(p.title));
const uncategorized = archived.filter(p =>
  !toDeleteSafe.includes(p) && !toDeleteMarketing.includes(p) && !toReactivate.includes(p)
);

console.log(`\n🗑  APAGAR SAFE (${toDeleteSafe.length})`);
toDeleteSafe.forEach(p => console.log(`  • ${p.title.slice(0, 80)}`));

console.log(`\n🗑  APAGAR MARKETING ANTIGOS (${toDeleteMarketing.length})`);
toDeleteMarketing.forEach(p => console.log(`  • ${p.title.slice(0, 80)}  ${p.totalStock > 0 ? `(perde stock ${p.totalStock})` : ''}`));

console.log(`\n♻️  REACTIVAR TABLETS (${toReactivate.length})`);
toReactivate.forEach(p => console.log(`  • ${p.title.slice(0, 80)}  (stock ${p.totalStock})`));

if (uncategorized.length) {
  console.log(`\n⚠️  NÃO CLASSIFICADO (${uncategorized.length}) — sem acção`);
  uncategorized.forEach(p => console.log(`  • ${p.title.slice(0, 80)}  (stock ${p.totalStock})`));
}

if (!EXECUTE) {
  console.log('\n→ DRY-RUN. EXECUTE=1 para correr.');
  process.exit(0);
}

// Executar
async function deleteOne(p) {
  const r = await shopifyGQL(`mutation($id:ID!){
    productDelete(input:{id:$id}){deletedProductId userErrors{message}}
  }`, { id: p.id });
  if (r.productDelete.userErrors.length) throw new Error(r.productDelete.userErrors.map(e => e.message).join('; '));
}
async function reactivateOne(p) {
  const r = await shopifyGQL(`mutation($input:ProductUpdateInput!){
    productUpdate(product:$input){product{id status}userErrors{message}}
  }`, { input: { id: p.id, status: 'ACTIVE' } });
  if (r.productUpdate.userErrors.length) throw new Error(r.productUpdate.userErrors.map(e => e.message).join('; '));
}

let del = 0, delFail = 0, rea = 0, reaFail = 0;

console.log('\nA apagar SAFE...');
for (const p of toDeleteSafe) {
  try { await deleteOne(p); console.log(`  ✓ ${p.title.slice(0, 70)}`); del++; }
  catch (e) { console.log(`  ✗ ${p.title.slice(0, 70)} — ${e.message}`); delFail++; }
  await new Promise(r => setTimeout(r, 350));
}
console.log('\nA apagar MARKETING ANTIGOS...');
for (const p of toDeleteMarketing) {
  try { await deleteOne(p); console.log(`  ✓ ${p.title.slice(0, 70)}`); del++; }
  catch (e) { console.log(`  ✗ ${p.title.slice(0, 70)} — ${e.message}`); delFail++; }
  await new Promise(r => setTimeout(r, 350));
}
console.log('\nA reactivar TABLETS...');
for (const p of toReactivate) {
  try { await reactivateOne(p); console.log(`  ✓ ${p.title.slice(0, 70)}`); rea++; }
  catch (e) { console.log(`  ✗ ${p.title.slice(0, 70)} — ${e.message}`); reaFail++; }
  await new Promise(r => setTimeout(r, 350));
}

console.log(`\nResumo:`);
console.log(`  Apagados:    ${del}  (falhas: ${delFail})`);
console.log(`  Reactivados: ${rea}  (falhas: ${reaFail})`);
