#!/usr/bin/env node
/*
 * refresh-oews.js — Annual BLS OEWS data refresh for the Reasonable Comp Tool.
 *
 * Run once a year (BLS publishes the new OEWS release each spring, data vintage
 * "May <year>"). Downloads the OEWS flat files from download.bls.gov, and
 * regenerates the wage data bundle as js/data/oews-core.js (national wages,
 * the full area/occupation index, and a per-state file manifest) plus one
 * js/data/oews/state-<fips>.js file per state/territory, loaded on demand by
 * js/data/loader.js. No server, no build step — plain <script> tags.
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

const USER_AGENT = 'ReasonableCompStudio-WhiteLabel/2.0 (OEWS annual data refresh)';
const BASE_URL = 'https://download.bls.gov/pub/time.series/oe/';
const FILES = ['oe.release', 'oe.area', 'oe.occupation', 'oe.data.0.Current'];

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

function download(file, destDir) {
  const dest = path.join(destDir, file);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    https.get(BASE_URL + file, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
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

  // ---- stream the data file ---------------------------------------------
  // series_id layout: OE U <areatype:1> <area:7> <industry:6> <occupation:6> <datatype:2>
  const wages = {};       // area_code -> { occ_code -> Array(WAGE_SLOTS) }
  const topcode = {};     // area_code -> { occ_code -> bitmask over slots 1..10 }
  let kept = 0, scanned = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, 'oe.data.0.Current')),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    scanned++;
    if (!line.startsWith('OEU')) continue; // header
    const seriesId = line.slice(0, line.indexOf('\t')).trim();
    const industry = seriesId.slice(11, 17);
    if (industry !== '000000') continue; // cross-industry only
    const datatype = seriesId.slice(23, 25);
    const slot = DATATYPE_SLOT[datatype];
    if (slot === undefined) continue;
    const area = seriesId.slice(4, 11);
    if (!areaSet.has(area)) continue;
    const occ = seriesId.slice(17, 23);
    if (!occSet.has(occ)) continue;

    const cells = line.split('\t');
    const rawValue = cells[3].trim();
    const footnotes = (cells[4] || '').trim();
    if (footnotes.includes('8')) continue; // estimate not released
    const value = parseFloat(rawValue);
    if (!isFinite(value)) continue;

    (wages[area] = wages[area] || {});
    (wages[area][occ] = wages[area][occ] || new Array(WAGE_SLOTS).fill(null));
    wages[area][occ][slot] = value;
    if (slot > 0 && footnotes.includes(TOPCODE_FOOTNOTE)) {
      (topcode[area] = topcode[area] || {});
      topcode[area][occ] = (topcode[area][occ] || 0) | (1 << (slot - 1));
    }
    kept++;
  }
  console.log(`Data rows scanned: ${scanned.toLocaleString()}, kept: ${kept.toLocaleString()}`);

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
    if (!dir || !fs.existsSync(dir)) throw new Error('--local <dir> must point to a folder holding the oe.* flat files');
    console.log(`Using local flat files in ${dir}`);
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oews-'));
    console.log(`Downloading OEWS flat files to ${dir} (the data file is ~330 MB; this can take a few minutes)…`);
    for (const f of FILES) {
      process.stdout.write(`  ${f} … `);
      await download(f, dir);
      console.log('done');
    }
  }
  await build(dir);
}

main().catch((e) => { console.error('REFRESH FAILED:', e.message); process.exit(1); });
