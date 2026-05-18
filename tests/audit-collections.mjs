#!/usr/bin/env node
// Lista todas as collections com sortOrder + productsCount.
// Quem está em MANUAL vai conseguir ser reordenado pela app.
// Quem não está, vai ser saltado.

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

const cols = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    collections(first:100, after:$c){
      pageInfo{hasNextPage endCursor}
      edges{node{id title handle sortOrder productsCount{count}}}
    }
  }`, { c: cursor });
  for (const e of d.collections.edges) {
    cols.push({
      title: e.node.title,
      handle: e.node.handle,
      sortOrder: e.node.sortOrder,
      productsCount: e.node.productsCount?.count ?? 0,
    });
  }
  hasNext = d.collections.pageInfo.hasNextPage;
  cursor = d.collections.pageInfo.endCursor;
}

console.log(`Total collections: ${cols.length}\n`);

const byOrder = new Map();
for (const c of cols) {
  if (!byOrder.has(c.sortOrder)) byOrder.set(c.sortOrder, []);
  byOrder.get(c.sortOrder).push(c);
}
const sorted = [...byOrder.entries()].sort((a, b) => b[1].length - a[1].length);
console.log('Por sortOrder:');
for (const [order, list] of sorted) {
  const withProducts = list.filter(c => c.productsCount > 0).length;
  const ok = order === 'MANUAL' ? '✓ reordenável' : '✕ não reordenável (Shopify limita)';
  console.log(`  ${order.padEnd(20)}  ${String(list.length).padStart(3)} collections (${withProducts} com produtos)  ${ok}`);
}

const manual = cols.filter(c => c.sortOrder === 'MANUAL' && c.productsCount > 0);
const notManual = cols.filter(c => c.sortOrder !== 'MANUAL' && c.productsCount > 0);

console.log(`\n📋 ${manual.length} collections MANUAL com produtos (a app pode reordenar):`);
manual.forEach(c => console.log(`  • ${c.title.padEnd(45)} ${c.productsCount} produtos`));

console.log(`\n⚠️  ${notManual.length} collections NÃO-MANUAL com produtos (a app salta):`);
notManual.slice(0, 30).forEach(c => console.log(`  • ${c.title.padEnd(45)} sortOrder=${c.sortOrder}  (${c.productsCount} produtos)`));
if (notManual.length > 30) console.log(`  …e mais ${notManual.length - 30}`);
