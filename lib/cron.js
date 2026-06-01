// Next-firing-time calculator for community_bot_schedules rows.
// Uses cron-parser for cron strings; falls back to interval_minutes addition.

import cronParser from 'cron-parser'

// Returns an ISO timestamp string of the next time this schedule should fire,
// or null if neither cron_expression nor interval_minutes is set.
export function nextRunAt(schedule, after = new Date()) {
  if (schedule.cron_expression) {
    try {
      const it = cronParser.parseExpression(schedule.cron_expression, {
        currentDate: after,
      })
      return it.next().toDate().toISOString()
    } catch {
      return null
    }
  }
  if (schedule.interval_minutes) {
    // Subtract a 10s buffer so an N-minute interval lands JUST BEFORE the
    // next minute-aligned tick instead of just after it. Without this, a
    // 1-min interval fired at :00:02 produced next_run_at = :01:02, which
    // the :01:00 tick missed (next_run_at > now), so the schedule ended up
    // running every other tick (2 min) instead of every minute.
    const ms = schedule.interval_minutes * 60_000 - 10_000
    const next = new Date(after.getTime() + ms)
    return next.toISOString()
  }
  return null
}
