import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfBankItems } from '../src/services/supabaseBankPdfLayout.js';

const columns=[['Date',35],['Narration',125],['Debit',345],['Credit',425],['Balance',505]];
const items=(y,values)=>values.map(([str,x])=>({str,transform:[1,0,0,1,x,y]}));
const records=[
  ...items(740,columns),
  ...items(719,[['04/11/2026',35],['SWIGGY UPI',125],['350.00',345],['650.00',505]]),
  ...items(695,[['05/11/2026',35],['SALARY NEFT',125],['25000.00',425],['25650.00',505]]),
  ...items(672,[['06/11/2026',35],['SELF TRANSFER',125],['500.00',345],['25150.00',505]]),
];
test('PDF layouts preserve debit, credit, date and description',()=>{
  const rows=parsePdfBankItems([records]);
  assert.deepEqual(rows.map(x=>[x.date,x.amount,x.transaction_type]),[
    ['2026-11-04','350.00','EXPENSE'],['2026-11-05','25000.00','INCOME'],['2026-11-06','500.00','EXPENSE']]);
});
test('repeated page headers do not create transactions',()=>{
  const rows=parsePdfBankItems([records.slice(0,9),[...items(740,columns),...items(720,[['07/11/2026',35],['CAFE',125],['100',345]])]]);
  assert.equal(rows.length,2);
});
test('image-only PDFs fail safely',()=>assert.throws(()=>parsePdfBankItems([[]]),/No structured/));
test('missing debit/credit values are not silently skipped',()=>{
  assert.throws(()=>parsePdfBankItems([[...items(740,columns),...items(720,[['04/11/2026',35],['CAFE',125]])]]),/dated row without an amount/);
});
test('two populated debit/credit columns fail',()=>{
  assert.throws(()=>parsePdfBankItems([[...items(740,columns),...items(720,[['04/11/2026',35],['CAFE',125],['40',345],['50',425]])]]),/debit\/credit/i);
});
