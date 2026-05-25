// Bee-Supplier worker — proxy para Shopify Admin API + Anthropic Claude API.
//
// Encaminhamento por header X-Endpoint:
//   X-Endpoint: anthropic   → POST para api.anthropic.com (precisa env.ANTHROPIC_API_KEY)
//   sem X-Endpoint          → comportamento Shopify (proxy GraphQL / REST conforme X-Rest-Path)
//
// Secrets configurados via Cloudflare Workers:
//   wrangler secret put ANTHROPIC_API_KEY
//
// Token Shopify continua a vir no header X-Shopify-Token vindo do browser.
// Token Anthropic NUNCA vem no browser — só vive no worker como secret.
export default {
  async fetch(request, env) {
    const CORS_HEADERS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Shopify-Shop, X-Shopify-Token, X-Shopify-Version, X-Rest-Path, X-Endpoint, X-KK-URL, anthropic-version',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const endpoint = request.headers.get('X-Endpoint');

    // ─── KuantoKusta page fetch (HTML scraping para og:image) ──────────────
    if (endpoint === 'kk-page') {
      const url = request.headers.get('X-KK-URL') || '';
      if (!url.startsWith('https://www.kuantokusta.pt/')) {
        return new Response(JSON.stringify({ error: 'X-KK-URL deve apontar para kuantokusta.pt' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
            'Referer': 'https://www.kuantokusta.pt/',
          },
        });
        const text = await resp.text();
        return new Response(text, {
          status: resp.status,
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Fetch KK falhou: ' + err.message }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
    }

    // ─── Anthropic Claude API proxy ─────────────────────────────────────────
    if (endpoint === 'anthropic') {
      if (!env.ANTHROPIC_API_KEY) {
        return new Response(
          JSON.stringify({ error: 'ANTHROPIC_API_KEY não está configurada no Cloudflare Worker. Define com `wrangler secret put ANTHROPIC_API_KEY`.' }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
      const body = await request.text();
      let resp;
      try {
        resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body,
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: 'Network error contactando Anthropic: ' + err.message }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }
      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // ─── Shopify Admin API proxy (default, comportamento existente) ────────
    const shop = request.headers.get('X-Shopify-Shop');
    const token = request.headers.get('X-Shopify-Token');
    const version = request.headers.get('X-Shopify-Version') || '2026-01';
    const restPath = request.headers.get('X-Rest-Path');

    if (!shop || !token) {
      return new Response(
        JSON.stringify({ error: 'Shop e token obrigatórios' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }

    const body = await request.text();
    const url = restPath
      ? `https://${shop}${restPath}`
      : `https://${shop}/admin/api/${version}/graphql.json`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body,
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
};
