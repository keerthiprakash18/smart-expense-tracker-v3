import React, { useMemo } from 'react';
import { BarChart3, CalendarRange, TrendingDown, TrendingUp } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useFinance } from '../context/FinanceContext';
import { EmptyState, MetricCard, PageHeader, Surface, money } from '../components/Ui';

const colors = ['var(--accent)', '#8c7bff', '#ffb454', '#ff6b7a', '#46d7a6', '#7dd3fc', '#f472b6'];
const tooltipStyle = { background: 'var(--panel-strong)', border: '1px solid var(--border)', borderRadius: 14, color: 'var(--text)' };

export default function Analytics() {
  const { transactions, profile } = useFinance();
  const symbol = profile?.currency || '₹';
  const spend = useMemo(()=>transactions.filter(x=>['EXPENSE','BILL'].includes(x.transaction_type)),[transactions]);
  const income = useMemo(()=>transactions.filter(x=>x.transaction_type==='INCOME'),[transactions]);
  const totalSpend = spend.reduce((s,x)=>s+Number(x.amount||0),0);
  const totalIncome = income.reduce((s,x)=>s+Number(x.amount||0),0);
  const avgSpend = spend.length ? totalSpend/spend.length : 0;

  const category = useMemo(()=>{
    const map={}; spend.forEach(x=>{map[x.category||'General']=(map[x.category||'General']||0)+Number(x.amount||0)});
    return Object.entries(map).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
  },[spend]);

  const months = useMemo(()=>{
    const map={};
    transactions.forEach((x)=>{
      const d=new Date(`${x.date}T00:00:00`); if(Number.isNaN(d.getTime())) return;
      const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if(!map[key]) map[key]={key,label:d.toLocaleDateString('en-US',{month:'short',year:'2-digit'}),income:0,spend:0};
      if(x.transaction_type==='INCOME') map[key].income+=Number(x.amount||0); else if(['EXPENSE','BILL'].includes(x.transaction_type)) map[key].spend+=Number(x.amount||0);
    });
    return Object.values(map).sort((a,b)=>a.key.localeCompare(b.key)).slice(-8);
  },[transactions]);

  return <div className="page-stack">
    <PageHeader eyebrow="INSIGHTS" title="Analytics" description="Understand where your money comes from, where it goes, and how the pattern changes over time." />
    <section className="metric-grid three">
      <MetricCard label="Total income" value={money(totalIncome,symbol)} helper={`${income.length} income entries`} icon={TrendingUp} tone="success" />
      <MetricCard label="Total spent" value={money(totalSpend,symbol)} helper={`${spend.length} spend entries`} icon={TrendingDown} tone="danger" />
      <MetricCard label="Average spend" value={money(avgSpend,symbol)} helper="Per expense / bill" icon={BarChart3} tone="violet" />
    </section>
    {!transactions.length ? <Surface><EmptyState title="Not enough data yet" description="Add transactions and your trends will appear here."/></Surface> : <>
      <Surface>
        <div className="section-heading"><div><span>MONTHLY TREND</span><h2>Income vs spending</h2></div><CalendarRange size={20}/></div>
        <div className="chart-large"><ResponsiveContainer width="100%" height="100%"><BarChart data={months} barGap={8}><CartesianGrid stroke="var(--grid)" vertical={false}/><XAxis dataKey="label" stroke="var(--muted)" tickLine={false} axisLine={false}/><YAxis stroke="var(--muted)" tickLine={false} axisLine={false}/><Tooltip formatter={(v)=>money(v,symbol)} contentStyle={tooltipStyle}/><Bar dataKey="income" fill="#46d7a6" radius={[8,8,0,0]}/><Bar dataKey="spend" fill="var(--accent)" radius={[8,8,0,0]}/></BarChart></ResponsiveContainer></div>
      </Surface>
      <section className="analytics-grid">
        <Surface><div className="section-heading"><div><span>CATEGORIES</span><h2>Spend distribution</h2></div></div><div className="chart-medium"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={category} dataKey="value" nameKey="name" innerRadius={64} outerRadius={95} paddingAngle={3}>{category.map((_,i)=><Cell key={i} fill={colors[i%colors.length]}/>)}</Pie><Tooltip formatter={(v)=>money(v,symbol)} contentStyle={tooltipStyle}/></PieChart></ResponsiveContainer></div><div className="legend compact">{category.slice(0,6).map((x,i)=><div key={x.name}><span className="dot" style={{background:colors[i%colors.length]}}/><span>{x.name}</span><strong>{money(x.value,symbol)}</strong></div>)}</div></Surface>
        <Surface><div className="section-heading"><div><span>CASH FLOW</span><h2>Net movement</h2></div></div><div className="chart-medium"><ResponsiveContainer width="100%" height="100%"><LineChart data={months.map(x=>({...x,net:x.income-x.spend}))}><CartesianGrid stroke="var(--grid)" vertical={false}/><XAxis dataKey="label" stroke="var(--muted)" tickLine={false} axisLine={false}/><YAxis stroke="var(--muted)" tickLine={false} axisLine={false}/><Tooltip formatter={(v)=>money(v,symbol)} contentStyle={tooltipStyle}/><Line type="monotone" dataKey="net" stroke="var(--accent)" strokeWidth={3} dot={{r:4,fill:'var(--accent)'}} activeDot={{r:6}}/></LineChart></ResponsiveContainer></div><div className="insight-box"><strong>{totalIncome-totalSpend>=0?'Positive overall cash flow':'Spending is above income'}</strong><span>{money(Math.abs(totalIncome-totalSpend),symbol)} {totalIncome-totalSpend>=0?'net surplus':'net gap'} across recorded transactions.</span></div></Surface>
      </section>
    </>}
  </div>;
}
