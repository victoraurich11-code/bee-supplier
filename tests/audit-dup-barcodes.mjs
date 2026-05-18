#!/usr/bin/env node
// Audita EANs duplicados entre variantes Shopify:
//   1. Mesmo EAN em variantes ARCHIVED + ACTIVE → archived rouba o stock
//   2. Mesmo EAN em 2+ variantes ACTIVE diferentes → matching ambíguo
//   3. Active sem tag sup:* ou com tag de fornecedor "errado" (cruza com EANs Teletech 15.05)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';

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

console.log('A carregar TODOS os produtos (active + draft + archived) com paginação...');
const all = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:100, after:$c){
      pageInfo{hasNextPage endCursor}
      edges{node{
        id title status tags
        variants(first:25){edges{node{id sku barcode inventoryQuantity}}}
      }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    for (const ve of pe.node.variants.edges) {
      if (ve.node.barcode) {
        all.push({
          productId: pe.node.id,
          productTitle: pe.node.title,
          productStatus: pe.node.status,
          supTag: (pe.node.tags || []).find(t => t.startsWith('sup:')) || '',
          allSupTags: (pe.node.tags || []).filter(t => t.startsWith('sup:')),
          variantId: ve.node.id,
          sku: ve.node.sku || '',
          barcode: ve.node.barcode.trim(),
          stock: ve.node.inventoryQuantity ?? 0,
        });
      }
    }
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}
console.log(`Variantes com barcode: ${all.length}\n`);

// 1. EANs duplicados entre variantes
const byEan = new Map();
for (const v of all) {
  if (!byEan.has(v.barcode)) byEan.set(v.barcode, []);
  byEan.get(v.barcode).push(v);
}
const dups = [...byEan.entries()].filter(([_, vs]) => vs.length > 1);
console.log(`═══ EANs duplicados entre variantes: ${dups.length} ═══`);
let archivedVsActive = 0, multiActive = 0;
for (const [ean, vs] of dups) {
  const statuses = new Set(vs.map(v => v.productStatus));
  const hasArchived = statuses.has('ARCHIVED');
  const activeCount = vs.filter(v => v.productStatus === 'ACTIVE').length;
  const tag = hasArchived && activeCount > 0 ? '[archived+active]'
            : activeCount > 1 ? '[2+ active]'
            : '[outro]';
  if (hasArchived && activeCount > 0) archivedVsActive++;
  if (activeCount > 1) multiActive++;
  console.log(`\n  ${tag} EAN ${ean}`);
  for (const v of vs) {
    const stockColor = v.stock > 0 ? `\x1b[32m${v.stock}\x1b[0m` : `\x1b[2m${v.stock}\x1b[0m`;
    const statusColor = v.productStatus === 'ARCHIVED' ? `\x1b[33m${v.productStatus}\x1b[0m` : `\x1b[36m${v.productStatus}\x1b[0m`;
    console.log(`    ${statusColor.padEnd(20)}  stock ${stockColor}  ${v.supTag || '(sem sup:)'}`);
    console.log(`      "${v.productTitle.slice(0, 80)}"`);
  }
}

console.log('\n═══ RESUMO ═══');
console.log(`  EANs duplicados (total):                 ${dups.length}`);
console.log(`  Casos archived ↔ active (stock perdido): ${archivedVsActive}`);
console.log(`  Casos 2+ active (matching ambíguo):      ${multiActive}`);
