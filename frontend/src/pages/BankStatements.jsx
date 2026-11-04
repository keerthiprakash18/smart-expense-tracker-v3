import React, { useState } from 'react';
import { FileUp, Landmark, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../services/api';
import { useFinance } from '../context/FinanceContext';
import { PageHeader, Surface, money } from '../components/Ui';

const STATUSES = {
  ready: 'Ready for review',
  duplicate: 'Already imported',
  possible_match: 'Possible existing transaction',
  review_transfer: 'Transfer / card payment: review manually',
};

export default function BankStatements() {
  const { accounts, profile, refresh, notify } = useFinance();
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState('pdf');
  const [pdfPassword, setPdfPassword] = useState('');
  const [accountId, setAccountId] = useState('');
  
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState([]);
  const [categories, setCategories] = useState({});
  const [allowMatches, setAllowMatches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);
  const currency = profile?.currency || '₹';

  const clearPreview = () => {
    setRows([]); setSelected([]); setCategories({}); setAllowMatches(false);
    setSummary(null); setError('');
  };

  const payload = () => {
    const form = new FormData();
    form.append('file', file);
    form.append('account_id', accountId);
    if (format === 'pdf' && pdfPassword) form.append('pdf_password', pdfPassword);
    return form;
  };

  const preview = async (event) => {
    event.preventDefault();
    setError(''); setSummary(null);
    if (!file || !accountId) { setError('Choose an account and statement file.'); return; }
    if (file.size > 5 * 1024 * 1024) { setError('Maximum file size is 5 MB.'); return; }
    setBusy(true);
    try {
      const res = await api.post('/api/v3/bank-statements/preview/', payload());
      const next = res.data?.rows || [];
      setRows(next);
      setSelected(next.filter(row => row.status === 'ready').map(row => row.index));
      setCategories({});
    } catch (err) {
      setRows([]);
      setError(err.response?.data?.error || 'Could not read this bank statement safely. Check the PDF password, or export a CSV.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (index) => setSelected(prev =>
    prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]
  );

  const importSelected = async () => {
    if (!selected.length || busy) return;
    setError(''); setBusy(true);
    try {
      const form = payload();
      form.append('selected_indices', JSON.stringify(selected));
      form.append('category_overrides', JSON.stringify(categories));
      form.append('allow_possible_matches', String(allowMatches));
      const res = await api.post('/api/v3/bank-statements/import/', form);
      setSummary(res.data);
      setRows([]); setSelected([]); setFile(null); setCategories({});
      setPdfPassword('');

      await refresh();
      notify('Bank statement transactions imported');
    } catch (err) {
      setError(err.response?.data?.error || 'Import could not be completed. No changes were made.');
    } finally {
      setBusy(false);
    }
  };

  const countReady = rows.filter(r => r.status === 'ready').length;

  return <div className="page-stack">
    <PageHeader eyebrow="BANK STATEMENTS" title="Import bank transactions" description="Upload a statement, check every transaction, and approve what enters your ledger." />
    <Surface>
      <div className="section-heading">
        <div><span>SECURE FILE IMPORT</span><h2>Upload a statement</h2></div>
        <FileUp size={21} />
      </div>
      <div className="settings-note"><ShieldCheck size={20}/><div>
        <strong>Not a live bank connection</strong>
        <span>CSV/PDF statements and PDF passwords are processed locally in your browser. Neither the raw document nor its password is uploaded or stored. Never enter your banking login password, ATM PIN or OTP here.</span>
      </div></div>
      <form onSubmit={preview} className="page-stack" style={{ marginTop: 18 }}>
        <div className="form-grid two">
          <label><span>Account to import into</span>
            <select required value={accountId} onChange={e=>{setAccountId(e.target.value);clearPreview();}}>
              <option value="">Choose account</option>
              {accounts.map(a=><option key={a.id} value={a.id}>{a.name} ({a.account_type})</option>)}
            </select>
          </label>
          <label><span>Statement format</span>
            <select value={format} onChange={e=>{setFormat(e.target.value);setFile(null);setPdfPassword('');clearPreview();}}>
              <option value="pdf">PDF bank statement</option>
              <option value="csv">CSV bank statement</option>
            </select>
          </label>
          <label><span>{format === 'pdf' ? 'PDF statement' : 'CSV statement'} (maximum 5 MB)</span>
            <input key={format} type="file" accept={format === 'pdf' ? '.pdf,application/pdf' : '.csv,text/csv'}
              onChange={e=>{setFile(e.target.files?.[0]||null);clearPreview();}} required />
          </label>
          {format === 'pdf' && <label><span>PDF password (only if protected)</span>
            <input type="password" autoComplete="off" maxLength={200} value={pdfPassword}
              onChange={e=>{setPdfPassword(e.target.value);clearPreview();}}
              placeholder="Enter your statement password privately" />
          </label>}
        </div>
        <p style={{opacity:.78,fontSize:13}}>CSV and text-based PDF bank statements are supported up to 5 MB. Password-protected PDFs can be opened with your statement password, only in this browser. PDF tables must have identifiable Date, Narration, Debit and Credit columns; scanned/image-only PDFs or unrecognized layouts are rejected rather than guessing financial transactions. PDFs are limited to 25 pages.</p>
        <button className="button primary" type="submit" disabled={busy||!file||!accountId}>
          <FileUp size={17}/>{busy?'Processing…':'Preview transactions'}
        </button>
      </form>
    </Surface>

    {error && <Surface><div className="settings-note" role="alert"><AlertTriangle size={20}/><div><strong>Import needs attention</strong><span>{error}</span></div></div></Surface>}
    {summary && <Surface><div className="settings-note"><CheckCircle2 size={20}/><div><strong>{summary.created} transaction(s) imported</strong><span>{summary.already_imported} already imported. {summary.message}</span></div></div></Surface>}

    {rows.length>0 && <Surface>
      <div className="section-heading"><div><span>REVIEW REQUIRED</span><h2>{rows.length} statement entries</h2>
        <p>{countReady} ready to import. Matches and transfers need extra care.</p></div>
      </div>
      <div className="settings-note"><AlertTriangle size={20}/><div>
        <strong>Balances are ledger-based estimates</strong>
        <span>Transfers and card payments are excluded here to avoid double-counting. Check your app balance against the bank's official statement separately.</span>
      </div></div>
      <div style={{overflowX:'auto', marginTop:16}}>
        <table style={{width:'100%',borderCollapse:'collapse', minWidth:680}}>
          <thead><tr><th>Import</th><th>Date / Description</th><th>Direction</th><th>Amount</th><th>Category</th><th>Status</th></tr></thead>
          <tbody>{rows.map(row=><tr key={row.index}>
            <td><input type="checkbox" aria-label={'Import '+row.description} checked={selected.includes(row.index)}
              disabled={row.status==='duplicate'||row.status==='review_transfer'||(row.status==='possible_match'&&!allowMatches)}
              onChange={()=>toggle(row.index)}/></td>
            <td><strong>{row.date}</strong><div style={{maxWidth:260, overflowWrap:'anywhere'}}>{row.description}</div></td>
            <td>{row.transaction_type==='INCOME'?'Credit':'Debit'}</td>
            <td>{money(row.amount,currency)}</td>
            <td><input aria-label={'Category for '+row.description} disabled={row.status==='duplicate'||row.status==='review_transfer'}
              value={categories[row.index] ?? row.category}
              maxLength={100} onChange={e=>setCategories(prev=>({...prev,[row.index]:e.target.value}))}/></td>
            <td>{STATUSES[row.status]||row.status}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {rows.some(r=>r.status==='possible_match')&&<label style={{display:'flex',gap:10,alignItems:'flex-start',marginTop:18}}>
        <input type="checkbox" checked={allowMatches} onChange={e=>{setAllowMatches(e.target.checked);if(!e.target.checked)setSelected(prev=>prev.filter(i=>rows.find(r=>r.index===i)?.status!=='possible_match'));}}/>
        <span>I reviewed existing similar transactions and explicitly want to allow importing possible matches.</span>
      </label>}
      <button className="button primary" style={{marginTop:20}} disabled={busy||!selected.length} onClick={importSelected}>
        {busy?'Importing…':'Import '+selected.length+' selected transaction(s)'}
      </button>
    </Surface>}
    <Surface><div className="section-heading"><div><span>FUTURE FEATURE</span><h2><Landmark size={18} style={{verticalAlign:'middle'}}/> Automatic bank sync</h2></div></div>
      <p>Live bank connections are not available yet. They require a verified, authorized consent-based banking partner. No banking login details are needed for CSV or PDF statement imports.</p>
    </Surface>
  </div>;
}
