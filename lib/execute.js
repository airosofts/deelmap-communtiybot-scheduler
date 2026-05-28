// Execute a single schedule.
//
// Mirrors the logic in admindashboarddeelmap/app/api/community-bots/scenarios/[id]/execute/route.js
// but adapted to direct DB access (no HTTP) so the scheduler is fully self-contained.

import { supabase } from './supabase.js'
import { groqChat, parseJsonFromGroq } from './groq.js'
import {
  createPostAsBot, createCommentAsBot, voteAsBot, tickBotActivity,
} from './bot-content.js'
import { isWithinActiveHours } from './active-hours.js'
import { nextRunAt } from './cron.js'
import { jitterMs, sleep } from './jitter.js'
import { log } from './log.js'

// Run one schedule end-to-end. Returns { status, action_id?, error? }.
export async function executeSchedule({ schedule, settings }) {
  // 1) Active hours (global) — reject quietly if outside
  if (!isWithinActiveHours(settings.active_hours_start, settings.active_hours_end)) {
    log.debug(`schedule ${schedule.id}: outside global active hours — skipping`)
    return { status: 'skipped', reason: 'outside_active_hours' }
  }

  // 2) Daily-runs cap on this schedule
  const resetStale = Date.now() - new Date(schedule.runs_today_reset_at || 0).getTime() > 24 * 60 * 60 * 1000
  const runsToday = resetStale ? 0 : (schedule.runs_today || 0)
  if (runsToday >= schedule.max_runs_per_day) {
    log.debug(`schedule ${schedule.id}: hit max_runs_per_day (${schedule.max_runs_per_day})`)
    // Don't advance next_run_at — wait for the counter to reset tomorrow.
    return { status: 'skipped', reason: 'max_runs_per_day' }
  }

  // 3) Load scenario
  const { data: scenario } = await supabase
    .from('community_bot_scenarios')
    .select(`*, lot:community_lots(id, slug, name, category)`)
    .eq('id', schedule.scenario_id)
    .maybeSingle()
  if (!scenario || !scenario.is_active) {
    log.warn(`schedule ${schedule.id}: scenario missing or paused`)
    return { status: 'skipped', reason: 'scenario_paused' }
  }

  // 4) Pick a bot from the pool — respect per-bot active hours + daily cap
  const bot = await pickBot(schedule.bot_pool)
  if (!bot) {
    log.warn(`schedule ${schedule.id}: no eligible bot`)
    return { status: 'skipped', reason: 'no_bot_available' }
  }

  // 5) Cadence realism — random sleep up to jitter_minutes
  const ms = jitterMs(schedule.jitter_minutes)
  if (ms > 0) {
    log.debug(`schedule ${schedule.id}: jitter ${(ms / 1000).toFixed(1)}s`)
    await sleep(ms)
  }

  // 6) Build Groq messages
  const targetWords = Math.floor(
    scenario.length_min_words + Math.random() * (scenario.length_max_words - scenario.length_min_words)
  )
  const lotContext   = scenario.lot ? `Lot: ${scenario.lot.name} (${scenario.lot.category})` : ''
  const avoidContext = scenario.avoid_list?.length ? `Do NOT include any of these: ${scenario.avoid_list.join('; ')}.` : ''
  const wantsTitle   = scenario.action_type === 'post'
  const formatInstr  = wantsTitle
    ? 'Respond as JSON: {"title": "...", "body": "..."}. Title 8–100 chars. Body is the post content.'
    : 'Respond as JSON: {"body": "..."}.'

  const messages = [
    { role: 'system', content: bot.persona_prompt },
    {
      role: 'user',
      content: `${scenario.generated_system_prompt}

${lotContext}
Target length: about ${targetWords} words.
${avoidContext}

${formatInstr}`,
    },
  ]

  // 7) Groq call
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
    await insertAction({
      bot, scenario, schedule, settings, status: 'failed',
      messages, error_message: err.message,
    })
    return { status: 'failed', error: err.message }
  }

  const parsed = parseJsonFromGroq(groqResult.content) || {}
  const title = wantsTitle ? String(parsed.title || '').trim().slice(0, 200) : null
  const body  = String(parsed.body || '').trim()

  if (wantsTitle && title.length < 8) {
    await insertAction({
      bot, scenario, schedule, settings, status: 'failed',
      messages, groqResult, generatedTitle: title, generatedBody: body,
      error_message: 'Generated title too short.',
    })
    return { status: 'failed', error: 'title_too_short' }
  }
  if (body.length < 5) {
    await insertAction({
      bot, scenario, schedule, settings, status: 'failed',
      messages, groqResult, generatedTitle: title, generatedBody: body,
      error_message: 'Generated body too short.',
    })
    return { status: 'failed', error: 'body_too_short' }
  }

  // 8) Draft mode? Log and stop — admin will approve in dashboard.
  if (settings.draft_review_enabled) {
    const actionId = await insertAction({
      bot, scenario, schedule, settings, status: 'draft',
      messages, groqResult, generatedTitle: title, generatedBody: body,
    })
    await bumpScheduleCounters(schedule)
    return { status: 'draft', action_id: actionId }
  }

  // 9) Publish
  try {
    let targetPostId = null
    let targetCommentId = null

    if (scenario.action_type === 'post') {
      if (!scenario.target_lot_id) throw new Error('Post scenario has no target_lot_id.')
      const post = await createPostAsBot({ bot, lotId: scenario.target_lot_id, title, body })
      targetPostId = post.id
    } else if (scenario.action_type === 'comment') {
      throw new Error('Comment scenarios need a target_post_id — not supported in scheduled mode yet.')
    } else if (scenario.action_type === 'vote') {
      throw new Error('Vote scenarios not supported in scheduled mode yet.')
    } else {
      throw new Error(`Action type "${scenario.action_type}" not supported in Phase 2.`)
    }

    await tickBotActivity(bot.id)
    const actionId = await insertAction({
      bot, scenario, schedule, settings, status: 'posted',
      messages, groqResult, generatedTitle: title, generatedBody: body,
      targetPostId, targetCommentId,
    })
    await bumpScheduleCounters(schedule)
    return { status: 'posted', action_id: actionId, post_id: targetPostId }
  } catch (err) {
    await insertAction({
      bot, scenario, schedule, settings, status: 'failed',
      messages, groqResult, generatedTitle: title, generatedBody: body,
      error_message: err.message,
    })
    return { status: 'failed', error: err.message }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

async function pickBot(botPool) {
  // If pool is empty, "any active bot."
  // Otherwise, intersect with active + not-over-daily-limit + within active hours.
  let q = supabase.from('community_bots').select('*').eq('is_active', true)
  if (Array.isArray(botPool) && botPool.length > 0) {
    q = q.in('id', botPool)
  }
  const { data: pool } = await q
  if (!pool?.length) return null

  const eligible = pool.filter(b => {
    const resetStale = Date.now() - new Date(b.actions_today_reset_at || 0).getTime() > 24 * 60 * 60 * 1000
    const todayCount = resetStale ? 0 : (b.actions_today || 0)
    if (todayCount >= (b.daily_action_limit || Infinity)) return false
    if (!isWithinActiveHours(b.active_hours_start, b.active_hours_end, b.timezone)) return false
    return true
  })
  if (!eligible.length) return null
  return eligible[Math.floor(Math.random() * eligible.length)]
}

async function bumpScheduleCounters(schedule) {
  const resetStale = Date.now() - new Date(schedule.runs_today_reset_at || 0).getTime() > 24 * 60 * 60 * 1000
  const runsToday = resetStale ? 1 : (schedule.runs_today || 0) + 1
  const patch = {
    last_run_at: new Date().toISOString(),
    runs_today: runsToday,
    next_run_at: nextRunAt(schedule, new Date()),
  }
  if (resetStale) patch.runs_today_reset_at = new Date().toISOString()
  await supabase.from('community_bot_schedules').update(patch).eq('id', schedule.id)
}

async function insertAction({
  bot, scenario, schedule, settings, status,
  messages, groqResult = null, generatedTitle = null, generatedBody = null,
  targetPostId = null, targetCommentId = null, error_message = null,
}) {
  const row = {
    bot_id: bot.id,
    scenario_id: scenario.id,
    schedule_id: schedule.id,
    triggered_by: 'schedule',
    action_type: scenario.action_type,
    status,
    groq_request: {
      model: settings.groq_model,
      temperature: scenario.tone_temperature,
      messages,
    },
    groq_response: groqResult ? {
      content: groqResult.content,
      usage: groqResult.raw?.usage || null,
    } : null,
    generated_title: generatedTitle,
    generated_body: generatedBody,
    target_post_id: targetPostId,
    target_comment_id: targetCommentId,
    target_lot_id: scenario.target_lot_id || null,
    tokens_used: groqResult?.tokens_used || null,
    cost_estimate_usd: groqResult?.cost_estimate_usd || null,
    error_message,
    completed_at: new Date().toISOString(),
  }
  const { data } = await supabase
    .from('community_bot_actions')
    .insert(row)
    .select('id')
    .single()
  return data?.id || null
}
