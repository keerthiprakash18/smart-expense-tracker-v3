import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBankStatementFile, MAX_BANK_STATEMENT_BYTES } from '../src/services/bankStatementFile.js';

test('Android document provider octet-stream PDF is accepted based on filename',()=>{
  const f={name:'statement.PDF',size:1250,type:'application/octet-stream'};
  assert.deepEqual(selectBankStatementFile(f),{file:f,format:'pdf',name:'statement.PDF',sizeLabel:'0.00 MB'});
});

test('PDF can be recognized from MIME even without extension',()=>{
  assert.equal(selectBankStatementFile({name:'statement',size:2048,type:'application/pdf'}).format,'pdf');
});

test('CSV is accepted up to inclusive 5MiB',()=>{
  assert.equal(selectBankStatementFile({name:'export.csv',size:MAX_BANK_STATEMENT_BYTES,type:'text/csv'}).format,'csv');
});

test('bad types and over-limit statements fail explicitly',()=>{
  assert.throws(()=>selectBankStatementFile({name:'photo.jpg',size:25,type:'image/jpeg'}),/Unsupported file/);
  assert.throws(()=>selectBankStatementFile({name:'big.pdf',size:MAX_BANK_STATEMENT_BYTES+1,type:'application/pdf'}),/larger than 5 MB/);
  assert.throws(()=>selectBankStatementFile({name:'empty.pdf',size:0,type:'application/pdf'}),/empty/);
});
