import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfBankItems } from '../src/services/supabaseBankPdfLayout.js';

const row=(y,cells)=>cells.map(([str,x,width=0])=>({str,transform:[1,0,0,1,x,y],width}));

// Fictional figures, dates and references: reconstructs only the column
// geometry shown in a HDFC bank statement screenshot, never user transaction data.
const HEADER=[
  ['Date',55],['Narration',179],['Chq./Ref.No.',321],
  ['Value Dt',430],['Withdrawal Amt.',495],['Deposit Amt.',572],
  ['Closing Balance',651],
];
const PAGE_1=[
  ...row(740,HEADER),
  ...row(714,[['04/09/26',23],['UPI-TEST COFFEE SHOP',80],['111122223333',321],
    ['05/09/26',421],['200.00',505],['3,540.00',654]]),
  ...row(703,[['TEST PURCHASE',80]]),
  ...row(682,[['04/09/26',23],['UPI-TEST MARKET',80],['111122223334',321],
    ['05/09/26',421],['300.00',505],['3,240.00',654]]),
  ...row(664,[['04/09/26',23],['NEFT TEST REFUND',80],['111122223335',321],
    ['05/09/26',421],['60.00',575],['3,300.00',654]]),
];
const PAGE_2=[
  ...row(739,HEADER),
  ...row(711,[['05/09/26',23],['UPI TEST MERCHANT',80],['111122223336',321],
    ['05/09/26',421],['100.00',505],['3,200.00',654]]),
];

test('HDFC screenshot geometry: centered headings and left-aligned narration must not merge into Date column',()=>{
  const records=parsePdfBankItems([PAGE_1,PAGE_2]);
  assert.equal(records.length,4);
  assert.deepEqual(records.map(r=>[r.date,r.description,r.amount,r.transaction_type]),[
    ['2026-09-04','UPI-TEST COFFEE SHOP TEST PURCHASE','200.00','EXPENSE'],
    ['2026-09-04','UPI-TEST MARKET','300.00','EXPENSE'],
    ['2026-09-04','NEFT TEST REFUND','60.00','INCOME'],
    ['2026-09-05','UPI TEST MERCHANT','100.00','EXPENSE'],
  ]);
});

test('HDFC headings wrapping across different PDF baselines are recognized',()=>{
  const headerLines=[
    ...row(743,[['Date',55],['Narration',179],['Chq./Ref.No.',321],['Value',430],['Withdrawal',495],['Deposit',572],['Closing',651]]),
    ...row(733,[['Dt',430],['Amt.',495],['Amt.',572],['Balance',651]]),
  ];
  const records=parsePdfBankItems([[...headerLines,...row(715,[['04/09/26',23],['TEST PAYMENT',80],['123456789000',321],['04/09/26',421],['50.00',505],['950.00',654]])]]);
  assert.equal(records.length,1);
  assert.equal(records[0].amount,'50.00');
  assert.equal(records[0].transaction_type,'EXPENSE');
});

test('HDFC page headers and account metadata never turn into financial transactions',()=>{
  const meta=row(782,[['Statement of Account',40],['Account Number: 000000XXXX',250]]);
  const parsed=parsePdfBankItems([[...meta,...PAGE_1]]);
  assert.equal(parsed.length,3);
  assert.ok(parsed.every(record=>record.description.startsWith('UPI-') || record.description.startsWith('NEFT')));
});

test('HDFC layout rejects both populated debit and credit even with a balance column',()=>{
 const bad=[...row(740,HEADER),...row(715,[['04/09/26',23],['BAD ROW',80],['04/09/26',421],['50.00',505],['25.00',575],['975.00',654]])];
 assert.throws(()=>parsePdfBankItems([bad]),/debit\/credit/i);
});
