// Netlify Function: AI Investment Advisor via Claude API
// Requires ANTHROPIC_API_KEY in environment variables
export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }
    })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  }

  try {
    const { portfolio, lang } = await request.json()

    const systemPrompt = lang === 'id'
      ? 'Anda adalah penasihat investasi. Berikan analisis portofolio dalam Bahasa Indonesia. Gunakan format markdown dengan header yang jelas.'
      : '你是專業投資顧問。用繁體中文分析投資組合。使用 markdown 格式，標題清楚分段。'

    const userPrompt = lang === 'id'
      ? `Analisis portofolio investasi berikut dan berikan saran:\n\n${JSON.stringify(portfolio, null, 2)}\n\nMohon berikan:\n1. Ringkasan portofolio\n2. Analisis alokasi aset (rasio saham/obligasi/kas)\n3. Analisis diversifikasi\n4. Risiko utama\n5. 3-5 saran investasi spesifik`
      : `請分析以下投資組合並提供建議：\n\n${JSON.stringify(portfolio, null, 2)}\n\n請提供：\n1. 投資組合總覽\n2. 資產配置分析（股債現金比）\n3. 分散度分析\n4. 主要風險提示\n5. 3-5 項具體投資建議`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        system: systemPrompt
      })
    })

    const data = await res.json()
    const advice = data.content?.[0]?.text || 'No response'

    return new Response(JSON.stringify({ advice }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  }
}

export const config = { path: "/api/ai-advice" }
