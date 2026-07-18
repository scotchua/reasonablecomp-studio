#!/usr/bin/env node
/*
 * test-engine.js — Hand-calculated unit tests for the reasonable comp engine.
 *
 * Run: node scripts/test-engine.js
 *
 * The fixture wage data below is invented so every expected value can be (and
 * was) worked out by hand arithmetic in the comments. A final integration
 * section runs the engine against the real generated oews-data.js and checks
 * internal consistency (not specific dollar values, which change each release).
 */

'use strict';

const path = require('path');
const engine = require(path.join(__dirname, '..', 'js', 'engine', 'comp-engine.js'));
const cfg = require(path.join(__dirname, '..', 'js', 'data', 'config.js'));

let failures = 0, passes = 0;
function check(label, actual, expected, tol) {
  tol = tol === undefined ? 0.51 : tol; // default: within a dollar of hand math
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : actual === expected;
  if (ok) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}: expected ${expected}, got ${actual}`); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ---------------------------------------------------------------- fixture data
// Hourly percentiles chosen so annual = hourly x 2080 is clean arithmetic.
// Wage row layout: [emp, h10,h25,h50,h75,h90, a10,a25,a50,a75,a90]
const FIX = {
  release: 'May 2025 (fixture)',
  releaseYear: 2025,
  topcodeNote: '>= $115.00/hr or $239,200/yr',
  areas: [
    ['0000000', 'National', 'N', '00'],
    ['1600000', 'Idaho', 'S', '16'],
    ['0017660', "Coeur d'Alene, ID", 'M', '16'],
  ],
  // SOC group levels, for the broad/minor/major-group warning (1.9). A fixture
  // (or a real occupations array) may omit this entirely -- costApproach must
  // not crash when it's absent (see the Scenario-1c/1b tests above, none of
  // which set `occupations`).
  occupations: [
    ['132011', 'Accountants and Auditors', 'detailed', ''],
    ['110000', 'Management Occupations', 'major', ''],
  ],
  wages: {
    '0017660': {
      // Accountants: h = 20/25/30/40/50 -> annual 41,600/52,000/62,400/83,200/104,000
      '132011': [100, 20, 25, 30, 40, 50, 41600, 52000, 62400, 83200, 104000],
      // Suppression case: ONLY the median published (h50 = 30)
      '292011': [50, null, null, 30, null, null, null, null, 62400, null, null],
    },
    '1600000': {
      // General managers: h = 25/30/40/50/60 -> annual 52,000/62,400/83,200/104,000/124,800
      '111021': [500, 25, 30, 40, 50, 60, 52000, 62400, 83200, 104000, 124800],
      '132011': [800, 18, 22, 27, 35, 45, 37440, 45760, 56160, 72800, 93600],
    },
    '0000000': {
      // Annual-only occupation (no hourly published), like teachers/pilots
      '434051': [9000, null, null, null, null, null, 30000, 35000, 40000, 45000, 50000],
      '132011': [1000000, 22, 27, 33, 42, 55, 45760, 56160, 68640, 87360, 114400],
      // Broad ("major") group, for the 1.9 warning test -- h = 30/35/45/60/75
      '110000': [2000000, 30, 35, 45, 60, 75, 62400, 72800, 93600, 124800, 156000],
    },
  },
  topcode: {},
};

const client = { name: 'Test Co', areaCode: '0017660' };

// ============================================================ Scenario 1
// Licensed CPA, 10 yrs experience -> default 75th percentile. 40 hrs/wk.
// 60% Accountant (CdA), 30% GM (CdA missing -> Idaho fallback), 10% annual-only (national).
//
// Hand math (mid, 75th):
//   132011: $40/hr x 40 x 52 = 83,200 x 60% = 49,920
//   111021: $50/hr x 40 x 52 = 104,000 x 30% = 31,200   (Idaho fallback)
//   434051: $45,000 x (40/40) x 10% = 4,500             (annual-only)
//   mid = 85,620
// low (50th): 62,400x.6 + 83,200x.3 + 40,000x.1 = 37,440+24,960+4,000 = 66,400
// high (90th): 104,000x.6 + 124,800x.3 + 50,000x.1 = 62,400+37,440+5,000 = 104,840
// Market approach: 132011 at 60% >= 60% threshold -> full-role 62,400/83,200/104,000
// Income approach now tests the shareholder's actual planned wages (totalOfficerWages
// = 60,000), not the tool's own 85,620 recommendation (that would be circular).
//   NIBC 150,000; tested 60,000; tax year 2025 -> SSA wage base 176,100 (60,000 is
//   under it): OASDI 60,000x.062=3,720; Medicare 60,000x.0145=870; FUTA 7,000x.006=42;
//   payroll = 4,632.00; residual = 150,000-60,000-4,632 = 85,368.00 (share .5691 -> plausible)
// BELOW_RANGE: planned wages 60,000 < range.low 66,400; shortfall (66,400-60,000)/66,400
//   = 9.6% < the 20% high-severity threshold -> medium.
console.log('Scenario 1: multi-hat licensed CPA, full-time');
{
  const input = {
    client,
    shareholder: { name: 'A', yearsExperience: 10, licenses: 'CPA', hoursPerWeek: 40, taxYear: '2025' },
    roleComponents: [
      // licenseApplies:true here (1.7): the CPA license is relevant to this hat.
      // Default tier is already 75th from 10 years' experience alone, so the
      // NUMBERS don't move -- but the floor still applies and the reason text
      // must say so. The GM component has no licenseApplies flag and must NOT
      // mention the license (this is the differentiation the old shared-floor
      // bug could never make: one text field used to float every hat).
      { roleTitle: 'Accounting/professional services', soc: '132011', pctTime: 60, licenseApplies: true },
      { roleTitle: 'General management', soc: '111021', pctTime: 30 },
      { roleTitle: 'Administrative', soc: '434051', pctTime: 10 },
    ],
    financials: { netIncomeBeforeOfficerComp: 150000, totalDistributions: 50000, totalOfficerWages: 60000 },
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  check('default tier is 75th (experience alone, 1.7: license no longer part of the shared default)', r.defaultTier.percentile, 75);
  checkTrue('accountant component reason mentions the license', r.costApproach.components[0].percentileReason.toLowerCase().includes('licens'));
  checkTrue('GM component reason does NOT mention the license', !r.costApproach.components[1].percentileReason.toLowerCase().includes('licens'));
  check('cost mid = 85,620 (unchanged -- license floor didn\'t need to move the number)', r.costApproach.mid, 85620);
  check('cost low = 66,400', r.costApproach.low, 66400);
  check('cost high = 104,840', r.costApproach.high, 104840);
  check('range.mid rounded', r.range.mid, 85620);
  checkTrue('GM component fell back to Idaho', r.costApproach.components[1].fellBack && r.costApproach.components[1].areaUsedName === 'Idaho');
  checkTrue('fallback disclosed in notes', r.costApproach.notes.some(n => n.includes('Idaho')));
  check('market approach applicable', r.marketApproach.applicable, true);
  check('market mid = 83,200', r.marketApproach.mid, 83200);
  check('market low = 62,400', r.marketApproach.low, 62400);
  check('market high = 104,000', r.marketApproach.high, 104000);
  check('income tested planned wages', r.incomeApproach.proposedSalary, 60000);
  check('income residual = 85,368.00 (exact OASDI/Medicare/FUTA at TY 2025)', r.incomeApproach.residual, 85368.00, 0.01);
  check('income verdict plausible', r.incomeApproach.verdict, 'plausible');
  check('employer payroll cost = 4,632.00', r.incomeApproach.employerPayrollTax, 4632.00, 0.01);
  checkTrue('reconciliation mentions corroboration (within 10%)', r.reconciliation.join(' ').includes('corroborate'));
  checkTrue('no capacity flag', !r.flags.some(f => f.id === 'EXCEEDS_CAPACITY'));
  const belowRange1 = r.flags.find(f => f.id === 'BELOW_RANGE');
  checkTrue('BELOW_RANGE fires (60,000 < low 66,400)', !!belowRange1);
  check('BELOW_RANGE severity medium (9.6% shortfall)', belowRange1 && belowRange1.severity, 'medium');
}

// ============================================================ Scenario 1b
// License-floor regression test (1.7) -- this is the VERIFIED BUG the plan
// names explicitly: a shareholder-level license text field used to floor
// EVERY role component at the 75th percentile, regardless of whether the
// license had anything to do with that hat. 1 year of experience -> 25th
// percentile by experience alone. "Class B driver license" is present on the
// shareholder, but must only floor a component the preparer marks
// licenseApplies:true on that specific component.
console.log('Scenario 1b: per-component license floor (regression test for the verified bug)');
{
  const shareholder = { name: 'Driver', yearsExperience: 1, licenses: 'Class B driver license', hoursPerWeek: 40 };
  const rNotApplied = engine.analyze({
    client,
    shareholder,
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100, licenseApplies: false }],
    financials: {},
    compHistory: [],
  }, FIX, cfg);
  check('licenseApplies:false -> stays at 25th (license irrelevant to this hat)', rNotApplied.costApproach.components[0].percentile, 25);

  const rApplied = engine.analyze({
    client,
    shareholder,
    roleComponents: [{ roleTitle: 'Delivery driving', soc: '132011', pctTime: 100, licenseApplies: true }],
    financials: {},
    compHistory: [],
  }, FIX, cfg);
  check('licenseApplies:true -> floored to 75th', rApplied.costApproach.components[0].percentile, 75);
}

// ============================================================ Scenario 1c
// Optional per-component years-experience override (1.8): shareholder has 20
// years of experience (75th by the shared default), but one component is
// explicitly re-priced from 2 years of experience for THAT hat (25th),
// leaving the other component at the shared 75th default.
//
// Hand math (both components 50% time, no license, hours full-time/52 wks):
//   Component A (132011 CdA, override 2 yrs -> 25th):
//     low  (10th): $20/hr x 40 x 52 = 41,600 x 50% = 20,800
//     mid  (25th): $25/hr x 40 x 52 = 52,000 x 50% = 26,000
//     high (50th): $30/hr x 40 x 52 = 62,400 x 50% = 31,200
//   Component B (111021 Idaho fallback, no override -> 75th from 20 yrs):
//     low  (50th): $40/hr x 40 x 52 = 83,200  x 50% = 41,600
//     mid  (75th): $50/hr x 40 x 52 = 104,000 x 50% = 52,000
//     high (90th): $60/hr x 40 x 52 = 124,800 x 50% = 62,400
//   Totals: low = 62,400, mid = 78,000, high = 93,600
console.log('Scenario 1c: per-component years-experience override');
{
  const input = {
    client,
    shareholder: { name: 'Multi', yearsExperience: 20, licenses: '', hoursPerWeek: 40 },
    roleComponents: [
      { roleTitle: 'Accounting (junior, component-specific)', soc: '132011', pctTime: 50, yearsExperienceOverride: 2 },
      { roleTitle: 'General management', soc: '111021', pctTime: 50 },
    ],
    financials: {},
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  check('component A (override 2 yrs) prices at 25th', r.costApproach.components[0].percentile, 25);
  checkTrue('component A reason names the override years', r.costApproach.components[0].percentileReason.includes('2 years') && r.costApproach.components[0].percentileReason.includes('component-specific'));
  check('component B (no override) prices at 75th (shareholder default)', r.costApproach.components[1].percentile, 75);
  check('blended low = 62,400', r.costApproach.low, 62400);
  check('blended mid = 78,000', r.costApproach.mid, 78000);
  check('blended high = 93,600', r.costApproach.high, 93600);
}

// ============================================================ Scenario 2
// Part-time, 20 hrs/wk, 2 yrs experience (-> 25th pct), single 100% role.
// 132011 CdA 25th: $25/hr x 20 x 52 = 26,000 (mid)
// low (10th): 20 x 20 x 52 = 20,800; high (50th): 30 x 20 x 52 = 31,200
console.log('Scenario 2: part-time junior, single role');
{
  const input = {
    client,
    shareholder: { name: 'B', yearsExperience: 2, licenses: '', hoursPerWeek: 20 },
    roleComponents: [{ roleTitle: 'Bookkeeper-owner', soc: '132011', pctTime: 100 }],
    financials: { netIncomeBeforeOfficerComp: 90000, totalDistributions: 0, totalOfficerWages: 26000 },
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  check('default tier is 25th', r.defaultTier.percentile, 25);
  check('cost mid = 26,000', r.costApproach.mid, 26000);
  check('cost low = 20,800', r.costApproach.low, 20800);
  check('cost high = 31,200', r.costApproach.high, 31200);
  checkTrue('no flags on clean part-timer', r.flags.length === 0);
}

// ============================================================ Scenario 3
// Percentile override + hours cap. 8+ yrs (75th default), override to 90th with reason.
// 80 hrs/wk claimed, CORROBORATED (1.5.2) -> capped at maxHoursScale (60), not 40.
// 132011 CdA 90th: $50 x 60 x 52 = 156,000 (mid).
// high band requests pctStep(90,+1) -> stays 90 -> also 156,000.
// low band = 75th: 40 x 60 x 52 = 124,800.
console.log('Scenario 3: override to 90th, hours capped at 60 (corroborated)');
{
  const input = {
    client,
    shareholder: { name: 'C', yearsExperience: 15, licenses: '', hoursPerWeek: 80, hoursCorroborated: true },
    roleComponents: [{ roleTitle: 'Owner-operator', soc: '132011', pctTime: 100, percentileOverride: 90, overrideReason: 'Senior owner-operator with full management scope' }],
    financials: { netIncomeBeforeOfficerComp: 400000, totalDistributions: 100000, totalOfficerWages: 150000 },
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  check('cost mid = 156,000 (90th, 60 hr cap)', r.costApproach.mid, 156000);
  check('cost low = 124,800 (75th)', r.costApproach.low, 124800);
  check('cost high = 156,000 (clamped at 90th)', r.costApproach.high, 156000);
  checkTrue('override reason preserved', r.costApproach.components[0].percentileReason.includes('management scope'));
  checkTrue('hours-cap note present', r.costApproach.notes.some(n => n.includes('capped at 60')));
}

// ============================================================ Scenario 3b
// Same claimed 80 hrs/wk, but NOT corroborated (1.5.2) -> wage scaling clamped
// back to full-time (40), not the 60-hour cap. 132011 CdA 90th: $50 x 40 x 52
// = 104,000 (mid). A clamp note must explain why 80 hrs wasn't monetized.
console.log('Scenario 3b: same 80 hrs/wk claim, NOT corroborated -> clamped to 40');
{
  const input = {
    client,
    shareholder: { name: 'C2', yearsExperience: 15, licenses: '', hoursPerWeek: 80, hoursCorroborated: false },
    roleComponents: [{ roleTitle: 'Owner-operator', soc: '132011', pctTime: 100, percentileOverride: 90, overrideReason: 'Senior owner-operator with full management scope' }],
    financials: { netIncomeBeforeOfficerComp: 400000, totalDistributions: 100000, totalOfficerWages: 150000 },
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  check('cost mid = 104,000 (90th, clamped to 40 hrs, uncorroborated)', r.costApproach.mid, 104000);
  checkTrue('uncorroborated-hours clamp note present', r.costApproach.notes.some(n => n.includes('not corroborated') && n.includes('capped at 40')));
  checkTrue('no 60-hr cap note (never reached the corroborated cap)', !r.costApproach.notes.some(n => n.includes('capped at 60')));
}

// ============================================================ Scenario 3c
// Seasonal weeks (1.5.4): 40 hrs/wk (full-time, no scaling above 1.0x needed),
// 26 weeks worked. 132011 CdA 75th (10 yrs exp -> 75th default): $40 x 40 x 26
// = 41,600 mid. Sibling annual-only occupation (434051, national) at 75th:
// $45,000 x (40/40 hrs, never scaled above 1.0x) x (26/52 wks) = 22,500.
console.log('Scenario 3c: seasonal weeksWorkedPerYear (hourly and annual-only)');
{
  const hourlyInput = {
    client,
    shareholder: { name: 'C3', yearsExperience: 10, licenses: '', hoursPerWeek: 40, weeksWorkedPerYear: 26 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: {},
    compHistory: [],
  };
  const rH = engine.analyze(hourlyInput, FIX, cfg);
  check('hourly basis: 40 x 40 x 26 = 41,600 mid', rH.costApproach.mid, 41600);
  checkTrue('basis string shows actual weeks (26 wks)', rH.costApproach.components[0].midDetail.basis.includes('26 wks'));

  const annualInput = {
    client: { name: 'Test Co', areaCode: '0000000' },
    shareholder: { name: 'C4', yearsExperience: 10, licenses: '', hoursPerWeek: 40, weeksWorkedPerYear: 26 },
    roleComponents: [{ roleTitle: 'Administrative', soc: '434051', pctTime: 100 }],
    financials: {},
    compHistory: [],
  };
  const rA = engine.analyze(annualInput, FIX, cfg);
  check('annual-only basis: 45,000 x 1.0 x 26/52 = 22,500 mid', rA.costApproach.mid, 22500);
}

// ============================================================ Scenario 4
// Red flags: Watson drift, ratio, below-staff, zero-salary patterns.
console.log('Scenario 4: red flags');
{
  const input = {
    client,
    shareholder: { name: 'D', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: { netIncomeBeforeOfficerComp: 200000, totalDistributions: 90000, totalOfficerWages: 30000, highestNonShareholderWage: 45000 },
    // salary CAGR 0%; distributions 40k->90k over 2 steps = 50%/yr; share 42.9% -> 25.0%
    compHistory: [
      { taxYear: 2023, salaryPaid: 30000, distributionsPaid: 40000 },
      { taxYear: 2024, salaryPaid: 30000, distributionsPaid: 70000 },
      { taxYear: 2025, salaryPaid: 30000, distributionsPaid: 90000 },
    ],
  };
  const r = engine.analyze(input, FIX, cfg);
  const ids = r.flags.map(f => f.id);
  checkTrue('DIST_RATIO_CURRENT (90k/30k = 3.0x > 2.0x)', ids.includes('DIST_RATIO_CURRENT'));
  checkTrue('DIST_RATIO_TRAILING (200k/90k = 2.2x > 2.0x)', ids.includes('DIST_RATIO_TRAILING'));
  checkTrue('WATSON_DRIFT', ids.includes('WATSON_DRIFT'));
  checkTrue('BELOW_STAFF (30k < 45k)', ids.includes('BELOW_STAFF'));
  checkTrue('Watson detail names both years', (r.flags.find(f => f.id === 'WATSON_DRIFT') || {}).detail.includes('2023'));
  // Cost mid (75th, 10 yrs exp): 40x40x52=83,200; low (50th): 30x40x52=62,400.
  // Planned wages 30,000 < low 62,400; shortfall (62,400-30,000)/62,400 = 51.9% >= 20% -> high.
  const belowRange4 = r.flags.find(f => f.id === 'BELOW_RANGE');
  checkTrue('BELOW_RANGE fires (30,000 vs low 62,400)', !!belowRange4);
  check('BELOW_RANGE severity high (51.9% shortfall)', belowRange4 && belowRange4.severity, 'high');
}

// ============================================================ Scenario 5
// Zero salary with distributions; and capacity/income-approach failure.
// 132011 75th mid = 83,200 > NIBC 40,000 -> EXCEEDS_CAPACITY + negative residual.
console.log('Scenario 5: zero salary, capacity exceeded');
{
  const input = {
    client,
    shareholder: { name: 'E', yearsExperience: 12, licenses: '', hoursPerWeek: 40, taxYear: '2025' },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: { netIncomeBeforeOfficerComp: 40000, totalDistributions: 50000, totalOfficerWages: 0 },
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  const ids = r.flags.map(f => f.id);
  checkTrue('ZERO_SALARY_WITH_DISTRIBUTIONS', ids.includes('ZERO_SALARY_WITH_DISTRIBUTIONS'));
  checkTrue('NEAR_ZERO_SALARY', ids.includes('NEAR_ZERO_SALARY'));
  // EXCEEDS_CAPACITY now includes EXACT employer payroll cost (Phase 2) on the mid
  // figure: 83,200 x .062=5,158.40 OASDI + 83,200x.0145=1,206.40 Medicare + 42.00 FUTA
  // = 6,406.80; 83,200+6,406.80=89,606.80 > 40,000 NIBC -> still fires.
  checkTrue('EXCEEDS_CAPACITY', ids.includes('EXCEEDS_CAPACITY'));
  checkTrue('no BELOW_RANGE (explicit 0 salary owned by the zero-salary flags)', !ids.includes('BELOW_RANGE'));
  check('income verdict negative', r.incomeApproach.verdict, 'negative');
  // Explicit totalOfficerWages: 0 -> salaryNum is 0, not > 0, so the income approach
  // falls back to testing the recommended mid (83,200) exactly as before Phase 1.2.
  check('employer payroll cost = 6,406.80 (exact OASDI/Medicare/FUTA)', r.incomeApproach.employerPayrollTax, 6406.80, 0.01);
  check('residual = 40,000 - 83,200 - 6,406.80 = -49,606.80', r.incomeApproach.residual, -49606.80, 0.01);
}

// ============================================================ Scenario 6
// Suppressed percentiles: 292011 has ONLY the median. Requested 75th must
// substitute the published 50th (nearest, conservative) and disclose it.
// mid = 30 x 40 x 52 = 62,400.
console.log('Scenario 6: suppressed percentile substitution');
{
  const input = {
    client,
    shareholder: { name: 'F', yearsExperience: 20, licenses: 'RN', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Nurse-owner', soc: '292011', pctTime: 100 }],
    financials: { netIncomeBeforeOfficerComp: 120000, totalDistributions: 0, totalOfficerWages: 70000 },
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  check('mid uses published median = 62,400', r.costApproach.mid, 62400);
  check('mid detail shows percentile actually used (50th)', r.costApproach.components[0].midDetail.percentile, 50);
  checkTrue('substitution disclosed in notes', r.costApproach.notes.some(n => n.includes('nearest published percentile')));
}

// ============================================================ Scenario 7
// Market approach NOT applicable when largest role is under the 60% threshold.
console.log('Scenario 7: no dominant role');
{
  const input = {
    client,
    shareholder: { name: 'G', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [
      { roleTitle: 'Accountant', soc: '132011', pctTime: 50 },
      { roleTitle: 'GM', soc: '111021', pctTime: 50 },
    ],
    financials: { netIncomeBeforeOfficerComp: 300000, totalDistributions: 0, totalOfficerWages: 100000 },
    compHistory: [],
  };
  const r = engine.analyze(input, FIX, cfg);
  check('market not applicable', r.marketApproach.applicable, false);
  checkTrue('reason names the threshold', r.marketApproach.reason.includes('60%'));
}

// ============================================================ Scenario 8
// Blank-vs-zero (1.1): a blank/absent input must never be silently treated as 0.
console.log('Scenario 8: blank-vs-zero inputs (INPUT_INCOMPLETE)');
{
  // Case 1: distributions entered, wages and NIBC never entered (absent, not 0).
  // Must NOT fire ZERO_SALARY_WITH_DISTRIBUTIONS (that requires an EXPLICIT 0), and
  // the income approach must be inapplicable (no NIBC) rather than treating null as 0.
  const input1 = {
    client,
    shareholder: { name: 'I', yearsExperience: 5, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: { totalDistributions: 80000 },
    compHistory: [],
  };
  const r1 = engine.analyze(input1, FIX, cfg);
  const ids1 = r1.flags.map(f => f.id);
  checkTrue('INPUT_INCOMPLETE fires (wages + NIBC absent)', ids1.includes('INPUT_INCOMPLETE'));
  checkTrue('ZERO_SALARY_WITH_DISTRIBUTIONS does NOT fire (salary absent, not 0)', !ids1.includes('ZERO_SALARY_WITH_DISTRIBUTIONS'));
  check('incomeApproach not applicable (no NIBC)', r1.incomeApproach.applicable, false);

  // Case 2: NIBC field was cleared (explicit null), wages present. Same outcome: the
  // Number(null) === 0 bug used to produce a false "negative residual" here.
  const input2 = {
    client,
    shareholder: { name: 'J', yearsExperience: 5, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: { totalDistributions: 80000, totalOfficerWages: 55000, netIncomeBeforeOfficerComp: null },
    compHistory: [],
  };
  const r2 = engine.analyze(input2, FIX, cfg);
  const ids2 = r2.flags.map(f => f.id);
  checkTrue('INPUT_INCOMPLETE fires (NIBC cleared)', ids2.includes('INPUT_INCOMPLETE'));
  checkTrue('ZERO_SALARY_WITH_DISTRIBUTIONS does NOT fire (salary present)', !ids2.includes('ZERO_SALARY_WITH_DISTRIBUTIONS'));
  check('incomeApproach not applicable (NIBC cleared)', r2.incomeApproach.applicable, false);

  // Case 3 (explicit 0 wages with distributions still fires ZERO_SALARY_WITH_DISTRIBUTIONS)
  // is already covered by Scenario 5 above — kept green, not duplicated here.
}

// ============================================================ Scenario 9
// Broad/minor/major SOC group warning (1.9). FIX.occupations marks 132011 as
// 'detailed' and 110000 as 'major' (Management Occupations) -- pricing a
// major group averages CEOs with shift supervisors, so it must be disclosed.
console.log('Scenario 9: broad/major SOC group warning');
{
  const detailed = engine.analyze({
    client,
    shareholder: { name: 'K', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: {},
    compHistory: [],
  }, FIX, cfg);
  checkTrue('detailed occupation (132011) is NOT flagged broadGroup', !detailed.costApproach.components[0].broadGroup);
  checkTrue('no broad-group note for a detailed occupation', !detailed.costApproach.notes.some(n => n.includes('occupation group')));

  const broad = engine.analyze({
    client,
    shareholder: { name: 'L', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Executive', soc: '110000', pctTime: 100 }],
    financials: {},
    compHistory: [],
  }, FIX, cfg);
  checkTrue('major-group SOC (110000) IS flagged broadGroup', !!broad.costApproach.components[0].broadGroup);
  checkTrue('broad-group note names the SOC and the level', broad.costApproach.notes.some(n => n.includes('SOC 11-0000') && n.includes('major') && n.includes('not a detailed occupation')));

  // Fixtures (or real data) without an `occupations` array must not crash.
  var fixNoOcc = {};
  Object.keys(FIX).forEach(function (k) { if (k !== 'occupations') fixNoOcc[k] = FIX[k]; });
  var crashed = false;
  try {
    engine.analyze({
      client,
      shareholder: { name: 'M', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
      roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
      financials: {},
      compHistory: [],
    }, fixNoOcc, cfg);
  } catch (e) { crashed = true; }
  checkTrue('fixture without an occupations array does not crash costApproach', !crashed);
}

// ============================================================ Scenario 10
// Watson regression (1.13): rising trend must NEVER fire, even though the
// year-to-year path is noisy (25% -> 45% -> 40%, a V-shape the endpoints alone
// (25 -> 40, a rise) would already call "not drifted", but this exercises the
// regression path explicitly). s1=20,000/d1=60,000 (share 25%); s2=45,000/
// d2=55,000 (share 45%); s3=40,000/d3=60,000 (share 40%).
// CAGR: sC = (40,000/20,000)^(1/2)-1 = sqrt(2)-1 = 41.4% (>> stall threshold
// 2%, so the CAGR pair can't fire); dC = (60,000/60,000)^(1/2)-1 = 0% (< 10%
// growth threshold, also can't fire).
// Regression: x = 2023,2024,2025 -> xbar = 2024; y = 25,45,40 -> ybar = 36.667.
// Sxy = (-1)(25-36.667) + 0(45-36.667) + (1)(40-36.667) = 11.667 + 0 + 3.333 = 15.
// Sxx = 1 + 0 + 1 = 2. slope = 15/2 = 7.5 (RISING). erosion = -7.5 x (2025-2023)
// = -15 (negative -> nowhere near the +15-point erosion threshold) -> must NOT fire.
console.log('Scenario 10: Watson regression — rising trend never fires');
{
  const input = {
    client,
    shareholder: { name: 'N', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: {},
    compHistory: [
      { taxYear: 2023, salaryPaid: 20000, distributionsPaid: 60000 },
      { taxYear: 2024, salaryPaid: 45000, distributionsPaid: 55000 },
      { taxYear: 2025, salaryPaid: 40000, distributionsPaid: 60000 },
    ],
  };
  const r = engine.analyze(input, FIX, cfg);
  checkTrue('rising salary-share trend does NOT fire WATSON_DRIFT', !r.flags.some(f => f.id === 'WATSON_DRIFT'));
}

// ============================================================ Scenario 11
// Multi-shareholder combined capacity (1.11). Same shareholder/component setup
// as Scenario 5/9 (10-12 yrs exp -> 75th, 100% accountant, CdA): cost mid =
// $40/hr x 40 x 52 = 83,200. No taxYear set here -> employerPayrollCost() falls
// back to the latest wage-base year on file (2026, $184,500) with no "not on
// file" note; since 83,200 and 90,000 are both under EVERY wage base in the
// table, the exact OASDI/Medicare/FUTA total is identical regardless of which
// year is used: 83,200x.062=5,158.40 + 83,200x.0145=1,206.40 + 42.00 = 6,406.80.
// Alone against NIBC 150,000 (plus its own payroll cost, 89,606.80) this
// shareholder's OWN capacity test passes (89,606.80 < 150,000 -> no
// EXCEEDS_CAPACITY). But a sibling shareholder ("Partner") already recommends a
// mid of 90,000 (payroll: 90,000x.062=5,580.00 + 90,000x.0145=1,305.00 + 42.00 =
// 6,927.00); combined: 83,200 + 6,406.80 + 90,000 + 6,927.00 = 186,533.80, which
// DOES exceed the 150,000 NIBC -> COMBINED_EXCEEDS_CAPACITY must fire. Absent
// otherShareholders, it must not.
console.log('Scenario 11: multi-shareholder combined capacity');
{
  const baseInput = {
    client,
    shareholder: { name: 'O', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: { netIncomeBeforeOfficerComp: 150000, totalOfficerWages: 83200 },
    compHistory: [],
  };
  const rAlone = engine.analyze(baseInput, FIX, cfg);
  checkTrue('no EXCEEDS_CAPACITY alone (89,606.80 < 150,000)', !rAlone.flags.some(f => f.id === 'EXCEEDS_CAPACITY'));
  checkTrue('no COMBINED_EXCEEDS_CAPACITY when otherShareholders absent', !rAlone.flags.some(f => f.id === 'COMBINED_EXCEEDS_CAPACITY'));

  const withSibling = Object.assign({}, baseInput, {
    otherShareholders: [{ name: 'Partner', recommendedMid: 90000 }],
  });
  const rCombined = engine.analyze(withSibling, FIX, cfg);
  checkTrue('COMBINED_EXCEEDS_CAPACITY fires (186,533.80 > 150,000 NIBC)', rCombined.flags.some(f => f.id === 'COMBINED_EXCEEDS_CAPACITY'));
  checkTrue('COMBINED_EXCEEDS_CAPACITY names the sibling shareholder', (rCombined.flags.find(f => f.id === 'COMBINED_EXCEEDS_CAPACITY') || {}).detail.includes('Partner'));
}

// ============================================================ Scenario 12
// Current-year history cross-check (1.12): a comp-history row for the SAME tax
// year as shareholder.taxYear disagreeing with financials.totalOfficerWages
// (or totalDistributions) must raise HISTORY_MISMATCH. Matching figures must not.
console.log('Scenario 12: history/financials mismatch cross-check');
{
  const mismatched = {
    client,
    shareholder: { name: 'P', yearsExperience: 10, licenses: '', hoursPerWeek: 40, taxYear: '2025' },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: { totalOfficerWages: 60000 },
    compHistory: [{ taxYear: 2025, salaryPaid: 50000 }],
  };
  const rMismatch = engine.analyze(mismatched, FIX, cfg);
  checkTrue('HISTORY_MISMATCH fires (history 50,000 vs financials 60,000)', rMismatch.flags.some(f => f.id === 'HISTORY_MISMATCH'));

  const matched = {
    client,
    shareholder: { name: 'Q', yearsExperience: 10, licenses: '', hoursPerWeek: 40, taxYear: '2025' },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: { totalOfficerWages: 50000 },
    compHistory: [{ taxYear: 2025, salaryPaid: 50000 }],
  };
  const rMatch = engine.analyze(matched, FIX, cfg);
  checkTrue('HISTORY_MISMATCH does NOT fire when figures agree', !rMatch.flags.some(f => f.id === 'HISTORY_MISMATCH'));
}

// ============================================================ Phase 2
// Exact employer payroll cost (employerPayrollCost), tested directly. At a
// high salary the old flat-7.65% simplification overstated employer cost
// (the entire reason this phase exists): 250,000 x .0765 = 19,125.00 flat vs.
// the exact TY-2025 figure below, which correctly caps OASDI at the $176,100
// wage base instead of applying 6.2% to the full salary.
//   OASDI: .062 x min(250,000, 176,100) = .062 x 176,100 = 10,918.20
//   Medicare (uncapped): .0145 x 250,000 = 3,625.00
//   FUTA (net): .006 x min(250,000, 7,000) = .006 x 7,000 = 42.00
//   total = 14,585.20  (vs. the old flat-rate 19,125.00 -- a $4,539.80 overstatement)
console.log('Phase 2: exact employer payroll cost at a high salary');
{
  const pc = engine.employerPayrollCost(250000, 2025, cfg);
  check('OASDI capped at the 2025 wage base = 10,918.20', pc.oasdi, 10918.20, 0.01);
  check('Medicare uncapped = 3,625.00', pc.medicare, 3625.00, 0.01);
  check('FUTA net = 42.00', pc.futa, 42.00, 0.01);
  check('total = 14,585.20 (old flat 7.65% would have said 19,125.00)', pc.total, 14585.20, 0.01);
  check('wage base year used = 2025', pc.wageBaseYear, 2025);
  checkTrue('not flagged as a clamped/out-of-range year', !pc.clampedYear);

  // An out-of-range tax year (e.g. 2010, before the table) clamps to the
  // earliest year on file AND is disclosed as such -- distinct from simply
  // omitting a tax year, which also falls back but is NOT "clamped" (that
  // case is exercised implicitly by every scenario above with no taxYear set).
  const pcOld = engine.employerPayrollCost(100000, 2010, cfg);
  check('out-of-range year clamps to the earliest table year (2015)', pcOld.wageBaseYear, 2015);
  checkTrue('out-of-range year IS flagged as clamped', pcOld.clampedYear);

  const pcNoYear = engine.employerPayrollCost(100000, null, cfg);
  checkTrue('missing tax year falls back silently (NOT flagged as clamped)', !pcNoYear.clampedYear);
}

// ============================================================ Phase 3
// Return on equity (ROE), the true independent-investor test, vs. the weaker
// residual-share screen used only when equity isn't provided. Same NIBC/tested-
// salary/tax-year as Scenario 1: NIBC 150,000, tested 60,000, TY 2025 -> exact
// payroll 4,632.00, residual 85,368.00 (Phase 2 math).
console.log('Phase 3: return on equity vs. residual-share screen');
{
  const baseFinancials = { netIncomeBeforeOfficerComp: 150000 };
  const shareholder = { taxYear: '2025' };

  // Equity 400,000 -> ROE 85,368/400,000 = 21.3% -> plausible (>= 10% required).
  const rHigh = engine.incomeApproach(
    { financials: Object.assign({}, baseFinancials, { shareholderEquity: 400000 }), shareholder },
    60000, cfg
  );
  check('ROE (equity 400k) = 21.3%', rHigh.roe * 100, 21.3, 0.1);
  check('method = return on equity', rHigh.method, 'return on equity');
  check('verdict plausible at 21.3% ROE', rHigh.verdict, 'plausible');

  // Equity 1,200,000 -> ROE 85,368/1,200,000 = 7.1% -> THIN, even though the
  // residual-share screen alone (85,368/150,000 = 56.9%) would have called this
  // "plausible" -- that gap is exactly what Phase 3 closes for capital-intensive
  // businesses the old residual-share screen was blind to.
  const rLow = engine.incomeApproach(
    { financials: Object.assign({}, baseFinancials, { shareholderEquity: 1200000 }), shareholder },
    60000, cfg
  );
  check('ROE (equity 1.2M) = 7.1%', rLow.roe * 100, 7.1, 0.1);
  check('verdict thin at 7.1% ROE (residual-share screen alone would say plausible)', rLow.verdict, 'thin');

  // Equity omitted entirely -> falls back to the residual-share screen, clearly
  // labeled as a weaker form of the test.
  const rNoEquity = engine.incomeApproach({ financials: baseFinancials, shareholder }, 60000, cfg);
  check('method = residual-share screen when equity is absent', rNoEquity.method, 'residual-share screen');
  checkTrue('narrative discloses the weaker-form fallback', rNoEquity.narrative.includes('weaker form'));
  check('residual-share screen verdict plausible (56.9% share)', rNoEquity.verdict, 'plausible');
}

// ============================================================ Phase 4a
// Data loader (js/data/loader.js), tested purely against in-memory fixtures --
// the real generated oews-core.js + per-state files don't exist until Phase 4b's
// --repack runs. Node has no <script> tag injection, so under Node an
// unregistered fips must report a clear error rather than hang; register() is
// exercised directly, exactly as a real state part file would invoke it via
// window.RCT_DATA_REGISTER on load.
console.log('Phase 4a: data loader (fixture-based; real generated files land in Phase 4b)');
{
  function freshLoader() {
    const loaderPath = path.join(__dirname, '..', 'js', 'data', 'loader.js');
    delete require.cache[require.resolve(loaderPath)];
    return require(loaderPath);
  }

  // National and any fips already marked loaded resolve synchronously.
  global.window = {
    RCT_DATA: {
      areas: [['0000000', 'National', 'N', '00'], ['9999999', 'Fixture State', 'S', '99']],
      states: { '99': 'js/data/oews/state-99.js' },
      wages: {}, topcode: {},
    },
  };
  let loader = freshLoader();
  let calledWith;
  loader.ensure('0000000', (err) => { calledWith = err; });
  checkTrue('national area resolves synchronously with no error', calledWith === undefined);

  // An unregistered state fips, under Node (no DOM), cannot inject a <script>
  // tag -- ensure() must report a clear error rather than hang or crash.
  calledWith = 'unset';
  loader.ensure('9999999', (err) => { calledWith = err; });
  checkTrue('unregistered fips under Node reports a clear error (no <script> injection possible)', calledWith instanceof Error);

  // register() -- exactly as a state part file's own window.RCT_DATA_REGISTER(...)
  // call would -- merges wages/topcode into RCT_DATA and marks the fips loaded.
  loader.register('99', { wages: { '9999999': { '132011': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] } }, topcode: {} });
  checkTrue('register() merges the state wage row into RCT_DATA.wages', !!global.window.RCT_DATA.wages['9999999']);
  calledWith = 'unset';
  loader.ensure('9999999', (err) => { calledWith = err; });
  checkTrue('a registered fips now resolves synchronously with no error', calledWith === undefined);

  // Backward compatibility: the OLD single-file bundle (no `states` manifest at
  // all) must resolve EVERY area synchronously, since all wages are already in
  // memory in that shape.
  global.window = { RCT_DATA: { areas: [['1700000', 'Texas', 'S', '48']], wages: { '1700000': {} }, topcode: {} } }; // no `states` key
  loader = freshLoader();
  calledWith = 'unset';
  loader.ensure('1700000', (err) => { calledWith = err; });
  checkTrue('legacy single-file bundle (no states manifest) resolves synchronously', calledWith === undefined);
}

// ============================================================ Phase 4c
// National industry-sector comparable (corroboration only) -- attaches
// alongside the area-based figure without affecting any total. Fixture: one
// sector ("541000 Professional, Scientific, and Technical Services") with a
// 132011 Accountants row at the SAME percentiles as the CdA area fixture (h75
// = $40/hr) so the comparable's mid is directly comparable to the area figure.
// 10 yrs experience -> 75th default; 40 hrs/wk, 52 wks (full-time, no scaling):
// industry comparable mid = $40/hr x 40 x 52 = 83,200 (same basis, unshared).
console.log('Phase 4c: national industry-sector comparable (corroboration only)');
{
  const fixWithIndustry = Object.assign({}, FIX, {
    industry: {
      sectors: [['541000', 'Professional, Scientific, and Technical Services']],
      wages: { '541000': { '132011': [400, 20, 25, 30, 40, 50, 41600, 52000, 62400, 83200, 104000] } },
      topcode: {},
    },
  });
  const withIndustry = engine.analyze({
    client,
    shareholder: { name: 'R', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100, industryCode: '541000' }],
    financials: {},
    compHistory: [],
  }, fixWithIndustry, cfg);
  const comp = withIndustry.costApproach.components[0];
  checkTrue('industryComparable is attached', !!comp.industryComparable);
  check('industryComparable mid = 83,200 (same percentile/hours/weeks basis, unshared)', comp.industryComparable && comp.industryComparable.mid, 83200);
  check('industryComparable percentile = 75th (matches the component)', comp.industryComparable && comp.industryComparable.percentile, 75);
  checkTrue('corroboration note names the sector and SOC', withIndustry.costApproach.notes.some(n => n.includes('Professional, Scientific, and Technical Services') && n.includes('13-2011') && n.includes('corroboration')));

  // Same input, WITHOUT industryCode set -- totals must be IDENTICAL, and no
  // industryComparable/corroboration note should appear.
  const withoutIndustry = engine.analyze({
    client,
    shareholder: { name: 'R', yearsExperience: 10, licenses: '', hoursPerWeek: 40 },
    roleComponents: [{ roleTitle: 'Accountant', soc: '132011', pctTime: 100 }],
    financials: {},
    compHistory: [],
  }, fixWithIndustry, cfg);
  check('totals unaffected by industryCode (low)', withIndustry.costApproach.low, withoutIndustry.costApproach.low);
  check('totals unaffected by industryCode (mid)', withIndustry.costApproach.mid, withoutIndustry.costApproach.mid);
  check('totals unaffected by industryCode (high)', withIndustry.costApproach.high, withoutIndustry.costApproach.high);
  checkTrue('no industryComparable when industryCode is unset', !withoutIndustry.costApproach.components[0].industryComparable);
}

// ============================================================ Integration
// Run against the REAL generated data file: internal consistency only.
console.log('Integration: real May-release OEWS data (core + per-state files via the loader)');
{
  global.window = {};
  const loader = require(path.join(__dirname, '..', 'js', 'data', 'loader.js'));
  global.window.RCT_DATA_REGISTER = loader.register;
  require(path.join(__dirname, '..', 'js', 'data', 'oews-core.js'));
  const DATA = global.window.RCT_DATA;
  checkTrue('release label present', /May \d{4}/.test(DATA.release));
  checkTrue('has Coeur d\'Alene in the area index', DATA.areas.some(a => a[1].includes("Coeur d'Alene")));
  checkTrue('has Spokane MSA in the area index', DATA.areas.some(a => a[1].includes('Spokane-Spokane Valley')));
  checkTrue('has all-state coverage (>= 50 S areas)', DATA.areas.filter(a => a[2] === 'S').length >= 50);
  checkTrue('core carries a per-state manifest for >= 50 states/territories', !!DATA.states && Object.keys(DATA.states).length >= 50);
  checkTrue('core does NOT carry Idaho wage rows before its state file loads', !DATA.wages['1600000']);

  // Coeur d'Alene lookup before loading Idaho's part file: only national wages
  // are in memory, so the lookup must fall back to national (or be absent),
  // never silently resolve at the (not-yet-loaded) requested area.
  let lkBefore = null;
  try { lkBefore = engine.lookupWage(DATA, '0017660', '132011'); } catch (e) { lkBefore = null; }
  checkTrue('Coeur d\'Alene lookup before loading Idaho falls back to national (or is absent)', !lkBefore || lkBefore.areaUsed === '0000000');

  require(path.join(__dirname, '..', 'js', 'data', 'oews', 'state-16.js'));
  checkTrue('Idaho wage rows are present after loading state-16.js', !!DATA.wages['1600000']);
  const lkAfter = engine.lookupWage(DATA, '0017660', '132011');
  checkTrue('Coeur d\'Alene lookup resolves at the requested area once Idaho is loaded', !!lkAfter && lkAfter.areaUsed === '0017660' && !lkAfter.fellBack);

  const input = {
    client: { name: 'Real Co', areaCode: '0017660' },
    shareholder: { name: 'H', yearsExperience: 12, licenses: 'CPA', hoursPerWeek: 45 },
    roleComponents: [
      { roleTitle: 'Accounting', soc: '132011', pctTime: 55 },
      { roleTitle: 'General management', soc: '111021', pctTime: 30 },
      { roleTitle: 'Office administration', soc: '434051', pctTime: 15 },
    ],
    financials: { netIncomeBeforeOfficerComp: 250000, totalDistributions: 120000, totalOfficerWages: 80000 },
    compHistory: [],
  };
  const r = engine.analyze(input, DATA, cfg);
  checkTrue('low < mid < high', r.range.low < r.range.mid && r.range.mid < r.range.high);
  checkTrue('mid in a sane band ($60k–$250k)', r.range.mid > 60000 && r.range.mid < 250000);
  checkTrue('every component traces to an area', r.costApproach.components.every(c => c.missing || c.areaUsedName));
  checkTrue('vintage propagated to result', r.oewsRelease === DATA.release);
  console.log(`  info: real-data recommendation for the test CPA scenario: $${r.range.low.toLocaleString()} / $${r.range.mid.toLocaleString()} / $${r.range.high.toLocaleString()} (${r.oewsRelease})`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
