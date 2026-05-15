# Bee-Supplier — Auditoria Técnica

**Data:** 2026-05-14
**Âmbito:** Diagnóstico de bugs reportados em produção (atualizações que não chegam à Shopify, aliases que pedem confirmação repetida, produtos marcados para zerar erradamente).
**Ficheiro de referência usado na análise:** `Stocklist 14.05.2026.xlsx` (fornecedor Teletech, 337 linhas).

> Este documento foi escrito para um engenheiro entrar a frio. Lê de cima para baixo: contexto → sintomas → smoking guns → plano. Cada bug tem `file:line` e excertos.

---

## 1. Stack & arquitectura

| Componente | Onde | Responsabilidade |
|---|---|---|
| **Frontend SPA** | `index.html` (~5853 linhas, vanilla JS num único ficheiro) | UI + estado + chamadas à API Shopify via worker. Servido por **GitHub Pages** em `victoraurich11-code.github.io/bee-supplier`. |
| **Cloudflare Worker** | `worker.js` (48 linhas) | Proxy CORS para Shopify Admin API. Stateless. Tokens passados em headers (`X-Shopify-Shop`, `X-Shopify-Token`, `X-Shopify-Version`). |
| **Supabase** | `supabase/functions/kk-search`, `supabase/config.toml` | Key/value store para sync entre devices (`productAliases`, `productCanonicals`, `tek4life_mapping`, etc.) + edge function de scraping KuantoKusta. |
| **Shopify** | API 2026-01 | Loja `bee-store-loja.myshopify.com`, Location ID `gid://shopify/Location/105498313079`. |
| **Scripts auxiliares** | `tek4life_sync.py`, `iphone17_drafts.{js,py}` | One-shots locais (não chamados pelo SPA). |

**Estado local:** `localStorage` via wrapper `DB.get/set` ([index.html:439-460](index.html#L439)). Chaves sincronizadas com Supabase listadas em `CLOUD_GUARDED_KEYS` ([index.html:496](index.html#L496)).

---

## 2. Sintomas reportados pelo utilizador

1. **"Os S26 aparecem como encontrados, mas não atualizam no site"** — depois do upload de hoje, painel mostra produtos S26 na coluna "Encontrados" e diz "Aplicado com sucesso", mas o stock/preço Shopify fica errado.
2. **"Os iPhone 16 aparecem todos para zerar"** — a modal pós-upload propõe zerar todos os iPhone 16 que não vieram no ficheiro.
3. **"A cena dos aliases me pede sempre para informar se é igual ou diferente... ou seja, não estão a ficar guardadas as alterações."**
4. **"Muitos produtos não atualizam como é suposto."**
5. **"As listagens dos diferentes fornecedores têm gerado confusão nas atualizações."**

---

## 3. Análise do ficheiro `Stocklist 14.05.2026.xlsx`

Folha única, 337 linhas, **sem coluna de SKU** — só `EAN-13, Modelo, Stock, Preço, Data prevista, Stock(2)`.

**Achado crítico:** 21 modelos com **EANs múltiplos para o mesmo produto físico** (mesmo nome + mesmo preço, EANs diferentes — provavelmente lotes/origens distintos do distribuidor). Exemplos:

| Modelo | EAN 1 | EAN 2 | Stock real (soma) |
|---|---|---|---|
| Samsung Galaxy S26 Ultra 256GB Black | `8806097821250` (1) | `8806097827221` (57) | **58** |
| Samsung Galaxy S26 256GB Cobalt Violet | `8806097827313` (19) | `8806097827337` (9) | **28** |
| Samsung Galaxy S26+ 512GB Pink Gold | `8806099054441` (3) | `8806099054472` (9) | **12** |
| Apple iPhone 17 Pro 512GB Cosmic Orange | `0195950627978` (15) | `0195950628043` (51) | **66** |
| Apple iPhone 17 Pro Max 256GB Cosmic Orange | `0195950639025` (9) | `0195950639094` (100) | **109** |
| Apple iPhone 17 Pro Max 256GB Deep Blue | `0195950639223` (5) | `0195950639292` (26) | **31** |
| Samsung A57 Navy 128GB | `8806099028282` (50) | `8806099028305` (61) | **111** |
| Samsung S25 Ultra 256GB Titanium Grey | `8806095860107` (29) | `8806095860237` (11) | **40** |

**iPhone 16** no ficheiro: apenas **6 SKUs** (236 unidades total). Em produção a Shopify tem dezenas de variantes iPhone 16 com tag `sup:teletech`. Combinado com o sintoma 2, suspeita: a Teletech é uma **"in-stock list"** (só lista o disponível no momento), não um catálogo completo — mas o sistema trata-a como catálogo e propõe zerar tudo o que ficou de fora.

---

## 4. Smoking guns (causas-raiz confirmadas no código)

### 🎯 Smoking Gun #1 — Sistema de aliases é **código morto**

**Sintoma que explica:** #3 (aliases pedem sempre), #4 (produtos não atualizam).

`findCanonicalForRow()` está definida em [`index.html:4996`](index.html#L4996) mas **nunca é chamada** no resto do código. Validação rápida:

```
$ grep -n findCanonicalForRow index.html
4996:function findCanonicalForRow({ suppId, sku, barcode }) {
(nada mais)
```

O lookup do upload usa apenas `skuMap`/`barcodeMap` directos da Shopify ([`index.html:2179-2181`](index.html#L2179)):

```js
let match = null, matchedBy = null;
if (sku && skuMap[sku.toLowerCase()]) { match = skuMap[sku.toLowerCase()]; matchedBy = 'SKU'; }
else if (barcode && barcodeMap[barcode]) { match = barcodeMap[barcode]; matchedBy = 'BARCODE'; }
```

**Consequência:** Cada alias criado via "Aceitar como substituição" ([`index.html:5183`](index.html#L5183), `addAlias`) é guardado em `state.productAliases` e sincronizado para Supabase, **mas nenhum caminho do upload o consulta**. O utilizador alimenta uma BD que ninguém lê → no upload seguinte aparece o mesmo pedido de confirmação.

---

### 🎯 Smoking Gun #2 — Merge multi-EAN descarta EANs secundários

**Sintoma que explica:** #1 (S26 não atualizam), #2 (iPhone 16 a zerar), #5 (confusão entre fornecedores).

Quando o utilizador aceita o merge de duplicados no `showDuplicateStep`, [`index.html:2137`](index.html#L2137):

```js
extraRows.push({
  [nc]: d.items[0].name,
  [sc]: d.items[0].sku,
  [bc]: d.items[0].barcode,   // ← só o PRIMEIRO EAN sobrevive
  [stc]: String(mergedStock),
  [pc]: String(minCost)
});
```

E os "missing" do health check usam `knownBarcodes` ([`index.html:2171`](index.html#L2171)):

```js
if (barcode) knownBarcodes.add(barcode);   // só regista o barcode "efectivo" da linha merged
```

**Cenário concreto com S26 Ultra Black:**
1. Ficheiro tem 2 linhas: EAN `...821250` (stock 1) + EAN `...827221` (stock 57).
2. User aceita merge → `effectiveRow` fica com EAN `...821250`, stock 58.
3. **Se a variante Shopify tem barcode = `...827221`** (o EAN secundário descartado), o lookup falha → produto aparece como "Novo" (em vez de actualizar).
4. **Se a variante Shopify tem barcode = `...821250`**, actualiza, mas:
5. `knownBarcodes` só contém `...821250`. O `runPostUploadHealthCheck` ([`index.html:849-855`](index.html#L849)) procura por **alguma** variante do produto a bater os SKUs/barcodes conhecidos. Se a Shopify tiver outra variante taggeada `sup:teletech` com barcode `...827221`, **vai para `missing`** → modal de zerar.

Este é o nexo entre "S26 não actualiza" e "iPhone 16 a zerar" — **mesmo bug, dois sintomas**.

---

### 🎯 Smoking Gun #3 — Migração canónica só corre uma vez

**Sintoma que explica:** #4.

[`index.html:5221-5224`](index.html#L5221):

```js
async function runMigrationIfNeeded() {
  if (!state.shopifyProducts.length) return;
  if (Object.keys(state.productCanonicals).length > 0) return;   // ← bail-out total
  const r = migrateToCanonicals();
  ...
}
```

Depois da primeira corrida, **nunca mais identifica novas variantes Shopify**. Produtos criados após essa data ficam sem canónico → `findReplacementCandidates` ([`index.html:5149`](index.html#L5149)) não consegue avaliar candidatos para eles.

---

### 🎯 Smoking Gun #4 — Sugestão de substituição só aparece no modal de zero

**Sintoma que explica:** #3.

`acceptReplacement` ([`index.html:5180`](index.html#L5180)) é chamada **exclusivamente** do botão em [`index.html:1003`](index.html#L1003), dentro do `showZeroConfirmModal`. Não há outro caminho para o utilizador associar manualmente um SKU novo a um produto existente.

Combinado com SG #1 (aliases ignorados), o loop é:

```
upload → produto X não bate → vai para isNew
      → mais tarde, variante de X com SKU antigo vira "missing"
      → modal de zero aparece com sugestão "este isNew parece substituição"
      → user clica "Aceitar como substituição" → cria alias
      → próximo upload → SG #1: alias ignorado → produto novamente em isNew
      → variante antiga novamente missing → modal aparece outra vez
      → "É igual ou diferente?" outra vez ────────────────┘ (loop)
```

**É exactamente o sintoma #3 reportado pelo utilizador.**

---

### 🎯 Smoking Gun #5 — Health check inadequado para "in-stock lists"

**Sintoma que explica:** #2 (iPhone 16 a zerar).

[`index.html:867`](index.html#L867):

```js
if (coveragePct < 70 && avgExpected > 50) {
  showPartialUploadModal({ ... });   // só PERGUNTA se parcial vs completo
  return;
}
// caso contrário, escala automaticamente e abre showZeroConfirmModal
```

Para a Teletech, `avgExpected` flutua (já é tipicamente parcial), pelo que a média sobe e o ratio raramente cai abaixo de 70%. Resultado: o modal de "tratar como parcial" **não dispara**, e qualquer variante ausente é candidata a zerar.

**Causa estrutural:** não existe metadata por fornecedor a indicar se é "catálogo completo" ou "in-stock list". A Teletech estruturalmente é uma in-stock list (só publica o que tem disponível) — tratar ausência como sinal de descontinuação está errado.

---

## 5. Bugs adicionais identificados (médios/baixos)

### 5.1 — Tek4life: falta `await` na sincronização ([index.html:5460](index.html#L5460))

```js
function tkApprove(idx) {
  ...
  tkState.mapping[m.tek.sku] = m.shop.id;
  DB.set('tek4life_mapping', tkState.mapping);
  ...
  toast(`✓ Aprovado: ...`, 'success');
  tkSyncSingleSku(m.tek.sku, m.shop.id, m.shop.title);   // ← async sem await
}
```

`tkSyncSingleSku` é async. UI mostra "Aprovado" imediatamente; se a promise falha (rede, userError Shopify, ou tab fechada), o SKU **nunca chega** à Shopify mas o mapping local diz que foi sincronizado.

**Agravante** em [`index.html:5463-5485`](index.html#L5463): o cache local (`firstVariant.sku`, `shopProd.tags`, `state.suppliers[].lastUpload`) é actualizado **antes** de confirmar o `await updateVariantSKU`. O `catch` faz `toast` mas não há rollback → cache fica desincronizado da Shopify.

### 5.2 — `findUserErrors` swallow silencioso

Verificar [`index.html:703-714`](index.html#L703) (`findUserErrors`). Se uma mutation devolver `userErrors[]` não vazios, o cliente deve `throw` para o `applyChanges` contar como erro. Confirmar se os caminhos `updateVariantPrice`, `updateVariantStock`, `updateVariantSKU`, `productUpdate` usam todos `findUserErrors` (deveriam, via `shopifyGQL` em [`index.html:685`](index.html#L685)). Caso falhe esse contrato, há mutações que reportam sucesso quando na verdade Shopify rejeitou.

### 5.3 — `saveToCloud` engole erros

[`index.html:5431`](index.html#L5431) e similares: `saveToCloud().catch(()=>{})`. Falhas Supabase não são visíveis ao utilizador, dispositivos diferentes ficam dessincronizados sem aviso.

### 5.4 — Matching Tek4life com regex guloso

[`index.html:5545-5566`](index.html#L5545) (`tkParseIphone` + `tkScore`):
- `tkParseIphone` apanha a **primeira** cor encontrada no título e o **primeiro** número seguido de GB/TB.
- Títulos como "iPhone 15 64GB 5G" podem produzir storage = "64GB" mas também há risco com "Gold rose" vs "Rose Gold", etc.
- Score: modelo aproximado por substring vale 30 pontos. "iPhone 15" e "iPhone 15 Pro" matcham fracamente, mas podem aparecer como candidato a aprovar.

### 5.5 — Health check Tek4life não cruza com aliases

[`index.html:5739-5740`](index.html#L5739): procura literalmente por SKUs `TK*` em variantes com tag `sup:tek4life`. Se outro fluxo mudou o SKU desse mesmo produto, é marcado como ausente erradamente.

### 5.6 — Dedupe de aliases sensível a `null` vs `''`

[`index.html:5023-5028`](index.html#L5023): chave de dedupe compara 4 campos. Se algum chegou como `null` do Supabase em vez de `''`, a comparação `normBarcode(null) === normBarcode('')` é `true` (ambos `''`), portanto este risco é **provavelmente teórico** — manter como TODO a verificar com dados reais.

---

## 6. Inventário do estado de cada funcionalidade

| Funcionalidade | Estado | Linhas |
|---|---|---|
| Sistema canónico/aliases (`productCanonicals`, `productAliases`, `findCanonicalForRow`) | 🧟 **Zombie** — construído, persistido, mas nunca consultado no upload | [4982-5230](index.html#L4982) |
| Matching principal por SKU/barcode directo | ✅ Funcional mas isolado dos canónicos | [2150-2232](index.html#L2150) |
| Merge de duplicados (`detectDuplicates`/`showDuplicateStep`) | ⚠️ Funciona, mas perde EANs no merge (SG #2) | [2272-2498](index.html#L2272) |
| `findReplacementCandidates` | ⚠️ Algoritmo bom mas depende de canónicos zombie | [5145-5159](index.html#L5145) |
| `runPostUploadHealthCheck` + `showZeroConfirmModal` | ⚠️ Lógica OK, threshold inadequado para in-stock lists | [836-888](index.html#L836) |
| Tek4life flow inteiro (`tk*`) | ⚠️ Falta `await` + sem rollback em erro | [5246-5786](index.html#L5246) |
| `migrateToCanonicals` (auto-run só inicial) | 🧟 Não cobre produtos novos pós-primeira corrida | [5048-5094](index.html#L5048) |
| Cloud sync (`saveToCloud`, `cloudUpsert`) | ⚠️ Engole erros silenciosamente | [521-562](index.html#L521) |
| KuantoKusta (`kk*`, edge function `kk-search`) | ✅ Funcional, não relacionado com este bug | [4591-4965](index.html#L4591) |
| `splitVariants` | ✅ Funcional, fluxo isolado | [3234-3712](index.html#L3234) |
| Normalização imagens (`img*`) | ✅ Funcional, fluxo isolado | [3713-4133](index.html#L3713) |
| Detecção fornecedores duplicados (`detectDuplicateSuppliers`) | ✅ Recente, OK | [1703-1851](index.html#L1703) |
| `tek4life_sync.py` (script local) | ❓ Não auditado neste documento — vale a pena? |
| `iphone17_drafts.{js,py}`, `iphone17_aliases*` | ❓ One-shots locais, sem entry point no SPA, **não estão em git** | — |

---

## 7. Plano de correção priorizado

| Prioridade | Fix | Smoking gun | Onde mexer |
|---|---|---|---|
| 🔴 **P0** | Ligar `findCanonicalForRow` ao `doAnalysis` (antes de classificar como "Novo", consultar canónicos+aliases) | #1, #4 | [index.html:2179](index.html#L2179) |
| 🔴 **P0** | Merge multi-EAN: registar TODOS os EANs do grupo em `knownBarcodes`; tentar lookup com cada um (não só o primeiro) | #2 | [index.html:2137, 2171](index.html#L2137) |
| 🟠 **P1** | Flag `isInStockList` por fornecedor (settings do supplier) + skip do `showZeroConfirmModal` quando activa | #5 | [index.html:836-888](index.html#L836), modelo `supplier` |
| 🟠 **P1** | Re-correr `migrateToCanonicals` para variantes Shopify sem canónico (não só quando o dict está vazio) | #3 | [index.html:5224](index.html#L5224) |
| 🟡 **P2** | Botão "associar a produto existente" no painel de "Produtos novos" do `renderAnalysis` (não só no modal de zero) | #4 | [index.html:2501+](index.html#L2501) |
| 🟡 **P2** | Tek4life: `await tkSyncSingleSku(...)` + rollback de cache em caso de erro | 5.1 | [index.html:5460, 5463-5485](index.html#L5460) |
| 🟡 **P2** | Endurecer `tkParseIphone`: cor por última ocorrência ou lista priorizada; storage com âncora `\b\d+\s*(GB|TB)\b` | 5.4 | [index.html:5545-5566](index.html#L5545) |
| 🟢 **P3** | `saveToCloud` mostrar toast vermelho em vez de `catch(()=>{})` | 5.3 | grep `catch(()=>{})` |
| 🟢 **P3** | Tek4life health check cruzar com `productAliases` antes de escalar | 5.5 | [index.html:5733-5769](index.html#L5733) |
| 🟢 **P3** | Validar que `findUserErrors` propaga em todos os caminhos de mutation (especialmente em `applyChanges`) | 5.2 | [index.html:685-714](index.html#L685) |

**Recomendação:** P0 + P1 numa única branch (`fix/aliases-and-multi-ean`) resolvem todos os sintomas reportados pelo utilizador. P2/P3 podem seguir em PRs separados.

---

## 8. Como reproduzir os bugs (com o ficheiro `Stocklist 14.05.2026.xlsx`)

### Repro do SG #2 (S26 não actualizam)

1. Abrir o SPA, fornecedor Teletech seleccionado.
2. Upload do ficheiro `Stocklist 14.05.2026.xlsx`.
3. O passo de duplicados detectará ~21 grupos (mesmo modelo, EANs diferentes). Clicar "✓ Todos iguais".
4. Avançar para análise.
5. Observar a coluna "Produtos novos" e "Encontrados": linhas que **deveriam** ser uma única actualização aparecem split — o EAN secundário cai em "Novos" ou o stock combinado fica errado.
6. Após "Aplicar", verificar na Shopify o stock real de `Samsung Galaxy S26 Ultra 256GB Black`: deveria ser 58, será 1 ou 57 (a versão da linha que matchou) ou 0 (se nenhuma matchou).

### Repro do SG #5 (iPhone 16 a zerar)

1. Mesmo upload acima.
2. Depois de "Aplicar", o sistema corre `runPostUploadHealthCheck`.
3. Modal `showZeroConfirmModal` aparece listando todas as variantes iPhone 16 com tag `sup:teletech` que não bateram (o ficheiro só traz 6 SKUs iPhone 16).
4. Confirmar que o `showPartialUploadModal` (parcial vs completo) **não disparou** (deveria avisar primeiro, dado o baixo coverage).

### Repro do SG #1+#4 (aliases ignorados)

1. Cenário: produto com SKU antigo `ABC-OLD` na Shopify, tag `sup:teletech`. Hoje a Teletech traz SKU `ABC-NEW` para a mesma referência.
2. No primeiro upload, `ABC-NEW` vai para "Novos" (não matcha por SKU/barcode). `ABC-OLD` vai para "missing" e propõe substituição. Utilizador clica **"Aceitar como substituição"** → `addAlias({canonicalId, suppId, sku: 'ABC-NEW', ...})`.
4. No upload seguinte (mesma Teletech), `ABC-NEW` chega de novo. `doAnalysis` consulta apenas `skuMap` (que vem da Shopify, onde o SKU ainda é `ABC-OLD` ou foi substituído — depende do flow). **`findCanonicalForRow` nunca é chamada** → `ABC-NEW` vai outra vez para "Novos" → modal vai pedir confirmação outra vez.

---

## 9. Notas operacionais para o engenheiro

- **Repo:** `github.com/victoraurich11-code/bee-supplier` (branch `main`).
- **Deploy frontend:** push para `main` → GitHub Pages serve `index.html`.
- **Deploy worker:** `wrangler deploy` (config em `.wrangler/`).
- **Supabase functions:** `supabase/functions/kk-search/index.ts` — usa `supabase functions deploy`.
- **Sem segredos no código** — confirmado por grep (`shpat_`, `sk_`, `eyJ`...). Tokens entram via env vars em scripts Python e via inputs no UI das settings.
- **Estado não-commitado em produção:** à data desta auditoria há `index.html` modificado localmente e ficheiros `iphone17_*` por commitar. Não bloqueia análise.
- **Branch sugerida para os fixes:** `fix/aliases-and-multi-ean`.

---

## 10. Glossário rápido

- **canonical** — registo `{ id, shopifyProductId, shopifyVariantId, primarySku, primaryBarcode, title, brand }`. Representa "a variante real" na Shopify, independente de SKUs de fornecedores.
- **alias** — `{ canonicalId, suppId, sku, barcode, ... }`. Liga uma identidade externa (do fornecedor) a um canónico.
- **negative match** — `{ canonicalId, suppId, sku, barcode }`. User disse explicitamente "estes são produtos diferentes" — evita sugestões repetidas.
- **isNew / found / notFound** — buckets do `doAnalysis`. `isNew` = tem SKU/barcode mas não bate Shopify; `notFound` = sem SKU nem barcode; `found` = matchou.
- **in-stock list** vs **catálogo** — distinção que **não existe** no modelo actual mas deveria. In-stock list só lista o disponível; catálogo lista tudo. Ausência num catálogo é sinal de fim-de-vida; ausência numa in-stock list é só "hoje não tenho".

---

**Fim do documento.** Sugestão: o engenheiro pode arrancar pelos repros da secção 8 para validar pessoalmente, depois atacar P0/P1 numa branch dedicada. Disponível para clarificar qualquer parte.
