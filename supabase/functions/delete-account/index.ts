import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createDeleteAccountHandler } from './handler.ts';

// These are server-only Edge Function secrets, never VITE_* configuration.
const config = {
  url: Deno.env.get('SUPABASE_URL') || '',
  publicKey: Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '',
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '',
  allowedOrigins: (Deno.env.get('AUTH_ALLOWED_ORIGINS') || '').split(',').map((value) => value.trim()).filter(Boolean),
};

Deno.serve(createDeleteAccountHandler({
  config,
  createClient: (url, key, options) => createClient(url, key, {
    ...options,
    global: {
      // Each network operation is bounded; the handler also caps the entire
      // cleanup, inventory size, tree depth and number of storage requests.
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
    },
  }),
}));
