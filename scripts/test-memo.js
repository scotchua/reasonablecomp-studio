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
    financials: {}, flagResponses: {}, evidence: {},
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
    costApproach: { hoursPerWeek: 40, totalPctTime: 100, low: 70000, mid: 90000, high: 115000, notes: [], components: [{ roleTitle: 'Advisor', soc: '132011', socDisplay: '13-2011', areaUsedName: 'National', fellBack: false, percentile: 50, percentileReason: 'Experience tier', pctTime: 100, low: 70000, mid: 90000, high: 115000, midDetail: { basis: 'May 2025 OEWS · National · SOC 13-2011', percentile: 50 } }] },
    marketApproach: { applicable: true, soc: '132011', socDisplay: '13-2011', pctTime: 100, areaUsedName: 'National', low: 70000, mid: 90000, high: 115000 },
    incomeApproach: { applicable: false, reason: 'Financial input not provided.' },
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
model.draft = true;
const draft = memo.build(model);
check('draft record has visible watermark', draft.includes('DRAFT - OPEN FINALIZATION ITEMS REMAIN'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
