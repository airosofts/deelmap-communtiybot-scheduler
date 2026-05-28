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
    const next = new Date(after.getTime() + schedule.interval_minutes * 60_000)
    return next.toISOString()
  }
  return null
}
