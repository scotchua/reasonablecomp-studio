'use strict';

const integrity = require('../js/engine/integrity.js');
const readiness = require('../js/engine/audit-readiness.js');
const cfg = require('../js/data/config.js');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { console.log('  ok   ' + name); passed++; }
  else { console.error('  FAIL ' + name); failed++; }
}

console.log('Integrity: deterministic SHA-256 audit records');
check('SHA-256 empty-string vector', integrity.sha256('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('SHA-256 abc vector', integrity.sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('canonical object order is stable', integrity.fingerprint({ b: 2, a: 1 }) === integrity.fingerprint({ a: 1, b: 2 }));
check('material change changes fingerprint', integrity.fingerprint({ a: 1 }) !== integrity.fingerprint({ a: 2 }));

function goodYear() {
  const evidence = {};
  cfg.auditRequiredEvidence.forEach(k => { evidence[k] = true; });
  return {
    duties: 'Provides advisory services and manages the practice.',
    hoursPerWeek: 40,
    roleComponents: [{ soc: '132011', pctTime: 100 }],
    revenueSources: { shareholderServicesPct: 80, employeeServicesPct: 15, capitalEquipmentPct: 5, notes: 'Supported by engagement ledger, staff reports, and asset schedule.' },
    flagResponses: {},
    approval: { approvedBy: 'Reviewer, CPA', approvedDate: '2026-01-15' },
    evidence,
  };
}

const data = { release: 'May 2025' };
const cleanAnalysis = { oewsRelease: 'May 2025', flags: [], inputFingerprint: 'current-input' };
const client = { areaCode: '0017660' };
console.log('Readiness: finalization gate');
let result = readiness.evaluate(goodYear(), cleanAnalysis, data, cfg, 'current-input', client);
check('complete record is finalizable', result.finalizable === true);
check('complete record scores 100', result.score === 100);

let badRevenue = goodYear();
badRevenue.revenueSources.capitalEquipmentPct = 0;
result = readiness.evaluate(badRevenue, cleanAnalysis, data, cfg, 'current-input', client);
check('90% source allocation blocks finalization', result.finalizable === false && result.blockers.some(x => x.id === 'revenue'));

let unexplainedOverride = goodYear();
unexplainedOverride.roleComponents[0].percentileOverride = 90;
result = readiness.evaluate(unexplainedOverride, cleanAnalysis, data, cfg, 'current-input', client);
check('unexplained percentile override blocks finalization', result.blockers.some(x => x.id === 'overrides'));

let highFlag = goodYear();
const flaggedAnalysis = { oewsRelease: 'May 2025', flags: [{ id: 'ZERO', severity: 'high' }], inputFingerprint: 'current-input' };
result = readiness.evaluate(highFlag, flaggedAnalysis, data, cfg, 'current-input', client);
check('unanswered high flag blocks finalization', result.blockers.some(x => x.id === 'flags'));
highFlag.flagResponses.ZERO = 'Resolved with a documented payroll true-up before year end.';
result = readiness.evaluate(highFlag, flaggedAnalysis, data, cfg, 'current-input', client);
check('documented flag response clears the blocker', !result.blockers.some(x => x.id === 'flags'));
result = readiness.evaluate(goodYear(), cleanAnalysis, data, cfg, 'changed-input', client);
check('changed calculation inputs invalidate the analysis', result.blockers.some(x => x.id === 'analysis'));

console.log('Readiness: 1.10 additions -- area gate and hours-corroboration gate on profile');
let noArea = readiness.evaluate(goodYear(), cleanAnalysis, data, cfg, 'current-input', { areaCode: '' });
check('missing principal work area blocks finalization', noArea.blockers.some(x => x.id === 'area'));
check('missing principal work area is NOT finalizable', noArea.finalizable === false);
let withArea = readiness.evaluate(goodYear(), cleanAnalysis, data, cfg, 'current-input', client);
check('area present clears the area blocker', !withArea.blockers.some(x => x.id === 'area'));
let noClient = readiness.evaluate(goodYear(), cleanAnalysis, data, cfg, 'current-input');
check('client omitted entirely also blocks on area (falsy client)', noClient.blockers.some(x => x.id === 'area'));

let uncorroboratedHours = goodYear();
uncorroboratedHours.hoursPerWeek = 50;
result = readiness.evaluate(uncorroboratedHours, cleanAnalysis, data, cfg, 'current-input', client);
check('50 claimed hours without hoursCorroborated blocks the profile item', result.blockers.some(x => x.id === 'profile'));
let corroboratedHours = goodYear();
corroboratedHours.hoursPerWeek = 50;
corroboratedHours.hoursCorroborated = true;
result = readiness.evaluate(corroboratedHours, cleanAnalysis, data, cfg, 'current-input', client);
check('50 claimed hours WITH hoursCorroborated clears the profile item', !result.blockers.some(x => x.id === 'profile'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
