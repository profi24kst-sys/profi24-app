import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportPeriod,reportPeriodMetadata} from '../src/report-period.js';

test('inclusive local dates use Kostanay midnight and the full previous calendar month',()=>{
 const p=reportPeriod({from:'2026-09-01',to:'2026-09-30'});
 assert.equal(p.days,30);
 assert.equal(p.start.toISOString(),'2026-08-31T19:00:00.000Z');
 assert.equal(p.end.toISOString(),'2026-09-30T19:00:00.000Z');
 assert.equal(p.previousFrom,'2026-08-01');assert.equal(p.previousTo,'2026-08-31');
 assert.equal(p.previousStart.toISOString(),'2026-07-31T19:00:00.000Z');
 assert.equal(p.comparison,'calendar_month');assert.equal(reportPeriodMetadata(p).time_zone,'Asia/Qostanay');
});
test('leap February and January compare with complete calendar months',()=>{
 const leap=reportPeriod({from:'2024-02-01',to:'2024-02-29'});
 assert.equal(leap.days,29);assert.equal(leap.previousFrom,'2024-01-01');assert.equal(leap.previousTo,'2024-01-31');
 const january=reportPeriod({from:'2026-01-01',to:'2026-01-31'});
 assert.equal(january.previousFrom,'2025-12-01');assert.equal(january.previousTo,'2025-12-31');
});
test('full quarter compares with the previous quarter across a year boundary',()=>{
 const p=reportPeriod({from:'2026-01-01',to:'2026-03-31'});
 assert.equal(p.previousFrom,'2025-10-01');assert.equal(p.previousTo,'2025-12-31');assert.equal(p.comparison,'calendar_quarter');
});
test('custom range compares the same number of calendar days',()=>{
 const p=reportPeriod({from:'2026-09-10',to:'2026-09-12'});
 assert.equal(p.days,3);assert.equal(p.previousFrom,'2026-09-07');assert.equal(p.previousTo,'2026-09-09');assert.equal(p.comparison,'equal_days');
});
test('IANA rules preserve the historical six-hour offset and Kazakhstan clock change',()=>{
 const p=reportPeriod({from:'2024-02-29',to:'2024-02-29'});
 assert.equal(p.start.toISOString(),'2024-02-28T18:00:00.000Z');
 assert.equal(p.end.toISOString(),'2024-02-29T19:00:00.000Z');
 assert.equal(p.days,1);assert.equal((p.end-p.start)/3600000,25);
});
test('no explicit range preserves legacy mode; invalid ranges are rejected',()=>{
 assert.equal(reportPeriod({}),null);
 for(const query of [{from:'2026-09-01'},{from:'2026-09-30',to:'2026-09-01'},{from:'2025-01-01',to:'2026-09-01'},{from:'2026-02-29',to:'2026-03-01'},{from:'invalid',to:'2026-09-01'}])assert.throws(()=>reportPeriod(query),e=>e.statusCode===422);
});
