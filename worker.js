export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Shopify-Shop, X-Shopify-Token, X-Shopify-Version, X-Rest-Path',
        }
      });
    }

    const shop = request.headers.get('X-Shopify-Shop');
    const token = request.headers.get('X-Shopify-Token');
    const version = request.headers.get('X-Shopify-Version') || '2026-01';
    const restPath = request.headers.get('X-Rest-Path');

    if (!shop || !token) {
      return new Response(JSON.stringify({ error: 'Shop e token obrigatórios' }), { status: 400 });
    }

    const body = await request.text();

    // REST ou GraphQL conforme o header X-Rest-Path
    const url = restPath
      ? `https://${shop}${restPath}`
      : `https://${shop}/admin/api/${version}/graphql.json`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body,
    });

    const data = await response.text();

    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
};
