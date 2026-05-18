#!/usr/bin/env node
// Lista todas as tags sup:* presentes nos produtos active da Shopify e conta.
// Identifica órfãs (tags que não correspondem a nenhum cartão de fornecedor
// no formato actual `sup_<nome>_<timestamp>` ou um id simples).
//
// Não escreve nada — só lê.

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
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

console.log('A carregar todos os produtos active da Shopify...');
const tagCounts = new Map();   // tag → count
const tagToProducts = new Map(); // tag → [{ id, title, status }]
let cursor = null, hasNext = true, total = 0;

while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:250, after:$c, query:"status:active"){
      pageInfo{hasNextPage endCursor}
      edges{node{ id title status tags }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    total++;
    for (const t of pe.node.tags) {
      if (!t.startsWith('sup:')) continue;
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      if (!tagToProducts.has(t)) tagToProducts.set(t, []);
      if (tagToProducts.get(t).length < 5) {
        tagToProducts.get(t).push({ id: pe.node.id, title: pe.node.title });
      }
    }
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

console.log(`\nProdutos active: ${total}\n`);
console.log('Tags sup:* encontradas (ordenadas por contagem):');
const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [tag, count] of sorted) {
  console.log(`\n  ${tag}  →  ${count} produto(s)`);
  const samples = tagToProducts.get(tag) || [];
  samples.forEach(s => console.log(`     · ${s.title.slice(0, 70)}`));
  if (count > samples.length) console.log(`     · ... e mais ${count - samples.length}`);
}

console.log(`\n${sorted.length} tag(s) sup:* distinta(s) detetada(s).`);
