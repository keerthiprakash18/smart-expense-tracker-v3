import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, LockKeyhole, Moon, ScanLine, ShieldCheck, Sparkles, Sun, TrendingUp, WalletCards } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api, { setTokens } from '../services/api';
import logoFull from '../assets/logo-full.png';
import { useTheme } from '../context/ThemeContext';

export default function Login() {
  const navigate=useNavigate(); const location=useLocation(); const {loginUser}=useAuth(); const {isLight,toggleMode}=useTheme();
  const [username,setUsername]=useState(''); const [password,setPassword]=useState(''); const [otp,setOtp]=useState(''); const [needsOtp,setNeedsOtp]=useState(false);
  const [show,setShow]=useState(false); const [loading,setLoading]=useState(false); const [error,setError]=useState(''); const [recoveryOpen,setRecoveryOpen]=useState(false);
  const submit=async(e)=>{e.preventDefault();setLoading(true);setError('');try{const res=await api.post('/api/token/',{username:username.trim(),password,otp:otp.trim()||undefined});if(res.status===202||res.data?.two_factor_required){setNeedsOtp(true);setError(res.data?.detail||'Enter your authenticator code.');return}setTokens(res.data.access,res.data.refresh);loginUser(res.data.access,res.data.refresh);navigate(location.state?.from||'/',{replace:true})}catch(err){if(err.response?.data?.two_factor_required)setNeedsOtp(true);setError(err.response?.data?.detail||'Invalid username or password.')}finally{setLoading(false)}};
  return <div className="auth-page"><button type="button" className="auth-theme-toggle" onClick={toggleMode} aria-label="Toggle theme">{isLight?<Moon size={18}/>:<Sun size={18}/>}</button><div className="auth-grid-bg"/><div className="auth-orb one"/><div className="auth-orb two"/><section className="auth-story"><div className="auth-logo-wrap"><span/><img src={logoFull} alt="Smart Expense Tracker"/></div><div className="auth-story-copy"><div className="eyebrow">SMART MONEY • LESS NOISE</div><h1>Know exactly where your money is going.</h1><p>Transactions, OCR receipts, analytics, bills, automation and goals — one secure workspace.</p><div className="auth-points"><div><Sparkles size={18}/><span>Automatic receipt capture</span></div><div><ShieldCheck size={18}/><span>User-isolated secure data</span></div><div><LockKeyhole size={18}/><span>JWT + optional 2FA</span></div></div><div className="auth-product-preview"><div className="preview-head"><span><i/> LIVE WORKSPACE</span><strong>Protected</strong></div><div className="preview-balance"><small>Available balance</small><strong>₹42,840</strong><em><TrendingUp size={14}/> +12.4%</em></div><div className="preview-bars"><i style={{height:'45%'}}/><i style={{height:'68%'}}/><i style={{height:'52%'}}/><i style={{height:'82%'}}/><i style={{height:'64%'}}/><i style={{height:'92%'}}/><i style={{height:'74%'}}/></div><div className="preview-footer"><span><WalletCards size={15}/> Smart ledger</span><span><ScanLine size={15}/> OCR ready</span></div></div></div></section><section className="auth-panel"><form className="auth-card" onSubmit={submit}><div className="auth-mobile-logo"><img src={logoFull} alt="Smart Expense Tracker"/></div><span className="micro-label">WELCOME BACK</span><h2>Sign in to your workspace</h2><p>Continue from exactly where you left your finances.</p>{error&&<div className={`alert ${needsOtp?'success':'error'}`}>{error}</div>}<label><span>Username or email</span><input autoFocus required value={username} onChange={e=>setUsername(e.target.value)} placeholder="Enter username or email" autoComplete="username"/></label><label><span>Password</span><div className="password-field"><input required type={show?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password"/><button type="button" onClick={()=>setShow(!show)}>{show?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></label>{needsOtp&&<label><span>Authenticator or recovery code</span><input required maxLength="16" value={otp} onChange={e=>setOtp(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,16))} placeholder="6-digit code or recovery code" autoComplete="one-time-code"/></label>}<button className="button primary full auth-submit" disabled={loading}>{loading?'Signing in…':<>Sign in <ArrowRight size={18}/></>}</button><button type="button" className="text-button auth-forgot" onClick={()=>setRecoveryOpen(true)}><KeyRound size={14}/> Forgot password? Use recovery code</button><div className="auth-switch">New to Smart Expense? <Link to="/register">Create an account</Link></div><div className="auth-secure"><ShieldCheck size={15}/> Secure personal finance workspace</div></form></section>{recoveryOpen&&<RecoveryResetModal onClose={()=>setRecoveryOpen(false)}/>}</div>;
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
      <div className="modal-head"><div><span>ACCOUNT RECOVERY</span><h2>Reset with a recovery code</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div>
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
