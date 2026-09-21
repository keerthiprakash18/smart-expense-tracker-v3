import React,{useCallback,useEffect,useState}from'react';
import{Bell,CheckCheck,RefreshCw}from'lucide-react';
import{useNavigate}from'react-router-dom';
import api from'../services/api';
import{EmptyState,PageHeader,Surface}from'../components/Ui';
import{useFinance}from'../context/FinanceContext';

export default function Notifications(){const navigate=useNavigate();const{notify}=useFinance();const[items,setItems]=useState([]);const[loading,setLoading]=useState(true);
 const load=useCallback(async(sync=true)=>{setLoading(true);try{if(sync)await api.post('/api/v3/notifications/sync/');const r=await api.get('/api/v3/notifications/');setItems(r.data||[])}catch{notify('Unable to load notifications','error')}finally{setLoading(false)}},[notify]);useEffect(()=>{load()},[load]);
 const open=async x=>{if(!x.is_read){try{await api.patch(`/api/v3/notifications/${x.id}/`,{is_read:true});setItems(p=>p.map(n=>n.id===x.id?{...n,is_read:true}:n))}catch{}}if(x.action_url)navigate(x.action_url)};
 const readAll=async()=>{try{await api.post('/api/v3/notifications/read-all/');setItems(p=>p.map(x=>({...x,is_read:true})));notify('All notifications marked read')}catch{notify('Unable to update notifications','error')}};
 return <div className="page-stack"><PageHeader eyebrow="NOTIFICATIONS" title="Money alerts" description="Budget warnings, bill due dates, card payments, recurring transactions and security messages." actions={<><button className="button ghost" onClick={()=>load(true)}><RefreshCw size={16}/>Sync</button><button className="button primary" onClick={readAll}><CheckCheck size={16}/>Read all</button></>}/><Surface>{loading?<div className="loading-state">Checking alerts…</div>:items.length?<div className="notification-list">{items.map(x=><button key={x.id} className={`notification-row ${x.is_read?'':'unread'}`} onClick={()=>open(x)}><div className="notification-icon"><Bell size={18}/></div><div><strong>{x.title}</strong><span>{x.message}</span><small>{x.due_date?`Due ${x.due_date} • `:''}{new Date(x.created_at).toLocaleString()}</small></div>{!x.is_read&&<i/>}</button>)}</div>:<EmptyState title="You're all caught up" description="New budget, bill, card and recurring alerts will appear here."/>}</Surface></div>}
