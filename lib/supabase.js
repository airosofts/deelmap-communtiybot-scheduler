import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url) throw new Error('Missing SUPABASE_URL in env.')
if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in env.')

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})
