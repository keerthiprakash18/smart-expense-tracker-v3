// A privacy-preserving PDF layout report. This module NEVER returns raw text,
// monetary values, dates, names, account numbers, references or PDF passwords.
// Users may voluntarily copy the report to help diagnose unsupported layouts.

const dateLike = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;
const moneyLike = /^(?:[+-]?\s*(?:₹|INR|Rs\.?)?\s*)?(?:\d{1,3}(?:,\d{2,3})+|\d{1,10})(?:\.\d{1,2})?\s*(?:CR|DR)?$/i;
const clean = value=>String(value||'').toLowerCase().replace(/[^a-z]/g,'');
const knownLabels = Object.freeze({
  date:['date','transactiondate','txndate','valuedt','valuedate'],
  narration:['narration','description','particulars','details'],
  reference:['chqrefno','chequeno','referenceno','refno','utr'],
  withdrawal:['withdrawal','withdrawalamt','debit','debitamt','debitamount'],
  deposit:['deposit','depositamt','credit','creditamt','creditamount'],
  balance:['balance','closingbalance','closingbalan','runningbalance','closingbal'],
  amount:['amount','transactionamount'],
});

function kind(text) {
  if (dateLike.test(text)) return 'DATE';
  if (moneyLike.test(text)) return 'NUMBER'; // Never include the number.
  return 'TEXT';
}

function safeX(x) {
  return Math.max(0,Math.min(9999,Math.round(x / 5) * 5));
}

function inspectPage(items,index) {
  const groups=new Map();
  const labels=new Map();
  let count=0, dates=0, numbers=0;
  for (const item of items) {
    const s=typeof item?.str==='string'?item.str.trim():'';
    const x=Number(item?.transform?.[4]),y=Number(item?.transform?.[5]);
    if (!s || !Number.isFinite(x)||!Number.isFinite(y)) continue;
    count++;
    const type=kind(s);
    if (type==='DATE') dates++;
    if (type==='NUMBER') numbers++;
    if (s.length<=65) {
      const normalized=clean(s);
      for (const [label,aliases] of Object.entries(knownLabels)) {
        if (aliases.includes(normalized)) {
          if (!labels.has(label)) labels.set(label,[]);
          const positions=labels.get(label);
          if (positions.length<3) positions.push(safeX(x));
        }
      }
    }
    const yBucket=Math.round(y/3);
    if (!groups.has(yBucket)) groups.set(yBucket,[]);
    const row=groups.get(yBucket);
    if (row.length<25) row.push({x:safeX(x),type});
  }

  // Only include the geometric shape of up to three lines with date-like
  // tokens. The report intentionally omits actual dates and all other text.
  const samples=[];
  for (const [,row] of [...groups.entries()].sort((a,b)=>b[0]-a[0])) {
    if (row.some(v=>v.type==='DATE')) {
      samples.push(row.slice(0,12).sort((a,b)=>a.x-b.x));
      if (samples.length===3) break;
    }
  }
  return {
    page:index+1,
    textItems:count,
    lineBuckets:groups.size,
    dateTokens:dates,
    numberTokens:numbers,
    headings:Object.fromEntries([...labels].map(([k,v])=>[k,v])),
    sampleDateRowGeometry:samples,
  };
}

export function diagnoseBankPdfPages(pages) {
  return {
    reportVersion:1,
    format:'pdf-layout-only',
    // These reports are generated locally. Not sent to an API or telemetry.
    pages:pages.length,
    pagesInspected:pages.slice(0,5).map(inspectPage),
    totalTextItems:pages.reduce((n,items)=>n+items.filter(item=>typeof item?.str==='string'&&item.str.trim()).length,0),
    // No source document bytes, text, filenames, values, identifiers or password.
  };
}
