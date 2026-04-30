const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const FALLBACK_BUILD_ID = "waa14mqBcHurQTXa3JXur";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    const { name, datadome, buildId, scraperApiKey } = await req.json();
    if (!name) {
      return new Response(JSON.stringify({ error: "name is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const result = await kkSearch(name, { datadome, buildId, scraperApiKey });
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function kkSearch(
  query: string,
  opts: { datadome?: string; buildId?: string; scraperApiKey?: string }
) {
  const { datadome, buildId: clientBuildId, scraperApiKey } = opts;
  const buildId = clientBuildId || FALLBACK_BUILD_ID;
  const searchUrl = `https://www.kuantokusta.pt/_next/data/${buildId}/search.json?q=${encodeURIComponent(query)}`;

  let resp: Response;

  if (scraperApiKey) {
    // Use ScraperAPI for residential IP bypass
    const scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(searchUrl)}&country_code=pt&headers=${encodeURIComponent(JSON.stringify({ "x-nextjs-data": "1", "Referer": `https://www.kuantokusta.pt/search?q=${encodeURIComponent(query)}`, "Accept-Language": "pt-PT,pt;q=0.9" }))}`;
    resp = await fetch(scraperUrl, { headers: { "User-Agent": UA } });
  } else {
    // Direct attempt (blocked by Akamai for datacenter IPs, but try anyway)
    const cookieParts: string[] = [];
    if (datadome) cookieParts.push(`datadome=${datadome}`);

    resp = await fetch(searchUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        "x-nextjs-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "Referer": `https://www.kuantokusta.pt/search?q=${encodeURIComponent(query)}`,
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        ...(cookieParts.length ? { "Cookie": cookieParts.join("; ") } : {}),
      },
    });
  }

  if (!resp.ok) {
    return {
      success: false,
      data: [],
      error: `HTTP ${resp.status}`,
      needsApiKey: !scraperApiKey,
    };
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    return { success: false, data: [], error: "invalid JSON response" };
  }

  const basePage = data?.pageProps?.basePage;
  const products = basePage?.data || [];

  return {
    success: true,
    total: basePage?.total || 0,
    data: products.map((p: any) => ({
      id: p.id,
      name: p.name,
      priceMin: p.priceMin,
      totalOffers: p.totalOffers,
      url: "https://www.kuantokusta.pt" + p.url,
      brand: p.brand,
      category: p.category,
    })),
  };
}
