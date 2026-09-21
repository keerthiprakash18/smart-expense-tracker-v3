import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Camera, Check, Receipt, Save } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import ReceiptScannerModal from '../components/ReceiptScannerModal';
import { PageHeader, Surface } from '../components/Ui';
import { useFinance } from '../context/FinanceContext';
import api from '../services/api';

const categories = {
  EXPENSE: ['Food & Dining','Groceries','Shopping','Travel & Fuel','Health','Entertainment','Education','General'],
  INCOME: ['Salary','Freelance','Investment','Gift','Refund','Other'],
  BILL: ['Bills & Utilities','Rent','Subscription','Loan EMI','Insurance','Other'],
};

export default function TransactionEditor() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { transactions, accounts, profile, createTransaction, updateTransaction, notify } = useFinance();
  const editing = Boolean(id);
  const existing = useMemo(()=>transactions.find((x)=>String(x.id)===String(id)),[transactions,id]);
  const [scanOpen,setScanOpen]=useState(false);
  const [customCategories,setCustomCategories]=useState([]);
  const [saving,setSaving]=useState(false);
  const [form,setForm]=useState({ transaction_type:'EXPENSE', title:'', amount:'', category:'Food & Dining', account:'', payment_method:'UPI', date:new Date().toISOString().slice(0,10), time:new Date().toTimeString().slice(0,5), notes:'', is_recurring:false });

  useEffect(()=>{
    if (editing && existing) setForm({ transaction_type:existing.transaction_type || 'EXPENSE', title:existing.title || '', amount:existing.amount || '', category:existing.category || 'General', account:String(existing.account || ''), payment_method:existing.payment_method || 'UPI', date:existing.date || new Date().toISOString().slice(0,10), time:existing.time || '12:00', notes:existing.notes || '', is_recurring:Boolean(existing.is_recurring) });
    else if (!editing && accounts[0]?.id && !form.account) setForm((prev)=>({...prev,account:String(accounts[0].id)}));
  },[editing,existing,accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{ if (!editing && new URLSearchParams(location.search).get('scan')==='1') setScanOpen(true); },[editing,location.search]);
  useEffect(()=>{let live=true;api.get('/api/v3/categories/').then(r=>{if(live)setCustomCategories(r.data||[])}).catch(()=>{});return()=>{live=false}},[]);
  const set=(key,value)=>setForm((prev)=>({...prev,[key]:value}));
  const baseCats=categories[form.transaction_type] || categories.EXPENSE;
  const customCats=customCategories.filter(x=>x.category_type===form.transaction_type || (form.transaction_type==='BILL' && x.category_type==='EXPENSE')).map(x=>x.name);
  const typeCats=[...new Set([...baseCats,...customCats])];
  useEffect(()=>{ if (!typeCats.includes(form.category)) set('category',typeCats[0]); },[form.transaction_type]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit=async(e)=>{
    e.preventDefault();
    if (!form.title.trim() || Number(form.amount)<=0 || !form.account) { notify('Add a title, valid amount and account','error'); return; }
    setSaving(true);
    try { editing ? await updateTransaction(id,form) : await createTransaction(form); navigate('/transactions',{replace:true}); }
    catch(err){ notify(err.response?.data?.error || err.response?.data?.detail || 'Unable to save transaction','error'); }
    finally{ setSaving(false); }
  };

  const scanned=async(payload)=>{ try { await createTransaction(payload); navigate('/transactions'); return true; } catch(err){ notify(err.response?.data?.error || 'Unable to save scanned receipt','error'); return false; } };

  return <div className="page-stack narrow-page">
    <PageHeader eyebrow={editing?'EDIT ENTRY':'NEW ENTRY'} title={editing?'Update transaction':'Add transaction'} description="Keep each entry accurate so your balances and analytics stay reliable." actions={<button className="button ghost" onClick={()=>navigate(-1)}><ArrowLeft size={17}/> Back</button>} />
    {!editing && <div className="type-switch">{['EXPENSE','INCOME','BILL'].map((item)=><button key={item} className={form.transaction_type===item?'active':''} onClick={()=>set('transaction_type',item)}>{item==='EXPENSE'?'Expense':item==='INCOME'?'Income':'Bill'}</button>)}</div>}
    <form onSubmit={submit} className="editor-grid">
      <Surface className="form-surface">
        <div className="section-heading"><div><span>DETAILS</span><h2>{editing?'Edit entry':'Transaction details'}</h2></div>{!editing&&<button type="button" className="button scan" onClick={()=>setScanOpen(true)}><Camera size={17}/> Scan receipt</button>}</div>
        <div className="amount-input"><span>{profile?.currency || '₹'}</span><input autoFocus={!editing} type="number" min="0.01" step="0.01" value={form.amount} onChange={(e)=>set('amount',e.target.value)} placeholder="0.00"/></div>
        <div className="form-grid two"><label><span>Title / Merchant</span><input value={form.title} onChange={(e)=>set('title',e.target.value)} placeholder="e.g. Dinner at Spice Hub"/></label><label><span>Category</span><select value={form.category} onChange={(e)=>set('category',e.target.value)}>{typeCats.map((x)=><option key={x}>{x}</option>)}</select></label></div>
        <div className="form-grid two"><label><span>Account</span><select value={form.account} onChange={(e)=>set('account',e.target.value)}><option value="">Select account</option>{accounts.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label><span>Payment method</span><select value={form.payment_method} onChange={(e)=>set('payment_method',e.target.value)}>{['UPI','Cash','Debit Card','Credit Card','Bank Transfer','Wallet','Other'].map((x)=><option key={x}>{x}</option>)}</select></label></div>
        <div className="form-grid two"><label><span>Date</span><input type="date" value={form.date} onChange={(e)=>set('date',e.target.value)}/></label><label><span>Time</span><input type="time" value={form.time} onChange={(e)=>set('time',e.target.value)}/></label></div>
        <label><span>Notes</span><textarea rows="4" value={form.notes} onChange={(e)=>set('notes',e.target.value)} placeholder="Optional note, order reference or context…"/></label>
        <label className="check-row"><input type="checkbox" checked={form.is_recurring} onChange={(e)=>set('is_recurring',e.target.checked)}/><span><strong>Recurring transaction</strong><small>Mark repeating bills, subscriptions or regular income.</small></span><Check size={17}/></label>
        <button className="button primary full" disabled={saving}><Save size={18}/>{saving?'Saving…':editing?'Save changes':'Save transaction'}</button>
      </Surface>
      <aside className="editor-side"><Surface><div className="side-tip-icon"><Receipt size={20}/></div><h3>Keep it clean</h3><p>Use consistent titles and categories. Your analytics become more useful with every accurate entry.</p></Surface><Surface><span className="micro-label">ACCOUNT IMPACT</span><h3>{form.transaction_type==='INCOME'?'Balance increases':'Balance decreases'}</h3><p>{form.transaction_type==='INCOME'?'Income is added to the selected account.':'Expenses and bills reduce the selected account balance.'}</p></Surface></aside>
    </form>
    <ReceiptScannerModal isOpen={scanOpen} onClose={()=>setScanOpen(false)} accounts={accounts} currency={profile?.currency || '₹'} onConfirmExpense={scanned}/>
  </div>;
}
