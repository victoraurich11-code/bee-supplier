#!/usr/bin/env node
// Validação diária pós-uploads — verifica que o modelo dono fixo está a manter
// a loja limpa. Correr depois dos uploads da manhã (Depau + Teletech):
//   node tests/validacao-diaria.mjs
// Lê Shopify via .env do projeto e, se ~/.supabase_secrets existir, também o
// estado cloud (histórico de uploads, relatórios, alertas).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SHOP = process.env.SHOPIFY_STORE_DOMAIN, TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const PASS = '\x1b[32m✓\x1b[0m', WARN = '\x1b[33m⚠\x1b[0m', FAIL = '\x1b[31m✗\x1b[0m';
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
let warns = 0, fails = 0;
const ok = (m) => console.log(`${PASS} ${m}`);
const warn = (m) => { warns++; console.log(`${WARN} ${m}`); };
const bad = (m) => { fails++; console.log(`${FAIL} ${m}`); };

async function gql(q, v = {}) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(`https://${SHOP}/admin/api/2026-01/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
      body: JSON.stringify({ query: q, variables: v }) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 2000)); continue; }
    const j = await r.json();
    if (j.errors) { if (JSON.stringify(j.errors).includes('THROTTLED')) { await new Promise(s => setTimeout(s, 2500)); continue; } throw new Error(JSON.stringify(j.errors).slice(0, 200)); }
    return j.data;
  }
  throw new Error('THROTTLED');
}

console.log(BOLD('═══ VALIDAÇÃO DIÁRIA — BeeStore × Bee-Supplier ═══'));
console.log(`loja: ${SHOP} · ${new Date().toISOString().slice(0, 16)}\n`);

// ── 1. Loja: puxar produtos ACTIVE+DRAFT ─────────────────────
const products = [];
let cursor = null, hasNext = true;
while (hasNext) {
  const d = await gql(`query($c:String){products(first:250,after:$c,query:"status:active OR status:draft"){pageInfo{hasNextPage endCursor}edges{node{id title status tags variants(first:5){edges{node{sku barcode inventoryQuantity}}}}}}}`, { c: cursor });
  for (const e of d.products.edges) {
    const n = e.node;
    products.push({ id: n.id, title: n.title, status: n.status, tags: n.tags || [], variants: n.variants.edges.map(v => ({ sku: v.node.sku, barcode: v.node.barcode, qty: v.node.inventoryQuantity })) });
  }
  hasNext = d.products.pageInfo.hasNextPage; cursor = d.products.pageInfo.endCursor;
}
const actives = products.filter(p => p.status === 'ACTIVE');
console.log(BOLD(`1. Loja (${actives.length} ativos, ${products.length - actives.length} rascunhos)`));

// 1a. Ativos com stock e sem EAN/SKU (fora recon/gift) — deve ser 0
const semEanRisco = actives.filter(p =>
  !/recondicionado|usado|gift card/i.test(p.title) &&
  p.variants.length && p.variants.every(v => !(v.sku || '').trim() && !(v.barcode || '').trim()) &&
  p.variants.reduce((a, v) => a + (v.qty || 0), 0) > 0
);
semEanRisco.length === 0
  ? ok('Nenhum produto ativo com stock e sem EAN (fora recondicionados)')
  : bad(`${semEanRisco.length} ativo(s) com stock e SEM EAN: ${semEanRisco.slice(0, 5).map(p => p.title.slice(0, 40)).join(' · ')}`);

// 1b. Ativos com stock e sem tag de fornecedor — órfãos com stock inventado
const semDonoRisco = actives.filter(p =>
  !/recondicionado|usado|gift card/i.test(p.title) &&
  !p.tags.some(t => t.startsWith('sup:')) &&
  p.variants.reduce((a, v) => a + (v.qty || 0), 0) > 0
);
semDonoRisco.length === 0
  ? ok('Nenhum produto ativo com stock sem fornecedor atribuído')
  : warn(`${semDonoRisco.length} ativo(s) com stock sem tag sup: — ${semDonoRisco.slice(0, 5).map(p => p.title.slice(0, 40)).join(' · ')}`);

// 1c. Duas tags sup: no mesmo produto (legado v1) — deve normalizar sozinho
const duplaTag = products.filter(p => p.tags.filter(t => t.startsWith('sup:')).length > 1);
duplaTag.length === 0
  ? ok('Nenhum produto com duas tags de fornecedor')
  : warn(`${duplaTag.length} produto(s) com 2 tags sup: (normalizam no próximo upload do dono)`);

// ── 2. Cloud (opcional): uploads e relatórios de hoje ───────
const secretsPath = path.join(os.homedir(), '.supabase_secrets');
if (fs.existsSync(secretsPath)) {
  const sec = {};
  for (const line of fs.readFileSync(secretsPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) sec[m[1]] = m[2];
  }
  const BASE = (sec.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = sec.SUPABASE_SERVICE_ROLE_KEY;
  const cloud = async (key) => {
    const r = await fetch(`${BASE}/bee_data?key=eq.${key}&select=value`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    const rows = await r.json();
    return rows[0]?.value;
  };
  const today = new Date().toISOString().slice(0, 10);
  console.log('\n' + BOLD('2. Uploads e relatórios'));

  const hist = (await cloud('uploadHistory')) || [];
  const deHoje = hist.filter(h => (h.date || '').startsWith(today));
  deHoje.length >= 2
    ? ok(`${deHoje.length} upload(s) hoje: ${deHoje.map(h => `${h.supplierName} (${h.updated} atualizados, ${h.errors} erros)`).join(' · ')}`)
    : warn(`só ${deHoje.length} upload(s) hoje — Depau e Teletech já correram?`);
  for (const h of deHoje) {
    if (h.errors > 0) bad(`upload ${h.supplierName} com ${h.errors} erro(s)`);
    if (h.report) {
      const r = h.report;
      console.log(`   · ${h.supplierName}: zerados ${r.zeroed?.length ?? 0} · mudanças de EAN ${r.eanChange?.length ?? 0} · doutro dono ${r.managedElsewhere ?? 0} · avisos ${r.errors?.length ?? 0}`);
      (r.errors || []).forEach(e => warn(`   relatório ${h.supplierName}: ${String(e).slice(0, 90)}`));
      (r.eanChange || []).forEach(e => warn(`   possível mudança de EAN por associar: ${e.title?.slice(0, 50)} ≈ ${String(e.candidate).slice(0, 40)}`));
    }
  }

  const alerts = (await cloud('alerts')) || [];
  const zerosHoje = alerts.filter(a => a.type === 'zero_stock' && (a.date || '').startsWith(today));
  zerosHoje.length <= 12
    ? ok(`${zerosHoje.length} zeragem(ns) automática(s) hoje (regime normal)`)
    : warn(`${zerosHoje.length} zeragens hoje — acima do normal, vale a pena olhar o relatório`);

  const semEanTotal = products.filter(p => !/recondicionado|usado|gift card/i.test(p.title) && p.variants.length && p.variants.every(v => !(v.sku || '').trim() && !(v.barcode || '').trim()));
  semEanTotal.length === 0
    ? ok('Tab "Sem EAN" vazia (fora recondicionados e gift card)')
    : warn(`${semEanTotal.length} produto(s) na tab Sem EAN por associar: ${semEanTotal.slice(0, 4).map(p => p.title.slice(0, 35)).join(' · ')}`);
} else {
  console.log(`\n(2. cloud saltado: ~/.supabase_secrets não encontrado)`);
}

console.log('\n' + BOLD('═══ RESULTADO ═══'));
if (fails === 0 && warns === 0) console.log(`${PASS} ${BOLD('Tudo limpo. A loja está 100% alinhada com os fornecedores.')}`);
else console.log(`${fails === 0 ? WARN : FAIL} ${BOLD(`${fails} problema(s) · ${warns} aviso(s)`)} — detalhe acima.`);
