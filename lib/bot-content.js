// Post/comment/vote inserters — mirrors admindashboarddeelmap/lib/botContent.js.

import { supabase } from './supabase.js'
import { groqChat, parseJsonFromGroq } from './groq.js'

// Read generated post content and ask Groq to pick the best-matching lot.
// Used when a scenario has target_lot_id = null so each post is routed to
// the lot that actually fits its content. Returns {id, slug, name} or null.
export async function classifyLotForContent({ title, body, groqModel = 'llama-3.3-70b-versatile' }) {
  const { data: rawLots } = await supabase
    .from('community_lots').select('id, slug, name, category, description').eq('is_active', true)
  if (!rawLots?.length) return null

  const lots = [...rawLots].sort(() => Math.random() - 0.5)
  const lotIndex = lots.map(l => `- ${l.slug} → ${l.name} (${l.category})${l.description ? ': ' + l.description : ''}`).join('\n')

  let content = ''
  try {
    const r = await groqChat({
      model: groqModel, temperature: 0, max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You classify real-estate community posts into Lots. Output ONLY JSON like {"slug":"..."}. Pick the SINGLE best-matching slug. Never default to wholesaling unless the content is specifically about assignment/wholesale deals.',
        },
        {
          role: 'user',
          content: `LOTS:\n${lotIndex}\n\nPOST TITLE: ${title || '(no title)'}\nPOST BODY: ${(body || '').slice(0, 1500)}\n\nReturn the single best-matching slug.`,
        },
      ],
    })
    content = r.content
  } catch { return null }

  const parsed = parseJsonFromGroq(content) || {}
  const slug = String(parsed.slug || '').trim().toLowerCase()
  if (!slug) return null
  return lots.find(l => l.slug === slug) || null
}

export function slugifyTitle(title) {
  const base = String(title || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const rand = Math.random().toString(36).slice(2, 8)
  return base ? `${base}-${rand}` : rand
}

export async function createPostAsBot({ bot, lotId, title, body, marketTag = null }) {
  if (!bot?.profile_id) throw new Error('Bot missing profile_id.')
  if (!lotId) throw new Error('lotId required.')

  const cleanTitle = String(title || '').trim().slice(0, 200)
  if (cleanTitle.length < 8) throw new Error('Title too short.')

  const { data, error } = await supabase
    .from('community_posts')
    .insert({
      slug: slugifyTitle(cleanTitle),
      lot_id: lotId,
      author_id: bot.profile_id,
      title: cleanTitle,
      body: body ? String(body).trim().slice(0, 30000) : null,
      market_tag: marketTag ? String(marketTag).slice(0, 80) : null,
      is_removed: false,
    })
    .select('id, slug, title, created_at')
    .single()

  if (error) throw new Error(`Post insert failed: ${error.message}`)
  return data
}

export async function createCommentAsBot({ bot, postId, parentCommentId = null, body }) {
  if (!bot?.profile_id) throw new Error('Bot missing profile_id.')
  if (!postId) throw new Error('postId required.')
  const cleanBody = String(body || '').trim().slice(0, 8000)
  if (cleanBody.length < 1) throw new Error('Comment body empty.')

  if (parentCommentId) {
    const { data: parent } = await supabase
      .from('community_comments').select('id, post_id, depth').eq('id', parentCommentId).maybeSingle()
    if (!parent || parent.post_id !== postId) throw new Error('Parent comment mismatch.')
    if (parent.depth >= 8) throw new Error('Maximum reply depth reached.')
  }

  const { data, error } = await supabase
    .from('community_comments')
    .insert({
      post_id: postId,
      author_id: bot.profile_id,
      parent_id: parentCommentId,
      body: cleanBody,
      is_removed: false,
    })
    .select('id, parent_id, body, created_at')
    .single()

  if (error) throw new Error(`Comment insert failed: ${error.message}`)
  return data
}

// Pick a real post for a bot to comment on, based on scenario comment settings.
export async function pickCommentTarget({ scenario, bot }) {
  const recencyDays = scenario.comment_recency_days || 7
  const sinceISO = new Date(Date.now() - recencyDays * 86_400_000).toISOString()

  let q = supabase
    .from('community_posts')
    .select(`
      id, title, body, score, comment_count, author_id,
      author:community_profiles!community_posts_author_id_fkey(is_bot)
    `)
    .eq('is_removed', false)
    .gte('created_at', sinceISO)
    .gte('score', scenario.comment_min_score || 0)
    .neq('author_id', bot.profile_id)
    .limit(120)
  if (scenario.target_lot_id) q = q.eq('lot_id', scenario.target_lot_id)
  if (scenario.comment_pick_strategy === 'top') q = q.order('score', { ascending: false })
  else q = q.order('created_at', { ascending: false })

  const { data: posts } = await q
  if (!posts?.length) return null

  let candidates = posts
  if (!scenario.comment_include_bot_posts) candidates = candidates.filter(p => !p.author?.is_bot)
  if (scenario.comment_max_per_post > 0) {
    candidates = candidates.filter(p => (p.comment_count || 0) < scenario.comment_max_per_post * 4)
  }
  if (!candidates.length) return null

  if (scenario.comment_one_per_bot) {
    const ids = candidates.map(p => p.id)
    const { data: existing } = await supabase
      .from('community_comments').select('post_id')
      .eq('author_id', bot.profile_id).in('post_id', ids)
    const commented = new Set((existing || []).map(c => c.post_id))
    candidates = candidates.filter(p => !commented.has(p.id))
  }
  if (!candidates.length) return null

  if (scenario.comment_pick_strategy === 'random') {
    return candidates[Math.floor(Math.random() * candidates.length)]
  }
  const pool = candidates.slice(0, 30)
  return pool[Math.floor(Math.random() * pool.length)]
}

export async function voteAsBot({ bot, targetType, targetId, value }) {
  if (!bot?.profile_id) throw new Error('Bot missing profile_id.')
  if (!['post', 'comment'].includes(targetType)) throw new Error('Invalid target_type.')
  if (![1, -1].includes(value)) throw new Error('Vote value must be 1 or -1.')

  const { error } = await supabase
    .from('community_votes')
    .upsert({
      profile_id: bot.profile_id,
      target_type: targetType,
      target_id: targetId,
      value,
    }, { onConflict: 'profile_id,target_type,target_id' })
  if (error) throw new Error(`Vote upsert failed: ${error.message}`)
  return { ok: true }
}

export async function tickBotActivity(botId) {
  const { data: bot } = await supabase
    .from('community_bots')
    .select('actions_today, actions_today_reset_at')
    .eq('id', botId).maybeSingle()
  if (!bot) return
  const resetAt = new Date(bot.actions_today_reset_at || 0).getTime()
  const stale = Date.now() - resetAt > 24 * 60 * 60 * 1000

  const patch = {
    last_action_at: new Date().toISOString(),
    actions_today: stale ? 1 : (bot.actions_today || 0) + 1,
    updated_at: new Date().toISOString(),
  }
  if (stale) patch.actions_today_reset_at = new Date().toISOString()

  await supabase.from('community_bots').update(patch).eq('id', botId)
}
