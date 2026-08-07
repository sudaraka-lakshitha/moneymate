import { createClient } from '@supabase/supabase-js';

// The anon key is a public, RLS-protected client key — it is meant to ship in the
// browser bundle. Values fall back to the project defaults so the app still runs
// without a local .env file.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://illvzuwxcvttbsoddptr.supabase.co';
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsbHZ6dXd4Y3Z0dGJzb2RkcHRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMjM2NjMsImV4cCI6MjEwMTY5OTY2M30.VnnMgXqZFeWnHxn22xjLVGiZ4PkhTPgoBdvyD_-Asgk';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});
