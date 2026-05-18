#!/usr/bin/env node
// Análise focada Samsung S26: cruza EANs da Teletech com variantes Shopify.
// Para cada EAN da Teletech, descobre se está numa variante S26 active e em que estado.
// Para cada variante S26 active na Shopify, descobre se algum EAN da Teletech bate.

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
const XLSX_PATH = process.argv[2] || '/Users/klark/Downloads/Stocklist 15.05.2026.xlsx';

async function shopifyGQL(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()).data;
}

// 1. Carrega EANs S26 da Teletech
const wb = xlsx.readFile(XLSX_PATH);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(ws, { defval: '', raw: true });
const teleS26 = rows
  .filter(r => /S26/i.test(String(r['Modelo'] || '')))
  .map(r => ({
    ean: String(r['EAN-13'] || '').trim(),
    name: String(r['Modelo'] || '').trim(),
    stock: parseInt(String(r['Stock'] || '0').replace(/[^0-9]/g, '')) || 0,
    price: parseFloat(String(r['Preço'] || '0').toString().replace(',', '.')) || 0,
  }));
console.log(`Teletech 15.05 — Samsung S26: ${teleS26.length} linhas\n`);

// 2. Carrega todas as variantes S26 da Shopify (active)
console.log('A carregar variantes S26 da Shopify (active)...');
const shopS26 = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:50, after:$c, query:"title:S26 status:active"){
      pageInfo{hasNextPage endCursor}
      edges{node{
        id title tags
        variants(first:25){edges{node{id sku barcode inventoryQuantity}}}
      }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    for (const ve of pe.node.variants.edges) {
      shopS26.push({
        productId: pe.node.id,
        productTitle: pe.node.title,
        supTag: (pe.node.tags || []).find(t => t.startsWith('sup:')) || '(sem sup:)',
        sku: ve.node.sku || '',
        barcode: ve.node.barcode || '',
        stock: ve.node.inventoryQuantity ?? 0,
      });
    }
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}
console.log(`Shopify (active, title contém "S26"): ${shopS26.length} variante(s)\n`);

// 3. Para cada EAN da Teletech, encontra match na Shopify
const teleEans = new Set(teleS26.map(r => r.ean));
const shopEans = new Set(shopS26.map(v => v.barcode).filter(Boolean));
const teleMatched = new Set();
const shopMatched = new Set();
for (const r of teleS26) if (shopEans.has(r.ean)) teleMatched.add(r.ean);
for (const v of shopS26) if (teleEans.has(v.barcode)) shopMatched.add(v.barcode);

console.log('═══ RESUMO ═══');
console.log(`  Teletech EANs: ${teleEans.size}   dos quais matcham variante Shopify: ${teleMatched.size}`);
console.log(`  Shopify EANs:  ${shopEans.size}   dos quais matcham linha Teletech:   ${shopMatched.size}`);

// 4. Por variante Shopify, mostrar stock actual vs stock Teletech (se houver match)
console.log('\n═══ Variantes S26 na Shopify (lado a lado com Teletech) ═══');
const byProduct = new Map();
for (const v of shopS26) {
  if (!byProduct.has(v.productTitle)) byProduct.set(v.productTitle, []);
  byProduct.get(v.productTitle).push(v);
}
const PAD = (s, n) => String(s).padEnd(n);
for (const [title, vars] of byProduct) {
  console.log(`\n  ${title}`);
  console.log(`    ${vars[0].supTag}`);
  for (const v of vars) {
    const matchInTele = teleS26.find(r => r.ean === v.barcode);
    const line = `      ${PAD('barcode ' + (v.barcode || '—'), 32)}  stock ${PAD(v.stock, 4)}`;
    if (matchInTele) {
      console.log(`${line}  Teletech: ${matchInTele.stock} unidades  | ${matchInTele.name.slice(0, 50)}`);
    } else if (v.barcode) {
      console.log(`${line}  Teletech: \x1b[33msem este EAN no ficheiro\x1b[0m`);
    } else {
      console.log(`${line}  \x1b[31mvariante sem barcode!\x1b[0m`);
    }
  }
}

// 5. EANs da Teletech S26 SEM variante Shopify correspondente — possíveis variantes a criar
console.log('\n═══ EANs Teletech S26 sem variante Shopify (potenciais oportunidades) ═══');
const orphans = teleS26.filter(r => !shopEans.has(r.ean));
const byName = new Map();
for (const r of orphans) {
  if (!byName.has(r.name)) byName.set(r.name, { stock: 0, eans: [] });
  byName.get(r.name).stock += r.stock;
  byName.get(r.name).eans.push(r.ean);
}
for (const [name, info] of byName) {
  console.log(`  • ${name}   stock total ${info.stock}   (${info.eans.length} EAN(s): ${info.eans.join(', ')})`);
}
console.log(`\nTotal de produtos S26 que a Teletech tem mas a Shopify não captura: ${byName.size}`);
