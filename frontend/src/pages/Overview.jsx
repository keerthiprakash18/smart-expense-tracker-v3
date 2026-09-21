import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, BarChart3, Camera, CircleDollarSign, Plus, ReceiptText, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { useFinance } from '../context/FinanceContext';
import api from '../services/api';
import { EmptyState, MetricCard, PageHeader, Progress, Skeleton, Surface, TransactionIcon, money } from '../components/Ui';

const palette = ['var(--accent)', '#8c7bff', '#ffb454', '#ff6b7a', '#46d7a6', '#7dd3fc'];

export default function Overview() {
  const navigate = useNavigate();
  const { profile, accounts, transactions, summary, loading, error } = useFinance();
  const [insights,setInsights]=useState([]);
  useEffect(()=>{let live=true;api.get('/api/v3/insights/').then(r=>{if(live)setInsights(r.data?.insights||[])}).catch(()=>{});return()=>{live=false}},[transactions.length]);
  const symbol = profile?.currency || '₹';
  const now = new Date();
  const monthTx = useMemo(() => transactions.filter((tx) => {
    const d = new Date(`${tx.date}T00:00:00`);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }), [transactions]);
  const monthSpend = useMemo(() => monthTx.filter((x) => ['EXPENSE','BILL'].includes(x.transaction_type)).reduce((s,x) => s + Number(x.amount || 0), 0), [monthTx]);
  const monthIncome = useMemo(() => monthTx.filter((x) => x.transaction_type === 'INCOME').reduce((s,x) => s + Number(x.amount || 0), 0), [monthTx]);
  const budget = Number(profile?.monthly_budget || summary.monthly_budget || 0);
  const budgetPercent = budget ? (monthSpend / budget) * 100 : 0;
  const categoryData = useMemo(() => {
    const map = {};
    monthTx.filter((x) => ['EXPENSE','BILL'].includes(x.transaction_type)).forEach((x) => { map[x.category || 'General'] = (map[x.category || 'General'] || 0) + Number(x.amount || 0); });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a,b) => b.value-a.value).slice(0,6);
  }, [monthTx]);

  if (loading) return <div className="page-stack"><Skeleton height={150}/><div className="metric-grid"><Skeleton/><Skeleton/><Skeleton/><Skeleton/></div><Skeleton height={320}/></div>;

  return <div className="page-stack">
    <PageHeader eyebrow="FINANCIAL COMMAND CENTER" title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${profile?.name || profile?.username || 'there'}`} description="Your money, bills, goals and spending in one clean view." actions={<><button className="button ghost" onClick={() => navigate('/analytics')}><BarChart3 size={17}/> Analytics</button><button className="button primary" onClick={() => navigate('/add')}><Plus size={18}/> Add transaction</button></>} />
    {error && <div className="alert error">{error}</div>}

    <section className="metric-grid">
      <MetricCard label="Account balance" value={money(summary.account_balance, symbol)} helper={`${accounts.length} active account${accounts.length === 1 ? '' : 's'}`} icon={Wallet} />
      <MetricCard label="This month income" value={money(monthIncome, symbol)} helper="Money received" icon={TrendingUp} tone="success" />
      <MetricCard label="This month spent" value={money(monthSpend, symbol)} helper={budget ? `${Math.min(999, budgetPercent).toFixed(0)}% of budget` : 'Set a monthly budget'} icon={TrendingDown} tone="danger" />
      <MetricCard label="Money owed to you" value={money(summary.lent_remaining, symbol)} helper={summary.borrowed_remaining ? `${money(summary.borrowed_remaining, symbol)} you owe` : 'Nothing borrowed'} icon={CircleDollarSign} tone="violet" />
    </section>

    <section className="overview-grid">
      <Surface className="hero-balance">
        <div className="section-heading"><div><span>MONTHLY PLAN</span><h2>Budget health</h2></div><strong>{Math.min(999, budgetPercent).toFixed(0)}%</strong></div>
        <Progress value={budgetPercent}/>
        <div className="budget-numbers"><div><span>Spent</span><strong>{money(monthSpend, symbol)}</strong></div><div><span>Remaining</span><strong>{money(Math.max(0,budget-monthSpend), symbol)}</strong></div><div><span>Budget</span><strong>{money(budget, symbol)}</strong></div></div>
        {budgetPercent > 85 && <div className="budget-warning">You are close to this month’s budget limit.</div>}
      </Surface>

      <Surface>
        <div className="section-heading"><div><span>SPENDING MIX</span><h2>Top categories</h2></div><button className="text-button" onClick={() => navigate('/analytics')}>View details <ArrowRight size={15}/></button></div>
        {categoryData.length ? <div className="donut-layout"><div className="donut"><ResponsiveContainer width="100%" height={190}><PieChart><Pie data={categoryData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={78} paddingAngle={3}>{categoryData.map((_, i) => <Cell key={i} fill={palette[i % palette.length]}/>)}</Pie><Tooltip formatter={(v) => money(v, symbol)} contentStyle={{background:'var(--panel-strong)',border:'1px solid var(--border)',borderRadius:12}}/></PieChart></ResponsiveContainer><div className="donut-center"><span>Spent</span><strong>{money(monthSpend, symbol)}</strong></div></div><div className="legend">{categoryData.slice(0,4).map((item,i)=><div key={item.name}><span className="dot" style={{background:palette[i]}}/><span>{item.name}</span><strong>{money(item.value,symbol)}</strong></div>)}</div></div> : <EmptyState title="No spend yet" description="Add an expense and your category mix appears here."/>}
      </Surface>
    </section>

    {insights.length > 0 && <Surface className="insights-surface">
      <div className="section-heading"><div><span>SMART INSIGHTS</span><h2>What changed</h2></div></div>
      <div className="insight-grid">{insights.slice(0,4).map((item,i)=><div className="smart-insight" key={`${item.kind}-${i}`}><strong>{item.title}</strong><span>{item.message}</span></div>)}</div>
    </Surface>}

    <section className="quick-grid">
      <button className="quick-card" onClick={() => navigate('/add')}><div className="quick-icon"><Plus size={22}/></div><div><strong>Add transaction</strong><span>Expense, income or bill</span></div><ArrowRight size={17}/></button>
      <button className="quick-card" onClick={() => navigate('/add?scan=1')}><div className="quick-icon"><Camera size={22}/></div><div><strong>Scan receipt</strong><span>OCR-powered capture</span></div><ArrowRight size={17}/></button>
      <button className="quick-card" onClick={() => navigate('/money')}><div className="quick-icon"><CircleDollarSign size={22}/></div><div><strong>Money Hub</strong><span>Borrow, lend, bills & goals</span></div><ArrowRight size={17}/></button>
      <button className="quick-card" onClick={() => navigate('/transactions')}><div className="quick-icon"><ReceiptText size={22}/></div><div><strong>Transactions</strong><span>Search your full history</span></div><ArrowRight size={17}/></button>
    </section>

    <Surface>
      <div className="section-heading"><div><span>ACTIVITY</span><h2>Recent transactions</h2></div><button className="text-button" onClick={() => navigate('/transactions')}>See all <ArrowRight size={15}/></button></div>
      {transactions.length ? <div className="transaction-list">{transactions.slice(0,6).map((tx)=><button key={tx.id} className="transaction-row" onClick={()=>navigate(`/transactions/${tx.id}/edit`)}><TransactionIcon type={tx.transaction_type}/><div className="transaction-main"><strong>{tx.title}</strong><span>{tx.category} • {tx.account_name || 'Account'} • {tx.date}</span></div><div className={`amount ${tx.transaction_type === 'INCOME' ? 'positive':'negative'}`}>{tx.transaction_type === 'INCOME' ? '+' : '-'}{money(tx.amount,symbol)}</div></button>)}</div> : <EmptyState title="Your timeline is empty" description="Add your first transaction to start tracking your money." action={<button className="button primary" onClick={()=>navigate('/add')}>Add first transaction</button>}/>} 
    </Surface>
  </div>;
}
