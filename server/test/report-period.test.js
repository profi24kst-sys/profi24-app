import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportPeriod} from '../src/report-period.js';

test('report period accepts an inclusive custom range and builds equal previous period',()=>{
  const p=reportPeriod({from:'2026-09-01',to:'2026-09-30'});
  assert.equal(p.days,30);
  assert.equal(p.start.toISOString(),'2026-09-01T00:00:00.000Z');
  assert.equal(p.end.toISOString(),'2026-10-01T00:00:00.000Z');
  assert.equal(p.previousFrom,'2026-08-02');
  assert.equal(p.previousTo,'2026-08-31');
});

test('report period keeps legacy current-month mode when no range is supplied',()=>{
  assert.equal(reportPeriod({}),null);
});

test('report period rejects incomplete, reversed and excessive ranges',()=>{
  assert.throws(()=>reportPeriod({from:'2026-09-01'}),e=>e.statusCode===422);
  assert.throws(()=>reportPeriod({from:'2026-09-30',to:'2026-09-01'}),e=>e.statusCode===422);
  assert.throws(()=>reportPeriod({from:'2025-01-01',to:'2026-09-01'}),e=>e.statusCode===422);
});
