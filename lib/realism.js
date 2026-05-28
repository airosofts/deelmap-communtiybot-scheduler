// Phase 3 realism — moderation pass, real-data anchoring, typo injection.
// Mirror of admindashboarddeelmap/lib/botRealism.js, adapted for the scheduler.

import { supabase } from './supabase.js'
import { groqChat } from './groq.js'

// ─── Moderation pass ─────────────────────────────────────────────────
export async function moderationPass({ text, enabled, groqModel }) {
  if (!enabled) return { result: 'skipped', reason: null }
  if (!text || text.trim().length < 4) return { result: 'pass', reason: null }
  try {
    const { content } = await groqChat({
      model: groqModel || 'llama-3.3-70b-versatile',
      temperature: 0,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: 'You are a content safety filter for a real-estate community forum. Reply with EXACTLY "PASS" if the content is safe to publish, or "FAIL: <one-line reason>" if it contains: real phone numbers, real NMLS numbers, scams, hate, harassment, off-platform contact details, doxxing, or anything misleading. Be permissive about real-estate jargon, market opinions, and rough numbers. Nothing else.',
        },
        { role: 'user', content: text.slice(0, 6000) },
      ],
    })
    const trimmed = content.trim()
    if (/^PASS\b/i.test(trimmed)) return { result: 'pass', reason: null }
    const m = trimmed.match(/^FAIL[: ]+(.*)/i)
    return { result: 'fail', reason: m ? m[1].trim() : 'Moderator flagged content.' }
  } catch (err) {
    return { result: 'skipped', reason: `mod check error: ${err.message}` }
  }
}

// ─── Real-data anchoring ─────────────────────────────────────────────
export async function pickRealDealAnchor({ source = 'any' }) {
  const queries = []
  if (source === 'any' || source === 'property') queries.push(fetchProperty())
  if (source === 'any' || source === 'wholesale_deal') queries.push(fetchWholesale())
  const results = (await Promise.all(queries)).filter(Boolean)
  if (!results.length) return null
  return results[Math.floor(Math.random() * results.length)]
}

async function fetchProperty() {
  const { data } = await supabase
    .from('properties')
    .select('id, address, price, bedrooms, bathrooms, floor_area, property_type, city, state')
    .order('created_at', { ascending: false }).limit(50)
  if (!data?.length) return null
  const row = data[Math.floor(Math.random() * data.length)]
  return { context: formatDealContext(row, 'listing'), anchored_property_id: row.id, anchored_wholesale_id: null }
}

async function fetchWholesale() {
  const { data } = await supabase
    .from('wholesale_deals')
    .select('id, address, price, bedrooms, bathrooms, sqft, property_type, city, state')
    .order('created_at', { ascending: false }).limit(50)
  if (!data?.length) return null
  const row = data[Math.floor(Math.random() * data.length)]
  return { context: formatDealContext(row, 'wholesale assignment'), anchored_property_id: null, anchored_wholesale_id: row.id }
}

function formatDealContext(d, kind) {
  const parts = [`Reference this real ${kind} as your topic:`, `Address: ${d.address || 'unknown'}`]
  if (d.city || d.state) parts.push(`Market: ${[d.city, d.state].filter(Boolean).join(', ')}`)
  if (d.price)           parts.push(`Price: $${Number(d.price).toLocaleString()}`)
  if (d.bedrooms != null && d.bathrooms != null) parts.push(`Beds/baths: ${d.bedrooms}/${d.bathrooms}`)
  if (d.sqft || d.floor_area) parts.push(`Size: ${(d.sqft || d.floor_area).toLocaleString()} sqft`)
  if (d.property_type)   parts.push(`Type: ${d.property_type}`)
  parts.push('Do NOT invent a different address. Comment naturally — like you saw this deal cross your desk.')
  return parts.join('\n')
}

// ─── Typo injection ──────────────────────────────────────────────────
export function injectTypos(text, chance = 0.05) {
  if (!text || chance <= 0) return text
  return text.replace(/\b[a-zA-Z]{5,}\b/g, (word) => (Math.random() > chance ? word : mangle(word)))
}

function mangle(word) {
  const pick = Math.floor(Math.random() * 3)
  const i = 1 + Math.floor(Math.random() * (word.length - 2))
  if (pick === 0 && i < word.length - 1) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)
  if (pick === 1) return word.slice(0, i) + word[i] + word.slice(i)
  return word.slice(0, i) + word.slice(i + 1)
}
