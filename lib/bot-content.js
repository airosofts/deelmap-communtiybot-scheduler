// Post/comment/vote inserters — mirrors admindashboarddeelmap/lib/botContent.js.

import { supabase } from './supabase.js'

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
