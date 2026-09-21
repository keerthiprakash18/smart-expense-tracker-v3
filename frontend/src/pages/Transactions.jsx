import React, { useMemo, useState } from 'react';
import { Download, Filter, Plus, Search, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useFinance } from '../context/FinanceContext';
import { EmptyState, PageHeader, Surface, TransactionIcon, money } from '../components/Ui';

export default function Transactions() {
  const navigate = useNavigate();
  const { transactions, profile, deleteTransaction, notify } = useFinance();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('ALL');
  const symbol = profile?.currency || '₹';

  const filtered = useMemo(() => transactions.filter((tx) => {
    const matchesType = type === 'ALL' || tx.transaction_type === type;
    const hay = `${tx.title} ${tx.category} ${tx.account_name} ${tx.payment_method}`.toLowerCase();
    return matchesType && hay.includes(query.trim().toLowerCase());
  }), [transactions, query, type]);

  const exportCsv = () => {
    const rows = [['Date','Title','Type','Category','Account','Amount'], ...filtered.map((x)=>[x.date,x.title,x.transaction_type,x.category,x.account_name || '',x.amount])];
    const csv = rows.map((r)=>r.map((v)=>`"${String(v ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    const a=document.createElement('a'); a.href=url; a.download='smart-expense-transactions.csv'; a.click(); URL.revokeObjectURL(url);
    notify('CSV exported');
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this transaction? The linked account balance will be adjusted.')) return;
    try { await deleteTransaction(id); } catch (err) { notify(err.response?.data?.error || 'Unable to delete transaction','error'); }
  };

  return <div className="page-stack">
    <PageHeader eyebrow="LEDGER" title="Transactions" description="Search, filter and manage every entry in your finance history." actions={<><button className="button ghost" onClick={exportCsv}><Download size={17}/> Export</button><button className="button primary" onClick={()=>navigate('/add')}><Plus size={18}/> Add</button></>} />
    <Surface className="toolbar-surface"><div className="search-box"><Search size={18}/><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search merchant, category or account…"/></div><div className="filter-tabs"><Filter size={16}/>{['ALL','EXPENSE','INCOME','BILL'].map((item)=><button key={item} className={type===item?'active':''} onClick={()=>setType(item)}>{item === 'ALL' ? 'All' : item[0]+item.slice(1).toLowerCase()}</button>)}</div></Surface>
    <Surface>
      <div className="list-summary"><strong>{filtered.length} transaction{filtered.length===1?'':'s'}</strong><span>Newest first</span></div>
      {filtered.length ? <div className="transaction-list detailed">{filtered.map((tx)=><div key={tx.id} className="transaction-row static"><button className="row-open" onClick={()=>navigate(`/transactions/${tx.id}/edit`)}><TransactionIcon type={tx.transaction_type}/><div className="transaction-main"><strong>{tx.title}</strong><span>{tx.category} • {tx.account_name || 'Account'} • {tx.date}</span></div><div className={`amount ${tx.transaction_type==='INCOME'?'positive':'negative'}`}>{tx.transaction_type==='INCOME'?'+':'-'}{money(tx.amount,symbol)}</div></button><button className="row-delete" onClick={()=>remove(tx.id)} title="Delete"><Trash2 size={17}/></button></div>)}</div> : <EmptyState title="No matching transactions" description="Try a different search or filter, or add a new transaction." action={<button className="button primary" onClick={()=>navigate('/add')}>Add transaction</button>}/>} 
    </Surface>
  </div>;
}
