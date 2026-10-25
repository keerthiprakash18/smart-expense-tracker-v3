import { createClient } from '@supabase/supabase-js';

// Vite exposes every VITE_* value to browsers. Never accept an administrative key.
export function validateSupabaseConfig(env = {}) {
  const enabled = (env.VITE_BACKEND_PROVIDER || 'django').trim().toLowerCase() === 'supabase';
  if (!enabled) return { enabled, url: '', key: '', error: null };
  const url = (env.VITE_SUPABASE_URL || '').trim();
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
  const invalid = (message) => ({ enabled, url, key: '', error: new Error(message) });
  if (!url || !key) return invalid('Supabase mode requires VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY. Configure both and rebuild the frontend.');
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
        (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
      return invalid('VITE_SUPABASE_URL must be an HTTPS project URL (HTTP is allowed only for local development).');
    }
  } catch {
    return invalid('VITE_SUPABASE_URL must be a valid Supabase project URL.');
  }
  if (key.startsWith('sb_secret_') || /service_role/i.test(key)) {
    return invalid('Never put secret or service_role keys in VITE_* variables. Use a Supabase publishable key.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    // Older local Supabase projects use a JWT anon key; check its role explicitly.
    try {
      const parts = key.split('.');
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (parts.length !== 3 || payload.role !== 'anon') throw new Error('Not a public key');
    } catch {
      return invalid('VITE_SUPABASE_PUBLISHABLE_KEY must be a public sb_publishable_ key or a legacy anon key; secret/service_role keys are forbidden.');
    }
  }
  return { enabled, url: url.replace(/\/$/, ''), key, error: null };
}

const configuration = validateSupabaseConfig(import.meta.env || {});
export const isSupabaseMode = configuration.enabled;
export const supabaseConfigurationError = configuration.error;
export const supabase = isSupabaseMode && !configuration.error
  ? createClient(configuration.url, configuration.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  })
  : null;

export function requireSupabase() {
  if (!supabase) throw supabaseConfigurationError || new Error('Supabase authentication is not enabled.');
  return supabase;
}

export function authRedirectUrl(recovery = false) {
  const url = new URL(window.location.href);
  url.search = recovery ? '?auth=recovery' : '';
  url.hash = recovery ? '/reset-password' : '/login';
  return url.toString();
}

const RECOVERY_KEY = 'smart-expense-supabase-recovery';
export function getRecoveryUserId() {
  if (typeof sessionStorage === 'undefined') return null;
  const value = sessionStorage.getItem(RECOVERY_KEY);
  if (!value) return null;
  try {
    const { userId, expires } = JSON.parse(value);
    return expires > Date.now() ? userId : null;
  } catch { return null; }
}

export function clearRecoverySession() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(RECOVERY_KEY);
  const url = new URL(window.location.href);
  if (url.searchParams.get('auth') === 'recovery') {
    url.searchParams.delete('auth');
    window.history.replaceState(null, '', url);
  }
}

if (supabase && typeof window !== 'undefined') {
  // A query marker survives PKCE's query-code exchange and avoids HashRouter's
  // collision with implicit access_token fragments. No SDK calls in this callback.
  if (new URLSearchParams(window.location.search).get('auth') === 'recovery') {
    window.location.hash = '/reset-password';
  }
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session?.user?.id) {
      sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ userId: session.user.id, expires: Date.now() + 30 * 60 * 1000 }));
      window.location.hash = '/reset-password';
    }
    if (event === 'SIGNED_OUT') clearRecoverySession();
  });
}

// Reauthenticate without replacing the active AAL2 session or publishing a new
// SIGNED_IN event to route guards. This short-lived client never persists tokens.
export async function verifySupabasePassword(email, password) {
  requireSupabase();
  const verifier = createClient(configuration.url, configuration.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'smart-expense-password-check' },
  });
  const { error } = await verifier.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const { error: signOutError } = await verifier.auth.signOut({ scope: 'local' });
  if (signOutError) throw signOutError;
}
