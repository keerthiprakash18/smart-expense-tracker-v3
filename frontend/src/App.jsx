import React, { useState } from 'react';
import { HashRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import Welcome from './pages/welcome';
import AppRouter from './routes/AppRouter';
import ErrorBoundary from './components/ErrorBoundary';
import { isSupabaseMode } from './services/supabaseClient';

export default function App(){
 const legalRoute=['#/privacy','#/terms'].some(path=>window.location.hash.startsWith(path)) || (isSupabaseMode && (window.location.hash.startsWith('#/reset-password') || new URLSearchParams(window.location.search).has('code')));
 const [seen,setSeen]=useState(()=>localStorage.getItem('smart_expense_intro_seen')==='true'||legalRoute);
 const finish=()=>{localStorage.setItem('smart_expense_intro_seen','true');setSeen(true)};
 return <ThemeProvider>{!seen?<Welcome onComplete={finish}/>:<ErrorBoundary><AuthProvider><HashRouter><AppRouter/></HashRouter></AuthProvider></ErrorBoundary>}</ThemeProvider>
}
