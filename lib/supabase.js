import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

// supabase-js v2.5x auto-inits a realtime client whose websocket factory
// needs a global WebSocket. Node < 22 doesn't ship one, so polyfill from `ws`.
// We never use realtime here — this just stops the constructor from throwing.
if (!globalThis.WebSocket) globalThis.WebSocket = ws

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url) throw new Error('Missing SUPABASE_URL in env.')
if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in env.')

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
})
