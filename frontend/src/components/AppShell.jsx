import React, { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, Bell, CircleDollarSign, LayoutDashboard, LogOut, MoreHorizontal, Moon, Plus, ReceiptText, RefreshCw, Settings, Sun, WalletCards, WandSparkles } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFinance } from '../context/FinanceContext';
import { useTheme } from '../context/ThemeContext';
import BrandMark from './BrandMark';
import api from '../services/api';

const nav = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/transactions', label: 'Transactions', icon: WalletCards },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/money', label: 'Money Hub', icon: CircleDollarSign },
  { to: '/planner', label: 'Planner', icon: WandSparkles },
  { to: '/receipts', label: 'Receipt Vault', icon: ReceiptText },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/profile', label: 'Profile & Settings', icon: Settings },
];

export default function AppShell() {
  const { logoutUser } = useAuth();
  const { profile, refreshing, refresh, toast, setToast } = useFinance();
  const { isLight, toggleMode, selectedTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const activeNav = nav.find(item => item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)) || (location.pathname==='/more'?{label:'More',icon:MoreHorizontal}:nav[0]);
  const ActiveIcon = activeNav.icon;

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast, setToast]);

  const signOut = async () => {
    try { await api.post('/api/logout/', {}); } catch {}
    finally { logoutUser(); navigate('/login', { replace: true }); }
  };

  return <div className="app-shell">
    <div className="ambient ambient-one" aria-hidden="true"/><div className="ambient ambient-two" aria-hidden="true"/>
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('/')} aria-label="Go to overview"><span className="brand-halo" aria-hidden="true"/><BrandMark /></button>
      <div className="side-caption">PERSONAL FINANCE</div>
      <nav className="side-nav" aria-label="Primary">{nav.map(({to,label,icon:Icon,end})=><NavLink key={to} to={to} end={end} className={({isActive})=>`side-link ${isActive?'active':''}`}><span className="nav-icon"><Icon size={18}/></span><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-spacer"/><button className="quick-add" onClick={()=>navigate('/add')}><Plus size={19}/> Add transaction</button>
      <div className="account-mini"><div className="avatar">{(profile?.name||profile?.username||'U').slice(0,1).toUpperCase()}</div><div><strong>{profile?.name||profile?.username||'Your account'}</strong><span>{profile?.email||'Secure workspace'}</span></div></div>
      <button className="signout" onClick={signOut}><LogOut size={18}/> Sign out</button><div className="build-tag">SMART EXPENSE • PRO</div>
    </aside>
    <main className="app-main">
      <header className="topbar">
        <div className="mobile-brand"><BrandMark compact /></div>
        <div className="topbar-context"><span className="context-icon"><ActiveIcon size={17}/></span><div><small>SMART EXPENSE</small><strong>{activeNav.label}</strong></div></div>
        <div className="topbar-spacer"/><span className="theme-chip">{selectedTheme.name}</span>
        <button className="icon-button theme-toggle" onClick={toggleMode} title={isLight?'Switch to dark mode':'Switch to light mode'} aria-label="Toggle color mode">{isLight?<Moon size={18}/>:<Sun size={18}/>}</button>
        <button className="icon-button notification-button" onClick={()=>navigate('/notifications')} title="Notifications" aria-label="Open notifications"><Bell size={18}/><i/></button>
        <button className="icon-button" onClick={refresh} disabled={refreshing} title="Sync data" aria-label="Sync finance data"><RefreshCw className={refreshing?'spin':''} size={18}/></button>
        <button className="top-profile" onClick={()=>navigate('/profile')} aria-label="Open profile settings"><div className="avatar small">{(profile?.name||profile?.username||'U').slice(0,1).toUpperCase()}</div><span>{profile?.name||'Profile'}</span></button>
      </header>
      <div className="page-wrap" key={location.pathname}><Outlet /></div>
    </main>
    <nav className="bottom-nav" aria-label="Mobile primary">
      <NavLink to="/" end><LayoutDashboard size={21}/><span>Overview</span></NavLink>
      <NavLink to="/transactions"><WalletCards size={21}/><span>Transactions</span></NavLink>
      <button className="bottom-add" onClick={()=>navigate('/add')} aria-label="Add transaction"><Plus size={25}/></button>
      <NavLink to="/planner"><WandSparkles size={21}/><span>Planner</span></NavLink>
      <NavLink to="/more"><MoreHorizontal size={21}/><span>More</span></NavLink>
    </nav>
    {toast&&<div className={`toast ${toast.type==='error'?'error':''}`} role="status">{toast.message}</div>}
  </div>;
}
