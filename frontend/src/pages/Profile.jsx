import React, { useEffect, useState } from 'react';
import { CreditCard, KeyRound, Landmark, MoonStar, Plus, Save, ShieldCheck, Smartphone, User, Wallet } from 'lucide-react';
import api, { clearTokens } from '../services/api';
import { PageHeader, Surface, money } from '../components/Ui';
import { useFinance } from '../context/FinanceContext';
import { useTheme } from '../context/ThemeContext';

const accountIcons = { BANK: Landmark, UPI: Smartphone, CASH: Wallet, CARD: CreditCard, WALLET: Wallet, CUSTOM: Wallet };

export default function Profile() {
  const { profile, accounts, summary, updateProfile, createAccount, notify } = useFinance();
  const { theme, setTheme, themes } = useTheme();
  const [form,setForm]=useState({name:'',username:'',email:'',phone:'',country:'India',currency:'₹',monthly_budget:'',savings_goal:''});
  const [saving,setSaving]=useState(false); const [accountOpen,setAccountOpen]=useState(false); const [passwordOpen,setPasswordOpen]=useState(false);
  useEffect(()=>{if(profile)setForm({name:profile.name||'',username:profile.username||'',email:profile.email||'',phone:profile.phone||'',country:profile.country||'India',currency:profile.currency||'₹',monthly_budget:profile.monthly_budget??'',savings_goal:profile.savings_goal??''})},[profile]);
  const set=(k,v)=>setForm(p=>({...p,[k]:v}));
  const save=async(e)=>{e.preventDefault();setSaving(true);try{await updateProfile(form)}catch(err){notify(err.response?.data?.error||'Unable to update profile','error')}finally{setSaving(false)}};

  return <div className="page-stack">
    <PageHeader eyebrow="ACCOUNT" title="Profile & settings" description="Control your identity, accounts, monthly plan and the visual style of your app." />
    <section className="profile-grid">
      <Surface className="profile-card"><div className="profile-avatar">{(profile?.name||profile?.username||'U').slice(0,1).toUpperCase()}</div><h2>{profile?.name||profile?.username}</h2><p>{profile?.email}</p><div className="profile-stat"><span>Total account balance</span><strong>{money(summary.account_balance,profile?.currency||'₹')}</strong></div><div className="security-pill"><ShieldCheck size={16}/> JWT secured</div></Surface>
      <Surface className="form-surface"><div className="section-heading"><div><span>PERSONAL DETAILS</span><h2>Your profile</h2></div><User size={20}/></div><form onSubmit={save}><div className="form-grid two"><label><span>Name</span><input value={form.name} onChange={e=>set('name',e.target.value)}/></label><label><span>Username</span><input value={form.username} onChange={e=>set('username',e.target.value)}/></label></div><div className="form-grid two"><label><span>Email</span><input type="email" value={form.email} onChange={e=>set('email',e.target.value)}/></label><label><span>Phone</span><input value={form.phone} onChange={e=>set('phone',e.target.value)}/></label></div><div className="form-grid three"><label><span>Currency</span><select value={form.currency} onChange={e=>set('currency',e.target.value)}>{['₹','$','€','£'].map(x=><option key={x}>{x}</option>)}</select></label><label><span>Monthly budget</span><input type="number" min="0" value={form.monthly_budget} onChange={e=>set('monthly_budget',e.target.value)}/></label><label><span>Savings target</span><input type="number" min="0" value={form.savings_goal} onChange={e=>set('savings_goal',e.target.value)}/></label></div><button className="button primary" disabled={saving}><Save size={17}/>{saving?'Saving…':'Save profile'}</button></form></Surface>
    </section>

    <Surface><div className="section-heading"><div><span>APPEARANCE</span><h2>Choose your finance theme</h2><p>Same app, your preferred personality.</p></div><MoonStar size={20}/></div><div className="theme-grid">{themes.map((item)=><button key={item.id} className={`theme-card ${theme===item.id?'active':''}`} onClick={()=>setTheme(item.id)}><div className="theme-preview" style={{background:item.swatch}}><span style={{background:item.accent}}/><i/><i/></div><div><strong>{item.name}</strong><span>{theme===item.id?'Active theme':'Use theme'}</span></div></button>)}</div></Surface>

    <Surface><div className="section-heading"><div><span>ACCOUNTS</span><h2>Your money sources</h2></div><button className="button ghost" onClick={()=>setAccountOpen(!accountOpen)}><Plus size={17}/> Add account</button></div>{accountOpen&&<AccountForm onSave={async(data)=>{try{await createAccount(data);setAccountOpen(false)}catch(err){notify(err.response?.data?.name?.[0]||'Unable to add account','error')}}}/>}<div className="account-grid">{accounts.map((a)=>{const Icon=accountIcons[a.account_type]||Wallet;return <div className="account-card" key={a.id}><div className="account-icon"><Icon size={20}/></div><div><strong>{a.name}</strong><span>{a.account_type}</span></div><b>{money(a.balance,profile?.currency||'₹')}</b></div>})}</div></Surface>

    <Surface><div className="section-heading"><div><span>SECURITY</span><h2>Password & access</h2></div><button className="button ghost" onClick={()=>setPasswordOpen(!passwordOpen)}><KeyRound size={17}/> Change password</button></div>{passwordOpen&&<PasswordForm onDone={()=>setPasswordOpen(false)} notify={notify}/>}<div className="settings-note"><ShieldCheck size={20}/><div><strong>Private by design</strong><span>Each API endpoint is authenticated and scoped to your user account.</span></div></div></Surface>
    <SecurityCenter profile={profile} notify={notify}/>
    <DangerZone notify={notify}/>
  </div>;
}

function AccountForm({onSave}) { const [name,setName]=useState('');const [type,setType]=useState('BANK');const [balance,setBalance]=useState('0');return <form className="inline-form" onSubmit={e=>{e.preventDefault();onSave({name,account_type:type,balance})}}><input required value={name} onChange={e=>setName(e.target.value)} placeholder="Account name"/><select value={type} onChange={e=>setType(e.target.value)}>{['BANK','UPI','CASH','CARD','WALLET','CUSTOM'].map(x=><option key={x}>{x}</option>)}</select><input type="number" step="0.01" value={balance} onChange={e=>setBalance(e.target.value)} placeholder="Opening balance"/><button className="button primary">Add account</button></form> }

function PasswordForm({onDone,notify}) { const [oldPassword,setOld]=useState('');const [newPassword,setNew]=useState('');const [saving,setSaving]=useState(false);const submit=async(e)=>{e.preventDefault();setSaving(true);try{await api.post('/api/change-password/',{old_password:oldPassword,new_password:newPassword});notify('Password updated');onDone()}catch(err){notify(err.response?.data?.error||'Unable to update password','error')}finally{setSaving(false)}};return <form className="inline-form password" onSubmit={submit}><input required type="password" value={oldPassword} onChange={e=>setOld(e.target.value)} placeholder="Current password"/><input required type="password" minLength="8" value={newPassword} onChange={e=>setNew(e.target.value)} placeholder="New strong password"/><button className="button primary" disabled={saving}>{saving?'Updating…':'Update password'}</button></form> }


function SecurityCenter({notify}) {
  const [status,setStatus]=useState({two_factor_enabled:false,recovery_codes_remaining:0});
  const [loading,setLoading]=useState(false);
  const [setup,setSetup]=useState(null);
  const [code,setCode]=useState('');
  const [showManualKey,setShowManualKey]=useState(false);
  const [recoveryCodes,setRecoveryCodes]=useState([]);

  const load=async()=>{
    try{
      const r=await api.get('/api/v3/security/');
      setStatus(r.data||{});
    }catch{}
  };
  useEffect(()=>{load()},[]);

  const start2fa=async()=>{
    setLoading(true);
    try{
      const r=await api.post('/api/v3/security/2fa/setup/');
      setSetup(r.data);
      setCode('');
      setShowManualKey(false);
      setRecoveryCodes([]);
    }catch(err){
      notify(err.response?.data?.error||'Unable to start 2FA setup','error');
    }finally{setLoading(false)}
  };

  const confirm2fa=async(e)=>{
    e.preventDefault();
    if(code.length!==6){
      notify('Open your authenticator app and enter the current 6-digit code','error');
      return;
    }
    setLoading(true);
    try{
      const r=await api.post('/api/v3/security/2fa/confirm/',{code});
      setRecoveryCodes(r.data?.recovery_codes||[]);
      setSetup(null);
      setCode('');
      notify('Two-factor authentication enabled');
      await load();
    }catch(err){
      notify(err.response?.data?.error||'Unable to enable 2FA','error');
    }finally{setLoading(false)}
  };

  const disable2fa=async()=>{
    const password=window.prompt('Enter your current password');
    if(!password)return;
    const codeOrRecovery=window.prompt('Enter your authenticator code or a recovery code');
    if(!codeOrRecovery)return;
    try{
      await api.post('/api/v3/security/2fa/disable/',{password,code:codeOrRecovery});
      notify('Two-factor authentication disabled');
      await load();
    }catch(err){
      notify(err.response?.data?.error||'Unable to disable 2FA','error');
    }
  };

  const copyText=async(value,message)=>{
    try{
      await navigator.clipboard.writeText(value);
      notify(message);
    }catch{
      notify('Copy failed — select and copy manually','error');
    }
  };

  return <>
    <Surface>
      <div className="section-heading">
        <div>
          <span>SECURITY CENTER</span>
          <h2>Two-factor authentication</h2>
          <p>Optional extra protection. Normal login continues to work without email verification.</p>
        </div>
        <ShieldCheck size={20}/>
      </div>

      <div className="security-grid">
        <div className="security-item">
          <div>
            <KeyRound size={20}/>
            <span>
              <strong>Authenticator 2FA</strong>
              <small>
                {status.two_factor_enabled
                  ? 'Enabled • ' + (status.recovery_codes_remaining||0) + ' recovery codes left'
                  : 'Disabled — optional'}
              </small>
            </span>
          </div>
          <button
            className={'button ' + (status.two_factor_enabled?'ghost':'primary')}
            disabled={loading}
            onClick={status.two_factor_enabled?disable2fa:start2fa}
          >
            {status.two_factor_enabled?'Disable 2FA':'Enable 2FA'}
          </button>
        </div>
      </div>

      <div className="settings-note">
        <ShieldCheck size={20}/>
        <div>
          <strong>No email code is required for normal login</strong>
          <span>Email verification and password-reset email are temporarily hidden until a reliable mail provider is configured.</span>
        </div>
      </div>
    </Surface>

    {setup&&
      <div className="modal-backdrop" onMouseDown={()=>setSetup(null)}>
        <form className="modal-card" onMouseDown={e=>e.stopPropagation()} onSubmit={confirm2fa}>
          <div className="modal-head">
            <div><span>AUTHENTICATOR SETUP</span><h2>Enable two-factor authentication</h2></div>
            <button type="button" className="icon-button" onClick={()=>setSetup(null)}>×</button>
          </div>

          <div className="alert success">
            The 6-digit code is NOT sent by email or SMS. Google Authenticator / Microsoft Authenticator generates it on your phone every 30 seconds.
          </div>

          <div style={{display:'grid',placeItems:'center',padding:'12px 0'}}>
            <img
              src={setup.qr_data_url}
              alt="Authenticator QR code"
              style={{width:220,height:220,background:'#fff',padding:12,borderRadius:16}}
            />
          </div>

          <div className="settings-note">
            <KeyRound size={20}/>
            <div>
              <strong>Step 1 — Scan the QR code</strong>
              <span>Open Google Authenticator → + → Scan a QR code. Do not share this QR code with anyone.</span>
            </div>
          </div>

          <button type="button" className="button ghost" onClick={()=>setShowManualKey(!showManualKey)}>
            {showManualKey?'Hide manual setup key':'Can’t scan? Show manual setup key'}
          </button>

          {showManualKey&&<>
            <label><span>Manual setup key</span><input readOnly value={setup.secret||''}/></label>
            <button type="button" className="button ghost" onClick={()=>copyText(setup.secret||'','Setup key copied')}>Copy setup key</button>
          </>}

          <div className="settings-note">
            <KeyRound size={20}/>
            <div>
              <strong>Step 2 — Enter the code shown in Authenticator</strong>
              <span>Open the newly added Smart Expense account in Authenticator and type its current 6-digit code below.</span>
            </div>
          </div>

          <label>
            <span>6-digit authenticator code</span>
            <input required autoFocus inputMode="numeric" maxLength="6" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} placeholder="123456" autoComplete="one-time-code"/>
          </label>

          <button className="button primary full" disabled={loading}>{loading?'Enabling…':'Confirm & enable 2FA'}</button>
        </form>
      </div>
    }

    {recoveryCodes.length>0&&
      <div className="modal-backdrop">
        <div className="modal-card">
          <div className="modal-head"><div><span>RECOVERY CODES</span><h2>Save these codes now</h2></div></div>
          <div className="alert success">Each recovery code works once if you lose access to your authenticator. Store them somewhere private.</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,margin:'14px 0'}}>
            {recoveryCodes.map(item=><code key={item} style={{padding:12,border:'1px solid var(--border)',borderRadius:10,textAlign:'center'}}>{item}</code>)}
          </div>
          <button type="button" className="button ghost full" onClick={()=>copyText(recoveryCodes.join('\n'),'Recovery codes copied')}>Copy all recovery codes</button>
          <button type="button" className="button primary full" onClick={()=>setRecoveryCodes([])}>I saved them</button>
        </div>
      </div>
    }
  </>;
}


function DangerZone({notify}) {
  const [deleting,setDeleting]=useState(false);
  const deleteAccount=async()=>{
    if(!window.confirm('This permanently deletes your Smart Expense account and finance data. Continue?')) return;
    const password=window.prompt('Enter your current password');
    if(!password) return;
    const confirmation=window.prompt('Type DELETE to permanently delete your account');
    if(confirmation!=='DELETE'){notify('Account deletion cancelled','error');return}
    setDeleting(true);
    try{
      await api.post('/api/delete-account/',{password,confirmation});
      clearTokens();
      window.location.hash='#/login';
      window.location.reload();
    }catch(err){
      notify(err.response?.data?.error||'Unable to delete account','error');
    }finally{setDeleting(false)}
  };
  return <Surface>
    <div className="section-heading">
      <div><span>DANGER ZONE</span><h2>Delete account & data</h2><p>Permanently deletes your profile and app records. Export a backup first if you need one.</p></div>
      <ShieldCheck size={20}/>
    </div>
    <button className="button ghost" disabled={deleting} onClick={deleteAccount}>{deleting?'Deleting…':'Delete my account'}</button>
  </Surface>
}
