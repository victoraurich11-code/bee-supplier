# bee-supplier — App de Gestão de Fornecedores BeeStore

## O que é
Ferramenta interna para importar e gerir produtos de fornecedores na BeeStore.
Deployado em: https://victoraurich11-code.github.io/bee-supplier

## Stack
- HTML único (single-file app)
- GitHub Pages (deploy automático via push)
- Comunicação com Shopify via shopify-proxy (Cloudflare Worker)

## Funcionalidades
- Upload de catálogos de fornecedores (CSV/Excel)
- Mapeamento de colunas para campos Shopify
- Preços psicológicos automáticos
- Deteção de duplicados no upload
- Sistema de saúde do catálogo via tags Shopify
- Sync de stock com Shopify (inventorySetQuantities)

## Shopify
- Shop: bee-store-loja.myshopify.com
- Location ID: gid://shopify/Location/105498313079
- API version: 2026-01
- Proxy: https://shopify-proxy.victoraurich11.workers.dev

## Notas técnicas
- productUpdate usa input types da API 2026-01 (breaking change vs 2024)
- Stock via inventorySetQuantities (não inventoryAdjustQuantity — deprecated)
- Fallback REST: /admin/api/2026-01/inventory_levels/set.json
