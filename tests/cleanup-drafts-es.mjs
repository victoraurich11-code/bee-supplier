#!/usr/bin/env node
// Apaga drafts em espanhol (versões antigas Depau ES substituídas por traduções PT).
// Heurística usa palavras-chave espanholas para identificar.

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

// Mesma heurística do audit. Mais conservadora: pelo menos 1 palavra ES forte.
const ES_WORDS = /\b(Altavoz|Tableta|Bater[íi]a|Cargador|Ratón|Aurícular(es)?|Auriculares|Funda|Cubierta|Pulsera|Imp(resora|resión)|Para |Disipador|Caja Externa|Soporte|Placa Base|Ventilador|Procesador|Inalámbrico|Regleta|Organizador)\b/i;
const isSpanish = (s) => ES_WORDS.test(s);

console.log(`MODO: ${EXECUTE ? '🔴 EXECUTE' : '🟢 DRY-RUN'}\n`);

console.log('A carregar drafts...');
const drafts = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:100, after:$c, query:"status:draft"){
      pageInfo{hasNextPage endCursor}
      edges{node{ id title variants(first:5){edges{node{id barcode inventoryQuantity}}} }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) drafts.push(pe.node);
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

const toDelete = drafts.filter(p => isSpanish(p.title));
console.log(`\nDrafts total: ${drafts.length}`);
console.log(`Drafts ES a apagar: ${toDelete.length}\n`);

// Sample show
toDelete.slice(0, 20).forEach(p => {
  const totalStock = p.variants.edges.reduce((s, v) => s + (v.node.inventoryQuantity || 0), 0);
  console.log(`  • ${p.title.slice(0, 80)}  (stock ${totalStock})`);
});
if (toDelete.length > 20) console.log(`  …e mais ${toDelete.length - 20}\n`);

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
    if (ok % 20 === 0) console.log(`  ... ${ok}/${toDelete.length}`);
  } catch (e) {
    console.log(`  ✗ ${p.title.slice(0, 70)} — ${e.message}`);
    fail++;
  }
  await new Promise(r => setTimeout(r, 350));   // 350ms entre cada → ~3/s
}

console.log(`\nResumo: ${ok}/${toDelete.length} apagados (falhas: ${fail})`);
