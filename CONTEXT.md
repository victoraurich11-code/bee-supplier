# shopify-proxy — Worker Cloudflare (CORS Proxy)

## O que é
Proxy CORS para comunicação entre o browser e a API Shopify (GraphQL + REST).
Usado pelo bee-supplier (victoraurich11-code.github.io/bee-supplier).

## Stack
- Cloudflare Worker (JS puro)
- Sem KV ou base de dados — stateless

## Headers obrigatórios nas chamadas
- `X-Shopify-Shop` — ex: bee-store-loja.myshopify.com
- `X-Shopify-Token` — Admin API token da loja
- `X-Shopify-Version` — ex: 2026-01 (default)
- `X-Rest-Path` — (opcional) se presente, faz chamada REST em vez de GraphQL

## Loja BeeStore
- Shop: bee-store-loja.myshopify.com
- Location ID: gid://shopify/Location/105498313079
- API version ativa: 2026-01

## Deploy
wrangler deploy

## Notas
- Não guardar o token Shopify no código
- Suporta GraphQL (POST sem X-Rest-Path) e REST (POST com X-Rest-Path)
- SKU de variante deve ser atualizado via `inventoryItemUpdate` (não `productVariantsBulkUpdate`) na API 2026-01
