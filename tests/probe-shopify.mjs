#!/usr/bin/env node
// Probe directo a casos específicos para diagnóstico.
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

// Casos a investigar (EANs vindos da Stocklist 15.05)
const CASES = [
  { name: 'iPhone 17 Pro Max 256GB Cosmic Orange', eans: ['0195950639025', '0195950639094'] },
  { name: 'Apple Airtag 4 Pack White',              eans: ['0195949686641', '0190199535046'] },
  { name: 'Samsung Galaxy A16 128GB Black',         eans: ['8806095822334', '8806095822365'] },
];

for (const c of CASES) {
  console.log(`\n═══ ${c.name} ═══`);
  for (const ean of c.eans) {
    const data = await shopifyGQL(`query($q:String!){
      products(first:5, query:$q){edges{node{
        id title status tags
        variants(first:25){edges{node{id sku barcode inventoryQuantity}}}
      }}}
    }`, { q: `barcode:${ean}` });
    const found = [];
    for (const pe of data.products.edges) {
      for (const ve of pe.node.variants.edges) {
        if (ve.node.barcode === ean) {
          found.push({
            title: pe.node.title,
            status: pe.node.status,
            tags: pe.node.tags.filter(t => t.startsWith('sup:') || t.startsWith('cat:') || t.startsWith('last-seen:') || t.startsWith('bsm:')).join(', '),
            sku: ve.node.sku,
            stock: ve.node.inventoryQuantity,
          });
        }
      }
    }
    if (!found.length) {
      console.log(`  EAN ${ean} → ⚠ não encontrado em nenhuma variante`);
    } else {
      for (const f of found) {
        console.log(`  EAN ${ean} → ${f.status} · stock ${f.stock} · "${f.title.slice(0,60)}"`);
        console.log(`            SKU ${f.sku || '—'} · tags [${f.tags || '—'}]`);
      }
    }
  }
}

// E também: qual é o stock actual do iPhone 17 Pro Max Cosmic Orange via tags?
console.log('\n═══ Procura por título (não por EAN) — iPhone 17 Pro Max Cosmic Orange ═══');
const d = await shopifyGQL(`query{
  products(first:10, query:"title:iPhone 17 Pro Max 256 Cosmic Orange"){edges{node{
    id title status tags
    variants(first:5){edges{node{id sku barcode inventoryQuantity}}}
  }}}
}`);
for (const pe of d.products.edges) {
  console.log(`  • ${pe.node.title}  (${pe.node.status})`);
  console.log(`      tags: ${pe.node.tags.filter(t => t.startsWith('sup:') || t.startsWith('cat:') || t.startsWith('last-seen:') || t.startsWith('bsm:')).join(', ') || '(nenhuma sup:/cat:/bsm: tag)'}`);
  for (const ve of pe.node.variants.edges) {
    console.log(`      variant SKU ${ve.node.sku || '—'} · barcode ${ve.node.barcode || '—'} · stock ${ve.node.inventoryQuantity ?? '?'}`);
  }
}
