import React, { useEffect, useState } from 'react';
import { BarChart3, CalendarRange, TrendingDown, TrendingUp } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useFinance } from '../context/FinanceContext';
import api from '../services/api';
import { EmptyState, MetricCard, PageHeader, Skeleton, Surface, money } from '../components/Ui';

const colors = ['var(--accent)', '#8c7bff', '#ffb454', '#ff6b7a', '#46d7a6', '#7dd3fc', '#f472b6'];
const tooltipStyle = { background: 'var(--panel-strong)', border: '1px solid var(--border)', borderRadius: 14, color: 'var(--text)' };

export default function Analytics() {
  const { profile } = useFinance();
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const symbol = profile?.currency || '₹';

  useEffect(()=>{
    let live=true;
    api.get('/api/v3/analytics/summary/').then(r=>{if(live)setData(r.data||null)}).catch(err=>{if(live)setError(err.response?.data?.detail||'Unable to load analytics')}).finally(()=>{if(live)setLoading(false)});
    return()=>{live=false};
  },[]);

  if(loading) return <div className="page-stack"><Skeleton height={150}/><Skeleton height={360}/></div>;

  const totals=data?.totals||{};
  const months=data?.months||[];
  const category=data?.month?.categories||[];
  const totalSpend=Number(totals.spend||0);
  const totalIncome=Number(totals.income||0);
  const avgSpend=Number(totals.average_spend||0);
  const count=Number(totals.transaction_count||0);

  return <div className="page-stack">
    <PageHeader eyebrow="INSIGHTS" title="Analytics" description="Server-calculated totals across your complete ledger, not only the rows currently loaded on screen." />
    {error&&<div className="alert error">{error}</div>}
    <section className="metric-grid three">
      <MetricCard label="Total income" value={money(totalIncome,symbol)} helper="Across full history" icon={TrendingUp} tone="success" />
      <MetricCard label="Total spent" value={money(totalSpend,symbol)} helper="Expenses and bills" icon={TrendingDown} tone="danger" />
      <MetricCard label="Average spend" value={money(avgSpend,symbol)} helper="Per expense / bill" icon={BarChart3} tone="violet" />
    </section>
    {!count ? <Surface><EmptyState title="Not enough data yet" description="Add transactions and your trends will appear here."/></Surface> : <>
      <Surface><div className="section-heading"><div><span>MONTHLY TREND</span><h2>Income vs spending</h2></div><CalendarRange size={20}/></div><div className="chart-large"><ResponsiveContainer width="100%" height="100%"><BarChart data={months} barGap={8}><CartesianGrid stroke="var(--grid)" vertical={false}/><XAxis dataKey="label" stroke="var(--muted)" tickLine={false} axisLine={false}/><YAxis stroke="var(--muted)" tickLine={false} axisLine={false}/><Tooltip formatter={(v)=>money(v,symbol)} contentStyle={tooltipStyle}/><Bar dataKey="income" fill="#46d7a6" radius={[8,8,0,0]}/><Bar dataKey="spend" fill="var(--accent)" radius={[8,8,0,0]}/></BarChart></ResponsiveContainer></div></Surface>
      <section className="analytics-grid">
        <Surface><div className="section-heading"><div><span>CATEGORIES</span><h2>This month distribution</h2></div></div><div className="chart-medium"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={category} dataKey="value" nameKey="name" innerRadius={64} outerRadius={95} paddingAngle={3}>{category.map((_,i)=><Cell key={i} fill={colors[i%colors.length]}/>)}</Pie><Tooltip formatter={(v)=>money(v,symbol)} contentStyle={tooltipStyle}/></PieChart></ResponsiveContainer></div><div className="legend compact">{category.slice(0,6).map((x,i)=><div key={x.name}><span className="dot" style={{background:colors[i%colors.length]}}/><span>{x.name}</span><strong>{money(x.value,symbol)}</strong></div>)}</div></Surface>
        <Surface><div className="section-heading"><div><span>CASH FLOW</span><h2>Net movement</h2></div></div><div className="chart-medium"><ResponsiveContainer width="100%" height="100%"><LineChart data={months}><CartesianGrid stroke="var(--grid)" vertical={false}/><XAxis dataKey="label" stroke="var(--muted)" tickLine={false} axisLine={false}/><YAxis stroke="var(--muted)" tickLine={false} axisLine={false}/><Tooltip formatter={(v)=>money(v,symbol)} contentStyle={tooltipStyle}/><Line type="monotone" dataKey="net" stroke="var(--accent)" strokeWidth={3} dot={{r:4,fill:'var(--accent)'}} activeDot={{r:6}}/></LineChart></ResponsiveContainer></div><div className="insight-box"><strong>{Number(totals.net||0)>=0?'Positive overall cash flow':'Spending is above income'}</strong><span>{money(Math.abs(Number(totals.net||0)),symbol)} {Number(totals.net||0)>=0?'net surplus':'net gap'} across recorded transactions.</span></div></Surface>
      </section>
    </>}
  </div>;
}
