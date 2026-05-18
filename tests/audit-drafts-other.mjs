#!/usr/bin/env node
// Lista os drafts NÃO-espanhol agrupados por vendor / categoria.
// Ajuda a decidir o que fazer com os 753 drafts "outros".

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

const ES_WORDS = /\b(Altavoz|Tableta|Bater[íi]a|Cargador|Ratón|Aurícular(es)?|Auriculares|Funda|Cubierta|Pulsera|Imp(resora|resión)|Para |Disipador|Caja Externa|Soporte|Placa Base|Ventilador|Procesador|Inalámbrico|Regleta|Organizador)\b/i;

console.log('A carregar drafts...');
const drafts = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:100, after:$c, query:"status:draft"){
      pageInfo{hasNextPage endCursor}
      edges{node{
        id title vendor productType
        tags
        variants(first:25){edges{node{id sku barcode inventoryQuantity}}}
      }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) drafts.push(pe.node);
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

const others = drafts.filter(p => !ES_WORDS.test(p.title));
console.log(`Drafts não-ES: ${others.length}\n`);

// Agrupar por vendor
const byVendor = new Map();
for (const p of others) {
  const v = p.vendor || '(sem vendor)';
  if (!byVendor.has(v)) byVendor.set(v, []);
  byVendor.get(v).push(p);
}
console.log('Por vendor:');
const sortedV = [...byVendor.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [v, ps] of sortedV) {
  const totalStock = ps.reduce((s, p) => s + p.variants.edges.reduce((a, ve) => a + (ve.node.inventoryQuantity || 0), 0), 0);
  const withBC = ps.filter(p => p.variants.edges.some(ve => ve.node.barcode)).length;
  console.log(`  ${v.padEnd(30)}  ${String(ps.length).padStart(4)} drafts  stock total ${String(totalStock).padStart(5)}  c/barcode ${withBC}`);
}

// Agrupar por tag sup:
console.log('\nPor tag sup:');
const bySup = new Map();
for (const p of others) {
  const s = (p.tags || []).find(t => t.startsWith('sup:')) || '(sem sup:)';
  if (!bySup.has(s)) bySup.set(s, []);
  bySup.get(s).push(p);
}
const sortedS = [...bySup.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [s, ps] of sortedS) {
  console.log(`  ${s.padEnd(40)}  ${String(ps.length).padStart(4)} drafts`);
}

// Sub-grupos suspeitos
console.log('\nSub-grupos suspeitos:');
const empty = others.filter(p => p.variants.edges.every(ve => !ve.node.barcode && !ve.node.inventoryQuantity));
console.log(`  Drafts sem barcode E sem stock:                ${empty.length}  ← candidatos a apagar`);
const noBC = others.filter(p => p.variants.edges.every(ve => !ve.node.barcode));
console.log(`  Drafts sem barcode (qualquer stock):           ${noBC.length}`);
const sampleEmpty = empty.slice(0, 10);
sampleEmpty.forEach(p => console.log(`     • ${p.title.slice(0, 80)}`));
