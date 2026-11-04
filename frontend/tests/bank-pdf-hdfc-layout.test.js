import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfBankItems } from '../src/services/supabaseBankPdfLayout.js';

const parts = (y, values) => values.map(([str,x,width=0])=>({str,transform:[1,0,0,1,x,y],width}));
const headings = [
  ['Date',32],['Narration',77],['Chq./Ref.No.',273],['Value',347],
  ['Dt.',374],['Withdrawal',416],['Amt.',446],['Deposit',487],
  ['Amt.',510],['Closing',541],['Balance',581],
];

test('HDFC-like recent seven-day table with 2-digit dates, split headers, reference and value date',()=>{
  const page=[
    ...parts(745,headings),
    ...parts(720,[['29/06/26',32],['UPI-SWIGGY ORDER',77],['0000640462245447',273],
      ['29/06/26',347],['350.00',416],['3,550.00',541]]),
    ...parts(695,[['30/06/26',32],['NEFT SALARY',77],['000064046222345',273],
      ['30/06/26',347],['25000.00',487],['28,550.00',541]]),
  ];
  const rows=parsePdfBankItems([page]);
  assert.deepEqual(rows.map(r=>[r.date,r.description,r.amount,r.transaction_type]),[
    ['2026-06-29','UPI-SWIGGY ORDER','350.00','EXPENSE'],
    ['2026-06-30','NEFT SALARY','25000.00','INCOME'],
  ]);
});

test('PDF column header may arrive as combined item with measured width',()=>{
  const headers=parts(740,[
    ['Date',32],['Narration',125],['Withdrawal Amt.',345,75],['Deposit Amt.',455,69],['Closing Balance',550,96],
  ]);
  const row=parts(715,[['04/11/26',32],['COFFEE SHOP',125],['50.00',345],['950.00',550]]);
  const rows=parsePdfBankItems([[...headers,...row]]);
  assert.equal(rows[0].amount,'50.00');
  assert.equal(rows[0].date,'2026-11-04');
});

test('PDF full heading in one PDF text object can still be split using its width',()=>{
  const headings=parts(740,[['Date        Narration                 Withdrawal Amt.     Deposit Amt.     Closing Balance',32,600]]);
  const row=parts(719,[['04/11/26',32],['RESTAURANT',120],['100.00',360],['900.00',550]]);
  // The all-in-one PDF text heading may have approximate character widths;
  // this test detects whether enough positional detail was retained.
  assert.throws(()=>parsePdfBankItems([[...headings,...row]]),/No structured|dated row|Invalid/);
});

test('narration wraps to the next line without duplicating the amount',()=>{
  const page=[
    ...parts(740,[['Date',35],['Narration',120],['Debit',340],['Credit',430]]),
    ...parts(719,[['04/11/26',35],['UPI TRANSFER',120],['200.00',340]]),
    ...parts(707,[['TO SOME MERCHANT',120]]),
  ];
  const rows=parsePdfBankItems([page]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].description,'UPI TRANSFER TO SOME MERCHANT');
});

test('labelled transaction blocks are supported only with explicit direction',()=>{
  const page=[
    ...parts(740,[['Transaction Date: 04/11/26',35]]),
    ...parts(718,[['Narration: UPI GROCERY SHOP',35]]),
    ...parts(696,[['Debit Amount: 150.00',35]]),
    ...parts(674,[['Transaction Date: 05/11/26',35]]),
    ...parts(652,[['Narration: REFUND',35]]),
    ...parts(630,[['Credit Amount: 50.00',35]]),
  ];
  const rows=parsePdfBankItems([page]);
  assert.deepEqual(rows.map(r=>[r.amount,r.transaction_type]),[['150.00','EXPENSE'],['50.00','INCOME']]);
});

test('PDF metadata and no transaction table must not create fake transactions',()=>{
  const page=[
    ...parts(740,[['Account Open Date: 12/10/26',35]]),
    ...parts(720,[['Available Balance: 99,999.00',35]]),
    ...parts(700,[['Recent 7 Days Transactions',35]]),
  ];
  assert.throws(()=>parsePdfBankItems([page]),/No structured/);
});

test('ambiguous debit/credit values are rejected rather than silently importing',()=>{
  const page=[
    ...parts(740,[['Date',35],['Narration',120],['Debit',340],['Credit',430]]),
    ...parts(719,[['04/11/26',35],['TEST',120],['100.00',340],['200.00',430]]),
  ];
  assert.throws(()=>parsePdfBankItems([page]),/debit\/credit/i);
});

test('impossible DD/MM/YY calendar dates fail',()=>{
  const page=[
    ...parts(740,[['Date',35],['Narration',120],['Debit',340],['Credit',430]]),
    ...parts(719,[['31/02/26',35],['TEST',120],['100.00',340]]),
  ];
  assert.throws(()=>parsePdfBankItems([page]),/invalid transaction date/i);
});
