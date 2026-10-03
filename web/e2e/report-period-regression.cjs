const assert=require('node:assert/strict');
(async()=>{
 const {presetRange}=await import('../report-period.js');
 // Just before/after local midnight; the machine/browser timezone must not matter.
 for(const zone of ['UTC','America/Los_Angeles','Asia/Tokyo']){
  process.env.TZ=zone;
  assert.deepEqual(presetRange('month',new Date('2026-09-30T19:01:00Z')),{kind:'month',from:'2026-10-01',to:'2026-10-01'});
  assert.deepEqual(presetRange('quarter',new Date('2026-09-30T18:59:00Z')),{kind:'quarter',from:'2026-07-01',to:'2026-09-30'});
  assert.deepEqual(presetRange('week',new Date('2026-09-27T19:01:00Z')),{kind:'week',from:'2026-09-28',to:'2026-09-28'});
 }
 console.log('REPORT_PERIOD_REGRESSION: ok');
})().catch(e=>{console.error(e);process.exitCode=1});
