/*
 * config.js — Every judgment threshold, tier rule, and citation in one place.
 * Nothing in the engine hard-codes a number that appears in a memo; if a figure
 * drives a recommendation or a red flag, it lives here where it can be seen,
 * defended, and changed deliberately.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RCT_CONFIG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {

    // ---- Experience → wage percentile tiers (Cost / Multiple Components approach) ----
    // Default percentile for each role component, from the shareholder's profile
    // (experience only — licensure is a PER-COMPONENT floor applied separately,
    // see licenseApplies below, not part of this shared default). Any component
    // can be overridden with a documented reason; the override and reason are
    // reproduced verbatim in the memo. The 90th percentile is never a default —
    // it is available only as a per-component override (senior owner-operator
    // with management scope for that component).
    percentiles: [10, 25, 50, 75, 90],
    experienceTiers: [
      { maxYears: 3,        percentile: 25, label: 'Less than 3 years relevant experience' },
      { maxYears: 8,        percentile: 50, label: '3–8 years relevant experience' },
      { maxYears: Infinity, percentile: 75, label: 'More than 8 years relevant experience' },
    ],
    // Holding a professional license/credential floors a role component at this
    // percentile — but ONLY the component(s) marked licenseApplies:true, never
    // every "hat" a shareholder wears (a driver's license has no bearing on a
    // bookkeeping component performed by the same person).
    licensedMinimumPercentile: 75,

    // ---- Market approach ----
    // A single SOC code "plainly dominates" the role at or above this share of time;
    // below it the market approach is reported as not separately applicable.
    dominantShareThreshold: 0.60,

    // ---- Full-time equivalency ----
    fullTimeHoursPerWeek: 40,
    weeksPerYear: 52,
    // Above this many hours/week the scale-up is capped and a note is added instead —
    // extreme hour claims should be documented, not silently monetized.
    maxHoursScale: 60,

    // ---- Income approach (independent investor test) ----
    // Exact employer payroll cost on the proposed salary: 6.2% OASDI up to the
    // Social Security wage base for the tax year, 1.45% Medicare (uncapped — the
    // employer side has no Additional Medicare Tax), and 0.6% net FUTA (6.0%
    // gross less the standard 5.4% full state credit) on the first $7,000.
    // State unemployment tax and workers' compensation premiums are excluded and
    // disclosed in the memo (they vary by state/rating and would need per-client
    // input) — this understates employer cost slightly.
    payrollTax: {
      oasdiRate: 0.062,
      medicareRate: 0.0145,
      futaNetRate: 0.006,
      futaWageBase: 7000,
      // SSA OASDI wage bases by year (2026 announced by SSA in October 2025).
      // A tax year outside this table clamps to the nearest year on file.
      socialSecurityWageBase: {
        2015: 118500, 2016: 118500, 2017: 127200, 2018: 128400, 2019: 132900,
        2020: 137700, 2021: 142800, 2022: 147000, 2023: 160200, 2024: 168600,
        2025: 176100, 2026: 184500,
      },
    },
    // Residual return below this share of net income before officer comp raises
    // the "thin residual" plausibility flag -- used ONLY as the weaker residual-
    // share screen when beginning shareholder equity was not provided (Phase 3).
    thinResidualShare: 0.10,
    // Return on beginning shareholder equity, the true independent-investor test:
    // below `required` is a "thin" plausibility flag (not a veto). 10% is a
    // defensible floor of what a passive investor demands over the long run;
    // `strong` is a reference point for a comfortably-above-required return, not
    // itself a distinct verdict tier.
    investorReturn: { required: 0.10, strong: 0.20 },

    // ---- ECI wage trending (4.4) ----
    // Trends OEWS wages from their May survey reference date to the tax
    // year's mid-year using the BLS Employment Cost Index. Disabling this
    // reverts to a flat factor of 1 (no trending) and surfaces a staleness
    // note whenever the tax year and OEWS vintage genuinely differ.
    wageTrending: { enabled: true },

    // ---- Red-flag thresholds ----
    flags: {
      // Distributions-to-salary ratio, current year and trailing 3-year aggregate.
      distributionsToSalaryRatio: 2.0,
      // Watson-pattern drift: over the comp history window, salary growing at or
      // below salaryStallCagr while distributions grow at or above distributionGrowthCagr,
      // OR salary's share of (salary + distributions) eroding by compShareErosionPoints.
      watson: {
        minYears: 3,
        salaryStallCagr: 0.02,
        distributionGrowthCagr: 0.10,
        compShareErosionPoints: 15,
      },
      // "Zero or near-zero salary with more than de minimis services."
      nearZeroSalary: 10000,
      deMinimisHoursPerWeek: 10,
      // Planned wages vs. the computed reasonable-compensation range: shortfalls
      // deeper than this share of the range's low end are flagged high (else medium).
      belowRangeHighShortfall: 0.20,
      // Planned wages above this multiple of the range's high end are flagged low
      // (overpaying employment tax, not an S-corp reclassification risk).
      aboveRangeRatio: 1.25,
    },

    // ---- Annual refresh staleness (dashboard) ----
    analysisStaleMonths: 11,

    // ---- Audit-workpaper completion gate (documentation, not a tax-law threshold) ----
    auditRequiredEvidence: [
      'jobDescription',
      'timeSupport',
      'financialStatements',
      'payrollRecords',
      'distributionLedger',
      'compensationResolution',
    ],
    auditReadinessWeights: {
      area: 6,
      profile: 10,
      roles: 18,
      overrides: 8,
      revenue: 16,
      analysis: 16,
      flags: 12,
      approval: 10,
      evidence: 6,
    },

    evidenceLabels: {
      jobDescription: 'Contemporaneous job description and duty narrative',
      timeSupport: 'Calendar, time study, or other hours support',
      resumeCredentials: 'Resume, licenses, and credentials',
      financialStatements: 'Financial statements and gross-receipts support',
      payrollRecords: 'Payroll register, Forms 941, and Form W-2',
      distributionLedger: 'Distribution, loan, and shareholder account ledger',
      employeeComp: 'Non-shareholder employee compensation records',
      capitalAssets: 'Asset list and capital/equipment contribution support',
      compensationResolution: 'Compensation agreement or board/shareholder minutes',
    },

    // ---- Citations reproduced in every memo (name/holding only, no quoted text) ----
    citations: [
      { cite: 'IRC §162(a)(1)', note: 'Deduction allowed for a reasonable allowance for salaries or other compensation for personal services actually rendered.' },
      { cite: 'Treas. Reg. §1.162-7(b)(3)', note: 'Reasonable compensation is the amount that would ordinarily be paid for like services by like enterprises under like circumstances.' },
      { cite: 'IRS Fact Sheet FS-2008-25', note: 'Wage compensation for S corporation officers: shareholder-employees performing services must receive reasonable wages before non-wage distributions.' },
      { cite: 'IRS Reasonable Compensation Job Aid for IRS Valuation Professionals', note: 'Describes the cost (multiple components), market, and income approaches applied in this analysis.' },
      { cite: 'Watson v. Commissioner, 668 F.3d 1008 (8th Cir. 2012)', note: 'Distributions reclassified as wages where salary was low relative to substantial services; comparable-wage evidence controlled.' },
      { cite: 'Joseph M. Grey, Public Accountant, P.C. v. Commissioner, 119 T.C. 121 (2002)', note: 'Zero salary while taking distributions reclassified as wages.' },
      { cite: 'Sean McAlary Ltd., Inc. v. Commissioner, T.C. Summ. Op. 2013-62', note: 'Court accepted a third-party valuation methodology using occupational wage data to set reasonable compensation.' },
      { cite: 'Nu-Look Design, Inc. v. Commissioner, 356 F.3d 290 (3d Cir. 2004)', note: 'Zero-salary pattern rejected; payments to controlling shareholder for services treated as wages.' },
    ],

    sourceManifest: [
      {
        publisher: 'Internal Revenue Service',
        title: 'S corporation compensation and medical insurance issues',
        url: 'https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues',
        use: 'Primary IRS guidance for the source-of-gross-receipts analysis and reasonable-compensation factors.',
      },
      {
        publisher: 'Internal Revenue Service',
        title: 'Instructions for Form 1120-S',
        url: 'https://www.irs.gov/instructions/i1120s',
        use: 'Primary form instructions on officer payments and reasonable compensation.',
      },
      {
        publisher: 'Internal Revenue Service',
        title: 'Reasonable Compensation Job Aid for IRS Valuation Professionals',
        url: 'https://www.irs.gov/pub/irs-lbi/Reasonable%20Compensation%20Job%20Aid%20for%20IRS%20Valuation%20Professionals.pdf',
        use: 'IRS reference material for valuation approaches; not an official IRS position or legal authority.',
      },
      {
        publisher: 'U.S. Bureau of Labor Statistics',
        title: 'Occupational Employment and Wage Statistics',
        url: 'https://www.bls.gov/oes/',
        use: 'Federal occupational wage evidence by occupation and geography.',
      },
      {
        publisher: 'U.S. Bureau of Labor Statistics',
        title: 'OEWS methodology and documentation',
        url: 'https://www.bls.gov/oes/oes_doc.htm',
        use: 'Survey methodology, reliability, scope, and release documentation.',
      },
    ],

    disclaimer:
      'This analysis applies IRS-published reasonable compensation methodology (Reasonable Compensation ' +
      'Job Aid for IRS Valuation Professionals) and BLS Occupational Employment and Wage Statistics (OEWS) ' +
      'wage data. Final determination reflects the preparer’s professional judgment applied to this ' +
      'client’s specific facts and circumstances.',

    educationLevels: [
      'High school / GED',
      'Some college',
      'Associate degree',
      'Bachelor’s degree',
      'Master’s degree',
      'Doctorate / professional degree',
    ],
  };
});
