import React, { useEffect, useState } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, LockKeyhole, Moon, ScanLine, ShieldCheck, Sparkles, Sun, TrendingUp, WalletCards } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api, { setTokens } from '../services/api';
import BrandMark from '../components/BrandMark';
import { useTheme } from '../context/ThemeContext';
import { isSupabaseMode } from '../services/supabaseClient';

export default function Login() {
  return isSupabaseMode ? <SupabaseLogin /> : <LegacyLogin />;
}

function SupabaseLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const { loginUser, logoutUser, needsMfa, mfaFactors, recoveryPending, authError } = useAuth();
  const { isLight, toggleMode } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState('');
  const [challenge, setChallenge] = useState(false);
  const [factors, setFactors] = useState([]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmationNeeded, setConfirmationNeeded] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const pendingMfa = challenge || needsMfa;
  const availableFactors = factors.length ? factors : mfaFactors || [];

  useEffect(() => {
    if (recoveryPending) navigate('/reset-password', { replace: true });
  }, [recoveryPending, navigate]);

  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.post(pendingMfa ? '/api/token/mfa/' : '/api/token/', pendingMfa
        ? { otp: code.trim(), factor_id: factorId || availableFactors[0]?.id }
        : { username: email.trim(), password });
      if (result.status === 202 || result.data?.two_factor_required) {
        setChallenge(true);
        setFactors(result.data.factors || []);
        setMessage(result.data.detail || 'Enter your authenticator code.');
        return;
      }
      await loginUser();
      navigate(location.state?.from || '/', { replace: true });
    } catch (failure) {
      const data = failure.response?.data;
      setConfirmationNeeded(data?.code === 'email_not_confirmed');
      setError(data?.detail || failure.message || 'Unable to sign in.');
    } finally { setBusy(false); }
  };

  const resend = async () => {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api.post('/api/resend-confirmation/', { email: email.trim() }); setMessage(result.data.message); }
    catch (failure) { setError(failure.response?.data?.detail || failure.message); }
    finally { setBusy(false); }
  };

  return <div className="auth-page">
    <button type="button" className="auth-theme-toggle" onClick={toggleMode} aria-label="Toggle theme">{isLight ? <Moon size={18}/> : <Sun size={18}/>}</button>
    <div className="auth-grid-bg"/><div className="auth-orb one"/><div className="auth-orb two"/>
    <section className="auth-story">
      <div className="auth-logo-wrap"><span/><BrandMark className="auth-brand-lockup"/></div>
      <div className="auth-story-copy"><div className="eyebrow">SMART MONEY • LESS NOISE</div><h1>Know exactly where your money is going.</h1><p>Your personal finance workspace, protected with email sign-in and optional authenticator verification.</p><div className="auth-points"><div><ShieldCheck size={18}/><span>Account-scoped data</span></div><div><LockKeyhole size={18}/><span>Secure session and authenticator support</span></div></div></div>
    </section>
    <section className="auth-panel"><form className="auth-card" onSubmit={submit}>
      <div className="auth-mobile-logo"><BrandMark compact/></div><span className="micro-label">WELCOME BACK</span>
      <h2>{pendingMfa ? 'Verify your authenticator' : 'Sign in to your workspace'}</h2>
      <p>{pendingMfa ? 'Enter a current 6-digit authenticator code. Legacy recovery codes are not supported.' : 'Use the email address you registered and confirmed.'}</p>
      {(error || authError) && <div className="alert error" role="alert">{error || authError}</div>}
      {message && <div className="alert success" role="status">{message}</div>}
      {!pendingMfa && <>
        <label><span>Email</span><input autoFocus required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@example.com"/></label>
        <label><span>Password</span><div className="password-field"><input required type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"/><button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>
      </>}
      {pendingMfa && <>
        {availableFactors.length > 1 && <label><span>Authenticator</span><select value={factorId || availableFactors[0]?.id} onChange={(e) => setFactorId(e.target.value)}>{availableFactors.map((factor, index) => <option key={factor.id} value={factor.id}>{factor.friendly_name || `Authenticator ${index + 1}`}</option>)}</select></label>}
        <label><span>Authenticator code</span><input required autoFocus inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" placeholder="123456"/></label>
      </>}
      <button className="button primary full auth-submit" disabled={busy || (pendingMfa && availableFactors.length === 0)}>{busy ? 'Verifying…' : <>{pendingMfa ? 'Verify and sign in' : 'Sign in'} <ArrowRight size={18}/></>}</button>
      {pendingMfa && <button className="text-button" type="button" disabled={busy} onClick={() => { logoutUser(); setChallenge(false); setFactors([]); setCode(''); setPassword(''); setMessage(''); }}>Cancel and use another account</button>}
      {confirmationNeeded && <button type="button" className="text-button" disabled={busy || !email.trim()} onClick={resend}>Resend confirmation email</button>}
      <button type="button" className="text-button auth-forgot" onClick={() => setRecoveryOpen(true)}><KeyRound size={14}/> Forgot password? Send a reset email</button>
      <div className="auth-switch">New to Smart Expense? <Link to="/register">Create an account</Link></div>
      <div className="auth-secure"><ShieldCheck size={15}/> Secure personal finance workspace</div>
    </form></section>
    {recoveryOpen && <EmailRecoveryModal initialEmail={email} onClose={() => setRecoveryOpen(false)}/>}
  </div>;
}

function EmailRecoveryModal({ initialEmail, onClose }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { const result = await api.post('/api/password-reset/', { email: email.trim() }); setMessage(result.data.message); }
    catch (failure) { setError(failure.response?.data?.detail || failure.message); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><form className="modal-card reset-card" onSubmit={submit}>
    <div className="modal-head"><h2>Reset your password</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close recovery dialog">×</button></div>
    <p>Open the reset email on this browser and device. Authenticator verification is still required if you enabled MFA; legacy recovery codes cannot be used.</p>
    {error && <div className="alert error" role="alert">{error}</div>}{message && <div className="alert success" role="status">{message}</div>}
    <label><span>Email</span><input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}/></label>
    <button className="button primary full" disabled={busy}>{busy ? 'Sending…' : 'Send reset email'}</button>
  </form></div>;
}

function LegacyLogin() {
  const navigate=useNavigate(); const location=useLocation(); const {loginUser}=useAuth(); const {isLight,toggleMode}=useTheme();
  const [username,setUsername]=useState(''); const [password,setPassword]=useState(''); const [otp,setOtp]=useState(''); const [needsOtp,setNeedsOtp]=useState(false);
  const [show,setShow]=useState(false); const [loading,setLoading]=useState(false); const [error,setError]=useState(''); const [recoveryOpen,setRecoveryOpen]=useState(false);
  const submit=async(e)=>{e.preventDefault();setLoading(true);setError('');try{const res=await api.post('/api/token/',{username:username.trim(),password,otp:otp.trim()||undefined});if(res.status===202||res.data?.two_factor_required){setNeedsOtp(true);setError(res.data?.detail||'Enter your authenticator code.');return}setTokens(res.data.access);loginUser(res.data.access);navigate(location.state?.from||'/',{replace:true})}catch(err){if(err.response?.data?.two_factor_required)setNeedsOtp(true);setError(err.response?.data?.detail||'Invalid username or password.')}finally{setLoading(false)}};
  return <div className="auth-page"><button type="button" className="auth-theme-toggle" onClick={toggleMode} aria-label="Toggle theme">{isLight?<Moon size={18}/>:<Sun size={18}/>}</button><div className="auth-grid-bg"/><div className="auth-orb one"/><div className="auth-orb two"/><section className="auth-story"><div className="auth-logo-wrap"><span/><BrandMark className="auth-brand-lockup"/></div><div className="auth-story-copy"><div className="eyebrow">SMART MONEY • LESS NOISE</div><h1>Know exactly where your money is going.</h1><p>Transactions, OCR receipts, analytics, bills, automation and goals — one secure workspace.</p><div className="auth-points"><div><Sparkles size={18}/><span>Automatic receipt data extraction</span></div><div><ShieldCheck size={18}/><span>User-isolated secure data</span></div><div><LockKeyhole size={18}/><span>JWT + optional 2FA</span></div></div><div className="auth-product-preview"><div className="preview-head"><span><i/> LIVE WORKSPACE</span><strong>Protected</strong></div><div className="preview-balance"><small>Available balance</small><strong>₹42,840</strong><em><TrendingUp size={14}/> +12.4%</em></div><div className="preview-bars"><i style={{height:'45%'}}/><i style={{height:'68%'}}/><i style={{height:'52%'}}/><i style={{height:'82%'}}/><i style={{height:'64%'}}/><i style={{height:'92%'}}/><i style={{height:'74%'}}/></div><div className="preview-footer"><span><WalletCards size={15}/> Smart ledger</span><span><ScanLine size={15}/> OCR ready</span></div></div></div></section><section className="auth-panel"><form className="auth-card" onSubmit={submit}><div className="auth-mobile-logo"><BrandMark compact /></div><span className="micro-label">WELCOME BACK</span><h2>Sign in to your workspace</h2><p>Continue from exactly where you left your finances.</p>{error&&<div className={`alert ${needsOtp?'success':'error'}`}>{error}</div>}<label><span>Username or email</span><input autoFocus required value={username} onChange={e=>setUsername(e.target.value)} placeholder="Enter username or email" autoComplete="username"/></label><label><span>Password</span><div className="password-field"><input required type={show?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password"/><button type="button" onClick={()=>setShow(!show)} aria-label={show?'Hide password':'Show password'}>{show?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></label>{needsOtp&&<label><span>Authenticator or recovery code</span><input required maxLength="16" value={otp} onChange={e=>setOtp(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,16))} placeholder="6-digit code or recovery code" autoComplete="one-time-code"/></label>}<button className="button primary full auth-submit" disabled={loading}>{loading?'Signing in…':<>Sign in <ArrowRight size={18}/></>}</button><button type="button" className="text-button auth-forgot" onClick={()=>setRecoveryOpen(true)}><KeyRound size={14}/> Forgot password? Use recovery code</button><div className="auth-switch">New to Smart Expense? <Link to="/register">Create an account</Link></div><div className="auth-secure"><ShieldCheck size={15}/> Secure personal finance workspace</div></form></section>{recoveryOpen&&<RecoveryResetModal onClose={()=>setRecoveryOpen(false)}/>}</div>;
}



function RecoveryResetModal({onClose}){
  const[identifier,setIdentifier]=useState('');
  const[recoveryCode,setRecoveryCode]=useState('');
  const[password,setPassword]=useState('');
  const[loading,setLoading]=useState(false);
  const[message,setMessage]=useState('');
  const[error,setError]=useState('');
  const submit=async(e)=>{
    e.preventDefault(); setError(''); setLoading(true);
    try{
      const r=await api.post('/api/v3/password-reset/recovery/',{
        identifier:identifier.trim(),
        recovery_code:recoveryCode.trim().toUpperCase(),
        new_password:password
      });
      setMessage(r.data?.message||'Password reset successfully');
      window.setTimeout(onClose,1200);
    }catch(err){ setError(err.response?.data?.error||'Unable to reset password'); }
    finally{ setLoading(false); }
  };
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <form className="modal-card reset-card" onMouseDown={e=>e.stopPropagation()} onSubmit={submit}>
      <div className="modal-head"><div><span>ACCOUNT RECOVERY</span><h2>Reset with a recovery code</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close recovery dialog">×</button></div>
      <div className="settings-note"><KeyRound size={20}/><div><strong>No email is required</strong><span>Use one of the one-time recovery codes saved when you enabled 2FA.</span></div></div>
      {message&&<div className="alert success">{message}</div>}
      {error&&<div className="alert error">{error}</div>}
      <label><span>Email or username</span><input required value={identifier} onChange={e=>setIdentifier(e.target.value)}/></label>
      <label><span>Recovery code</span><input required value={recoveryCode} onChange={e=>setRecoveryCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,16))} placeholder="ABCDE-FGHIJ"/></label>
      <label><span>New password</span><input required minLength="8" type="password" value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <button className="button primary full" disabled={loading}>{loading?'Resetting…':'Reset password'}</button>
    </form>
  </div>
}
