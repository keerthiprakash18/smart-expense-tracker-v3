import React, { useEffect, useState } from 'react';
import { FileText, ReceiptText, ScanLine } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api, { API_BASE_URL } from '../services/api';
import { EmptyState, PageHeader, Surface, money } from '../components/Ui';
import { useFinance } from '../context/FinanceContext';

function fileUrl(value){if(!value)return'';if(/^https?:\/\//i.test(value))return value;return `${API_BASE_URL}${value.startsWith('/')?'':'/'}${value}`}

export default function ReceiptVault(){
 const navigate=useNavigate();const {profile,notify}=useFinance();const symbol=profile?.currency||'₹';const [items,setItems]=useState([]);const [loading,setLoading]=useState(true);
 useEffect(()=>{let live=true;api.get('/api/v3/receipts/').then(r=>{if(live)setItems(r.data||[])}).catch(()=>notify('Unable to load receipt vault','error')).finally(()=>live&&setLoading(false));return()=>{live=false}},[notify]);
 return <div className="page-stack"><PageHeader eyebrow="RECEIPT VAULT" title="Scanned receipts" description="Every saved receipt stays linked to the transaction so you can verify, search and revisit it later." actions={<button className="button primary" onClick={()=>navigate('/add?scan=1')}><ScanLine size={17}/>Scan receipt</button>}/>
  <Surface>{loading?<div className="loading-state">Loading receipts…</div>:items.length?<div className="receipt-grid">{items.map(x=>{const url=fileUrl(x.receipt_image);const pdf=/\.pdf($|\?)/i.test(url);return <button className="receipt-card" key={x.id} onClick={()=>navigate(`/transactions/${x.id}/edit`)}>{pdf?<div className="receipt-thumb pdf"><FileText size={34}/></div>:<div className="receipt-thumb">{url?<img src={url} alt={x.title}/>:<ReceiptText size={30}/>}</div>}<div className="receipt-card-body"><span>{x.date}</span><strong>{x.title}</strong><small>{x.category} • {x.payment_method}</small><div><b>{money(x.amount,symbol)}</b><em>{x.ocr_confidence?`${x.ocr_confidence}% OCR`:'Scanned'}</em></div></div></button>})}</div>:<EmptyState title="No scanned receipts" description="Use the receipt scanner and your saved bills will appear here."/>}</Surface>
 </div>
}
