# bee-supplier — App de Gestão de Fornecedores BeeStore

## O que é
Ferramenta interna para importar e gerir produtos de fornecedores na BeeStore.
Deployado em: https://victoraurich11-code.github.io/bee-supplier

## Stack
- HTML único (single-file app)
- GitHub Pages (deploy automático via push)
- Comunicação com Shopify via shopify-proxy (Cloudflare Worker)
- Cloud sync via Supabase (tabela `bee_data`, colunas `key` + `value`)

## Funcionalidades
- Upload de catálogos de fornecedores (CSV/Excel)
- Mapeamento de colunas para campos Shopify
- Preços psicológicos automáticos
- Deteção de duplicados no upload
- Sistema de saúde do catálogo via tags Shopify
- Sync de stock com Shopify (inventorySetQuantities)
- Tek4life — iPhones Grade A+ (secção própria, ver abaixo)

## Shopify
- Shop: bee-store-loja.myshopify.com
- Location ID: gid://shopify/Location/105498313079
- API version: 2026-01
- Proxy: https://shopify-proxy.victoraurich11.workers.dev

## Notas técnicas críticas — API 2026-01
- `productUpdate` usa input types da API 2026-01 (breaking change vs 2024)
- Stock via `inventorySetQuantities` (não `inventoryAdjustQuantity` — deprecated)
- Fallback REST: `/admin/api/2026-01/inventory_levels/set.json`
- **SKU NÃO está em `ProductVariantsBulkInput`** — usar sempre `inventoryItemUpdate` com `InventoryItemInput { sku }`. Função já disponível: `updateVariantSKU(inventoryItemId, sku)`
- `productVariantsBulkUpdate` serve apenas para preço, barcode, etc. — nunca para SKU

## Cloud Sync (Supabase)
- Chaves sincronizadas: `suppliers`, `alerts`, `uploadHistory`, `skuHealth`, `matches`, `settings`, `costHistory`, `costAlerts`, `shopifyProducts`, `productCanonicals`, `productAliases`, `negativeMatches`, **`tek4life_mapping`**
- `tek4life_mapping` foi adicionado ao sync — guardar sempre via `saveToCloud()` após alterações ao mapping
- Credenciais Supabase (supabaseUrl + supabaseKey) são preservadas locais e nunca sobrescritas pelo load da cloud

## Sistema de Saúde do Catálogo — Tags
- `sup:<suppId>` — fornecedor responsável
- `cat:atualizado` — visto no último upload/análise
- `cat:em-vigilancia` — ausente 1-2 análises
- `cat:critico` — ausente N+ análises (threshold por fornecedor, default 3-4)
- `cat:sem-origem` — sem fornecedor conhecido
- `last-seen:AAAA-MM` — data da última atualização
- `bsm:zerado-auto` — stock zerado pelo sistema
- `bsm:ausente-N` — contador de análises em falta

## Tek4life — iPhones Grade A+
- Secção dedicada em `index.html` (navigate: `tek4life`)
- Script Python de sync diário: `tek4life_sync.py` (corre Mon-Fri 09:03 via Cowork scheduled task)
- URL pública do catálogo: `https://www.tek4life.pt/collections/recondicionados/products.json`
- Filtro: iPhones com tag/título `grade a+`, `grade-a+` ou `a+`
- SKUs tek4life: formato `TK` + número (ex: `TK46158`) — internos, sem barcode

### Matching semi-automático
- `tkState.mapping` = `{ tkSku: shopifyProductId }` — guardado em localStorage (`bsm3_tek4life_mapping`) **e** Supabase
- Aprovação grava mapping + chama `updateVariantSKU(inventoryItemId, tkSku)` + aplica tags `sup:tek4life`, `cat:atualizado`, `last-seen:AAAA-MM`
- Fuzzy matching: extrai modelo/storage/cor do título; pontuação modelo(50) + storage(30) + cor(20)
- Botão "♻ Recuperar mapping": reconstrói mapping varrendo variantes Shopify com SKU `TK…` (útil após perda de localStorage)

### Health check pós-análise (`tkRunHealthCheck`)
- Produtos com `sup:tek4life` encontrados no catálogo → `cat:atualizado`
- Produtos com `sup:tek4life` ausentes do catálogo → incrementa `bsm:ausente-N`, aplica `cat:em-vigilancia` ou `cat:critico` (threshold: 3)
- Registo de alerta criado em `state.alerts` quando há ausências

### Painel "Sem SKU TK"
- Tab "🚫 Sem SKU TK" na secção tek4life
- Mostra iPhones Shopify sem variante com SKU a começar por `TK`
- Estes produtos **não entram na automação** de stock/preço
- Função: `tkGetSemSku()` — filtro por SKU, não por tag
