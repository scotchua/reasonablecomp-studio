# ReasonableComp Studio — Improvement Implementation Plan

**Status: approved for implementation. All design decisions in this document are final — do not re-litigate them. Implement in the phase order given, one commit per phase, running all three test scripts before every commit.**

This plan was produced by a full review of the codebase (engine, config, data pipeline, UI, memo renderer, tests) with the suspicious math paths verified by executing the engine. It addresses three problem classes: weak information sources, bad math, and inputs that make false assumptions easy.

---

## 0. Ground rules for the implementing session

- **You cannot reach BLS from this environment.** `download.bls.gov` and `api.bls.gov` are both blocked by the proxy (verified: CONNECT 403). Never attempt to download BLS data here, and never fabricate wage, ECI, or area-code values. All data regeneration happens on the user's machine via `scripts/refresh-oews.js`; your job is to make that script produce the new outputs and to make the app consume them. Code must be fully testable against hand-built fixtures (the existing pattern in `scripts/test-engine.js`).
- **Preserve the deployment model**: plain `<script>` tags, no build step, no external libraries, works from `file://`. `fetch()` does NOT work under `file://` — dynamic `<script>` injection does; that is why the lazy loader below uses script injection.
- **Match the codebase style**: ES5 (`var`, IIFE + UMD factory pattern), pure engine functions with no DOM access, every judgment number in `config.js`, every simplification disclosed in the memo.
- **Tests**: extend `scripts/test-engine.js`, `test-audit.js`, `test-memo.js` in their existing style (`check`/`checkTrue`, hand-worked arithmetic in comments). Some existing expectations change — each such change is listed explicitly in this plan. When you finish, update the "Current suite: 66 checks" line in `README.md` with the real new count.
- **Don't touch**: `LS_KEY`, the `.cmd` launcher, the white-label firm/preparer mechanism, `css/styles.css` beyond what new UI elements need.
- **Version stamps**: bump `methodology: 'RCT-2.0'` → `'RCT-2.1'` everywhere it appears (`js/ui/app.js` ×3), and export payload `version: 2` → `3`. Import must continue accepting version 2 files (all new fields have defaults via `yearRec()` patching).
- **Commit messages**: use the per-phase messages given at the end of each phase section.

### New shared helper (used throughout Phase 1)

Add to `comp-engine.js`, exported:

```js
// Blank-vs-zero: '' / null / undefined / non-numeric -> null; otherwise the number.
// A blank input is ABSENT, not zero. Nothing downstream may treat null as 0.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
```

Background (verified by running the current engine): `Number(null) === 0`, so a cleared "Net income before officer comp" field currently produces a false high-severity "negative residual" verdict, and distributions with a *blank* (never entered) wage field currently fire the high-severity `ZERO_SALARY_WITH_DISTRIBUTIONS` flag. Those are the bugs this helper kills.

---

## Phase 1 — Engine correctness and false-assumption fixes

### 1.1 Blank ≠ zero everywhere

In `computeFlags` and `incomeApproach` (`js/engine/comp-engine.js`), replace every `Number(f.x)` / `isFinite(...)` gate with `num(f.x)` and explicit null checks:

- `incomeApproach`: `applicable` only when `num(f.netIncomeBeforeOfficerComp) !== null`. A null NIBC → `reason: 'Net income before officer compensation not provided.'` (existing string, now actually reachable for cleared fields).
- `ZERO_SALARY_WITH_DISTRIBUTIONS`: fires only when `salary === 0` **explicitly** (`num(...) === 0`), not when null.
- `NEAR_ZERO_SALARY`: requires `salary !== null`.
- `BELOW_STAFF`, ratios: all operands non-null.
- New **low-severity** flag when material inputs are missing but others are present:

```
id: 'INPUT_INCOMPLETE', severity: 'low',
title: 'Analysis inputs incomplete',
detail: 'The following inputs were not provided, so the checks that depend on them
were skipped: <list, e.g. "officer wages paid", "net income before officer
compensation">. Enter them (or enter 0 if truly zero) and re-run.'
```
  Fire it when `dist !== null && dist > 0 && salary === null`, or `nibc === null`.

**Tests** (new scenario in `test-engine.js`): financials `{ totalDistributions: 80000 }` with wages and NIBC absent → flags contain `INPUT_INCOMPLETE`, do NOT contain `ZERO_SALARY_WITH_DISTRIBUTIONS`; `incomeApproach.applicable === false`. Second case: `netIncomeBeforeOfficerComp: null` (cleared field) → same. Third: explicit `totalOfficerWages: 0` with distributions → `ZERO_SALARY_WITH_DISTRIBUTIONS` still fires (Scenario 5 already covers this; keep it green).

### 1.2 The independent investor test must test the client's actual salary

Today `analyze()` computes `proposed = input.proposedSalary || cost.mid`, and `buildEngineInput()` never passes `proposedSalary` — so the income approach always evaluates the tool's own recommendation (circular), and the memo's "at the proposed compensation of $X" misleads.

In `analyze()`:

```js
var salaryNum = num((input.financials || {}).totalOfficerWages);
var tested = (salaryNum !== null && salaryNum > 0) ? salaryNum : Math.round(cost.mid);
var testedBasis = (salaryNum !== null && salaryNum > 0)
  ? 'planned officer wages as entered'
  : 'the recommended mid figure (no planned officer wages were entered)';
var income = incomeApproach(input, tested, cfg);
income.salaryBasis = testedBasis;
```

Remove the dead `input.proposedSalary` path. Memo section 4 (Phase 5.4) and the analysis panel in `app.js` must state the basis: "At the tested compensation of $X (planned officer wages as entered), …".

**Test changes**: Scenario 1 has `totalOfficerWages: 60000`, so the income approach now tests 60,000, not 85,620. New hand math with the Phase 2 payroll function (values in §2 below): residual = 150,000 − 60,000 − 4,632 = **85,368**, share 0.569 → plausible. Update the two Scenario-1 income checks and add `check('income tested planned wages', r.incomeApproach.proposedSalary, 60000)`.

### 1.3 New flag: actual wages below (or far above) the computed range

The single most important report finding is currently absent. In `computeFlags` (which already receives `range`):

```js
// salary = num(f.totalOfficerWages)
if (salary !== null && salary > 0 && range && range.low > 0 && salary < range.low) {
  var shortfallPct = (range.low - salary) / range.low;
  flags.push({ id: 'BELOW_RANGE', severity: shortfallPct > cfg.flags.belowRangeHighShortfall ? 'high' : 'medium',
    title: 'Planned wages below the reasonable-compensation range',
    detail: 'Planned officer wages ($X) fall $Y (Z%) below the low end of the
    reconciled range ($LOW). This is the primary reclassification exposure this
    workpaper exists to address — document the justification or adjust the wage.' });
}
if (salary !== null && range && range.high > 0 && salary > range.high * cfg.flags.aboveRangeRatio) {
  flags.push({ id: 'ABOVE_RANGE', severity: 'low',
    title: 'Planned wages well above the reasonable-compensation range',
    detail: 'Planned wages exceed the high end of the range by more than ' +
    Math.round((cfg.flags.aboveRangeRatio - 1) * 100) + '% — not an IRS reclassification
    risk for an S corporation, but it overpays employment tax; confirm intent.' });
}
```

Config additions (`flags` object): `belowRangeHighShortfall: 0.20`, `aboveRangeRatio: 1.25`.

**Test changes**: Scenario 1 (wages 60,000 < low 66,400, shortfall 9.6%) now gets a **medium** `BELOW_RANGE`; Scenario 4 (30,000 vs low 62,400, 51.9%) gets **high**; Scenario 5 must NOT get it (salary 0 — the zero-salary flags own that pattern); Scenario 2 stays clean (26,000 > 20,800). Update `checkTrue('no flags on clean part-timer', ...)` — it remains true; add explicit BELOW_RANGE assertions to Scenarios 1 and 4.

### 1.4 Capacity flag must include employer payroll cost

`EXCEEDS_CAPACITY` currently compares `range.mid > nibc`. Change to `range.mid + employerPayrollCost(range.mid, taxYear, cfg).total > nibc` (function from Phase 2). Update the flag detail to mention the payroll cost. Scenario 5 still fires (83,200 + cost > 40,000). No existing check text changes.

### 1.5 Hours and weeks: stop silently monetizing assumptions

Three changes in `costApproach` / `annualAtPercentile` plus one new input:

1. **Blank/zero hours no longer defaults to 40.** `var hours = num(sh.hoursPerWeek);` — if `hours === null || hours <= 0`, throw is wrong (analysis should still run for partial data); instead use 40 **and push a prominent note**: `'Hours per week not entered — full-time (40) assumed. Enter actual hours; this assumption is disclosed in the memo.'` AND make hours a **blocking readiness item** (Phase 1.10) so a FINAL memo can never carry the assumption.
2. **Hours above 40 are monetized only when corroborated.** New year-record boolean `hoursCorroborated` (UI checkbox: *"Hours above 40/week are supported by retained time records (calendar, time study)"*). Engine: `effHours = hours <= ft ? hours : (input.shareholder.hoursCorroborated ? Math.min(hours, cfg.maxHoursScale) : ft)`, with a note when clamped to 40 for lack of corroboration: `'Claimed N hrs/week not corroborated by time records — wage scaling capped at 40; check the corroboration box after retaining support.'` Keep the existing 60-hour cap note when corroborated.
3. **Annual-only occupations never scale above 1.0×.** In `annualAtPercentile`, the annual branch becomes `annual * (Math.min(effHours, ft) / ft) * weeksFactor`. Salaried comparables at a given percentile already reflect long weeks; scaling a salary to 60/40 = 1.5× was indefensible. Add a note the first time this bites: `'SOC XX-XXXX publishes annual-only wages; annual figures are not scaled above full-time.'`
4. **New input `weeksWorkedPerYear`** (year record, default 52, integer 1–52; UI next to seasonality). Engine: hourly basis uses `hourly × effHours × weeksWorked`; annual basis multiplies by `weeksWorked / 52`. Basis strings must show the actual weeks (e.g. `'hourly $40.00 × 40 hrs/wk × 26 wks'`). This turns the free-text seasonality note into math.

`yearRec()` in `app.js` must patch `weeksWorkedPerYear: 52` and `hoursCorroborated: false` onto existing records. `buildEngineInput` passes both through on `shareholder`.

**Test changes**: Scenario 3 (80 hrs → 60 cap → 156,000) must now set `hoursCorroborated: true` to keep its expectations; add a sibling check with the flag false → mid = 50 × 40 × 52 = **104,000** and the clamp note present. New seasonal test: 40 hrs, 26 weeks, 132011 CdA 75th → 40 × 40 × 26 = **41,600** mid; annual-only 434051 at 26 weeks → 45,000 × 1.0 × 26/52 = **22,500**.

### 1.6 Kill the Coeur d'Alene default area

`addClient()` (`app.js:217`) hard-codes `areaCode: '0017660'` — a Texas client silently gets Idaho metro wages. Change to `areaCode: ''`. Guard `lookupWage` callers: `runAnalysis` should toast and abort when `!c.areaCode`; the client view should show the area select with a `(select the principal work area)` placeholder option. Add blocking readiness item (Phase 1.10). The dashboard already prints "no area set" for missing areas.

### 1.7 License floor requires per-component relevance

Verified: any text in the licenses field ("Class B driver license") floors every component at the 75th percentile. Fix:

- `defaultPercentile(shareholder, cfg)` computes the tier from **experience only** (delete the license floor from it).
- New per-component boolean `licenseApplies` (roles-table checkbox column, header "Lic?", title-attr *"The professional license/credential applies to this hat"*).
- In `costApproach` (and `marketApproach` for the dominant component): after resolving the default tier, apply the floor per component:
  ```js
  if (rc.licenseApplies && String(sh.licenses || '').trim() && compPercentile < cfg.licensedMinimumPercentile && !rc.percentileOverride) {
    compPercentile = cfg.licensedMinimumPercentile;
    compReason = 'Licensed/certified (' + sh.licenses + ') applied to this component — floored at 75th percentile';
  }
  ```
- Migration: `yearRec()` leaves old components without the field → `licenseApplies` falsy → floor no longer applies until the preparer checks it. That is intended (fail toward the lower percentile); the input-fingerprint change already forces a re-run.

**Test changes**: Scenario 1's shareholder has 10 years experience → 75th by experience alone, so its numbers are unchanged; set `licenseApplies: true` on the accountant component anyway and assert the reason string mentions the license for that component but NOT for the GM component. New test: 1 year experience + `licenses: 'Class B driver license'` + `licenseApplies: false` → percentile 25 (this is the regression test for the verified bug); same with `licenseApplies: true` → 75.

### 1.8 Optional per-component experience

One experience number currently prices every hat (20 dentist-years → 75th-percentile bookkeeping). Add optional `yearsExperienceOverride` per role component (small numeric input in the roles table, blank = inherit). Engine: compute each component's tier from `num(rc.yearsExperienceOverride) !== null ? that : shareholder years`. The percentile-override mechanism stays as the final word. Memo `percentileReason` must show which years drove the tier when overridden (e.g. `'2 years relevant experience (component-specific)'`).

**Test**: shareholder 20 yrs + component override 2 yrs, no license → that component prices at 25th, others at 75th; hand math on a 2-component blend.

### 1.9 Warn when a non-detailed SOC group is priced

The picker allows broad/minor/major groups; pricing "Management Occupations" averages CEOs with shift supervisors. In `costApproach`, build `var occLevel = {}; (data.occupations || []).forEach(...)` (fixtures without `occupations` must not crash) and when a component's level exists and isn't `'detailed'`, set `comp.broadGroup = true` and push a note: `'SOC XX-XXXX is a <level> occupation group, not a detailed occupation — the wage averages dissimilar jobs; select a detailed occupation unless the group is genuinely representative.'` Memo prints the note via the existing notes loop; the analysis table should mark the SOC cell (e.g. `' (group)'`).

**Test**: add `occupations: [['132011','Accountants and Auditors','detailed',''], ['110000','Management Occupations','major','']]` to `FIX`, plus a wage row for `110000`, and assert the note fires for it and not for 132011.

### 1.10 Readiness gate additions

`audit-readiness.js` — `evaluate(yr, analysis, data, cfg, currentInputFingerprint, client)` gains a sixth parameter (update both call sites in `app.js` and all calls in `test-audit.js`):

- New blocking item `{ id: 'area', label: 'Principal OEWS work area selected', blocking: true, complete: !!(client && client.areaCode) }` — presence check only; validity is the engine's job.
- Extend the `profile` item: `complete` additionally requires `Number(yr.hoursPerWeek) > 0` (it already checks this — verify) **and** `(Number(yr.hoursPerWeek) <= 40 || !!yr.hoursCorroborated)`.
- Weights: adjust `auditReadinessWeights` to `{ area: 6, profile: 10, roles: 18, overrides: 8, revenue: 16, analysis: 16, flags: 12, approval: 10, evidence: 6 }` (total stays 100 — the score remains a percentage).

**Test changes** (`test-audit.js`): pass a `client` (`{ areaCode: '0017660' }`) in `goodYear` calls; add checks that a missing area blocks, and that 50 claimed hours without `hoursCorroborated` blocks.

### 1.11 Multi-shareholder combined capacity

Each shareholder is currently tested against the company's entire NIBC — two 50/50 owners can both pass while their combined recommendation is 2× earnings.

- `buildEngineInput` adds `otherShareholders`: for every *other* shareholder of the same client having `years[year].analysis`, include `{ name: sh2.name, recommendedMid: sh2.years[year].analysis.range.mid }`.
- `computeFlags`: when `otherShareholders.length && nibc !== null`, compute `combined = range.mid + Σ otherMid`, plus employer payroll cost on each; if the total exceeds `nibc`, push high-severity `COMBINED_EXCEEDS_CAPACITY` naming each shareholder and figure.
- **Known and intended ripple**: because `otherShareholders` is part of the engine input, running shareholder B's analysis changes A's input fingerprint, so A's dashboard pill flips to "inputs changed - re-run". That is self-healing (A re-runs and picks up B's number) — do not "fix" it; document it in the README workflow section (add a step: "analyze every shareholder, then re-run any that show inputs-changed").

**Test**: fixture input with `otherShareholders: [{ name: 'Partner', recommendedMid: 90000 }]`, NIBC 150,000, own mid 83,200 → combined 173,200 + payroll > 150,000 → flag fires; absent `otherShareholders` → no flag.

### 1.12 Current-year history cross-check

Salary lives in two places (comp-history row for the tax year, and `financials.totalOfficerWages`) and can silently disagree. In `computeFlags`, when a history row's `taxYear === Number(input.shareholder.taxYear)` and both its `salaryPaid` and `financials.totalOfficerWages` are non-null and differ by more than `max($100, 1%)` → medium flag `HISTORY_MISMATCH` quoting both figures. Same comparison for `distributionsPaid` vs `totalDistributions`. Requires `taxYear` on the engine input — `buildEngineInput` already sets `shareholder.taxYear`.

**Test**: history row `{taxYear: 2025, salaryPaid: 50000}` + `totalOfficerWages: 60000` + `shareholder.taxYear: '2025'` → flag; equal values → none.

### 1.13 Watson drift: regression, not endpoints

The endpoint-only CAGR misses V-shaped histories. Keep the existing CAGR conditions, but replace the endpoints-only share-erosion test with a least-squares slope over all years:

```
x = taxYear, y = salary share of (salary+distributions) in percentage points (skip years where s+d = 0)
slope = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)²      (require ≥ 3 usable points)
erosion = −slope × (lastYear − firstYear)
drifted if erosion ≥ cfg.flags.watson.compShareErosionPoints  (OR the existing CAGR pair)
```

Worked example for the test comment (this is Scenario 4's data): shares 42.86, 30.00, 25.00 for 2023–25 → x̄ = 2024, ȳ = 32.62; Σ(x−x̄)(y−ȳ) = (−1)(10.24) + 0 + (1)(−7.62) = −17.86; Σ(x−x̄)² = 2; slope = −8.93 pts/yr; erosion over 2 years = **17.86 ≥ 15 → drifted**. Scenario 4 stays green. Add a V-shape test the old code missed: shares 40, 20, 38 → endpoints say −2 points, regression slope = −1.0 pt/yr → erosion 2 → correctly NOT drifted either way, so instead use a noisy-decline case the endpoint test *under*-detects: shares 45, 20, 28 (endpoints −17 ≥ 15 fires; regression slope −8.5 → erosion 17 fires too). Better V-case for the changed behavior: shares 30, 45, 12 → endpoints −18 (fires), regression slope −9 → erosion 18 (fires). Since both fire in those, the *distinguishing* test is: shares 42, 12, 40 → endpoints −2 (old: silent), regression slope −1 → erosion 2 (new: silent) — both silent; and shares 25, 45, 40 with **rising** trend must never fire. Include the rising case and the Scenario-4 hand-math comment; exhaustive divergence hunting isn't required.

### 1.14 Percentile-substitution direction: keep, but disclose the choice

Decision: keep lower-first substitution. Add to the substitution note (engine, where `r.substituted`): `'…nearest published percentile (Nth) used — substitution prefers the lower percentile so suppressed data can never raise the figure.'` No config change.

### 1.15 Import: warn on unfingerprinted files

`importClientFile()` silently accepts files with no `exportFingerprint` (stripping the field defeats the tamper check). Before accepting such a file: `if (!confirm('This file has NO integrity fingerprint — it either predates fingerprinting or the fingerprint was removed. Its contents cannot be verified. Import anyway?')) return;`

**Phase 1 commit**: `Fix engine correctness: blank-vs-zero inputs, real-salary investor test, range comparison flags, hours/weeks assumptions, per-component licensure, readiness gates`

---

## Phase 2 — Exact employer payroll cost

Replace the flat 7.65% with the real formula. New engine function (exported):

```js
// Employer-side payroll cost. SUTA and workers' comp are excluded and disclosed
// (they vary by state and rating; excluding them understates cost slightly).
function employerPayrollCost(salary, taxYear, cfg) {
  var bases = cfg.payrollTax.socialSecurityWageBase;
  var years = Object.keys(bases).map(Number).sort(function (a, b) { return a - b; });
  var y = Math.min(Math.max(taxYear || years[years.length - 1], years[0]), years[years.length - 1]);
  var clamped = y !== taxYear;                        // taxYear outside the table
  var base = bases[y];
  var oasdi = cfg.payrollTax.oasdiRate * Math.min(salary, base);
  var medicare = cfg.payrollTax.medicareRate * salary;
  var futa = cfg.payrollTax.futaNetRate * Math.min(salary, cfg.payrollTax.futaWageBase);
  return { total: oasdi + medicare + futa, oasdi: oasdi, medicare: medicare, futa: futa,
           wageBaseYear: y, wageBase: base, clampedYear: clamped };
}
```

Config (replaces `employerPayrollTaxRate`):

```js
payrollTax: {
  oasdiRate: 0.062,          // employer OASDI
  medicareRate: 0.0145,      // employer Medicare (no wage base; employer side has no Additional Medicare Tax)
  futaNetRate: 0.006,        // 6.0% gross less the full 5.4% state credit — standard net rate
  futaWageBase: 7000,
  // SSA OASDI wage bases by year. 2026 announced by SSA in October 2025.
  socialSecurityWageBase: {
    2015: 118500, 2016: 118500, 2017: 127200, 2018: 128400, 2019: 132900,
    2020: 137700, 2021: 142800, 2022: 147000, 2023: 160200, 2024: 168600,
    2025: 176100, 2026: 184500,
  },
},
```

Wire it into `incomeApproach` (which needs `taxYear` — pass `Number(input.shareholder.taxYear)` through `analyze`) and the Phase 1.4 capacity check. New `payrollTaxNote` text:

> `'Employer payroll cost computed as 6.2% OASDI up to the $<base> <year> Social Security wage base, 1.45% Medicare (uncapped), and 0.6% net FUTA on the first $7,000. State unemployment tax and workers’ compensation premiums are excluded (understates employer cost slightly).'`

When `clampedYear` is true append: `' Wage base for <requested year> not on file; the <used year> base was used.'`

**Worked example for tests** (Scenario 1, tax year 2025, tested salary 60,000): OASDI 0.062 × 60,000 = 3,720; Medicare 0.0145 × 60,000 = 870; FUTA 0.006 × 7,000 = 42; **total 4,632**; residual = 150,000 − 60,000 − 4,632 = **85,368**. High-salary case: salary 250,000, TY 2025 → OASDI 0.062 × 176,100 = 10,918.20; Medicare 3,625; FUTA 42 → **14,585.20** (the flat 7.65% would have said 19,125 — that error is why this phase exists). Add both as checks; update Scenario 5's residual: 40,000 − 83,200 − (0.062×83,200 + 0.0145×83,200 + 42) = 40,000 − 83,200 − 6,406.80 = **−49,606.80** (taxYear absent → clamps to latest table year; set `shareholder.taxYear: '2025'` in the fixture inputs to make hand math stable).

**Phase 2 commit**: `Replace flat 7.65% payroll estimate with exact OASDI/Medicare/FUTA computation and SSA wage-base table`

---

## Phase 3 — Real independent-investor test (return on equity)

The IRS Job Aid's income approach is a return-on-investment analysis; the current residual-share screen is a proxy that misleads for capital-intensive businesses. Changes:

- New financials field `shareholderEquity` — UI label *"Total shareholder equity (book value, beginning of year)"*, in the financials grid.
- `incomeApproach`: after computing `residual`:
  - If `num(f.shareholderEquity) > 0`: `roe = residual / equity`. Verdicts against config `investorReturn: { required: 0.10, strong: 0.20 }`:
    - `residual < 0` → `'negative'` (existing narrative)
    - `roe < cfg.investorReturn.required` → `'thin'`, narrative: `'After the tested compensation, the return on beginning shareholder equity is <roe>% — below the <required>% an independent investor would plausibly require. Document why the owner’s services account for substantially all of the enterprise’s earnings, or revisit the wage.'`
    - else `'plausible'`, narrative: `'After the tested compensation and employer payroll cost, the company earns a <roe>% return on beginning shareholder equity — a return an independent investor could accept. The independent investor test does not contradict the market-based figure.'`
  - If equity is absent or ≤ 0: keep the residual-share logic **relabeled** — `res.method = 'residual-share screen'` vs `'return on equity'`, and the narrative must open with: `'Book equity was not provided, so only a residual-share screen was performed (residual as a share of pre-compensation earnings). This is a weaker form of the independent investor test; enter beginning shareholder equity for the full return-on-equity analysis.'`
- Config: add `investorReturn: { required: 0.10, strong: 0.20 }` with a comment: chosen as a round long-run equity-return hurdle; a preparer can defend 10% as the floor of what a passive investor demands. Keep `thinResidualShare: 0.10` for the fallback screen.
- Result carries `roe`, `equity`, `method` for the memo.

**Worked example for tests**: NIBC 150,000, tested salary 60,000, TY 2025 (payroll 4,632), equity 400,000 → residual 85,368, ROE 21.3% → plausible. Same but equity 1,200,000 → ROE 7.1% → **thin** even though residual share is 56.9% — this divergence is the entire point of the phase; assert the residual-share screen alone would have said "plausible" (comment, not code). Equity absent → `method === 'residual-share screen'` and narrative contains "weaker form".

**Phase 3 commit**: `Upgrade income approach to a true return-on-equity independent investor test with disclosed residual-share fallback`

---

## Phase 4 — Data expansion: all states, industry comparables, wage trending

This is the largest phase. All downloads run on the user's machine; every emission must be self-auditing (counts + sample lookups printed). Add a `--states 16,53` dev flag that limits metro detail for fast local iteration, but the **default is all states**.

### 4.1 refresh-oews.js: nationwide metro coverage, split output

- Delete the `STATE_DETAIL` constant and its filter — keep **every** `M`-type area (all ~380 MSAs + ~170 nonmetro areas), unless `--states` was passed.
- Split the emission:
  - `js/data/oews-core.js` → `window.RCT_DATA = { release, releaseCode, releaseYear, generatedAt, source, topcodeNote, areas: <ALL areas>, occupations, wages: { '0000000': ... }, topcode: { '0000000': ... }, states: { '16': 'js/data/oews/state-16.js', ... } }` — national wages only, plus the full area index and the state-file manifest.
  - `js/data/oews/state-<fips>.js` (one per state) → `window.RCT_DATA_REGISTER('<fips>', { wages: {...}, topcode: {...} })` containing the statewide area and every metro/nonmetro area in that state.
- Delete `js/data/oews-data.js` from the emission (and from git once the new files are generated — but see 4.6: the repo keeps working before regeneration).
- Self-audit block: print per-state area/occupation counts, assert ≥ 50 state files, and sample big-metro lookups **found by name, not hardcoded code**: find the area whose name starts with `'Dallas'`, `'New York'`, `'Los Angeles'`, `'Chicago'`, `'Miami'` and print the 13-2011 median for each (FAIL the run if any is absent).
- Fix the pre-existing dead code: the `nat`/`keptAreas.find((a) => a[2] === 'N' ...)` line reads array indices off objects; delete it.
- Size guidance (for the README): expect roughly 25–40 MB total across ~52 files; each file is far below GitHub's limits; localStorage is unaffected (data files are never stored there).

### 4.2 Lazy state loader

New file `js/data/loader.js` (UMD like the others), loaded in `index.html` after `oews-core.js`:

```js
// window.RCTDataLoader
//   ensure(areaCode, cb)  — cb(err) after the state file for areaCode is merged
//   loaded fips are tracked in a Set; national ('00') is always ready.
// Under file:// only <script> injection works (fetch does not) — that is why
// this injects script tags. RCT_DATA_REGISTER merges parts into RCT_DATA.
```

- `window.RCT_DATA_REGISTER = function (fips, part) { merge part.wages/part.topcode into RCT_DATA.wages/.topcode; mark fips loaded; }` — defined in `loader.js` so state files can load in any order.
- `ensure(areaCode, cb)`: resolve `fips` from the area index (`area[3]`); `'00'` or already-loaded → sync `cb()`. Otherwise inject `<script src=RCT_DATA.states[fips]>`; `onload` → cb(); `onerror` → cb(new Error('Wage data file for <state> is missing — re-run scripts/refresh-oews.js')).
- `app.js`: `runAnalysis` becomes `RCTDataLoader.ensure(c.areaCode, function (err) { if (err) return toast(err.message); ...existing body... })`. Also call `ensure` (fire-and-forget) in `renderClient` when an area is selected, as a prefetch. Nothing else needs to wait: memos render from the stored analysis snapshot.
- Node tests: in `test-engine.js`'s integration section, set `global.window = {}`, require `loader.js` (exports `ensure`/`register` for Node too), require `oews-core.js`, then `require` two state part files directly (they call `window.RCT_DATA_REGISTER`) and assert a Coeur d'Alene lookup falls back correctly before/after the Idaho part is registered.

### 4.3 National industry comparables (corroboration only — decided)

Industry wages **do not** replace the area-based primary path; they render as disclosed corroboration lines. Scope: national, NAICS **sector level** only (~20 sectors — kept small deliberately).

- `refresh-oews.js`: also download `oe.industry`; keep rows where `display_level === '1'` (sector level — verify against the file header when implementing; if the column differs, select codes matching the sector list in `oe.industry` and log what was kept). From the data file, additionally keep national-area (`0000000`) series whose industry is a kept sector (today the filter drops everything with `industry !== '000000'`). Emit `js/data/oews-industry.js` → `window.RCT_INDUSTRY = { sectors: [[code, title], ...], wages: { sectorCode: { occ: row } } }`. Loaded from `index.html` (it's national-only and small enough to load eagerly).
- UI: per role component, optional "Industry (national comparable)" select (blank = none) → `rc.industryCode`.
- Engine: when `rc.industryCode` and `data.industry` are present, attach `comp.industryComparable = { code, name, mid }` (same percentile, same hours/weeks math, national) and a note: `'National <sector> industry comparable for SOC XX-XXXX at the same percentile: $N — shown for corroboration; the area-based figure remains primary.'` No change to totals.
- Memo: print the note via the existing notes loop (no new section).
- `app.js` boot: `DATA.industry = window.RCT_INDUSTRY || null`.

**Test**: fixture `industry: { sectors: [['540000','Professional Services']], wages: { '540000': { '132011': [...] } } }`, component with `industryCode: '540000'` → comparable attached with hand-mathed mid; totals unchanged versus the same run without `industryCode`.

### 4.4 ECI wage trending

OEWS May-vintage wages are used for tax years up to 18+ months away; standard practice is trending by the BLS Employment Cost Index.

- `refresh-oews.js`: also download from `https://download.bls.gov/pub/time.series/ci/` the files `ci.series` and `ci.data.1.AllData`. Target series: **`CIU2020000000000I`** (ECI: wages and salaries, private industry workers, all industries and occupations, index, not seasonally adjusted). **Verify, don't trust**: assert the series id exists in `ci.series` and its row references the wages-and-salaries estimate for private industry; if not found, print every series id in `ci.series` matching `/^CIU202/` and exit 1 so the user can correct the constant. Extract quarterly index values from 2015Q1 forward; emit `js/data/eci-data.js` → `window.RCT_ECI = { series, title, values: { '2015Q1': 123.4, ... }, generatedAt }`. Load eagerly in `index.html`; `app.js` boot sets `DATA.eci = window.RCT_ECI || null`.
- Config: `wageTrending: { enabled: true }`.
- Engine (`analyze` → passed down to `annualAtPercentile` via cfg-derived context, or compute one factor per run in `costApproach` — one factor per run is correct since vintage and tax year are run-level):
  - Vintage anchor: `<releaseYear>Q2` (OEWS reference is May). Target: `<taxYear>Q2` (mid-year of the compensation period).
  - `factor = eci[target] / eci[vintage]` when both exist.
  - Target beyond the last available quarter: `yoy = eci[last] / eci[last − 4 quarters]`; `factor = (eci[last] / eci[vintage]) × yoy ^ (quartersBetween(last, target) / 4)`; mark `extrapolated: true`.
  - Tax year before the vintage: factor < 1 is correct (back-trending); allowed.
  - Missing ECI data or `wageTrending.enabled === false`: factor 1; if `|taxYear − releaseYear| ≥ 1`, push a note: `'Wages were not trended from the May <vintage> survey reference to tax year <year> (ECI data unavailable) — the figures are <n> months stale in a rising-wage environment.'`
  - Apply the factor to every wage value in both cost and market approaches; append to every basis string: `' × ECI trend <factor> (May <vintage> → mid-<taxYear>)'` (4-decimal factor), and when extrapolated add `', extrapolated beyond published ECI'`. Result carries `trending: { factor, vintageQuarter, targetQuarter, extrapolated, series }` for the memo.
- **Test** (fixture ECI): `values: { '2025Q2': 100.0, '2026Q2': 104.0 }`, taxYear 2026 → factor 1.04; Scenario-style single component 40 × 40 × 52 = 83,200 → **86,528**. Extrapolation: values `2025Q2: 100, 2025Q3: 101, 2025Q4: 102, 2026Q1: 103, 2026Q2: 104`, taxYear 2027 → target 2027Q2 is 4 quarters past last; yoy = 104/100 = 1.04; factor = 1.04 × 1.04 = **1.0816**; assert `extrapolated === true`. Absent ECI + taxYear ≠ releaseYear → factor 1 and the staleness note. All pre-existing scenarios: leave `FIX` without `eci` so factors stay 1 and hand math is untouched (set fixture `shareholder.taxYear` = releaseYear where the staleness note would otherwise appear, or assert the note where it should).

### 4.5 Dashboard/readiness staleness tie-in

`analysisStatus` already flags old OEWS vintage. Add: when the stored analysis has `trending.extrapolated` or a staleness note, show pill text `'trended (extrapolated)'` / no change respectively — minimal: only add the vintage/tax-year mismatch warning to the **memo** (Phase 5.3) and a `note`-level line in the analysis panel; do not complicate the pill logic beyond what exists.

### 4.6 Transition behavior: `--repack` (no broken window between merge and regen)

The existing `js/data/oews-data.js` already contains everything needed to produce the new layout at **current** coverage (national + all states + ID/WA metros). Add a `--repack` mode to `refresh-oews.js` that requires **no network**: it reads the existing `js/data/oews-data.js` (strip the `window.RCT_DATA = ` prefix, `JSON.parse` the object), regroups its `wages`/`topcode` by state fips using the area index, and emits `oews-core.js` plus `state-16.js`/`state-53.js` (only states that actually have non-national data) with a correct `states` manifest, then deletes `js/data/oews-data.js`. The implementing session **runs `--repack` itself in the sandbox** as part of this phase and commits the result — the app is never broken: it works immediately with today's coverage, and the user's later full refresh (on a normal network) widens coverage to all states and adds the industry/ECI files.

`index.html` gets the new tag list (`oews-core.js`, `loader.js`, `oews-industry.js`, `eci-data.js`). The industry and ECI files will not exist until the user's full refresh — a missing `<script src>` logs a console error and continues, and the code already treats `window.RCT_INDUSTRY`/`window.RCT_ECI` as optional (`|| null`), so this is safe; still, add a one-line dashboard note when `DATA.eci` is null: `'Industry/ECI data not yet generated — run scripts/refresh-oews.js for full coverage.'` Add a boot guard in `app.js`: if `!window.RCT_DATA`, replace the page body with "Wage data files not found — run: node scripts/refresh-oews.js". The tests' integration section should require `oews-core.js` + the state part files via the loader (per 4.2); after `--repack` runs, the old-path fallback is unnecessary.

**Phase 4 commits** (split in four):
1. `Expand OEWS refresh to nationwide metro coverage with per-state lazy-loaded data files`
2. `Repack existing OEWS bundle into the per-state layout (no coverage change)` — includes the generated `oews-core.js` + state files and the deletion of `oews-data.js`
3. `Add national industry-sector comparables as disclosed corroboration`
4. `Add ECI wage trending between OEWS vintage and tax year`

---

## Phase 5 — Memo and report readability

### 5.1 Planned-wages-vs-range summary block

Immediately after the conclusion box (memo section order unchanged): when `financials.totalOfficerWages` is non-null, a bordered block:

> **Planned wages vs. this analysis** — Planned officer wages of $X are $Y **below/within/above** the reconciled range of $LOW–$HIGH (recommended $MID). *(below: "See the BELOW_RANGE flag response in section 6." / within: "No adjustment is indicated." / above: "See the ABOVE_RANGE note in section 6.")*

When wages are null: "Planned officer wages were not provided; this memo prices the role but does not evaluate a planned wage."

### 5.2 OEWS limitations disclosure (verbatim — add to config as `oewsLimitations`, render after the source manifest)

> "OEWS wage estimates measure the straight-time wages of employees of sampled establishments. They include base pay, commissions, production bonuses, and tips, but exclude overtime premiums, nonproduction bonuses (such as year-end or profit-sharing bonuses), equity compensation, and the employer cost of benefits. They reflect employees rather than owner-operators, and cross-industry estimates average establishments of all industries and sizes. These limitations tend to make OEWS a conservative (low) measure of the total market compensation of an experienced owner-manager; where a component uses a cross-industry figure, the industry-sector comparable shown, if any, provides corroboration."

### 5.3 Vintage/tax-year alignment line

In the memo's section 2 intro, after the OEWS release sentence: when trending was applied — `'Wages were trended from the May <vintage> survey reference date to mid-<taxYear> using the BLS Employment Cost Index (<series>), factor <factor><", extrapolated beyond published data" if so>.'`; when not applied and years differ — the staleness note from 4.4 (it arrives via `costApproach.notes`; ensure it renders).

### 5.4 Income-approach section rewrite

Section 4 must name: the tested salary **and its basis** (Phase 1.2), the payroll-cost breakdown note (Phase 2), and the method (`return on equity` with the ROE figure and benchmark, or the `residual-share screen` fallback with its "weaker form" sentence, Phase 3).

### 5.5 Analysis panel parity

Every memo change above has a sibling in `renderAnalysis` (`app.js`): wages-vs-range banner line under the range boxes; tested-salary basis in the income card; trending factor in the header line (`'OEWS May 2025 · trended ×1.0400 to TY 2026'`).

**Test changes** (`test-memo.js`): extend the model with `financials: { totalOfficerWages: 60000 }` and a `trending` object; assert the summary block, the limitations paragraph, the trend line, and the ROE/fallback narratives render and are escaped. Keep the existing escaping checks green.

**Phase 5 commit**: `Memo: planned-wage comparison, OEWS limitations disclosure, trending and investor-test transparency`

---

## Phase 6 — Cleanup and docs

- Delete the stray empty `download` file at repo root.
- README: new data architecture (core + per-state files + industry + ECI), regeneration instructions (`node scripts/refresh-oews.js`, needs ~1 GB temp space and BLS access — **must run on a normal network, not a cloud sandbox**; expect ~25–40 MB of generated files; delete the old `js/data/oews-data.js` after the first successful run), the multi-shareholder re-run workflow note (Phase 1.11), updated methodology bullets (trending, ROE test, exact payroll math), and the new test count.
- Verify `scripts/refresh-oews.js --states 16,53 --local <dir>` still works against a saved flat-file directory if the user has one (document the flag).

**Phase 6 commit**: `Cleanup: remove stray file, document new data architecture and workflows`

---

## Acceptance checklist (run before declaring done)

1. `node scripts/test-engine.js && node scripts/test-audit.js && node scripts/test-memo.js` — all green, count updated in README.
2. `node scripts/refresh-oews.js --repack` has been run and its output committed: the app opens from `file://` with full current coverage (national + states + ID/WA metros), a new client forces area selection, and an analysis runs end-to-end.
3. Grep-level checks: no remaining `employerPayrollTaxRate`, no `'0017660'` literal in `app.js`, no `Number(f.` in flag/income code paths (all through `num()`), `RCT-2.1` stamped in the three `app.js` sites.
4. Every new memo sentence added in Phase 5 appears in `test-memo.js` assertions.
5. The user (not the implementing session) runs `node scripts/refresh-oews.js` locally, commits the generated data files, and re-runs the three test scripts — the integration section must pass against the real nationwide data, including the big-metro sample assertions in the refresh script's own output.

## Facts pre-verified for this plan (do not re-research, do not alter)

- SSA Social Security wage bases 2015–2026: as tabulated in Phase 2 (2026 = $184,500, announced October 2025).
- FUTA: 6.0% gross on the first $7,000; 0.6% net after the standard full state credit.
- ECI target series `CIU2020000000000I` — subject to the built-in verification step in 4.4 (the refresh script proves it against `ci.series` at run time).
- OEWS wage-definition inclusions/exclusions: as written in the 5.2 disclosure paragraph.
- BLS endpoints are unreachable from the cloud sandbox (verified 2026-07-18: proxy CONNECT 403 for both `download.bls.gov` and `api.bls.gov`).
- Current bundle (May 2025 release, generated 2026-07-10): 76 areas = national + 54 states/territories + 21 ID/WA metro/nonmetro areas; 1,103 occupations; 3.7 MB.
