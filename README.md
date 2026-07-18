# ReasonableComp Studio

An offline, audit-workpaper application for documenting S-corporation shareholder-employee reasonable compensation.

This distribution is white labeled. On the client-library screen, use the
**Firm** and **Preparer** buttons to set the names that should appear on memos.

## Open the app

Double-click **Launch ReasonableComp Studio.cmd**. It opens in a dedicated Microsoft Edge application window. If Edge is unavailable, it opens in the default browser.

No installation, server, account, or internet connection is required for normal use. Client information remains in the browser's local storage. Export a tamper-evident `.rct.json` client file after meaningful work and retain it with the tax workpapers.

## Recommended workflow

1. Create the S-corporation client and select the principal OEWS work area.
2. Add the shareholder-employee and tax year.
3. Document training, credentials, duties, hours (and whether hours above full-time are corroborated by retained time records), weeks worked per year, and seasonality.
4. Split actual work into SOC-coded role components totaling 100%; mark which components a license/credential actually applies to, and optionally override years of experience or add a national industry comparable per component.
5. Enter company financials, beginning shareholder equity, and multi-year salary/distribution history.
6. Reconcile the IRS source of gross receipts to 100% and document the support.
7. Run the analysis, address every high-severity flag — including any planned-wage-vs-range and multi-shareholder capacity flags — identify retained evidence, and approve the professional conclusion.
8. Generate a FINAL audit memo and export the client file.

**Multiple shareholders on the same client:** analyze every shareholder for the tax year, then re-run any whose dashboard pill shows "inputs changed - re-run." Each shareholder's combined-capacity check reads the others' stored recommendations, so running shareholder B after shareholder A changes A's input fingerprint; re-running A picks up B's figure and is the intended, self-healing way this cross-check stays current.

The readiness panel prevents a memo from being labeled FINAL while material documentation items remain open (including a selected work area and, when more than 40 hours/week are claimed, corroborating time records). Draft memos are visibly watermarked.

## Methodology

The tool reconciles the three approaches described in the IRS *Reasonable Compensation Job Aid for IRS Valuation Professionals*:

- Cost / multiple components approach: primary role-by-role replacement-cost analysis, with each component's wage optionally trended from the OEWS survey date to the tax year using the BLS Employment Cost Index, and optionally corroborated by a national industry-sector comparable.
- Market approach: direct comparable when one SOC occupation dominates the role.
- Income approach: independent-investor test against planned officer wages (not the tool's own recommendation) — a true return on beginning shareholder equity when equity is provided, or a disclosed, weaker residual-share screen when it isn't. Employer payroll cost is computed exactly (6.2% OASDI up to the Social Security wage base for the tax year, 1.45% uncapped Medicare, 0.6% net FUTA on the first $7,000), not estimated with a flat rate.

It also documents the IRS source-of-gross-receipts analysis, facts-and-circumstances factors, compensation/distribution history, retained evidence, and preparer responses to automated review flags — including whether planned officer wages fall below, within, or above the reconciled range, and whether multiple shareholders' recommendations together exceed what the company can pay.

There is no percentage-of-profit shortcut or 60/40 rule.

## Data and record integrity

- BLS OEWS May 2025 release, split into `js/data/oews-core.js` (national wages, the full area/occupation index, and a per-state manifest) plus one `js/data/oews/state-<fips>.js` file per state/territory, lazy-loaded on demand by `js/data/loader.js` as each client's work area requires it.
- Optional `js/data/oews-industry.js` (national NAICS-sector wage comparables, shown for corroboration only) and `js/data/eci-data.js` (BLS Employment Cost Index, used to trend wages from the OEWS survey date to the tax year) — both generated only by a full network refresh; the app runs fully without them and discloses when they're missing.
- Automatic disclosed fallback from local area to state to national figures.
- Stored analysis input snapshot and SHA-256 fingerprint.
- SHA-256 fingerprint on exported client files; imports reject changed fingerprinted records, and warn loudly on files with no fingerprint at all.
- Current-input check invalidates an analysis whenever calculation inputs change.
- Audit memo contains the OEWS vintage (and any wage-trending factor applied), component wage bases, source manifest, OEWS data limitations, workpaper fingerprint, evidence appendix, and approval record.

## Refreshing wage data

`node scripts/refresh-oews.js` runs the full annual refresh: downloads the OEWS, industry, and ECI flat files from BLS and regenerates `js/data/oews-core.js`, every `js/data/oews/state-<fips>.js` file, `js/data/oews-industry.js`, and `js/data/eci-data.js`. **This requires real outbound internet access to `download.bls.gov`** — it will not run from a sandboxed or cloud dev environment with no network. It prints a self-audit (state file counts, national/state/metro sanity lookups, and — for a full nationwide run — confirmation that major metros like Dallas, New York, Los Angeles, Chicago, and Miami actually resolved) and fails loudly if coverage looks wrong. Expect roughly 25–40 MB across the core file plus ~50+ per-state files; industry and ECI failures are logged as warnings and don't block the core OEWS refresh.

Flags:
- `--local <dir>` — use OEWS/ECI/industry flat files already downloaded into `<dir>`, instead of downloading them.
- `--states 16,53` — dev-only flag that narrows *metro-level* detail to the given FIPS codes for fast local iteration (every state's own statewide figure is always included regardless of this flag). Omit it for a real nationwide refresh.
- `--repack` — rebuilds `js/data/oews-core.js` and the per-state files from an existing single-file `js/data/oews-data.js`, with **no network access and no change in geographic coverage**. This was the one-time transition step used to move this repo onto the per-state layout before any nationwide network refresh had been run; keep it in mind if you ever need to reconstruct the split files from a single-file export without re-downloading everything.

## Tests

Run after calculation, readiness, integrity, or memo changes:

```powershell
node scripts/test-engine.js
node scripts/test-audit.js
node scripts/test-memo.js
```

Current suite: 167 checks (136 engine + 17 readiness + 14 memo).

## Important limitation

Reasonable compensation is a facts-and-circumstances determination. This tool provides structured decision support and documentation; it does not guarantee an IRS outcome and does not replace the tax professional's judgment.
