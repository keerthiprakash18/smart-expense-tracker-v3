import React, { useState } from 'react';
import { ArrowRight, BarChart3, Camera, CircleDollarSign, ShieldCheck, WalletCards } from 'lucide-react';
import logoFull from '../assets/logo-full.png';

const slides=[
 {eyebrow:'SMART EXPENSE • V2',title:'A calmer way to understand your money.',text:'Track daily spending, income and bills without turning personal finance into a spreadsheet.',icon:WalletCards},
 {eyebrow:'SCAN • REVIEW • SAVE',title:'Turn receipts into useful records.',text:'Capture a receipt, let OCR read the important details, then confirm before it enters your ledger.',icon:Camera},
 {eyebrow:'SEE THE BIG PICTURE',title:'Your habits become visible.',text:'Budget health, account balances, analytics, borrowed/lent money and savings goals live together.',icon:BarChart3},
];

export default function Welcome({onComplete}){const [index,setIndex]=useState(0);const slide=slides[index];const Icon=slide.icon;const next=()=>index<slides.length-1?setIndex(index+1):onComplete();return <div className="welcome-page"><div className="welcome-glow"/><div className="welcome-shell"><div className="welcome-brand"><img src={logoFull} alt="Smart Expense Tracker"/><span>PRIVATE • SECURE • PERSONAL</span></div><div className="welcome-visual"><div className="welcome-icon"><Icon size={54}/></div><div className="float-card one"><CircleDollarSign size={18}/><span>Money Hub</span></div><div className="float-card two"><ShieldCheck size={18}/><span>Protected</span></div></div><div className="welcome-copy"><div className="eyebrow">{slide.eyebrow}</div><h1>{slide.title}</h1><p>{slide.text}</p><div className="welcome-dots">{slides.map((_,i)=><span key={i} className={i===index?'active':''}/>)}</div><button className="button primary welcome-next" onClick={next}>{index===slides.length-1?'Enter Smart Expense':'Continue'}<ArrowRight size={19}/></button>{index<slides.length-1&&<button className="text-button welcome-skip" onClick={onComplete}>Skip intro</button>}</div></div></div>}
