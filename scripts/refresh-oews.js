#!/usr/bin/env node
/*
 * refresh-oews.js — Annual BLS OEWS data refresh for the Reasonable Comp Tool.
 *
 * Run once a year (BLS publishes the new OEWS release each spring, data vintage
 * "May <year>"). Downloads the OEWS flat files from download.bls.gov, filters to
 * the coverage set below, and regenerates js/data/oews-data.js, which the app
 * loads as a plain <script> tag (no server, no build step).
 *
 * Usage:
 *   node scripts/refresh-oews.js                 # download fresh files, then build
 *   node scripts/refresh-oews.js --local <dir>   # use already-downloaded flat files in <dir>
 *
 * Coverage (edit STATE_DETAIL to widen):
 *   - National
 *   - Every state, statewide
 *   - All metro + nonmetro areas within the states in STATE_DETAIL (Idaho, Washington)
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

// FIPS state codes whose metro/nonmetro areas are included in full detail.
// 16 = Idaho, 53 = Washington. Every state's statewide figure is always included.
const STATE_DETAIL = new Set(['16', '53']);

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

const OUT_PATH = path.join(__dirname, '..', 'js', 'data', 'oews-data.js');

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

async function build(dir) {
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
    (a.areatype_code === 'M' && STATE_DETAIL.has(a.state_code))
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

  // ---- emit --------------------------------------------------------------
  const out = {
    release: releaseLabel,
    releaseCode: release.release_date,
    releaseYear,
    generatedAt: new Date().toISOString(),
    source: 'BLS OEWS flat files, download.bls.gov/pub/time.series/oe/',
    topcodeNote: 'Wage equal to or greater than $115.00/hour or $239,200/year (BLS top-code).',
    // areas: [area_code, name, type(N/S/M), state_fips]
    areas: keptAreas.map((a) => [a.area_code, a.area_name, a.areatype_code, a.state_code]),
    // occupations: [code, title, level, description] — code is 6-digit; display as XX-XXXX
    occupations: keptOccs
      .filter((o) => occsWithData.has(o.occupation_code))
      .map((o) => [o.occupation_code, o.occupation_name, socLevel(o.occupation_code), o.occupation_description]),
    // wages[area][occ] = [emp, h10,h25,h50,h75,h90, a10,a25,a50,a75,a90] (null = suppressed)
    wages,
    // topcode[area][occ] = bitmask over the 10 wage slots (bit0 = h10 ... bit9 = a90)
    topcode,
  };

  const js = '// GENERATED by scripts/refresh-oews.js — do not edit by hand.\n' +
    `// BLS OEWS ${releaseLabel} release. Regenerate annually when BLS publishes the new release.\n` +
    'window.RCT_DATA = ' + JSON.stringify(out) + ';\n';
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, js);
  const mb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${OUT_PATH} (${mb} MB)`);

  // Quick sanity echoes so a refresh run is self-auditing.
  const nat = keptAreas.find((a) => a[2] === 'N' || a.areatype_code === 'N');
  const sample = (areaCode, occCode, label) => {
    const w = wages[areaCode] && wages[areaCode][occCode];
    console.log(`  ${label}: ${w ? `median $${(w[8] || 0).toLocaleString()}/yr, emp ${(w[0] || 0).toLocaleString()}` : 'NOT FOUND'}`);
  };
  console.log('Sanity checks:');
  sample('0000000', '132011', 'National 13-2011 Accountants & Auditors');
  sample('0017660', '132011', "Coeur d'Alene 13-2011 Accountants & Auditors");
  sample('0044060', '119199', 'Spokane 11-9199 Managers, All Other');
  sample('1600000', '472031', 'Idaho 47-2031 Carpenters');
}

async function main() {
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
