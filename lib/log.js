// Tiny level-aware logger. LOG_LEVEL env var controls verbosity.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const current = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] || LEVELS.info

function ts() { return new Date().toISOString() }

function fmt(level, args) {
  return `[${ts()}] ${level.toUpperCase()} ${args.join(' ')}`
}

export const log = {
  debug: (...a) => { if (current <= LEVELS.debug) console.log(fmt('debug', a)) },
  info:  (...a) => { if (current <= LEVELS.info)  console.log(fmt('info',  a)) },
  warn:  (...a) => { if (current <= LEVELS.warn)  console.warn(fmt('warn',  a)) },
  error: (...a) => { if (current <= LEVELS.error) console.error(fmt('error', a)) },
}
