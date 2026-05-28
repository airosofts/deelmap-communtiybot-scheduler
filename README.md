# deelmap-bot-scheduler

Persistent Node service that fires community bot schedules.
Ticks every 60 seconds, finds due schedules, runs them through Groq,
and posts as bots. Standalone so Vercel/serverless can't kill it.

## What it does, in order

Every minute:

1. Read `community_bot_settings` — bail if `bots_enabled = false`.
2. Sum today's spend from `community_bot_actions`. Bail if over `daily_budget_usd`.
3. Find schedules where `next_run_at <= now()` and `is_active = true`.
4. For each schedule:
   - Skip if outside global active hours
   - Skip if `runs_today >= max_runs_per_day`
   - Pick a random bot from `bot_pool` (or any active bot if empty)
     - Skip the bot if its `last_action_at` is too recent, or if it's outside its own active hours
   - Sleep a random `0 - jitter_minutes` (cadence realism)
   - Call Groq with `bot.persona_prompt` + `scenario.generated_system_prompt`
   - Post / comment / vote as the bot
   - Log to `community_bot_actions`
   - Advance `next_run_at` based on cron expression or interval
   - Bump `runs_today`, `last_run_at`

If `draft_review_enabled = true` in settings, the action is logged as
`status='draft'` and **not** published — admin approves in the dashboard.

## Setup

```bash
cd deelmap-bot-scheduler
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY
npm install
npm start
```

Locally you'll see one tick per minute:

```
[2026-05-28T14:32:00.012Z] tick: 2 schedules due
[2026-05-28T14:32:01.234Z] schedule abc123 → bot @bluegrass_brrrr → posted
```

## Deploy to Railway

1. New project from this directory
2. Add the three env vars
3. Start command: `npm start`
4. ~$5/mo for an always-on hobby node process

## Where the kill switches are

| Knob | Location | Effect |
|---|---|---|
| Global ON/OFF | Admin → Bots → Settings | Master kill switch |
| Per-schedule pause | Admin → Bots → Schedules | Pause one schedule |
| Per-bot pause | Admin → Bots → Bots | Stops bot from being picked |
| Daily budget cap | Admin → Bots → Settings | Scheduler bails when reached |
| Draft review | Admin → Bots → Settings | Forces everything into review queue |
| Active hours | Admin → Bots → Settings | Scheduler refuses outside window |

If anything goes wrong, **turn off `bots_enabled` first** — that stops everything
at the next tick (within 60s). No deploy needed.

## Files

```
index.js            entry point — registers node-cron job
lib/supabase.js     service-role Supabase client
lib/groq.js         Groq chat-completions wrapper
lib/tick.js         the every-minute loop body
lib/execute.js      runs one schedule end-to-end
lib/cron.js         next-run-at calculator
lib/bot-content.js  post/comment/vote inserts (mirrors admin's lib)
lib/active-hours.js timezone-aware hour check
lib/jitter.js       random-sleep helper
```
