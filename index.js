// deelmap-bot-scheduler — entry point.
//
// Loads env, registers a node-cron job that fires every minute,
// and triggers an immediate tick on startup so we don't wait
// up to a minute on cold boot.

import 'dotenv/config'
import cron from 'node-cron'
import { tick } from './lib/tick.js'
import { log } from './lib/log.js'

log.info('deelmap-bot-scheduler starting…')
log.info(`log level: ${process.env.LOG_LEVEL || 'info'}`)

// One immediate tick so deploys see activity in the logs
tick().catch(err => log.error('initial tick failed:', err.message))

// node-cron: '* * * * *' = every minute on the minute (server clock)
cron.schedule('* * * * *', () => {
  tick().catch(err => log.error('tick failed:', err.message))
})

// Keep the process alive, surface uncaught errors instead of dying silent
process.on('unhandledRejection', err => log.error('unhandledRejection:', err))
process.on('uncaughtException',  err => log.error('uncaughtException:',  err))
process.on('SIGTERM', () => { log.info('SIGTERM received — shutting down'); process.exit(0) })
process.on('SIGINT',  () => { log.info('SIGINT received — shutting down');  process.exit(0) })

log.info('cron registered: tick every 60 seconds')
