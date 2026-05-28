// Random sleep — cadence realism so bot posts don't all hit at :00.
//
// Caller is responsible for clamping `maxMinutes`. We add a tiny
// 0-2 second always-on baseline so even zero-jitter schedules don't
// flock on the same exact tick.

export function jitterMs(maxMinutes) {
  const minutes = Math.max(0, Math.min(60, Number(maxMinutes) || 0))
  const millis = Math.floor(Math.random() * minutes * 60_000)
  return millis + Math.floor(Math.random() * 2000)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
