import React, { useState } from 'react';
import { HashRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import Welcome from './pages/welcome';
import AppRouter from './routes/AppRouter';

export default function App(){
 const [seen,setSeen]=useState(()=>localStorage.getItem('smart_expense_intro_seen')==='true');
 const finish=()=>{localStorage.setItem('smart_expense_intro_seen','true');setSeen(true)};
 return <ThemeProvider>{!seen?<Welcome onComplete={finish}/>:<AuthProvider><HashRouter><AppRouter/></HashRouter></AuthProvider>}</ThemeProvider>
}
