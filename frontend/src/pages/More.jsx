import React from 'react';
import { BarChart3, Bell, ChevronRight, CircleDollarSign, ReceiptText, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Surface } from '../components/Ui';

const items = [
  { to:'/analytics', title:'Analytics', text:'Full-ledger trends and category insights', icon:BarChart3 },
  { to:'/money', title:'Money Hub', text:'Borrowing, lending, bills and savings', icon:CircleDollarSign },
  { to:'/receipts', title:'Receipt Vault', text:'Review securely stored receipt records', icon:ReceiptText },
  { to:'/notifications', title:'Notifications', text:'Due dates, recurring activity and alerts', icon:Bell },
  { to:'/profile', title:'Profile & Settings', text:'Security, theme, backup and account controls', icon:Settings },
];

export default function More(){
  const navigate=useNavigate();
  return <div className="page-stack"><PageHeader eyebrow="MORE" title="More tools" description="Everything that does not need to occupy your primary mobile navigation."/><Surface><div className="transaction-list detailed">{items.map(({to,title,text,icon:Icon})=><button key={to} className="transaction-row" onClick={()=>navigate(to)}><span className="transaction-icon"><Icon size={19}/></span><span className="transaction-main"><strong>{title}</strong><span>{text}</span></span><ChevronRight size={18}/></button>)}</div></Surface></div>;
}
