import React, { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import BrandMark from '../components/BrandMark';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { isSupabaseMode } from '../services/supabaseClient';

export default function AuthRecovery() {
  const { recoveryPending, needsMfa, mfaFactors, loading, authError, logoutUser } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState('');
  const [challenge, setChallenge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [complete, setComplete] = useState(false);
  const pendingMfa = needsMfa || challenge;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('error') || params.has('error_code')) setError('This reset link is invalid or expired. Request a fresh email from the sign-in screen.');
  }, []);

  if (!isSupabaseMode) return <Navigate to="/login" replace/>;
  const submit = async (event) => {
    event.preventDefault(); setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      setError('Use 8+ characters with uppercase, lowercase and a number.'); return;
    }
    setBusy(true);
    try {
      const result = await api.post('/api/password-reset/confirm/', { new_password: password, otp: code.trim() || undefined, factor_id: factorId || mfaFactors?.[0]?.id });
      if (result.status === 202) { setChallenge(true); setError(result.data.detail); return; }
      setMessage(result.data.message); setComplete(true); setPassword(''); setConfirm('');
    } catch (failure) { setError(failure.response?.data?.detail || failure.message || 'Unable to reset password.'); }
    finally { setBusy(false); }
  };
  return <div className="auth-page"><section className="auth-panel"><form className="auth-card" onSubmit={submit}>
    <BrandMark compact/><span className="micro-label">ACCOUNT RECOVERY</span><h2>Choose a new password</h2>
    {(error || authError) && <div className="alert error" role="alert">{error || authError}</div>}
    {message && <div className="alert success" role="status">{message}</div>}
    {loading ? <p>Checking your recovery link…</p> : !complete && !recoveryPending ? <p>Open a fresh reset email in the same browser and device that requested it. This link may have expired or already been used.</p> : null}
    {!complete && recoveryPending && <>
      <label><span>New password</span><input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}/></label>
      <label><span>Confirm password</span><input required type="password" minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}/></label>
      {pendingMfa && <>
        <p>Enter your authenticator code. Email recovery does not disable MFA, and legacy recovery codes are not supported.</p>
        {mfaFactors?.length > 1 && <label><span>Authenticator</span><select value={factorId || mfaFactors[0].id} onChange={(e) => setFactorId(e.target.value)}>{mfaFactors.map((factor, index) => <option key={factor.id} value={factor.id}>{factor.friendly_name || `Authenticator ${index + 1}`}</option>)}</select></label>}
        <label><span>Authenticator code</span><input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}/></label>
      </>}
      <button className="button primary full" disabled={busy || loading || (pendingMfa && !mfaFactors?.length)}>{busy ? 'Updating…' : 'Update password'}</button>
    </>}
    <div className="auth-switch"><Link to="/login" onClick={() => { if (recoveryPending) logoutUser(); }}>Back to sign in</Link></div>
  </form></section></div>;
}
