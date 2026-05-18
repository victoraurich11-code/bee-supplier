#!/usr/bin/env node
// Tenta encontrar os S26 na Shopify usando várias estratégias de pesquisa.
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

async function search(q, label) {
  const d = await shopifyGQL(`query($q:String!){
    products(first:50, query:$q){edges{node{id title status tags variants(first:5){edges{node{id sku barcode inventoryQuantity}}}}}}
  }`, { q });
  console.log(`\n[${label}]  query: "${q}"  →  ${d.products.edges.length} resultado(s)`);
  d.products.edges.slice(0, 5).forEach(pe => {
    console.log(`  • ${pe.node.title}  (${pe.node.status})`);
    pe.node.variants.edges.forEach(ve => {
      console.log(`      barcode ${ve.node.barcode || '—'}  stock ${ve.node.inventoryQuantity ?? '?'}`);
    });
  });
  return d.products.edges;
}

await search('title:S26', 'TEST 1');
await search('title:S26 status:active', 'TEST 2');
await search('title:"S26"', 'TEST 3');
await search('"Galaxy S26"', 'TEST 4');
await search('title:Galaxy S26', 'TEST 5');
await search('vendor:Samsung product_type:Smartphone', 'TEST 6');

// E vamos confirmar com lookup por EAN directo
console.log('\n\n═══ Lookup por EAN específico de S26 ═══');
const TEST_EANS = [
  '8806097827221',  // S26 Ultra 256GB Black (confirmado preenchido pelo user)
  '8806097827467',  // S26 256GB Black
  '8806097827122',  // S26 Ultra 1TB Black
  '8806097828303',  // S26+ 512GB Black
];
for (const ean of TEST_EANS) {
  const d = await shopifyGQL(`query($q:String!){
    products(first:5, query:$q){edges{node{id title status tags variants(first:25){edges{node{id sku barcode inventoryQuantity}}}}}}
  }`, { q: `barcode:${ean}` });
  console.log(`\nEAN ${ean}:`);
  if (!d.products.edges.length) { console.log('  ⚠ nenhum produto'); continue; }
  for (const pe of d.products.edges) {
    for (const ve of pe.node.variants.edges) {
      if (ve.node.barcode === ean) {
        const supTag = (pe.node.tags || []).find(t => t.startsWith('sup:')) || '(sem sup:)';
        console.log(`  → "${pe.node.title}"  status ${pe.node.status}  stock ${ve.node.inventoryQuantity}`);
        console.log(`     ${supTag}`);
      }
    }
  }
}
