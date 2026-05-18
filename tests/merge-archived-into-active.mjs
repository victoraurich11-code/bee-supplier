#!/usr/bin/env node
// Para cada EAN duplicado entre uma variante ARCHIVED e uma variante ACTIVE:
//   1. Soma o stock do archived no active (active gets active.stock + archived.stock)
//   2. Limpa o barcode do archived (deixa em branco) — assim o EAN passa a estar
//      apenas no active, e futuros uploads atualizam o sítio certo.
//
// NÃO apaga produtos archived — só os "desliga" do EAN. Apagar fica para o user.
//
// DRY-RUN por defeito. Execute: EXECUTE=1 node tests/merge-archived-into-active.mjs

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

async function shopifyREST(pathname, method, body) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

console.log(`MODO: ${EXECUTE ? '🔴 EXECUTE (escreve)' : '🟢 DRY-RUN (só simula)'}\n`);

// 1. Carrega tudo
console.log('A carregar produtos...');
const all = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await shopifyGQL(`query($c:String){
    products(first:100, after:$c){
      pageInfo{hasNextPage endCursor}
      edges{node{
        id title status
        variants(first:25){edges{node{id sku barcode inventoryQuantity inventoryItem{id}}}}
      }}
    }
  }`, { c: cursor });
  for (const pe of d.products.edges) {
    for (const ve of pe.node.variants.edges) {
      if (ve.node.barcode) {
        all.push({
          productId: pe.node.id, productTitle: pe.node.title, productStatus: pe.node.status,
          variantId: ve.node.id, sku: ve.node.sku || '',
          barcode: ve.node.barcode.trim(), stock: ve.node.inventoryQuantity ?? 0,
          inventoryItemId: ve.node.inventoryItem?.id || null,
        });
      }
    }
  }
  hasNext = d.products.pageInfo.hasNextPage;
  cursor = d.products.pageInfo.endCursor;
}

// 2. Encontra pares archived↔active com mesmo EAN
const byEan = new Map();
for (const v of all) {
  if (!byEan.has(v.barcode)) byEan.set(v.barcode, []);
  byEan.get(v.barcode).push(v);
}
const pairs = [];
for (const [ean, vs] of byEan) {
  if (vs.length < 2) continue;
  const archived = vs.filter(v => v.productStatus === 'ARCHIVED');
  const active = vs.filter(v => v.productStatus === 'ACTIVE');
  if (archived.length && active.length) {
    // Se houver 1 active, é o destino. Se houver 2+ active, skip (caso ambíguo — ver audit).
    if (active.length === 1) {
      pairs.push({ ean, archived, active: active[0] });
    }
  }
}

console.log(`Pares archived↔active com 1 active: ${pairs.length}\n`);

// 3. Get location ID para inventory updates
const loc = await shopifyGQL(`{locations(first:1){edges{node{id}}}}`);
const locationId = loc.locations.edges[0]?.node.id;
const locationNumId = locationId.replace('gid://shopify/Location/', '');

let ok = 0, fail = 0;
for (const p of pairs) {
  const archivedTotal = p.archived.reduce((a, v) => a + v.stock, 0);
  const newActiveStock = p.active.stock + archivedTotal;
  console.log(`\n  EAN ${p.ean}`);
  console.log(`    ACTIVE  "${p.active.productTitle.slice(0, 70)}"`);
  console.log(`            stock atual: ${p.active.stock}  →  novo: ${newActiveStock}`);
  for (const a of p.archived) {
    console.log(`    ARCHIVED  stock ${a.stock} → 0  ·  barcode "${a.barcode}" → ""`);
    console.log(`              "${a.productTitle.slice(0, 70)}"`);
  }

  if (!EXECUTE) continue;

  try {
    // a) Move stock do archived para o active
    if (archivedTotal > 0) {
      const invItemNumId = p.active.inventoryItemId.replace('gid://shopify/InventoryItem/', '');
      await shopifyREST(`/inventory_levels/set.json`, 'POST', {
        location_id: parseInt(locationNumId),
        inventory_item_id: parseInt(invItemNumId),
        available: newActiveStock,
      });
    }

    // b) Zera stock do archived
    for (const a of p.archived) {
      if (a.stock > 0 && a.inventoryItemId) {
        const invId = a.inventoryItemId.replace('gid://shopify/InventoryItem/', '');
        await shopifyREST(`/inventory_levels/set.json`, 'POST', {
          location_id: parseInt(locationNumId),
          inventory_item_id: parseInt(invId),
          available: 0,
        });
      }
    }

    // c) Limpa barcode do archived (inventoryItemUpdate só aceita SKU; barcode é em ProductVariantsBulkUpdate)
    for (const a of p.archived) {
      const r = await shopifyGQL(`mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
        productVariantsBulkUpdate(productId:$productId,variants:$variants){
          productVariants{id barcode}
          userErrors{message}
        }
      }`, { productId: a.productId, variants: [{ id: a.variantId, barcode: '' }] });
      if (r.productVariantsBulkUpdate.userErrors.length) {
        throw new Error(r.productVariantsBulkUpdate.userErrors.map(e => e.message).join('; '));
      }
    }

    console.log(`    ✓ migrado`);
    ok++;
  } catch (e) {
    console.log(`    ✗ erro: ${e.message}`);
    fail++;
  }
  await new Promise(r => setTimeout(r, 400));
}

console.log(`\n${EXECUTE ? `Resumo: ${ok} migrado(s), ${fail} falha(s).` : 'DRY-RUN. Executar com EXECUTE=1.'}`);
