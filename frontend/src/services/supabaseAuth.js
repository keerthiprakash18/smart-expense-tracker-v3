import {
  isSupabaseMode, supabase, supabaseConfigurationError, authRedirectUrl,
  verifySupabasePassword, getRecoveryUserId, clearRecoverySession,
} from './supabaseClient.js';

export function authError(message, status = 400, code = 'auth_error', extra = {}) {
  const error = new Error(message);
  error.response = { status, data: { detail: message, error: message, code, ...extra } };
  return error;
}

function checked(result) {
  if (result.error) throw result.error;
  return result.data;
}

export function normalizeAuthError(error) {
  if (error.response) return error;
  const code = error.code || 'auth_error';
  const message = code === 'email_not_confirmed'
    ? 'Confirm your email using the signup email before signing in. You can request another confirmation email below.'
    : error.message || 'Authentication failed. Please try again.';
  return authError(message, error.status || 400, code);
}

// Always ask Auth for current factors: session.user can be stale after MFA is
// enrolled on another device. Passing the JWT also makes the SDK validate user
// state remotely rather than relying solely on a locally decoded session.
export async function readSupabaseAuthState(client = supabase) {
  if (!client) throw supabaseConfigurationError || authError('Supabase is not configured.', 503);
  const { session } = checked(await client.auth.getSession());
  if (!session) return { session: null, authenticated: false, needsMfa: false, factors: [] };
  const assurance = checked(await client.auth.mfa.getAuthenticatorAssuranceLevel(session.access_token));
  const factors = checked(await client.auth.mfa.listFactors());
  const verified = factors.all.filter((factor) => factor.status === 'verified');
  const needsMfa = (assurance.nextLevel === 'aal2' || verified.length > 0) && assurance.currentLevel !== 'aal2';
  return {
    session,
    authenticated: !needsMfa && ['aal1', 'aal2'].includes(assurance.currentLevel),
    needsMfa,
    factors: verified.filter((factor) => factor.factor_type === 'totp'),
    allFactors: factors.all,
  };
}

const response = (data, status = 200) => ({ data, status });
const mfaRequired = (state) => response({
  two_factor_required: true,
  detail: state.factors.length
    ? 'Enter the current 6-digit code from your authenticator app. Legacy recovery codes are not supported.'
    : 'This account requires an MFA method this app does not support. Contact your project administrator.',
  factors: state.factors.map(({ id, friendly_name }) => ({ id, friendly_name })),
}, 202);

async function verifyFactor(client, code, factorId, factors) {
  if (!/^\d{6}$/.test(String(code || '').trim())) {
    throw authError('Enter a current 6-digit authenticator code. Legacy recovery codes do not work with Supabase.');
  }
  const factor = factorId ? factors.find((item) => item.id === factorId) : factors[0];
  if (!factor) throw authError('No supported authenticator factor is available.', 409, 'unsupported_mfa');
  checked(await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: String(code).trim() }));
}

async function authenticatedState(client) {
  const state = await readSupabaseAuthState(client);
  if (!state.session) throw authError('Sign in to continue.', 401);
  if (!state.authenticated) throw authError('Complete authenticator verification before continuing.', 403, 'mfa_required', { two_factor_required: true });
  return state;
}

const routes = new Set([
  'POST /api/register/', 'POST /api/token/', 'POST /api/token/mfa/',
  'POST /api/token/refresh/', 'POST /api/logout/', 'POST /api/change-password/', 'POST /api/delete-account/',
  'GET /api/v3/security/', 'POST /api/v3/security/2fa/setup/',
  'POST /api/v3/security/2fa/confirm/', 'POST /api/v3/security/2fa/disable/',
  'POST /api/password-reset/', 'POST /api/password-reset/confirm/',
  'POST /api/resend-confirmation/', 'POST /api/v3/password-reset/recovery/',
]);

// Dependency injection keeps boundary tests offline: no real account or secret
// is needed. The production export below uses the singleton Supabase client.
export function createSupabaseAuthHandler(client, {
  enabled = true, configurationError = null, redirectUrl = authRedirectUrl,
  verifyPassword = verifySupabasePassword, recoveryUserId = getRecoveryUserId,
  finishRecovery = clearRecoverySession,
} = {}) {
  let pendingFactor = null;
  return async function handle(method, path, data = {}) {
    const endpoint = `/${String(path).split('?')[0].replace(/^\/+|\/+$/g, '')}/`;
    const route = `${String(method).toUpperCase()} ${endpoint}`;
    if (!enabled || !routes.has(route)) return null;
    try {
      if (!client) throw configurationError || authError('Supabase is not configured.', 503);
      if (endpoint === '/api/register/') {
        const email = String(data.email || '').trim().toLowerCase();
        if (!email || !data.password) throw authError('Email and password are required.');
        if (data.accepted_terms !== true || data.accepted_privacy !== true) throw authError('Accept the Terms and Privacy Policy before signing up.');
        const signedUp = checked(await client.auth.signUp({
          email, password: data.password,
          options: {
            emailRedirectTo: redirectUrl(false),
            data: { name: String(data.name || '').trim(), phone: String(data.phone || '').trim(), accepted_terms: true, accepted_privacy: true, terms_accepted_at: true, privacy_accepted_at: true },
          },
        }));
        // Respect the project's confirmation policy. Never fabricate tokens or
        // turn signup into an automatic login if confirmations are disabled.
        if (signedUp.session) checked(await client.auth.signOut({ scope: 'local' }));
        return response({
          confirmation_required: !signedUp.session,
          message: signedUp.session ? 'Account created. You can now sign in.' : 'Check your email to confirm your account, then sign in. Open the link in this browser.',
        }, 201);
      }
      if (endpoint === '/api/token/' || endpoint === '/api/token/mfa/') {
        if (endpoint === '/api/token/') {
          const email = String(data.email || data.username || '').trim().toLowerCase();
          if (!email.includes('@') || !data.password) throw authError('Enter your email address and password.');
          checked(await client.auth.signInWithPassword({ email, password: data.password }));
        }
        let state = await readSupabaseAuthState(client);
        if (state.needsMfa && (data.otp || data.code)) {
          await verifyFactor(client, data.otp || data.code, data.factor_id, state.factors);
          state = await readSupabaseAuthState(client);
        }
        if (state.needsMfa) return mfaRequired(state);
        if (!state.authenticated) throw authError('No authenticated session was returned. Sign in again.', 401);
        return response({ access: state.session.access_token });
      }
      if (endpoint === '/api/token/refresh/') {
        checked(await client.auth.refreshSession());
        const state = await authenticatedState(client);
        return response({ access: state.session.access_token });
      }
      if (endpoint === '/api/logout/') {
        checked(await client.auth.signOut({ scope: 'local' }));
        pendingFactor = null;
        finishRecovery();
        return response({ message: 'Signed out.' });
      }
      if (endpoint === '/api/resend-confirmation/') {
        checked(await client.auth.resend({ type: 'signup', email: String(data.email || '').trim().toLowerCase(), options: { emailRedirectTo: redirectUrl(false) } }));
        return response({ message: 'If this account needs confirmation, a confirmation email has been sent. Open it in this browser.' });
      }
      if (endpoint === '/api/password-reset/') {
        checked(await client.auth.resetPasswordForEmail(String(data.email || '').trim().toLowerCase(), { redirectTo: redirectUrl(true) }));
        return response({ message: 'If an account exists for this email, a reset link has been sent. Open it in this browser and device.' });
      }
      if (endpoint === '/api/v3/password-reset/recovery/') {
        throw authError('Legacy recovery codes are not supported in Supabase mode. Request a password-reset email instead.', 409, 'legacy_recovery_unsupported');
      }
      if (endpoint === '/api/password-reset/confirm/') {
        let state = await readSupabaseAuthState(client);
        if (!state.session || recoveryUserId() !== state.session.user.id) throw authError('Open a fresh password-reset email in the browser that requested it.', 403, 'recovery_session_required');
        if (state.needsMfa && data.otp) {
          await verifyFactor(client, data.otp, data.factor_id, state.factors);
          state = await readSupabaseAuthState(client);
        }
        if (state.needsMfa) return mfaRequired(state);
        if (!state.authenticated) throw authError('Unable to verify the recovery session.', 403);
        if (String(data.new_password || '').length < 8) throw authError('Use a password with at least 8 characters.');
        checked(await client.auth.updateUser({ password: data.new_password }));
        checked(await client.auth.signOut({ scope: 'global' }));
        finishRecovery();
        return response({ message: 'Password updated. Sign in with your new password.' });
      }
      const state = await authenticatedState(client);
      if (endpoint === '/api/delete-account/') {
        if (!data.password || data.confirmation !== 'DELETE') throw authError('Enter your current password and type DELETE to confirm account deletion.');
        const result = await client.functions.invoke('delete-account', {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.session.access_token}` },
          body: { password: data.password, confirmation: data.confirmation },
        });
        if (result.error) {
          // FunctionsHttpError exposes the actual response. Preserve intentional
          // 400/401/403/409 failures without leaking arbitrary server internals.
          const context = result.error.context;
          let payload;
          if (context && typeof context.json === 'function') {
            try { payload = await context.json(); } catch { /* Non-JSON platform error. */ }
          }
          throw authError(payload?.error || 'Account deletion could not complete. Check the function configuration or try again after checking your account status.', context?.status || 503, payload?.code || 'account_deletion_failed', { receipts_may_have_been_removed: Boolean(payload?.receipts_may_have_been_removed) });
        }
        if (result.data?.deleted !== true) throw authError('Account deletion was not confirmed by the server.', 502, 'account_deletion_unconfirmed');
        const signedOut = await client.auth.signOut({ scope: 'local' });
        if (signedOut.error) throw authError('Your account was deleted, but local sign-out could not complete. Close this tab and sign in again if needed.', 503, 'account_deleted_signout_failed', { account_deleted: true });
        finishRecovery();
        return response({ deleted: true, message: 'Your account and app records were deleted.' });
      }
      if (endpoint === '/api/change-password/') {
        if (!data.old_password || String(data.new_password || '').length < 8) throw authError('Enter your current password and a new password with at least 8 characters.');
        checked(await client.auth.updateUser({ password: data.new_password, current_password: data.old_password }));
        checked(await client.auth.signOut({ scope: 'global' }));
        return response({ message: 'Password updated. Sign in again.' });
      }
      if (endpoint === '/api/v3/security/') {
        const verified = state.allFactors.filter((factor) => factor.status === 'verified');
        return response({ two_factor_enabled: verified.length > 0, recovery_codes_remaining: 0, recovery_codes_supported: false, email_verified: Boolean(state.session.user.email_confirmed_at), mfa_disable_supported: state.factors.length === 1 && verified.every((factor) => factor.factor_type === 'totp') });
      }
      if (endpoint === '/api/v3/security/2fa/setup/') {
        if (state.factors.length) throw authError('An authenticator is already enabled. Disable it before setting up a replacement.', 409);
        // Remove only this app's abandoned, unverified enrollments.
        for (const factor of state.allFactors.filter((item) => item.status === 'unverified' && item.factor_type === 'totp' && item.friendly_name === 'Smart Expense')) {
          checked(await client.auth.mfa.unenroll({ factorId: factor.id }));
        }
        const factor = checked(await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Smart Expense' }));
        pendingFactor = { id: factor.id, userId: state.session.user.id };
        const svgPrefix = 'data:image/svg+xml;utf-8,';
        const qr = factor.totp.qr_code.startsWith(svgPrefix)
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(factor.totp.qr_code.slice(svgPrefix.length))}`
          : factor.totp.qr_code;
        return response({ factor_id: factor.id, secret: factor.totp.secret, qr_data_url: qr, uri: factor.totp.uri });
      }
      if (endpoint === '/api/v3/security/2fa/confirm/') {
        if (!pendingFactor || pendingFactor.userId !== state.session.user.id) throw authError('Start authenticator setup again.', 409);
        await verifyFactor(client, data.code, pendingFactor.id, [{ id: pendingFactor.id }]);
        pendingFactor = null;
        return response({ two_factor_enabled: true, recovery_codes: [], recovery_codes_supported: false });
      }
      if (endpoint === '/api/v3/security/2fa/disable/') {
        if (!data.password) throw authError('Enter your current password.');
        if (state.factors.length !== 1 || state.allFactors.some((factor) => factor.status === 'verified' && factor.factor_type !== 'totp')) {
          throw authError('This screen can disable one TOTP authenticator only. Contact your project administrator to manage other MFA factors.', 409, 'unsupported_mfa');
        }
        await verifyPassword(state.session.user.email, data.password);
        await verifyFactor(client, data.code, state.factors[0].id, state.factors);
        checked(await client.auth.mfa.unenroll({ factorId: state.factors[0].id }));
        checked(await client.auth.refreshSession());
        return response({ two_factor_enabled: false });
      }
      return null;
    } catch (error) { throw normalizeAuthError(error); }
  };
}

export const handleSupabaseAuth = createSupabaseAuthHandler(supabase, {
  enabled: isSupabaseMode, configurationError: supabaseConfigurationError,
});
