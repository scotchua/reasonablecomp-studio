#!/usr/bin/env node
/*
 * refresh-oews.js — Annual BLS OEWS data refresh for the Reasonable Comp Tool.
 *
 * Run once a year (BLS publishes the new OEWS release each spring, data vintage
 * "May <year>"). Downloads the OEWS flat files from download.bls.gov, and
 * regenerates the wage data bundle as js/data/oews-core.js (national wages,
 * the full area/occupation index, and a per-state file manifest) plus one
 * js/data/oews/state-<fips>.js file per state/territory, loaded on demand by
 * js/data/loader.js, plus js/data/oews-industry.js (national NAICS-sector wage
 * comparables, shown in the app for corroboration only) and js/data/eci-data.js
 * (BLS Employment Cost Index, used to trend OEWS wages forward from their May
 * survey date to the tax year). No server, no build step — plain <script> tags.
 *
 * The industry and ECI files are each optional enhancements: a failure
 * downloading/parsing either one is logged as a WARNING and that file is
 * simply not (re)written -- it does NOT abort the core OEWS refresh, and the
 * app treats both files as optional wherever it uses them.
 *
 * NOTE: a full network refresh requires real internet access to
 * download.bls.gov and is NOT possible from a sandboxed/cloud dev
 * environment with no outbound network -- run it on a normal machine/network.
 *
 * Usage:
 *   node scripts/refresh-oews.js                 # download fresh files, then build
 *   node scripts/refresh-oews.js --local <dir>    # use already-downloaded flat files in <dir>
 *   node scripts/refresh-oews.js --states 16,53   # DEV FLAG: restrict metro-level detail to
 *                                                  # the given FIPS codes, for fast local
 *                                                  # iteration. Every state's own statewide
 *                                                  # figure is ALWAYS included regardless of
 *                                                  # this flag -- it only narrows metro/nonmetro
 *                                                  # breakdown. Omit entirely for a real
 *                                                  # nationwide refresh (the default).
 *   node scripts/refresh-oews.js --repack         # Rebuild oews-core.js + per-state files from
 *                                                  # the EXISTING js/data/oews-data.js, with NO
 *                                                  # network access and NO coverage change. A
 *                                                  # one-time transition step (see README) so the
 *                                                  # per-state-loader code has real files to load
 *                                                  # before anyone has run a real network refresh.
 *
 * BLS requires a User-Agent identifying the requester on download.bls.gov;
 * anonymous/bot-looking requests get 403. Keep the contact email current.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');

const USER_AGENT = 'ReasonableCompStudio-WhiteLabel/2.0 (OEWS annual data refresh; contact: scott.edwards@1953.tax)';
const BASE_URL = 'https://download.bls.gov/pub/time.series/oe/';
const FILES = ['oe.release', 'oe.area', 'oe.occupation', 'oe.industry', 'oe.data.0.Current'];

// Datatypes we keep (see oe.datatype):
// 01 employment; 06-10 hourly 10/25/50/75/90; 11-15 annual 10/25/50/75/90.
// Slot = position in the output wage array.
const DATATYPE_SLOT = {
  '01': 0,
  '06': 1, '07': 2, '08': 3, '09': 4, '10': 5,
  '11': 6, '12': 7, '13': 8, '14': 9, '15': 10,
};
const WAGE_SLOTS = 11; // emp + 5 hourly + 5 annual
const TOPCODE_FOOTNOTE = '5'; // ">= $115.00/hr or $239,200/yr"

const DATA_DIR = path.join(__dirname, '..', 'js', 'data');
const OEWS_DIR = path.join(DATA_DIR, 'oews');
const CORE_OUT = path.join(DATA_DIR, 'oews-core.js');
const LEGACY_OUT = path.join(DATA_DIR, 'oews-data.js');
const INDUSTRY_OUT = path.join(DATA_DIR, 'oews-industry.js');
const ECI_OUT = path.join(DATA_DIR, 'eci-data.js');

// display_level value BLS's oe.industry file uses for NAICS SECTOR-level rows
// (as distinct from '0' cross-industry total, or deeper 3-/4-/5-/6-digit NAICS
// detail). This is BLS's documented oe.industry hierarchy convention, but it
// is VERIFIED against the live file at run time (see readIndustrySectors())
// rather than trusted blindly -- if the file's actual values don't match,
// the refresh aborts with the full set of values found so this constant can
// be corrected against the real file.
const INDUSTRY_SECTOR_DISPLAY_LEVEL = '1';

// ---- ECI wage trending (4.4) --------------------------------------------
const ECI_BASE_URL = 'https://download.bls.gov/pub/time.series/ci/';
const ECI_FILES = ['ci.series', 'ci.data.1.AllData'];
// ECI: wages and salaries, private industry workers, all industries and
// occupations, index, not seasonally adjusted. VERIFIED against the live
// ci.series file at run time (see readEciSeries()) rather than trusted
// blindly -- if this series id isn't found, the refresh prints every
// candidate CIU202* series id and skips ECI trending for this run (it does
// NOT abort the OEWS refresh, which is the core deliverable).
const ECI_SERIES_ID = 'CIU2020000000000I';

function download(baseUrl, file, destDir) {
  const dest = path.join(destDir, file);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    https.get(baseUrl + file, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`${file}: HTTP ${res.statusCode} — BLS may be blocking the request; check the User-Agent contact info.`));
        res.resume();
        return;
      }
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
    }).on('error', reject);
  });
}

function readTsv(file) {
  // Small reference files: read whole, split on tabs, trim each cell.
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const header = lines[0].split('\t').map((c) => c.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split('\t').map((c) => c.trim());
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] || ''; });
    return row;
  });
}

// SOC hierarchy level from the 6-digit OEWS occupation code.
function socLevel(code) {
  if (code === '000000') return 'total';
  if (code.slice(2) === '0000') return 'major';
  if (code.endsWith('000')) return 'minor';
  if (code.endsWith('0')) return 'broad';
  return 'detailed';
}

// ---- national industry-sector comparables (4.3) ------------------------
// Reads oe.industry and returns the NAICS sector-level rows, VERIFYING the
// display_level column and value against the live file rather than trusting
// INDUSTRY_SECTOR_DISPLAY_LEVEL blindly -- if the schema doesn't match what's
// expected, this aborts with every display_level value actually present so a
// human can correct the constant against the real file, instead of silently
// keeping the wrong rows (e.g. cross-industry totals or 4-digit NAICS detail).
function readIndustrySectors(dir) {
  const industryPath = path.join(dir, 'oe.industry');
  if (!fs.existsSync(industryPath)) {
    throw new Error(`oe.industry not found in ${dir} -- industry comparables require this file (add it to a --local flat-file directory, or let this script download it).`);
  }
  const rows = readTsv(industryPath);
  if (!rows.length || !('display_level' in rows[0])) {
    const cols = rows.length ? Object.keys(rows[0]).join(', ') : '(no rows)';
    throw new Error(`oe.industry does not have a 'display_level' column (columns found: ${cols}). Update readIndustrySectors() to match the real BLS schema before proceeding -- industry comparables are being SKIPPED, not silently miscategorized.`);
  }
  const levelsSeen = {};
  rows.forEach((r) => { levelsSeen[r.display_level] = (levelsSeen[r.display_level] || 0) + 1; });
  const sectorRows = rows.filter((r) => r.display_level === INDUSTRY_SECTOR_DISPLAY_LEVEL && r.industry_code !== '000000');
  console.log(`oe.industry display_level counts: ${JSON.stringify(levelsSeen)}`);
  console.log(`Industry sector rows kept (display_level=${INDUSTRY_SECTOR_DISPLAY_LEVEL}): ${sectorRows.length}`);
  if (!sectorRows.length) {
    throw new Error(`No oe.industry rows matched display_level='${INDUSTRY_SECTOR_DISPLAY_LEVEL}' (levels present: ${Object.keys(levelsSeen).join(', ')}). Correct INDUSTRY_SECTOR_DISPLAY_LEVEL to match the real file before proceeding.`);
  }
  sectorRows.slice(0, 25).forEach((r) => console.log(`  kept sector: ${r.industry_code} ${r.industry_name}`));
  if (sectorRows.length > 25) console.log(`  ...and ${sectorRows.length - 25} more.`);
  return sectorRows;
}

// ---- ECI wage trending data (4.4) ---------------------------------------
// Confirms ECI_SERIES_ID actually exists in the live ci.series file rather
// than trusting it blindly. Throws (caught by the caller, non-fatal to the
// overall refresh) with every CIU202*-prefixed candidate if it's not found.
function readEciSeries(dir) {
  const seriesPath = path.join(dir, 'ci.series');
  if (!fs.existsSync(seriesPath)) {
    throw new Error(`ci.series not found in ${dir} -- ECI wage trending requires this file.`);
  }
  const rows = readTsv(seriesPath);
  const match = rows.find((r) => r.series_id === ECI_SERIES_ID);
  if (!match) {
    const candidates = rows.filter((r) => r.series_id.indexOf('CIU202') === 0).map((r) => `${r.series_id}  ${r.series_title || ''}`);
    throw new Error(`ECI series '${ECI_SERIES_ID}' not found in ci.series. Candidates starting with CIU202:\n  ${candidates.slice(0, 40).join('\n  ')}\nCorrect ECI_SERIES_ID at the top of this file to match the real file before proceeding.`);
  }
  console.log(`ECI series verified: ${ECI_SERIES_ID} — ${match.series_title || '(no title column in this file)'}`);
  return match;
}

// Extracts quarterly index values (2015Q1 forward) for ECI_SERIES_ID from
// ci.data.1.AllData. BLS's standard quarterly period codes are 'Q01'-'Q04'
// (an annual-average row, if present, uses a different code and is excluded);
// this is VERIFIED against the rows actually present rather than trusted --
// if nothing matches that pattern, it throws with the period codes actually
// found so the pattern can be corrected against the real schema.
function readEciValues(dir) {
  const dataPath = path.join(dir, 'ci.data.1.AllData');
  if (!fs.existsSync(dataPath)) {
    throw new Error(`ci.data.1.AllData not found in ${dir} -- ECI wage trending requires this file.`);
  }
  const rows = readTsv(dataPath);
  const seriesRows = rows.filter((r) => r.series_id === ECI_SERIES_ID);
  if (!seriesRows.length) {
    throw new Error(`No rows found for series '${ECI_SERIES_ID}' in ci.data.1.AllData.`);
  }
  const values = {};
  let matchedAny = false;
  seriesRows.forEach((r) => {
    const m = /^Q0([1-4])$/.exec(r.period || '');
    if (!m) return;
    matchedAny = true;
    const year = parseInt(r.year, 10);
    if (year < 2015) return; // only need 2015 forward
    const value = parseFloat(r.value);
    if (!isFinite(value)) return;
    values[`${year}Q${m[1]}`] = value;
  });
  if (!matchedAny) {
    const periodsSeen = Array.from(new Set(seriesRows.map((r) => r.period))).join(', ');
    throw new Error(`No quarterly ('Q01'-'Q04') rows recognized for series '${ECI_SERIES_ID}' (period codes found: ${periodsSeen}). Update the period-code pattern in readEciValues() to match the real BLS schema before proceeding.`);
  }
  console.log(`ECI quarterly values extracted: ${Object.keys(values).length} (2015Q1 forward)`);
  return values;
}

// Builds js/data/eci-data.js from ci.series + ci.data.1.AllData in `dir`. A
// failure here does NOT abort the OEWS refresh -- ECI trending is an
// enhancement layered on the core wage dataset, not a blocker. Called after
// the main OEWS build() so the primary deliverable always completes first.
function buildEci(dir) {
  try {
    const series = readEciSeries(dir);
    const values = readEciValues(dir);
    const out = { series: ECI_SERIES_ID, title: series.series_title || null, values, generatedAt: new Date().toISOString() };
    const js = `// GENERATED by scripts/refresh-oews.js — do not edit by hand.\n` +
      `// BLS Employment Cost Index (${ECI_SERIES_ID}), quarterly, 2015Q1 forward.\n` +
      `window.RCT_ECI = ${JSON.stringify(out)};\n`;
    fs.writeFileSync(ECI_OUT, js);
    console.log(`ECI trending data written: ${ECI_OUT}`);
  } catch (e) {
    console.error(`WARNING: ECI wage trending data will NOT be generated this run: ${e.message}`);
    console.error('Wage trending falls back to a disclosed staleness note until this is fixed -- see js/engine/comp-engine.js computeTrendingFactor().');
  }
}

// ---- shared emission --------------------------------------------------
// Splits a full wages/topcode/areas payload into oews-core.js (national wages
// + the full area/occupation index + a per-state file manifest) and one
// js/data/oews/state-<fips>.js file per state/territory present among
// 'S'/'M'-type areas. A metro area and its owning state share the SAME
// per-state file (both carry the same area[3] fips), so loading one state
// file always satisfies the full metro -> state -> national fallback chain
// except for the always-in-core national row. Used by both the real network
// download (build()) and the network-free --repack path (repackFromLegacy()).
function emitCoreAndStateFiles({ release, releaseCode, releaseYear, generatedAt, source, topcodeNote, areas, occupations, wages, topcode }) {
  const byFips = {};
  areas.forEach((a) => {
    const areaType = a[2], stateCode = a[3], areaCode = a[0];
    if (areaType === 'N') return; // national handled separately, always in core
    (byFips[stateCode] = byFips[stateCode] || []).push(areaCode);
  });
  const stateFipsList = Object.keys(byFips).sort();

  fs.mkdirSync(OEWS_DIR, { recursive: true });
  const statesManifest = {};
  stateFipsList.forEach((fips) => {
    const stateWages = {}, stateTopcode = {};
    byFips[fips].forEach((areaCode) => {
      if (wages[areaCode]) stateWages[areaCode] = wages[areaCode];
      if (topcode[areaCode]) stateTopcode[areaCode] = topcode[areaCode];
    });
    const outPath = path.join(OEWS_DIR, `state-${fips}.js`);
    const js = `// GENERATED by scripts/refresh-oews.js — do not edit by hand.\n` +
      `// BLS OEWS ${release} release — state/territory fips ${fips}.\n` +
      `window.RCT_DATA_REGISTER('${fips}', ${JSON.stringify({ wages: stateWages, topcode: stateTopcode })});\n`;
    fs.writeFileSync(outPath, js);
    statesManifest[fips] = `js/data/oews/state-${fips}.js`;
  });

  const core = {
    release, releaseCode, releaseYear, generatedAt, source, topcodeNote,
    areas,
    occupations,
    // Core carries ONLY the national wage row -- every state/metro/nonmetro
    // row is lazy-loaded per state via `states` below (see js/data/loader.js).
    wages: wages['0000000'] ? { '0000000': wages['0000000'] } : {},
    topcode: topcode['0000000'] ? { '0000000': topcode['0000000'] } : {},
    states: statesManifest,
  };
  const coreJs = `// GENERATED by scripts/refresh-oews.js — do not edit by hand.\n` +
    `// BLS OEWS ${release} release. National wages + full area/occupation index + per-state manifest.\n` +
    `// Regenerate annually when BLS publishes the new release.\n` +
    `window.RCT_DATA = ${JSON.stringify(core)};\n`;
  fs.writeFileSync(CORE_OUT, coreJs);

  return { stateFipsList, core };
}

async function build(dir) {
  const statesFlagIdx = process.argv.indexOf('--states');
  // Dev flag ONLY -- see the usage comment at the top of this file.
  const stateDetail = statesFlagIdx !== -1 ? new Set(process.argv[statesFlagIdx + 1].split(',')) : null;

  // ---- release vintage -------------------------------------------------
  const releaseRows = readTsv(path.join(dir, 'oe.release'));
  const release = releaseRows[0]; // e.g. { release_date: '2025A01', description: 'May 2025' }
  const releaseLabel = release.description;               // "May 2025"
  const releaseYear = parseInt(releaseLabel.match(/\d{4}/)[0], 10);
  console.log(`OEWS release: ${releaseLabel} (${release.release_date})`);

  // ---- areas ------------------------------------------------------------
  const areaRows = readTsv(path.join(dir, 'oe.area'));
  const keptAreas = areaRows.filter((a) =>
    a.areatype_code === 'N' ||
    a.areatype_code === 'S' ||
    (a.areatype_code === 'M' && (!stateDetail || stateDetail.has(a.state_code)))
  );
  const areaSet = new Set(keptAreas.map((a) => a.area_code));
  console.log(`Areas kept: ${keptAreas.length} of ${areaRows.length}`);

  // ---- occupations -------------------------------------------------------
  const occRows = readTsv(path.join(dir, 'oe.occupation'));
  const keptOccs = occRows.filter((o) => o.selectable === 'T' && o.occupation_code !== '000000');
  const occSet = new Set(keptOccs.map((o) => o.occupation_code));
  console.log(`Occupations kept: ${keptOccs.length} of ${occRows.length}`);

  // ---- industry sectors (4.3, national comparables only) -----------------
  // A failure here does NOT abort the OEWS refresh -- industry comparables
  // are an enhancement layered on the core wage dataset, not a blocker.
  let sectorRows = [];
  try {
    sectorRows = readIndustrySectors(dir);
  } catch (e) {
    console.error(`WARNING: industry-sector comparables will NOT be generated this run: ${e.message}`);
  }
  const sectorCodeSet = new Set(sectorRows.map((r) => r.industry_code));

  // ---- stream the data file ---------------------------------------------
  // series_id layout: OE U <areatype:1> <area:7> <industry:6> <occupation:6> <datatype:2>
  const wages = {};       // area_code -> { occ_code -> Array(WAGE_SLOTS) }
  const topcode = {};     // area_code -> { occ_code -> bitmask over slots 1..10 }
  const industryWages = {};   // sector_code -> { occ_code -> Array(WAGE_SLOTS) } -- NATIONAL AREA ONLY
  const industryTopcode = {}; // sector_code -> { occ_code -> bitmask }
  let kept = 0, scanned = 0, industryKept = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, 'oe.data.0.Current')),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    scanned++;
    if (!line.startsWith('OEU')) continue; // header
    const seriesId = line.slice(0, line.indexOf('\t')).trim();
    const industry = seriesId.slice(11, 17);
    const datatype = seriesId.slice(23, 25);
    const slot = DATATYPE_SLOT[datatype];
    if (slot === undefined) continue;
    const area = seriesId.slice(4, 11);
    const occ = seriesId.slice(17, 23);
    if (!occSet.has(occ)) continue;

    const cells = line.split('\t');
    const rawValue = cells[3].trim();
    const footnotes = (cells[4] || '').trim();
    if (footnotes.includes('8')) continue; // estimate not released
    const value = parseFloat(rawValue);
    if (!isFinite(value)) continue;

    if (industry === '000000' && areaSet.has(area)) {
      // Primary cross-industry dataset (unchanged from before Phase 4.3).
      (wages[area] = wages[area] || {});
      (wages[area][occ] = wages[area][occ] || new Array(WAGE_SLOTS).fill(null));
      wages[area][occ][slot] = value;
      if (slot > 0 && footnotes.includes(TOPCODE_FOOTNOTE)) {
        (topcode[area] = topcode[area] || {});
        topcode[area][occ] = (topcode[area][occ] || 0) | (1 << (slot - 1));
      }
      kept++;
    } else if (area === '0000000' && sectorCodeSet.has(industry)) {
      // National industry-sector comparable (corroboration only; 4.3) --
      // NEVER mixed into the primary `wages` object above.
      (industryWages[industry] = industryWages[industry] || {});
      (industryWages[industry][occ] = industryWages[industry][occ] || new Array(WAGE_SLOTS).fill(null));
      industryWages[industry][occ][slot] = value;
      if (slot > 0 && footnotes.includes(TOPCODE_FOOTNOTE)) {
        (industryTopcode[industry] = industryTopcode[industry] || {});
        industryTopcode[industry][occ] = (industryTopcode[industry][occ] || 0) | (1 << (slot - 1));
      }
      industryKept++;
    }
  }
  console.log(`Data rows scanned: ${scanned.toLocaleString()}, kept (cross-industry): ${kept.toLocaleString()}, kept (industry-sector, national only): ${industryKept.toLocaleString()}`);

  // Drop occupation entries with no wage data at all in any kept area,
  // but keep the reference list intact for autocomplete honesty.
  const occsWithData = new Set();
  for (const area of Object.keys(wages)) {
    for (const occ of Object.keys(wages[area])) occsWithData.add(occ);
  }

  const areasOut = keptAreas.map((a) => [a.area_code, a.area_name, a.areatype_code, a.state_code]);
  const occupationsOut = keptOccs
    .filter((o) => occsWithData.has(o.occupation_code))
    .map((o) => [o.occupation_code, o.occupation_name, socLevel(o.occupation_code), o.occupation_description]);

  const { stateFipsList } = emitCoreAndStateFiles({
    release: releaseLabel,
    releaseCode: release.release_date,
    releaseYear,
    generatedAt: new Date().toISOString(),
    source: 'BLS OEWS flat files, download.bls.gov/pub/time.series/oe/',
    topcodeNote: 'Wage equal to or greater than $115.00/hour or $239,200/year (BLS top-code).',
    areas: areasOut,
    occupations: occupationsOut,
    wages,
    topcode,
  });

  console.log(`State/territory files written: ${stateFipsList.length} (${OEWS_DIR})`);
  console.log(`Core file written: ${CORE_OUT}`);
  const coreMb = (fs.statSync(CORE_OUT).size / 1024 / 1024).toFixed(2);
  console.log(`Core file size: ${coreMb} MB`);

  // ---- industry-sector comparables (4.3) ----------------------------------
  if (sectorRows.length) {
    const industryOut = {
      sectors: sectorRows.map((r) => [r.industry_code, r.industry_name]),
      wages: industryWages,
      topcode: industryTopcode,
    };
    const industryJs = `// GENERATED by scripts/refresh-oews.js — do not edit by hand.\n` +
      `// BLS OEWS ${releaseLabel} release. National NAICS-sector wage comparables (corroboration only).\n` +
      `window.RCT_INDUSTRY = ${JSON.stringify(industryOut)};\n`;
    fs.writeFileSync(INDUSTRY_OUT, industryJs);
    console.log(`Industry comparables written: ${INDUSTRY_OUT} (${sectorRows.length} sectors)`);
  } else {
    console.log('Industry comparables NOT written this run (see WARNING above, if any) -- js/data/oews-industry.js left untouched.');
  }

  // ---- self-audit ---------------------------------------------------------
  // Only a full nationwide refresh (no --states) is expected to clear these;
  // --repack (see below) never adds coverage and has its own, narrower audit.
  if (stateFipsList.length < 50 && !stateDetail) {
    console.error(`FAIL: expected at least 50 state/territory files for a nationwide refresh, got ${stateFipsList.length}.`);
    process.exitCode = 1;
  }
  console.log('Sanity checks:');
  const sample = (areaCode, occCode, label) => {
    const w = wages[areaCode] && wages[areaCode][occCode];
    console.log(`  ${label}: ${w ? `median $${(w[8] || 0).toLocaleString()}/yr, emp ${(w[0] || 0).toLocaleString()}` : 'NOT FOUND'}`);
  };
  sample('0000000', '132011', 'National 13-2011 Accountants & Auditors');
  sample('0017660', '132011', "Coeur d'Alene 13-2011 Accountants & Auditors");
  sample('0044060', '119199', 'Spokane 11-9199 Managers, All Other');
  sample('1600000', '472031', 'Idaho 47-2031 Carpenters');

  if (!stateDetail) {
    // Full nationwide refresh only: prove real big-metro coverage exists, by
    // NAME (never a hardcoded area code -- these codes appear nowhere else in
    // this codebase, so a name lookup is the only honest way to check).
    const bigMetros = ['Dallas', 'New York', 'Los Angeles', 'Chicago', 'Miami'];
    const missing = [];
    bigMetros.forEach((namePrefix) => {
      const area = areasOut.find((a) => a[1].startsWith(namePrefix));
      if (!area) { missing.push(namePrefix); return; }
      const w = (wages[area[0]] || {})['132011'];
      console.log(`  ${area[1]} (${area[0]}) 13-2011 median: ${w ? '$' + Math.round(w[8] || 0).toLocaleString() + '/yr' : 'no estimate published for this occupation'}`);
    });
    if (missing.length) {
      console.error(`FAIL: nationwide refresh is missing expected big-metro coverage: ${missing.join(', ')}.`);
      process.exitCode = 1;
    }
  } else {
    console.log(`(--states ${[...stateDetail].join(',')} restricts metro detail -- big-metro self-audit only applies to a full nationwide refresh, skipped.)`);
  }
}

// ---- --repack -----------------------------------------------------------
// Rebuilds oews-core.js + per-state files from the EXISTING js/data/oews-data.js,
// with NO network access and NO change in geographic coverage. A one-time
// transition step so the app keeps working with TODAY's coverage (national +
// every state + Idaho/Washington metro detail) the moment the per-state loader
// code lands, before anyone has run a real network refresh. Deletes
// js/data/oews-data.js once the new files are written.
function repackFromLegacy() {
  if (!fs.existsSync(LEGACY_OUT)) {
    throw new Error(`--repack requires an existing ${LEGACY_OUT} to read from, and it was not found.`);
  }
  console.log(`Repacking ${LEGACY_OUT} (no network access, no coverage change)...`);
  const raw = fs.readFileSync(LEGACY_OUT, 'utf8');
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  const legacy = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));

  const { stateFipsList } = emitCoreAndStateFiles({
    release: legacy.release,
    releaseCode: legacy.releaseCode,
    releaseYear: legacy.releaseYear,
    generatedAt: legacy.generatedAt,
    source: legacy.source,
    topcodeNote: legacy.topcodeNote,
    areas: legacy.areas,
    occupations: legacy.occupations,
    wages: legacy.wages,
    topcode: legacy.topcode,
  });

  console.log(`State/territory files written: ${stateFipsList.length} (${OEWS_DIR})`);
  console.log(`Core file written: ${CORE_OUT}`);

  // Sanity checks scoped to what --repack CAN prove: today's coverage is
  // national + every state's own statewide row + Idaho/Washington metro
  // detail only. Real nationwide metro coverage (Dallas, NYC, etc.) requires
  // an actual network refresh and is NOT expected here -- do not assert it.
  const idahoFile = path.join(OEWS_DIR, 'state-16.js');
  const waFile = path.join(OEWS_DIR, 'state-53.js');
  if (!fs.existsSync(idahoFile)) { console.error('FAIL: expected js/data/oews/state-16.js (Idaho) to exist after repack.'); process.exitCode = 1; }
  if (!fs.existsSync(waFile)) { console.error('FAIL: expected js/data/oews/state-53.js (Washington) to exist after repack.'); process.exitCode = 1; }
  const cdaArea = legacy.areas.find((a) => a[1].includes("Coeur d'Alene"));
  const spokaneArea = legacy.areas.find((a) => a[1].includes('Spokane-Spokane Valley'));
  console.log(`  Coeur d'Alene, ID area present: ${!!cdaArea}`);
  console.log(`  Spokane-Spokane Valley, WA area present: ${!!spokaneArea}`);
  if (!cdaArea || !spokaneArea) { console.error('FAIL: expected Idaho/Washington metro detail to survive the repack.'); process.exitCode = 1; }
  const texasArea = legacy.areas.find((a) => a[1] === 'Texas' && a[2] === 'S');
  console.log(`  Texas statewide area present (state-only, no metro detail expected yet): ${!!texasArea}`);
  if (!texasArea) { console.error('FAIL: expected every state to have at least its statewide row.'); process.exitCode = 1; }

  if (process.exitCode === 1) {
    console.error('Repack sanity checks FAILED -- leaving both old and new files in place for inspection.');
    return;
  }
  fs.unlinkSync(LEGACY_OUT);
  console.log(`Deleted legacy ${LEGACY_OUT} (superseded by oews-core.js + per-state files).`);
}

async function main() {
  if (process.argv.includes('--repack')) {
    repackFromLegacy();
    return;
  }
  const localIdx = process.argv.indexOf('--local');
  let dir;
  if (localIdx !== -1) {
    dir = process.argv[localIdx + 1];
    if (!dir || !fs.existsSync(dir)) throw new Error('--local <dir> must point to a folder holding the oe.* (and, for ECI trending, ci.*) flat files');
    console.log(`Using local flat files in ${dir}`);
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oews-'));
    console.log(`Downloading OEWS flat files to ${dir} (the data file is ~330 MB; this can take a few minutes)…`);
    for (const f of FILES) {
      process.stdout.write(`  ${f} … `);
      await download(BASE_URL, f, dir);
      console.log('done');
    }
    console.log('Downloading ECI (wage trending) flat files…');
    try {
      for (const f of ECI_FILES) {
        process.stdout.write(`  ${f} … `);
        await download(ECI_BASE_URL, f, dir);
        console.log('done');
      }
    } catch (e) {
      console.error(`WARNING: could not download ECI flat files: ${e.message}`);
      console.error('The OEWS refresh will continue; ECI wage trending will not be generated this run.');
    }
  }
  await build(dir);
  buildEci(dir);
}

main().catch((e) => { console.error('REFRESH FAILED:', e.message); process.exit(1); });
