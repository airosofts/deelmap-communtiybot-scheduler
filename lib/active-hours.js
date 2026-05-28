// Is "now" inside [startHour, endHour] in the given IANA timezone?
//
// Handles the windows-that-cross-midnight case (e.g. 22 to 6 means
// 22:00-23:59 OR 00:00-05:59 — wrap-around is intentional).

export function isWithinActiveHours(startHour, endHour, timezone = 'America/New_York') {
  if (startHour == null || endHour == null) return true
  if (startHour === endHour) return true  // "all day"

  let hour
  try {
    hour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
      10,
    )
  } catch {
    hour = new Date().getUTCHours()  // fallback
  }

  if (startHour < endHour) {
    // Normal window: e.g. 9 - 21
    return hour >= startHour && hour <= endHour
  }
  // Wrap-around window: e.g. 22 - 6
  return hour >= startHour || hour <= endHour
}
