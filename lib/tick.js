// The every-minute loop body.
//
// 1. Read global settings — bail on kill switch
// 2. Sum today's spend vs daily_budget_usd
// 3. Find due schedules
// 4. Execute each one (with cadence jitter)
// 5. Continue — failures on one schedule don't block others

import { supabase } from './supabase.js'
import { executeSchedule, processFollowup } from './execute.js'
import { jitterMs, sleep } from './jitter.js'
import { log } from './log.js'

let tickInFlight = false  // simple re-entry guard if a tick runs long

export async function tick() {
  if (tickInFlight) {
    log.debug('tick already in flight, skipping')
    return
  }
  tickInFlight = true

  try {
    // 1. Settings
    const { data: settings, error: settingsErr } = await supabase
      .from('community_bot_settings').select('*').eq('id', 1).maybeSingle()
    if (settingsErr) { log.error('settings query failed:', settingsErr.message); return }
    if (!settings) {
      log.error('settings row missing — run migration 003.')
      return
    }
    if (!settings.bots_enabled) {
      log.debug('bots_enabled = false — tick skipped')
      return
    }

    // 2. Budget check (UTC day boundary)
    if (Number(settings.daily_budget_usd) > 0) {
      const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0)
      const { data: todays } = await supabase
        .from('community_bot_actions')
        .select('cost_estimate_usd')
        .gte('created_at', startOfToday.toISOString())
      const spent = (todays || []).reduce((s, a) => s + Number(a.cost_estimate_usd || 0), 0)
      if (spent >= Number(settings.daily_budget_usd)) {
        log.warn(`daily budget reached: $${spent.toFixed(4)} of $${settings.daily_budget_usd} — tick skipped`)
        return
      }
    }

    const nowISO = new Date().toISOString()

    // 3. Due reply-chain follow-ups (process first — they're time-sensitive)
    const { data: followups } = await supabase
      .from('community_bot_followups')
      .select('*')
      .lte('due_at', nowISO)
      .eq('status', 'pending')
      .limit(20)
    if (followups?.length) {
      log.info(`tick: ${followups.length} follow-up${followups.length === 1 ? '' : 's'} due`)
      for (const followup of followups) {
        try {
          // Light jitter so chained replies don't all land on the same second
          await sleep(Math.min(jitterMs(2), 5000))
          const result = await processFollowup({ followup, settings })
          log.info(`followup ${followup.id.slice(0, 8)} → ${result.status}`)
        } catch (err) {
          log.error(`followup ${followup.id} threw:`, err.message)
        }
      }
    }

    // 4. Due schedules
    const { data: due, error: dueErr } = await supabase
      .from('community_bot_schedules')
      .select('*')
      .lte('next_run_at', nowISO)
      .eq('is_active', true)
      .limit(20)
    if (dueErr) { log.error('schedules query failed:', dueErr.message); return }
    if (!due?.length) {
      log.debug('no schedules due')
      return
    }

    log.info(`tick: ${due.length} schedule${due.length === 1 ? '' : 's'} due`)

    // 5. Execute each — serialize so we don't blow past the budget mid-tick
    for (const schedule of due) {
      try {
        const result = await executeSchedule({ schedule, settings })
        const tag = result.action_id ? ` action=${result.action_id.slice(0, 8)}` : ''
        const why = result.reason ? ` (${result.reason})` : ''
        log.info(`schedule ${schedule.id.slice(0, 8)} → ${result.status}${tag}${why}`)
      } catch (err) {
        log.error(`schedule ${schedule.id} threw:`, err.message)
      }
    }
  } finally {
    tickInFlight = false
  }
}
