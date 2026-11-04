import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseBankPdfPages } from '../src/services/bankPdfSafeDiagnostics.js';

const sample=[
  ['Date',50,720],['Narration',180,720],['Chq./Ref.No.',300,720],
  ['Withdrawal Amt.',490,720],['Deposit Amt.',570,720],['Closing Balance',660,720],
  ['04/09/26',22,695],['USER SECRET STREET BANK ACCOUNT 123456789',80,695],
  ['0000987612345678',300,695],['200.00',500,695],['3500.00',660,695],
];
const items = sample.map(([str,x,y])=>({str,transform:[1,0,0,1,x,y],width:String(str).length*5}));

test('private report includes only whitelisted geometry, not document content or bank values',()=>{
  const report=diagnoseBankPdfPages([items]);
  const serialized=JSON.stringify(report);
  assert.equal(report.format,'pdf-layout-only');
  assert.equal(report.pages,1);
  assert.equal(report.pagesInspected[0].dateTokens,1);
  assert.equal(report.pagesInspected[0].headings.withdrawal[0],490);
  assert.equal(report.pagesInspected[0].sampleDateRowGeometry[0][0].type,'DATE');
  for(const text of ['04/09/26','200.00','3500.00','123456789','SECRET STREET',
    '0000987612345678','Chq./Ref.No.','USER']) {
    assert.equal(serialized.includes(text),false, 'No PDF text or financial values in safe report');
  }
});

test('diagnostic limits to five pages and three date row patterns per page',()=>{
  const many = Array(8).fill(items);
  const report=diagnoseBankPdfPages(many);
  assert.equal(report.pages,8);
  assert.equal(report.pagesInspected.length,5);
  assert.ok(report.pagesInspected.every(page=>page.sampleDateRowGeometry.length<=3));
});

test('empty scanned PDF page returns zero text without exposing content',()=>{
  const report=diagnoseBankPdfPages([[]]);
  assert.equal(report.totalTextItems,0);
  assert.equal(report.pagesInspected[0].dateTokens,0);
});
