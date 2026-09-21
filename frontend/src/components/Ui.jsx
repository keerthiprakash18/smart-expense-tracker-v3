import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Landmark, ReceiptText, Sparkles } from 'lucide-react';

export const money = (value, symbol = '₹') => `${symbol}${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const cx = (...names) => names.filter(Boolean).join(' ');

export function PageHeader({ eyebrow, title, description, actions }) {
  return <div className="page-header">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

export function Surface({ children, className = '', ...props }) {
  return <section className={cx('surface', className)} {...props}>{children}</section>;
}

export function MetricCard({ label, value, helper, icon: Icon, tone = 'accent' }) {
  return <div className={cx('metric-card', `metric-${tone}`)}>
    <div className="metric-top"><span>{label}</span><div className="metric-icon">{Icon && <Icon size={18} />}</div></div>
    <strong>{value}</strong>{helper && <small>{helper}</small>}
  </div>;
}

export function TransactionIcon({ type = 'EXPENSE' }) {
  const map = {
    INCOME: [ArrowDownLeft, 'income'],
    BILL: [ReceiptText, 'bill'],
    TRANSFER: [Landmark, 'transfer'],
    EXPENSE: [ArrowUpRight, 'expense'],
  };
  const [Icon, tone] = map[type] || map.EXPENSE;
  return <div className={cx('transaction-icon', tone)}><Icon size={18} /></div>;
}

export function EmptyState({ title, description, action }) {
  return <div className="empty-state"><div className="empty-icon"><Sparkles size={24} /></div><strong>{title}</strong><p>{description}</p>{action}</div>;
}

export function Progress({ value }) {
  const safe = Math.max(0, Math.min(100, Number(value || 0)));
  return <div className="progress"><span style={{ width: `${safe}%` }} /></div>;
}

export function Skeleton({ height = 120 }) { return <div className="skeleton" style={{ height }} />; }
