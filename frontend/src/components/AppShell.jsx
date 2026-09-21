import React, { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, CircleDollarSign, LayoutDashboard, LogOut, Plus, RefreshCw, Settings, WalletCards } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFinance } from '../context/FinanceContext';
import logoFull from '../assets/logo-full.png';

const nav = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/transactions', label: 'Transactions', icon: WalletCards },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/money', label: 'Money Hub', icon: CircleDollarSign },
  { to: '/profile', label: 'Profile & Settings', icon: Settings },
];

export default function AppShell() {
  const { logoutUser } = useAuth();
  const { profile, refreshing, refresh, toast, setToast } = useFinance();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast, setToast]);

  const signOut = () => { logoutUser(); navigate('/login', { replace: true }); };

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('/')} aria-label="Go to overview"><img src={logoFull} alt="Smart Expense Tracker" /></button>
      <div className="side-caption">PERSONAL FINANCE</div>
      <nav className="side-nav">
        {nav.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}><Icon size={19} /><span>{label}</span></NavLink>)}
      </nav>
      <div className="sidebar-spacer" />
      <button className="quick-add" onClick={() => navigate('/add')}><Plus size={19} /> Add transaction</button>
      <div className="account-mini"><div className="avatar">{(profile?.name || profile?.username || 'U').slice(0, 1).toUpperCase()}</div><div><strong>{profile?.name || profile?.username || 'Your account'}</strong><span>{profile?.email || 'Secure workspace'}</span></div></div>
      <button className="signout" onClick={signOut}><LogOut size={18} /> Sign out</button>
      <div className="build-tag">SMART EXPENSE • V2</div>
    </aside>

    <main className="app-main">
      <header className="topbar">
        <div className="mobile-brand"><img src={logoFull} alt="Smart Expense Tracker" /></div>
        <div className="topbar-spacer" />
        <button className="icon-button" onClick={refresh} disabled={refreshing} title="Sync data"><RefreshCw className={refreshing ? 'spin' : ''} size={18} /></button>
        <button className="top-profile" onClick={() => navigate('/profile')}><div className="avatar small">{(profile?.name || profile?.username || 'U').slice(0,1).toUpperCase()}</div><span>{profile?.name || 'Profile'}</span></button>
      </header>
      <div className="page-wrap" key={location.pathname}><Outlet /></div>
    </main>

    <nav className="bottom-nav">
      {nav.slice(0, 2).map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end}><Icon size={21}/><span>{label}</span></NavLink>)}
      <button className="bottom-add" onClick={() => navigate('/add')}><Plus size={25}/></button>
      <NavLink to="/money"><CircleDollarSign size={21}/><span>Money</span></NavLink>
      <NavLink to="/profile"><Settings size={21}/><span>Profile</span></NavLink>
    </nav>

    {toast && <div className={`toast ${toast.type === 'error' ? 'error' : ''}`}>{toast.message}</div>}
  </div>;
}
