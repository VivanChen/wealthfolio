// Netlify Function: Fetch stock prices from Yahoo Finance
// Supports both US stocks (AAPL) and TW stocks (2330.TW)
export default async (request) => {
  const url = new URL(request.url)
  const symbols = url.searchParams.get('symbols')

  if (!symbols) {
    return new Response(JSON.stringify({ error: 'Missing symbols parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  }

  const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean)
  const results = {}

  // Fetch each symbol from Yahoo Finance
  await Promise.all(symbolList.map(async (symbol) => {
    try {
      const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
      const res = await fetch(yfUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
      const data = await res.json()
      const meta = data?.chart?.result?.[0]?.meta
      if (meta) {
        results[symbol] = {
          symbol: meta.symbol,
          price: meta.regularMarketPrice,
          previousClose: meta.chartPreviousClose || meta.previousClose,
          currency: meta.currency,
          name: meta.shortName || meta.longName || symbol,
          exchange: meta.exchangeName,
          change: meta.regularMarketPrice - (meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice),
          changePercent: meta.chartPreviousClose
            ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100)
            : 0,
          timestamp: meta.regularMarketTime,
        }
      } else {
        results[symbol] = { symbol, error: 'No data found' }
      }
    } catch (e) {
      results[symbol] = { symbol, error: e.message }
    }
  }))

  return new Response(JSON.stringify(results), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300' // cache 5 min
    }
  })
}

export const config = { path: "/api/stock-price" }
