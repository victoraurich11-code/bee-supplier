#!/usr/bin/env node
// Migração de tag órfã: renomeia `sup:teletech` → `sup:sup_teletech_mnhivma4`
// em todos os produtos active que tenham a tag antiga.
//
// DRY-RUN por defeito (lista o que faria). Para executar:
//   EXECUTE=1 node tests/migrate-tag.mjs
//
// Configurável via env:
//   FROM_TAG=sup:teletech
//   TO_TAG=sup:sup_teletech_mnhivma4

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
const FROM = process.env.FROM_TAG || 'sup:teletech';
const TO = process.env.TO_TAG || 'sup:sup_teletech_mnhivma4';
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

console.log(`MODO: ${EXECUTE ? '🔴 EXECUTE (vai escrever na Shopify)' : '🟢 DRY-RUN (só simula)'}`);
console.log(`Migração: "${FROM}"  →  "${TO}"\n`);

// 1. Encontrar produtos com a tag FROM
const products = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:50, after:$c, query:"tag:'${FROM}' status:active"){
      pageInfo{hasNextPage endCursor}
      edges{node{ id title tags }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    if (pe.node.tags.includes(FROM)) products.push(pe.node);
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

if (!products.length) {
  console.log(`✓ Nenhum produto tem a tag "${FROM}". Nada a fazer.`);
  process.exit(0);
}

console.log(`${products.length} produto(s) com tag "${FROM}":\n`);
products.forEach(p => console.log(`  • ${p.title}`));

if (!EXECUTE) {
  console.log(`\n→ DRY-RUN. Para executar de verdade:`);
  console.log(`   EXECUTE=1 node tests/migrate-tag.mjs\n`);
  process.exit(0);
}

// 2. Para cada produto, substituir FROM por TO
console.log('\nA aplicar migração...');
let ok = 0, fail = 0;
for (const p of products) {
  const newTags = [...new Set(p.tags.filter(t => t !== FROM).concat(TO))];
  try {
    const d = await shopifyGQL(`mutation($input:ProductUpdateInput!){
      productUpdate(product:$input){product{id tags}userErrors{message}}
    }`, { input: { id: p.id, tags: newTags } });
    if (d.productUpdate.userErrors.length) {
      throw new Error(d.productUpdate.userErrors.map(e => e.message).join('; '));
    }
    console.log(`  ✓ ${p.title.slice(0, 60)}`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${p.title.slice(0, 60)}  —  ${e.message}`);
    fail++;
  }
  await new Promise(r => setTimeout(r, 350));   // throttle
}

console.log(`\nResumo: ${ok} migrado(s), ${fail} falha(s).`);
