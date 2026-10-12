import React, { useState } from 'react';
import { BarChart3, Bell, Bot, ChevronRight, CircleDollarSign, LogOut, ReceiptText, Settings, WandSparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Surface } from '../components/Ui';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { stopBackgroundWake } from '../services/nativeSpeech';

const items = [
  { to:'/assistant', title:'AI Assistant', text:'Speak or type expenses and finance questions', icon:Bot },
  { to:'/planner', title:'Planner', text:'Budgets, recurring plans and future money actions', icon:WandSparkles },
  { to:'/analytics', title:'Analytics', text:'Full-ledger trends and category insights', icon:BarChart3 },
  { to:'/money', title:'Money Hub', text:'Borrowing, lending, bills and savings', icon:CircleDollarSign },
  { to:'/receipts', title:'Receipt Vault', text:'Review securely stored receipt records', icon:ReceiptText },
  { to:'/notifications', title:'Notifications', text:'Due dates, recurring activity and alerts', icon:Bell },
  { to:'/profile', title:'Profile & Settings', text:'Security, theme, backup and account controls', icon:Settings },
];

export default function More(){
  const navigate=useNavigate();
  const { logoutUser }=useAuth();
  const [loggingOut,setLoggingOut]=useState(false);

  const signOut=async()=>{
    if(loggingOut) return;
    setLoggingOut(true);
    try{
      await stopBackgroundWake().catch(()=>{});
      await api.post('/api/logout/',{}).catch(()=>{});
    }finally{
      logoutUser();
      navigate('/login',{replace:true});
      setLoggingOut(false);
    }
  };

  return <div className="page-stack">
    <PageHeader eyebrow="MORE" title="More tools" description="Everything that does not need to occupy your primary mobile navigation."/>
    <Surface>
      <div className="transaction-list detailed">
        {items.map(({to,title,text,icon:Icon})=><button key={to} className="transaction-row" onClick={()=>navigate(to)}><span className="transaction-icon"><Icon size={19}/></span><span className="transaction-main"><strong>{title}</strong><span>{text}</span></span><ChevronRight size={18}/></button>)}
        <button className="transaction-row danger-row" onClick={signOut} disabled={loggingOut}>
          <span className="transaction-icon"><LogOut size={19}/></span>
          <span className="transaction-main"><strong>{loggingOut?'Signing out…':'Log out'}</strong><span>Securely end this session on this device</span></span>
          <ChevronRight size={18}/>
        </button>
      </div>
    </Surface>
  </div>;
}
