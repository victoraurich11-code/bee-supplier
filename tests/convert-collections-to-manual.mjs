#!/usr/bin/env node
// Converte colecções com sortOrder != MANUAL para MANUAL.
// Shopify preserva a ordem actual (a que seria gerada por BEST_SELLING/etc.)
// como base manual. Após isto, a função Categorias da app consegue reordenar.
//
// DRY-RUN por defeito. EXECUTE=1 para correr.
//
// Filtros opcionais via env:
//   ONLY_WITH_PRODUCTS=1   (default) só colecções com produtos
//   FROM=BEST_SELLING       (default) só converte se sortOrder for este (use "ANY" para todas)
//   MAX=999                 cap de segurança

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
const FROM = process.env.FROM || 'BEST_SELLING';
const ONLY_WITH_PRODUCTS = process.env.ONLY_WITH_PRODUCTS !== '0';
const MAX = parseInt(process.env.MAX || '999');

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

console.log(`MODO: ${EXECUTE ? '🔴 EXECUTE' : '🟢 DRY-RUN'}`);
console.log(`Filtro: sortOrder ${FROM === 'ANY' ? '!= MANUAL' : `== ${FROM}`}, ${ONLY_WITH_PRODUCTS ? 'só com produtos' : 'todas'}`);
console.log(`Cap: max ${MAX} colecções\n`);

console.log('A carregar colecções...');
const all = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    collections(first:100, after:$c){
      pageInfo{hasNextPage endCursor}
      edges{node{id title handle sortOrder productsCount{count}}}
    }
  }`, { c: cursor });
  for (const e of d.collections.edges) {
    all.push({
      id: e.node.id,
      title: e.node.title,
      sortOrder: e.node.sortOrder,
      productsCount: e.node.productsCount?.count ?? 0,
    });
  }
  hasNext = d.collections.pageInfo.hasNextPage;
  cursor = d.collections.pageInfo.endCursor;
}

const target = all.filter(c => {
  if (FROM !== 'ANY' && c.sortOrder !== FROM) return false;
  if (FROM === 'ANY' && c.sortOrder === 'MANUAL') return false;
  if (ONLY_WITH_PRODUCTS && c.productsCount === 0) return false;
  return true;
}).slice(0, MAX);

console.log(`\n${target.length} colecção(ões) a converter para MANUAL:\n`);
target.forEach(c => console.log(`  • ${c.title.padEnd(50)} (${c.sortOrder}, ${c.productsCount} produtos)`));

if (!EXECUTE) {
  console.log('\n→ DRY-RUN. EXECUTE=1 para correr.\n');
  process.exit(0);
}

console.log('\nA converter...');
let ok = 0, fail = 0;
for (const c of target) {
  try {
    const r = await shopifyGQL(`mutation($input:CollectionInput!){
      collectionUpdate(input:$input){
        collection{id sortOrder}
        userErrors{message field}
      }
    }`, { input: { id: c.id, sortOrder: 'MANUAL' } });
    if (r.collectionUpdate.userErrors.length) {
      throw new Error(r.collectionUpdate.userErrors.map(e => e.message).join('; '));
    }
    console.log(`  ✓ ${c.title.slice(0, 60)}`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${c.title.slice(0, 60)} — ${e.message}`);
    fail++;
  }
  await new Promise(r => setTimeout(r, 350));
}

console.log(`\nResumo: ${ok} convertidas, ${fail} falhas.`);
console.log('\n💡 Próximo passo: na app, vai a "Categorias" → "Reordenar todas" para pôr esgotados ao fim.');
