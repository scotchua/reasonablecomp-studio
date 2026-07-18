'use strict';

const memo = require('../js/renderers/memo.js');
const cfg = require('../js/data/config.js');

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { console.log('  ok   ' + name); passed++; }
  else { console.error('  FAIL ' + name); failed++; }
}

const model = {
  draft: false,
  firm: 'Example Accounting Firm',
  preparer: 'Reviewer, CPA',
  client: { id: 'client-1', name: 'Sample <Advisory> Inc.', entityType: 'S-Corp', areaCode: '0000000' },
  shareholder: { name: 'Jordan Sample', compHistory: [] },
  year: '2025',
  yearRec: {
    hoursPerWeek: 40,
    duties: 'Advises clients and manages the business.',
    revenueSources: { shareholderServicesPct: 80, employeeServicesPct: 15, capitalEquipmentPct: 5, notes: 'Supported by engagement and asset records.' },
    financials: { totalOfficerWages: 60000 }, flagResponses: {}, evidence: {},
    approval: { approvedBy: 'Reviewer, CPA', approvedDate: '2026-01-15', status: 'Final', conclusionNotes: 'The reconciled amount reflects the actual mix of duties.' },
  },
  readiness: { score: 94 },
  workpaperFingerprint: 'a'.repeat(64),
  occTitle: () => 'Accountants and Auditors',
  areaName: () => 'National',
  data: { generatedAt: '2026-05-15T10:00:00Z' },
  cfg,
  analysis: {
    oewsRelease: 'May 2025', generatedAt: '2026-07-10T10:00:00Z', analysisFingerprint: 'b'.repeat(64),
    range: { low: 70000, mid: 90000, high: 115000 }, flags: [],
    trending: { factor: 1.04, vintageQuarter: '2025Q2', targetQuarter: '2026Q2', extrapolated: false, series: 'CIU2020000000000I', note: null },
    costApproach: { hoursPerWeek: 40, totalPctTime: 100, low: 70000, mid: 90000, high: 115000, notes: [], components: [{ roleTitle: 'Advisor', soc: '132011', socDisplay: '13-2011', areaUsedName: 'National', fellBack: false, percentile: 50, percentileReason: 'Experience tier', pctTime: 100, low: 70000, mid: 90000, high: 115000, midDetail: { basis: 'May 2025 OEWS · National · SOC 13-2011', percentile: 50 } }] },
    marketApproach: { applicable: true, soc: '132011', socDisplay: '13-2011', pctTime: 100, areaUsedName: 'National', low: 70000, mid: 90000, high: 115000 },
    incomeApproach: {
      applicable: true, proposedSalary: 60000, salaryBasis: 'planned officer wages as entered',
      employerPayrollTax: 4632, residual: 85368, residualShare: 0.5691,
      method: 'return on equity', equity: 400000, roe: 0.2134,
      narrative: 'After the tested compensation and employer payroll cost, the company earns a 21.3% return on beginning shareholder equity — a return an independent investor could accept. The independent investor test does not contradict the market-based figure.',
      payrollTaxNote: 'Employer payroll cost computed as 6.2% OASDI up to the $176,100 2025 Social Security wage base, 1.45% Medicare (uncapped), and 0.6% net FUTA on the first $7,000. State unemployment tax and workers’ compensation premiums are excluded (understates employer cost slightly).',
    },
    reconciliation: ['Cost and market approaches corroborate the recommendation.'],
  },
};

console.log('Memo: audit package content and escaping');
const html = memo.build(model);
check('source-of-receipts section included', html.includes("Source of the corporation's gross receipts"));
check('source manifest included', html.includes('Source manifest and reproducibility'));
check('workpaper fingerprint included', html.includes('a'.repeat(64)));
check('analysis fingerprint included', html.includes('b'.repeat(64)));
check('client HTML is escaped', html.includes('Sample &lt;Advisory&gt; Inc.') && !html.includes('Sample <Advisory> Inc.'));
check('final record is marked FINAL', html.includes('Record status</td><td><strong>FINAL'));

// 5.1 — planned-wages-vs-range summary block. totalOfficerWages (60,000) is
// below range.low (70,000), so this must render the "below" branch.
check('planned-wages-vs-range summary block included', html.includes('Planned wages vs. this analysis'));
check('summary block reports the below-range shortfall and points to section 6', html.includes('below the reconciled range of $70,000') && html.includes('BELOW_RANGE flag response in section 6'));

// 5.2 — OEWS limitations disclosure, rendered verbatim.
check('OEWS limitations paragraph included', html.includes('OEWS data limitations') && html.includes('straight-time wages') && html.includes('conservative (low) measure'));

// 5.3 — vintage/tax-year trending sentence in the section-2 intro.
check('ECI trending sentence included in section 2', html.includes('Wages were trended from the May 2025') && html.includes('factor 1.0400'));

// 5.4 — income section names the tested salary, its basis, and the ROE method.
check('income section names the tested salary and its basis', html.includes('Tested at') && html.includes('planned officer wages as entered'));
check('income section shows the ROE method and benchmark', html.includes('return on beginning shareholder equity') && html.includes('21.3%') && html.includes('10% independent-investor benchmark'));

model.draft = true;
const draft = memo.build(model);
check('draft record has visible watermark', draft.includes('DRAFT - OPEN FINALIZATION ITEMS REMAIN'));

// Residual-share-screen fallback narrative also renders correctly (equity
// absent). Shallow-clone model/analysis (functions like occTitle/areaName
// don't survive JSON round-tripping) and only replace incomeApproach.
const fallbackModel = Object.assign({}, model, {
  analysis: Object.assign({}, model.analysis, {
    incomeApproach: {
      applicable: true, proposedSalary: 60000, salaryBasis: 'planned officer wages as entered',
      employerPayrollTax: 4632, residual: 85368, residualShare: 0.5691,
      method: 'residual-share screen', equity: null, roe: null,
      narrative: 'Book equity was not provided, so only a residual-share screen was performed (residual as a share of pre-compensation earnings). This is a weaker form of the independent investor test; enter beginning shareholder equity for the full return-on-equity analysis. After the proposed salary and employer payroll cost, the company retains a residual return an unrelated investor could find acceptable. The independent investor test does not contradict the market-based figure.',
      payrollTaxNote: model.analysis.incomeApproach.payrollTaxNote,
    },
  }),
});
const fallbackHtml = memo.build(fallbackModel);
check('residual-share-screen fallback method renders with its weaker-form disclosure', fallbackHtml.includes('residual-share screen') && fallbackHtml.includes('weaker form of the independent investor test'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
