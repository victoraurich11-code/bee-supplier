#!/usr/bin/env node
// Validação automática do estado da Shopify após o último upload Teletech.
//
// Lê o ficheiro Teletech de hoje, agrupa por modelo+capacidade+cor (mesma
// lógica do detector de duplicados), e para cada grupo:
//   1. Soma o stock esperado
//   2. Vai à Shopify pelos EANs do grupo e descobre a variante real
//   3. Compara stock atual vs esperado
//
// Uso:
//   1. Criar `.env.local` na raiz do repo com:
//        SHOPIFY_TOKEN=shpat_xxx
//        SHOPIFY_SHOP=bee-store-loja.myshopify.com
//        SHOPIFY_API_VERSION=2026-01
//   2. node tests/validate-shopify.mjs
//
// O script NÃO escreve nada na Shopify — só lê.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';

// ─── Carrega .env.local ───────────────────────────────────────────────────────
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

if (!SHOP || !TOKEN) {
  console.error('❌ Falta SHOPIFY_SHOP e/ou SHOPIFY_TOKEN em .env.local');
  process.exit(1);
}
if (!fs.existsSync(XLSX_PATH)) {
  console.error(`❌ Ficheiro não encontrado: ${XLSX_PATH}`);
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

async function shopifyGQL(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function findVariantByBarcode(barcode) {
  // Procura variante por barcode (EAN). Usa products query com filter.
  const data = await shopifyGQL(`query($q:String!){
    products(first:5, query:$q){edges{node{
      id title status
      variants(first:25){edges{node{id sku barcode inventoryQuantity}}}
    }}}
  }`, { q: `barcode:${barcode}` });
  const out = [];
  for (const pe of data.products.edges) {
    for (const ve of pe.node.variants.edges) {
      if (ve.node.barcode === barcode) {
        out.push({
          productId: pe.node.id,
          productTitle: pe.node.title,
          productStatus: pe.node.status,
          variantId: ve.node.id,
          variantSku: ve.node.sku,
          variantBarcode: ve.node.barcode,
          stock: ve.node.inventoryQuantity ?? 0,
        });
      }
    }
  }
  return out;
}

// ─── Carrega Teletech e agrupa por chave canónica ─────────────────────────────
function loadTeletech() {
  const wb = xlsx.readFile(XLSX_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '', raw: true });
  return rows.map(r => ({
    ean: String(r['EAN-13'] || '').trim(),
    name: String(r['Modelo'] || '').trim(),
    stock: parseInt(String(r['Stock'] || '0').replace(/[^0-9]/g, '')) || 0,
    price: parseFloat(String(r['Preço'] || '0').toString().replace(',', '.')) || 0,
  })).filter(r => r.ean && r.name);
}

// Agrupa por (modelo+capacidade+cor) usando uma chave simples.
// NOTA: aqui usamos uma chave conservadora que junta apenas linhas IDÊNTICAS em
// nome — não fazemos fuzzy. Isso significa que diferentes grafias de cor (ex.
// "Sky Blue" vs "Ultramarine") nunca se juntam. É exactamente o que queremos
// porque vamos validar contra a Shopify pelo EAN, que é o source of truth.
function groupByName(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = r.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!map.has(k)) map.set(k, { name: r.name, eans: [], totalStock: 0 });
    const g = map.get(k);
    g.eans.push({ ean: r.ean, stock: r.stock });
    g.totalStock += r.stock;
  }
  return [...map.values()];
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────
console.log(BOLD('\n══════════════════════════════════════════════════════════════════════'));
console.log(BOLD(`VALIDAÇÃO SHOPIFY pós-upload — ${XLSX_PATH.split('/').pop()}`));
console.log(BOLD('══════════════════════════════════════════════════════════════════════'));
console.log(`  Shop:    ${SHOP}`);
console.log(`  Version: ${API_VERSION}`);

const tele = loadTeletech();
const groups = groupByName(tele);
console.log(`  Linhas Teletech: ${tele.length}`);
console.log(`  Grupos por nome: ${groups.length}`);

// Para evitar spam à API, validamos amostragem: top N por stock total (mais impacto).
const N = parseInt(process.env.SAMPLE_N || '15');
const sample = [...groups].sort((a, b) => b.totalStock - a.totalStock).slice(0, N);

console.log(`\n${BOLD(`Validação dos top ${N} grupos por stock total`)}`);
console.log(DIM('  (override com SAMPLE_N=30)'));

let pass = 0, fail = 0, partial = 0, missing = 0;
const issues = [];

for (const g of sample) {
  // Para cada EAN do grupo, encontra a variante Shopify e soma o stock real.
  const variantsFound = [];
  for (const e of g.eans) {
    try {
      const hits = await findVariantByBarcode(e.ean);
      hits.forEach(h => variantsFound.push({ ...h, expectedFromThisEan: e.stock }));
    } catch (err) {
      // ignora — vamos ver no fim
    }
  }

  // Stock real na Shopify = soma do stock de TODAS as variantes únicas encontradas.
  // (Uma variante pode aparecer 2x se vários EANs apontam para ela — só conta 1x.)
  const uniqueVariants = new Map();
  for (const v of variantsFound) {
    if (!uniqueVariants.has(v.variantId)) uniqueVariants.set(v.variantId, v);
  }
  const realStock = [...uniqueVariants.values()].reduce((a, v) => a + v.stock, 0);

  const status = uniqueVariants.size === 0 ? 'MISSING'
               : realStock === g.totalStock ? 'OK'
               : realStock === 0 ? 'ZERO'
               : 'PARTIAL';

  const icon = status === 'OK' ? PASS
             : status === 'ZERO' ? FAIL
             : status === 'MISSING' ? WARN
             : FAIL;

  const title = g.name.slice(0, 75);
  console.log(`\n  ${icon} ${title}`);
  console.log(`      Teletech: ${g.eans.length} EAN(s), stock total ${BOLD(g.totalStock)}`);
  console.log(`      Shopify:  ${uniqueVariants.size} variante(s) encontrada(s), stock real ${BOLD(realStock)}`);

  if (status !== 'OK') {
    if (status === 'MISSING') {
      console.log(DIM(`      → nenhuma variante Shopify tem nenhum destes EANs.`));
      missing++;
    } else {
      [...uniqueVariants.values()].forEach(v => {
        console.log(DIM(`      → "${v.productTitle}" · stock ${v.stock} · status ${v.productStatus}`));
      });
      if (status === 'ZERO') fail++;
      else partial++;
    }
    issues.push({ group: g, realStock, variantsFound: [...uniqueVariants.values()], status });
  } else {
    pass++;
  }

  // Throttle: Shopify rate limit
  await new Promise(r => setTimeout(r, 300));
}

console.log(BOLD('\n──────────────────────────────────────────────────────────────────────'));
console.log(BOLD('RESUMO'));
console.log(BOLD('──────────────────────────────────────────────────────────────────────'));
console.log(`  ${PASS} OK       — stock Shopify = stock Teletech:           ${pass}`);
console.log(`  ${FAIL} ZERO     — variante existe mas stock está 0:         ${fail}`);
console.log(`  ${FAIL} PARTIAL  — stock parcial (provavelmente só 1 EAN):   ${partial}`);
console.log(`  ${WARN} MISSING  — nenhuma variante Shopify com estes EANs:  ${missing}`);

if (issues.length) {
  console.log(`\n${BOLD('Próximas acções sugeridas:')}`);
  if (issues.some(i => i.status === 'ZERO')) {
    console.log(`  • ZERO: a app não aplicou o stock para estes. Re-correr Aplicar.`);
  }
  if (issues.some(i => i.status === 'PARTIAL')) {
    console.log(`  • PARTIAL: a Shopify só tem 1 dos EANs do grupo (merge não aplicou os secundários). É o caso típico do bug SG#2 antes do fix.`);
  }
  if (issues.some(i => i.status === 'MISSING')) {
    console.log(`  • MISSING: nenhuma das EANs Teletech está numa variante. Produto não existe na Shopify OU EAN não preenchido.`);
  }
}
