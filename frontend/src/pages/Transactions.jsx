import React, { useCallback, useEffect, useState } from 'react';
import { Download, Filter, Plus, Search, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useFinance } from '../context/FinanceContext';
import api from '../services/api';
import { EmptyState, PageHeader, Surface, TransactionIcon, money } from '../components/Ui';

const PAGE_SIZE = 50;

export default function Transactions() {
  const navigate = useNavigate();
  const { profile, notify, refresh } = useFinance();
  const [rows, setRows] = useState([]);
  const [paging, setPaging] = useState(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const symbol = profile?.currency || '₹';

  const load = useCallback(async ({ page = 1, append = false } = {}) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const res = await api.get('/api/expenses/', { params: {
        search: query.trim() || undefined,
        transaction_type: type === 'ALL' ? undefined : type,
        page,
        page_size: PAGE_SIZE,
      }});
      const data = res.data || {};
      const nextRows = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
      setRows(prev => append ? [...prev, ...nextRows] : nextRows);
      setPaging(Array.isArray(data) ? null : data);
    } catch (err) {
      notify(err.response?.data?.detail || 'Unable to load transactions', 'error');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [notify, query, type]);

  useEffect(() => {
    const timer = window.setTimeout(() => load({ page: 1 }), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query, type]);

  const loadMore = () => {
    if (!paging?.has_next || loadingMore) return;
    load({ page: Number(paging.page || 1) + 1, append: true });
  };

  const exportCsv = async () => {
    try {
      const response = await api.get('/api/v3/transactions/export.csv/', {
        params: { search: query.trim() || undefined, transaction_type: type === 'ALL' ? undefined : type },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'smart-expense-transactions.csv';
      a.click();
      URL.revokeObjectURL(url);
      notify('Full CSV exported');
    } catch {
      notify('Unable to export transactions', 'error');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this transaction? The linked account balance will be adjusted.')) return;
    try {
      await api.delete(`/api/expenses/${id}/`);
      notify('Transaction deleted');
      await Promise.all([load({ page: 1 }), refresh()]);
    } catch (err) {
      notify(err.response?.data?.error || 'Unable to delete transaction', 'error');
    }
  };

  return <div className="page-stack">
    <PageHeader eyebrow="LEDGER" title="Transactions" description="Search, filter and manage your complete finance history." actions={<><button className="button ghost" onClick={exportCsv}><Download size={17}/> Export all matches</button><button className="button primary" onClick={()=>navigate('/add')}><Plus size={18}/> Add</button></>} />
    <Surface className="toolbar-surface"><div className="search-box"><Search size={18}/><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search merchant, category, account or notes…" aria-label="Search transactions"/></div><div className="filter-tabs"><Filter size={16}/>{['ALL','EXPENSE','INCOME','BILL'].map((item)=><button key={item} className={type===item?'active':''} onClick={()=>setType(item)}>{item === 'ALL' ? 'All' : item[0]+item.slice(1).toLowerCase()}</button>)}</div></Surface>
    <Surface>
      <div className="list-summary"><strong>{paging?.count ?? rows.length} matching transaction{(paging?.count ?? rows.length)===1?'':'s'}</strong><span>{paging?`Showing ${rows.length} of ${paging.count}`:'Newest first'}</span></div>
      {loading ? <div className="boot-screen" style={{minHeight:180}}><div className="boot-mark"/>Loading ledger…</div> :
       rows.length ? <div className="transaction-list detailed">{rows.map((tx)=><div key={tx.id} className="transaction-row static"><button className="row-open" onClick={()=>navigate(`/transactions/${tx.id}/edit`)}><TransactionIcon type={tx.transaction_type}/><div className="transaction-main"><strong>{tx.title}</strong><span>{tx.category} • {tx.account_name || 'Account'} • {tx.date}</span></div><div className={`amount ${tx.transaction_type==='INCOME'?'positive':'negative'}`}>{tx.transaction_type==='INCOME'?'+':'-'}{money(tx.amount,symbol)}</div></button><button className="row-delete" onClick={()=>remove(tx.id)} title="Delete transaction" aria-label={`Delete ${tx.title}`}><Trash2 size={17}/></button></div>)}</div> :
       <EmptyState title="No matching transactions" description="Try a different search or filter, or add a new transaction." action={<button className="button primary" onClick={()=>navigate('/add')}>Add transaction</button>}/>}
      {paging?.has_next&&<button className="button ghost load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore?'Loading…':`Load more (${Math.max(0,(paging.count||0)-rows.length)} remaining)`}</button>}
    </Surface>
  </div>;
}
