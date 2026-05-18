#!/usr/bin/env node
// Snapshot do estado final do catálogo após toda a limpeza.
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

async function countByStatus(status) {
  let total = 0, cursor = null, hasNext = true;
  while (hasNext) {
    const d = await shopifyGQL(`query($c:String){
      products(first:250, after:$c, query:"status:${status}"){
        pageInfo{hasNextPage endCursor}
        edges{node{id tags variants(first:25){edges{node{barcode}}}}}
      }
    }`, { c: cursor });
    total += d.products.edges.length;
    hasNext = d.products.pageInfo.hasNextPage;
    cursor = d.products.pageInfo.endCursor;
  }
  return total;
}

const PASS = '\x1b[32m✓\x1b[0m';
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

console.log(BOLD('\n══════════════════════════════════════════════'));
console.log(BOLD('SNAPSHOT FINAL DO CATÁLOGO'));
console.log(BOLD('══════════════════════════════════════════════'));

const active = await countByStatus('active');
const draft = await countByStatus('draft');
const archived = await countByStatus('archived');
console.log(`\n  Produtos ACTIVE:   ${active}`);
console.log(`  Produtos DRAFT:    ${draft}`);
console.log(`  Produtos ARCHIVED: ${archived}`);
console.log(`  TOTAL:             ${active + draft + archived}`);

// Tags sup:*
console.log('\nTags sup:* no catálogo (active):');
const tagCounts = new Map();
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:250, after:$c, query:"status:active"){
      pageInfo{hasNextPage endCursor}
      edges{node{tags}}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    for (const t of pe.node.tags) {
      if (t.startsWith('sup:')) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}
const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, c] of sorted) console.log(`  ${t.padEnd(40)}  ${c} produtos`);
