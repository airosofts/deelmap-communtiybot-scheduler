// Execute a single schedule, and process due reply-chain follow-ups.
// Phase 3: anchoring, moderation pass, typo injection, reply chains, vote swarm.

import { supabase } from './supabase.js'
import { groqChat, parseJsonFromGroq } from './groq.js'
import {
  createPostAsBot, createCommentAsBot, voteAsBot, tickBotActivity, pickCommentTarget,
  classifyLotForContent,
} from './bot-content.js'
import { isWithinActiveHours } from './active-hours.js'
import { nextRunAt } from './cron.js'
import { moderationPass, pickRealDealAnchor, injectTypos } from './realism.js'
import { log } from './log.js'

// ── Run one schedule end-to-end ────────────────────────────────────────
export async function executeSchedule({ schedule, settings }) {
  const tz = settings.timezone || 'UTC'
  if (!isWithinActiveHours(settings.active_hours_start, settings.active_hours_end, tz)) {
    return { status: 'skipped', reason: 'outside_active_hours' }
  }

  const resetStale = Date.now() - new Date(schedule.runs_today_reset_at || 0).getTime() > 24 * 60 * 60 * 1000
  const runsToday = resetStale ? 0 : (schedule.runs_today || 0)
  if (runsToday >= schedule.max_runs_per_day) {
    return { status: 'skipped', reason: 'max_runs_per_day' }
  }

  const { data: scenario } = await supabase
    .from('community_bot_scenarios')
    .select(`*, lot:community_lots(id, slug, name, category)`)
    .eq('id', schedule.scenario_id).maybeSingle()
  if (!scenario || !scenario.is_active) return { status: 'skipped', reason: 'scenario_paused' }

  const bot = await pickBot(schedule.bot_pool, tz)
  if (!bot) return { status: 'skipped', reason: 'no_bot_available' }

  // ── CLAIM THE SLOT ────────────────────────────────────────────────────
  // Advance next_run_at NOW, before any Groq work. This is the reliability
  // guarantee: whatever happens next — success, Groq failure, a crash, a
  // process restart — the schedule is already moved forward and will NOT get
  // stuck "due now" hammering Groq every single tick. runs_today is bumped
  // separately (markRun) only when real content is produced.
  await claimNextRun(schedule)

  // Vote scenarios skip Groq entirely — pure engagement swarm.
  if (scenario.action_type === 'vote') {
    const result = await voteSwarm({ bot, scenario })
    await tickBotActivity(bot.id)
    const actionId = await insertAction({
      bot, scenario, schedule, settings, status: 'posted',
      messages: null, generatedBody: `vote swarm: backed ${result.voted}/${result.attempted || 0}`,
    })
    await markRun(schedule)
    return { status: 'posted', action_id: actionId, voted: result.voted }
  }

  // ── Generation path (post / reply_chain / comment) ──
  const anchor = scenario.anchor_to_real_deal
    ? await pickRealDealAnchor({ source: scenario.deal_source || 'any' })
    : null

  // Comment scenarios: auto-pick a real post to reply to, read its content.
  let commentTarget = null
  if (scenario.action_type === 'comment') {
    commentTarget = await pickCommentTarget({ scenario, bot })
    if (!commentTarget) {
      // Log the skip so it's visible in the Activity tab (not silent), and
      // advance next_run_at WITHOUT burning a daily run — a skip isn't a run.
      const reason = scenario.comment_include_bot_posts
        ? 'No eligible post to comment on in the look-back window (try widening the days or lowering min score).'
        : 'No eligible HUMAN post to comment on. Your community is currently bot-seeded — turn off "humans only" on this scenario, or wait for real posts.'
      await insertAction({
        bot, scenario, schedule, settings, status: 'skipped',
        messages: null, generatedBody: reason,
      })
      // next_run_at already advanced by claimNextRun above — no extra call.
      return { status: 'skipped', reason: 'no_comment_target' }
    }
  }

  const targetWords = Math.floor(
    scenario.length_min_words + Math.random() * (scenario.length_max_words - scenario.length_min_words)
  )
  const lotContext   = scenario.lot ? `Lot: ${scenario.lot.name} (${scenario.lot.category})` : ''
  const avoidContext = scenario.avoid_list?.length ? `Do NOT include any of these: ${scenario.avoid_list.join('; ')}.` : ''
  const wantsTitle   = scenario.action_type === 'post' || scenario.action_type === 'reply_chain'
  const formatInstr  = wantsTitle
    ? 'Respond as JSON: {"title": "...", "body": "..."}. Title 8–100 chars.'
    : 'Respond as JSON: {"body": "..."}.'
  const commentContext = commentTarget
    ? `\nReply to this post — read it and respond naturally (agree, push back, add a number, or ask a sharp follow-up). Don't repeat the title back.\nPOST TITLE: ${commentTarget.title}\nPOST BODY: ${(commentTarget.body || '').slice(0, 2000)}\n`
    : ''

  const messages = [
    { role: 'system', content: bot.persona_prompt },
    {
      role: 'user',
      content: `${scenario.generated_system_prompt}

${lotContext}
${anchor ? `\n${anchor.context}\n` : ''}${commentContext}
Target length: about ${targetWords} words.
${avoidContext}

${formatInstr}`,
    },
  ]

  let groqResult
  try {
    groqResult = await groqChat({
      model: settings.groq_model,
      temperature: Number(scenario.tone_temperature) || 0.85,
      max_tokens: Math.max(400, scenario.length_max_words * 4),
      response_format: { type: 'json_object' },
      messages,
    })
  } catch (err) {
    await insertAction({ bot, scenario, schedule, settings, status: 'failed', messages, error_message: err.message })
    return { status: 'failed', error: err.message }
  }

  const parsed = parseJsonFromGroq(groqResult.content) || {}
  const title = wantsTitle ? String(parsed.title || '').trim().slice(0, 200) : null
  let body = String(parsed.body || '').trim()

  if ((wantsTitle && title.length < 8) || body.length < 5) {
    await insertAction({
      bot, scenario, schedule, settings, status: 'failed', messages, groqResult,
      generatedTitle: title, generatedBody: body, error_message: 'Generated content too short.',
    })
    return { status: 'failed', error: 'too_short' }
  }

  if (Number(settings.typo_chance) > 0) body = injectTypos(body, Number(settings.typo_chance))

  const moderation = await moderationPass({
    text: `${title ? title + '\n\n' : ''}${body}`,
    enabled: !!settings.moderation_pass_enabled,
    groqModel: settings.groq_model,
  })
  if (moderation.result === 'fail') {
    await insertAction({
      bot, scenario, schedule, settings, status: 'rejected', messages, groqResult,
      generatedTitle: title, generatedBody: body, anchor, moderation,
      error_message: `Moderation: ${moderation.reason}`,
    })
    // Slot already claimed; rejected content isn't counted as a run.
    return { status: 'rejected', reason: moderation.reason }
  }

  // Draft mode — log, don't publish. Stash comment target so approval knows the post.
  if (settings.draft_review_enabled) {
    const actionId = await insertAction({
      bot, scenario, schedule, settings, status: 'draft', messages, groqResult,
      generatedTitle: title, generatedBody: body, anchor, moderation,
      targetPostId: commentTarget?.id || null,
    })
    await markRun(schedule)
    return { status: 'draft', action_id: actionId }
  }

  // Publish
  try {
    // Comment scenario — reply to the resolved post.
    if (scenario.action_type === 'comment') {
      const c = await createCommentAsBot({ bot, postId: commentTarget.id, body })
      await tickBotActivity(bot.id)
      const actionId = await insertAction({
        bot, scenario, schedule, settings, status: 'posted', messages, groqResult,
        generatedTitle: null, generatedBody: body, anchor, moderation,
        targetPostId: commentTarget.id, targetCommentId: c.id,
      })
      await markRun(schedule)
      return { status: 'posted', action_id: actionId, post_id: commentTarget.id, comment_id: c.id }
    }

    // Post / reply_chain
    // Per-post auto-classify when the scenario has no fixed target_lot.
    // Routes each post into the best-matching lot based on its actual content.
    let lotId = scenario.target_lot_id
    if (!lotId) {
      const picked = await classifyLotForContent({ title, body, groqModel: settings.groq_model })
      if (!picked) throw new Error('Could not classify content into any lot.')
      lotId = picked.id
    }
    const post = await createPostAsBot({ bot, lotId, title, body })
    if (anchor?.anchored_property_id || anchor?.anchored_wholesale_id) {
      await supabase.from('community_posts').update({
        property_id: anchor.anchored_property_id,
        wholesale_deal_id: anchor.anchored_wholesale_id,
      }).eq('id', post.id)
    }
    await tickBotActivity(bot.id)
    const actionId = await insertAction({
      bot, scenario, schedule, settings, status: 'posted', messages, groqResult,
      generatedTitle: title, generatedBody: body, anchor, moderation, targetPostId: post.id,
    })

    // Reply-chain: queue follow-ups from other bots
    if (scenario.action_type === 'reply_chain') {
      await spawnFollowups({ parentActionId: actionId, parentPostId: post.id, scenario, excludeBotId: bot.id })
    }

    await markRun(schedule)
    return { status: 'posted', action_id: actionId, post_id: post.id }
  } catch (err) {
    await insertAction({
      bot, scenario, schedule, settings, status: 'failed', messages, groqResult,
      generatedTitle: title, generatedBody: body, anchor, moderation, error_message: err.message,
    })
    return { status: 'failed', error: err.message }
  }
}

// ── Process one due reply-chain follow-up ──────────────────────────────
export async function processFollowup({ followup, settings }) {
  // Load the bot + scenario + parent post
  const { data: bot } = await supabase
    .from('community_bots').select('*').eq('id', followup.bot_id).maybeSingle()
  if (!bot || !bot.is_active) {
    await supabase.from('community_bot_followups').update({ status: 'cancelled', error_message: 'bot inactive', completed_at: new Date().toISOString() }).eq('id', followup.id)
    return { status: 'cancelled' }
  }

  const { data: parentPost } = await supabase
    .from('community_posts').select('id, title, body, is_removed').eq('id', followup.parent_post_id).maybeSingle()
  if (!parentPost || parentPost.is_removed) {
    await supabase.from('community_bot_followups').update({ status: 'cancelled', error_message: 'parent gone', completed_at: new Date().toISOString() }).eq('id', followup.id)
    return { status: 'cancelled' }
  }

  const { data: scenario } = followup.scenario_id
    ? await supabase.from('community_bot_scenarios').select('*').eq('id', followup.scenario_id).maybeSingle()
    : { data: null }

  // Build a contextual reply prompt
  const messages = [
    { role: 'system', content: bot.persona_prompt },
    {
      role: 'user',
      content: `Another member posted this in the community:

TITLE: ${parentPost.title}
BODY: ${(parentPost.body || '').slice(0, 1500)}

Write a natural reply as yourself — agree, push back, add a number, or ask a sharp follow-up question. 1-3 sentences. Sound like a real practitioner, not a cheerleader.
${scenario?.avoid_list?.length ? `Avoid: ${scenario.avoid_list.join('; ')}.` : ''}

Respond as JSON: {"body": "..."}.`,
    },
  ]

  let groqResult
  try {
    groqResult = await groqChat({
      model: settings.groq_model,
      temperature: 0.9,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages,
    })
  } catch (err) {
    await supabase.from('community_bot_followups').update({ status: 'failed', error_message: err.message, completed_at: new Date().toISOString() }).eq('id', followup.id)
    return { status: 'failed', error: err.message }
  }

  const parsed = parseJsonFromGroq(groqResult.content) || {}
  let body = String(parsed.body || '').trim()
  if (body.length < 3) {
    await supabase.from('community_bot_followups').update({ status: 'failed', error_message: 'reply too short', completed_at: new Date().toISOString() }).eq('id', followup.id)
    return { status: 'failed', error: 'too_short' }
  }
  if (Number(settings.typo_chance) > 0) body = injectTypos(body, Number(settings.typo_chance))

  const moderation = await moderationPass({ text: body, enabled: !!settings.moderation_pass_enabled, groqModel: settings.groq_model })

  const status = moderation.result === 'fail' ? 'rejected'
    : settings.draft_review_enabled ? 'draft'
    : 'posted'

  let commentId = null
  if (status === 'posted') {
    try {
      const c = await createCommentAsBot({ bot, postId: parentPost.id, body })
      commentId = c.id
      await tickBotActivity(bot.id)
    } catch (err) {
      await supabase.from('community_bot_followups').update({ status: 'failed', error_message: err.message, completed_at: new Date().toISOString() }).eq('id', followup.id)
      return { status: 'failed', error: err.message }
    }
  }

  // Log the action
  const { data: action } = await supabase.from('community_bot_actions').insert({
    bot_id: bot.id,
    scenario_id: followup.scenario_id || null,
    triggered_by: 'reply_chain',
    action_type: 'comment',
    status,
    groq_request: { model: settings.groq_model, messages },
    groq_response: { content: groqResult.content, usage: groqResult.raw?.usage || null },
    generated_body: body,
    target_post_id: parentPost.id,
    target_comment_id: commentId,
    moderation_result: moderation.result,
    moderation_reason: moderation.reason,
    tokens_used: groqResult.tokens_used,
    cost_estimate_usd: groqResult.cost_estimate_usd,
    error_message: moderation.result === 'fail' ? `Moderation: ${moderation.reason}` : null,
    completed_at: new Date().toISOString(),
  }).select('id').single()

  await supabase.from('community_bot_followups').update({
    status: status === 'posted' || status === 'draft' ? 'done' : 'failed',
    completed_action_id: action?.id || null,
    error_message: moderation.result === 'fail' ? moderation.reason : null,
    completed_at: new Date().toISOString(),
  }).eq('id', followup.id)

  return { status, action_id: action?.id }
}

// ── helpers ─────────────────────────────────────────────────────────────

async function pickBot(botPool, tz = 'UTC') {
  let q = supabase.from('community_bots').select('*').eq('is_active', true)
  if (Array.isArray(botPool) && botPool.length > 0) q = q.in('id', botPool)
  const { data: pool } = await q
  if (!pool?.length) return null

  const eligible = pool.filter(b => {
    const resetStale = Date.now() - new Date(b.actions_today_reset_at || 0).getTime() > 24 * 60 * 60 * 1000
    const todayCount = resetStale ? 0 : (b.actions_today || 0)
    if (todayCount >= (b.daily_action_limit || Infinity)) return false
    // Evaluate the bot's active hours in the global timezone so one setting
    // controls everything (per-bot timezone has no UI yet).
    if (!isWithinActiveHours(b.active_hours_start, b.active_hours_end, tz)) return false
    return true
  })
  if (!eligible.length) return null
  return eligible[Math.floor(Math.random() * eligible.length)]
}

async function voteSwarm({ bot, scenario }) {
  const targetCount = scenario.vote_target_count || 5
  const sinceISO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  let q = supabase
    .from('community_posts').select('id, author_id')
    .gte('created_at', sinceISO).eq('is_removed', false)
    .neq('author_id', bot.profile_id)
    .order('created_at', { ascending: false }).limit(targetCount * 3)
  if (scenario.target_lot_id) q = q.eq('lot_id', scenario.target_lot_id)
  const { data: candidates } = await q
  if (!candidates?.length) return { voted: 0, attempted: 0 }

  const shuffled = [...candidates].sort(() => Math.random() - 0.5).slice(0, targetCount)
  let voted = 0
  for (const post of shuffled) {
    if (Math.random() > 0.7) continue
    try { await voteAsBot({ bot, targetType: 'post', targetId: post.id, value: 1 }); voted++ } catch { /* skip */ }
  }
  return { voted, attempted: shuffled.length }
}

async function spawnFollowups({ parentActionId, parentPostId, scenario, excludeBotId }) {
  const min = Math.max(0, scenario.followup_count_min || 0)
  const max = Math.max(min, scenario.followup_count_max || 0)
  const count = min === max ? min : (min + Math.floor(Math.random() * (max - min + 1)))
  if (count < 1) return

  const { data: pool } = await supabase
    .from('community_bots').select('id').eq('is_active', true).neq('id', excludeBotId)
  if (!pool?.length) return

  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count)
  const delayMin = Math.max(0, scenario.followup_delay_min_minutes || 15)
  const delayMax = Math.max(delayMin, scenario.followup_delay_max_minutes || 90)

  const rows = shuffled.map(b => {
    const delay = delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1))
    return {
      bot_id: b.id,
      scenario_id: scenario.id,
      parent_action_id: parentActionId,
      parent_post_id: parentPostId,
      due_at: new Date(Date.now() + delay * 60_000).toISOString(),
      status: 'pending',
    }
  })
  await supabase.from('community_bot_followups').insert(rows)
}

// Next fire time = base cadence + random 0..jitter_minutes, baked into
// next_run_at (non-blocking — no sleep stalls the tick loop).
function computeNextRun(schedule) {
  let next = nextRunAt(schedule, new Date())
  if (next && schedule.jitter_minutes > 0) {
    const offsetMs = Math.floor(Math.random() * schedule.jitter_minutes * 60_000)
    next = new Date(new Date(next).getTime() + offsetMs).toISOString()
  }
  return next
}

// CLAIM the slot — advance next_run_at up front so the schedule moves forward
// no matter what happens next (success, failure, crash). This is what stops a
// failing schedule from getting stuck "due now" and retrying every tick.
async function claimNextRun(schedule) {
  await supabase.from('community_bot_schedules')
    .update({ next_run_at: computeNextRun(schedule) })
    .eq('id', schedule.id)
}

// Count a completed run toward the daily cap + stamp last_run_at. Does NOT
// touch next_run_at (claimNextRun already advanced it).
async function markRun(schedule) {
  const resetStale = Date.now() - new Date(schedule.runs_today_reset_at || 0).getTime() > 24 * 60 * 60 * 1000
  const runsToday = resetStale ? 1 : (schedule.runs_today || 0) + 1
  const patch = {
    last_run_at: new Date().toISOString(),
    runs_today: runsToday,
  }
  if (resetStale) patch.runs_today_reset_at = new Date().toISOString()
  await supabase.from('community_bot_schedules').update(patch).eq('id', schedule.id)
}

async function insertAction({
  bot, scenario, schedule, settings, status,
  messages, groqResult = null, generatedTitle = null, generatedBody = null,
  anchor = null, moderation = null, targetPostId = null, targetCommentId = null, error_message = null,
}) {
  const { data } = await supabase.from('community_bot_actions').insert({
    bot_id: bot.id,
    scenario_id: scenario.id,
    schedule_id: schedule.id,
    triggered_by: 'schedule',
    action_type: scenario.action_type,
    status,
    groq_request: messages ? { model: settings.groq_model, temperature: scenario.tone_temperature, messages } : null,
    groq_response: groqResult ? { content: groqResult.content, usage: groqResult.raw?.usage || null } : null,
    generated_title: generatedTitle,
    generated_body: generatedBody,
    target_post_id: targetPostId,
    target_comment_id: targetCommentId,
    target_lot_id: scenario.target_lot_id || null,
    anchored_property_id:  anchor?.anchored_property_id  || null,
    anchored_wholesale_id: anchor?.anchored_wholesale_id || null,
    moderation_result: moderation?.result || null,
    moderation_reason: moderation?.reason || null,
    tokens_used: groqResult?.tokens_used || null,
    cost_estimate_usd: groqResult?.cost_estimate_usd || null,
    error_message,
    completed_at: new Date().toISOString(),
  }).select('id').single()
  return data?.id || null
}
