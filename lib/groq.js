// Groq Chat Completions wrapper — mirror of admindashboarddeelmap/lib/groqClient.js
// Kept self-contained so the scheduler doesn't need any cross-project imports.

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const COST_PER_M_TOKENS_USD = 0.59

export async function groqChat({
  model = 'llama-3.3-70b-versatile',
  messages,
  temperature = 0.85,
  max_tokens = 800,
  response_format = null,
}) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured.')

  const body = { model, messages, temperature, max_tokens }
  if (response_format) body.response_format = response_format

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content?.trim() || ''
  const usage = data?.usage || {}
  const tokensUsed = usage.total_tokens || 0
  const costEstimate = (tokensUsed / 1_000_000) * COST_PER_M_TOKENS_USD

  return {
    content,
    tokens_used: tokensUsed,
    cost_estimate_usd: Number(costEstimate.toFixed(6)),
    raw: data,
    request: { model, messages, temperature, max_tokens },
  }
}

export function parseJsonFromGroq(content) {
  if (!content) return null
  const fenced = content.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  const raw = fenced ? fenced[1] : content
  try { return JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]+\}/)
    if (!m) return null
    try { return JSON.parse(m[0]) } catch { return null }
  }
}
