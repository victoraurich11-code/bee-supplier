# Worker Cloudflare — Deploy + Setup Anthropic

O worker `shopify-proxy` agora também faz proxy para a Anthropic Claude API.
Para activar a feature **SEO Studio** na app, é preciso:

1. **Re-deployar o worker** (versão actualizada do `worker.js`)
2. **Configurar a `ANTHROPIC_API_KEY`** como secret do worker

## Passo 1 — Obter API key Anthropic (se ainda não tens)

1. https://console.anthropic.com/
2. Sign up + confirma email
3. Settings → Billing → adiciona $5-10 de credit pre-paid
4. Settings → API Keys → **Create Key** → "BeeStore SEO"
5. **Copia a key** (começa por `sk-ant-api03-...`)

## Passo 2 — Deploy do worker via wrangler

No terminal:

```bash
cd "/Users/klark/Projetos /Bee Store/Bee-Supplier"

# Login no Cloudflare (uma só vez)
npx wrangler login

# Configurar o secret (cola a key quando pedir)
npx wrangler secret put ANTHROPIC_API_KEY
# → cola: sk-ant-api03-...

# Deploy do worker
npx wrangler deploy
```

Se nunca usaste `wrangler`, ele vai pedir-te para autorizar via browser. É um one-click.

## Passo 3 — Testar

Na app local:
1. Hard refresh (Cmd+Shift+R)
2. Menu lateral → **🚀 SEO Studio**
3. Selecciona 1 produto qualquer
4. Clica **🧠 Gerar**
5. Vê o preview no modal
6. Se OK, **✓ Aplicar à Shopify**

## Troubleshooting

**Erro "ANTHROPIC_API_KEY não está configurada"** → o secret não foi posto. Repete o `wrangler secret put`.

**Erro CORS** → o worker tem CORS aberto. Verifica que estás a aceder via `http://localhost:8765` (não `file://`).

**Erro 401 Anthropic** → key inválida ou sem credit. Vai a console.anthropic.com → Billing.

**Erro 429** → rate limit. Modera o batch (espera ~30s).

## Custos

| Modelo | Custo/produto | 500 produtos |
|---|---|---|
| Claude Haiku 4.5 (default na app) | ~$0.001 | ~$0.50 |
| Claude Sonnet 4.5 (mudar `model` em `callClaude`) | ~$0.01 | ~$5 |

Recomendação: começar com Haiku para validar. Sonnet só para produtos importantes (top sellers, hero products).
