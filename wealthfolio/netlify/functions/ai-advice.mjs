// Netlify Function: AI Investment Advisor via Google Gemini API (FREE)
// Requires GEMINI_API_KEY in environment variables
// Get free key at: https://ai.google.dev/
export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }
    })
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  }

  try {
    const { portfolio, lang } = await request.json()

    const systemPrompt = '你是專業投資顧問。用繁體中文分析投資組合，包含資產和負債。使用 markdown 格式，標題清楚分段。請提供具體、可操作的建議。'

    const userPrompt = `請分析以下投資組合並提供建議：

${JSON.stringify(portfolio, null, 2)}

請提供：
1. 投資組合總覽（淨資產、資產配置）
2. 資產配置分析（股債現金比）
3. 負債分析（負債比、月付金壓力、利率結構）
4. 分散度分析（市場、類型、集中度）
5. 主要風險提示
6. 3-5 項具體投資建議（含資產和負債管理）
7. 每月現金流建議`

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: userPrompt }]
        }],
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7,
        }
      })
    })

    const data = await res.json()

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message || 'Gemini API error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    const advice = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response'

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
