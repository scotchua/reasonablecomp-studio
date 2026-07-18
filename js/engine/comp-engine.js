/*
 * comp-engine.js — Reasonable compensation calculation engine.
 *
 * Implements and reconciles the three approaches from the IRS Reasonable
 * Compensation Job Aid for IRS Valuation Professionals:
 *   1. Cost / Multiple Components — blend of per-"hat" market wages
 *   2. Market — direct comparable where one SOC code dominates
 *   3. Income — independent investor plausibility test (flags, never the number)
 *
 * Pure functions, no DOM, no globals mutated: runs identically in the browser
 * (window.RCTEngine) and under Node for unit tests (module.exports). Every
 * figure returned carries the trace of the OEWS row and assumptions behind it —
 * nothing in the memo may be untraceable.
 *
 * There is deliberately NO percentage-of-profit shortcut anywhere in this file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RCTEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PCTS = [10, 25, 50, 75, 90];
  // Wage row layout (see refresh-oews.js): [emp, h10,h25,h50,h75,h90, a10,a25,a50,a75,a90]
  var H_SLOT = { 10: 1, 25: 2, 50: 3, 75: 4, 90: 5 };
  var A_SLOT = { 10: 6, 25: 7, 50: 8, 75: 9, 90: 10 };

  // Blank-vs-zero: '' / null / undefined / non-numeric -> null; otherwise the number.
  // A blank input is ABSENT, not zero. Nothing downstream may treat null as 0.
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function socDisplay(code) { return code.slice(0, 2) + '-' + code.slice(2); }

  // ---------------------------------------------------------------- data access

  // Wage lookup with MSA -> state -> national fallback. `data` is the object
  // produced by refresh-oews.js (window.RCT_DATA) or a test fixture of the same
  // shape. Returns null only if the SOC is absent even nationally.
  function lookupWage(data, areaCode, soc) {
    var areaById = {};
    data.areas.forEach(function (a) { areaById[a[0]] = a; });
    var chain = [];
    var cur = areaCode;
    while (cur) {
      chain.push(cur);
      var rec = areaById[cur];
      if (!rec) break;
      if (rec[2] === 'M') cur = rec[3] + '00000';      // metro -> its state
      else if (rec[2] === 'S') cur = '0000000';        // state -> national
      else cur = null;                                  // national -> stop
    }
    if (chain[chain.length - 1] !== '0000000') chain.push('0000000');

    for (var i = 0; i < chain.length; i++) {
      var row = data.wages[chain[i]] && data.wages[chain[i]][soc];
      if (row) {
        return {
          row: row,
          topcodeMask: (data.topcode[chain[i]] && data.topcode[chain[i]][soc]) || 0,
          areaUsed: chain[i],
          areaUsedName: areaById[chain[i]] ? areaById[chain[i]][1] : chain[i],
          fellBack: chain[i] !== areaCode,
          requestedArea: areaCode,
          requestedAreaName: areaById[areaCode] ? areaById[areaCode][1] : areaCode,
        };
      }
    }
    return null;
  }

  // Annual wage at a percentile, scaled to actual hours and actual weeks
  // worked. Prefers the hourly percentile x effective hours x weeks worked
  // (exact for part-time/part-year); falls back to the annual figure
  // pro-rated on a 40-hour week for annual-only occupations. `effHours` is
  // already resolved by resolveHours() (corroboration-gated, capped) —
  // annual-only figures are additionally never scaled above 1.0x full-time,
  // because salaried comparables at a given percentile already reflect long
  // weeks (see 1.5.3).
  function annualAtPercentile(lookup, percentile, effHours, weeksWorked, cfg) {
    var row = lookup.row;
    var ft = cfg.fullTimeHoursPerWeek;
    var hSlot = H_SLOT[percentile], aSlot = A_SLOT[percentile];
    var hourly = row[hSlot], annual = row[aSlot];
    var topcoded = !!(lookup.topcodeMask & ((1 << (hSlot - 1)) | (1 << (aSlot - 1))));
    var value, basis, annualScaleCapped = false;
    if (hourly != null) {
      value = hourly * effHours * weeksWorked;
      basis = 'hourly $' + hourly.toFixed(2) + ' × ' + effHours + ' hrs/wk × ' + weeksWorked + ' wks';
    } else if (annual != null) {
      var annualEffHours = Math.min(effHours, ft);
      annualScaleCapped = effHours > ft;
      value = annual * (annualEffHours / ft) * (weeksWorked / cfg.weeksPerYear);
      basis = 'annual $' + Math.round(annual).toLocaleString() + ' × ' + annualEffHours + '/' + ft + ' hrs × ' + weeksWorked + '/' + cfg.weeksPerYear + ' wks (annual-only occupation)';
    } else {
      return null; // this percentile suppressed
    }
    return { value: value, percentile: percentile, basis: basis, topcoded: topcoded, annualScaleCapped: annualScaleCapped };
  }

  // Wage at the requested percentile, falling back to the nearest PUBLISHED
  // percentile when BLS suppressed the requested one — lower percentiles first
  // (the conservative direction), then higher. The percentile actually used is
  // recorded on the result so the memo never claims a percentile it didn't use.
  function availableAt(lookup, percentile, effHours, weeksWorked, cfg) {
    var start = PCTS.indexOf(percentile);
    var order = [percentile];
    for (var d = 1; d < PCTS.length; d++) {
      if (start - d >= 0) order.push(PCTS[start - d]);
      if (start + d < PCTS.length) order.push(PCTS[start + d]);
    }
    for (var i = 0; i < order.length; i++) {
      var r = annualAtPercentile(lookup, order[i], effHours, weeksWorked, cfg);
      if (r) { r.substituted = order[i] !== percentile; r.requestedPercentile = percentile; return r; }
    }
    return null;
  }

  // Resolve a shareholder's hours-per-week and weeks-worked-per-year into the
  // effective hours used for wage scaling, applying the corroboration gate:
  // hours at or below full-time scale normally; hours ABOVE full-time only
  // scale up (to maxHoursScale) when hoursCorroborated is true — otherwise
  // they are capped back to full-time and a note is required. A blank/zero
  // entry is never silently zero: it defaults to full-time with a disclosed
  // assumption (1.5.1).
  function resolveHours(shareholder, cfg) {
    var ft = cfg.fullTimeHoursPerWeek;
    var hoursRaw = num(shareholder.hoursPerWeek);
    var assumedFullTime = false;
    if (hoursRaw === null || hoursRaw <= 0) { hoursRaw = ft; assumedFullTime = true; }
    var hoursCorroborated = !!shareholder.hoursCorroborated;
    var effHours, clampedUncorroborated = false;
    if (hoursRaw <= ft) {
      effHours = hoursRaw;
    } else if (hoursCorroborated) {
      effHours = Math.min(hoursRaw, cfg.maxHoursScale);
    } else {
      effHours = ft;
      clampedUncorroborated = true;
    }
    var weeksWorked = num(shareholder.weeksWorkedPerYear);
    if (weeksWorked === null || weeksWorked <= 0) weeksWorked = cfg.weeksPerYear;
    return {
      hoursRaw: hoursRaw,
      effHours: effHours,
      weeksWorked: weeksWorked,
      assumedFullTime: assumedFullTime,
      clampedUncorroborated: clampedUncorroborated,
      cappedAt60: hoursCorroborated && hoursRaw > cfg.maxHoursScale,
    };
  }

  // ------------------------------------------------------------- tier defaults

  // Tier from years of relevant experience ONLY. Licensure no longer floors
  // this shared default (1.7) — it is applied per role component instead,
  // because a license relevant to one "hat" (e.g. a CPA license for the
  // accounting component) has no bearing on an unrelated component (e.g.
  // bookkeeping or driving) performed by the same shareholder.
  function tierForYears(yrs, cfg) {
    var pct = cfg.experienceTiers[cfg.experienceTiers.length - 1].percentile;
    var label = '';
    for (var i = 0; i < cfg.experienceTiers.length; i++) {
      if (yrs < cfg.experienceTiers[i].maxYears) { pct = cfg.experienceTiers[i].percentile; label = cfg.experienceTiers[i].label; break; }
    }
    return { percentile: pct, reason: label || (yrs + ' years relevant experience') };
  }

  function defaultPercentile(shareholder, cfg) {
    return tierForYears(Number(shareholder.yearsExperience) || 0, cfg);
  }

  function pctStep(p, step) {
    var i = PCTS.indexOf(p) + step;
    return PCTS[Math.max(0, Math.min(PCTS.length - 1, i))];
  }

  // ------------------------------------------------------------- payroll cost

  // Exact employer-side payroll cost for a salary in a given tax year (Phase 2 —
  // replaces the old flat-7.65% simplification). `taxYear` is a number or null;
  // null (or any non-finite value) falls back to the latest wage-base year on
  // file WITHOUT a "not on file" note — that note is reserved for a genuinely
  // out-of-range year, not simply an absent one.
  function employerPayrollCost(salary, taxYear, cfg) {
    var bases = cfg.payrollTax.socialSecurityWageBase;
    var years = Object.keys(bases).map(Number).sort(function (a, b) { return a - b; });
    var hasYear = taxYear !== null && taxYear !== undefined && isFinite(taxYear);
    var y = hasYear ? Math.min(Math.max(taxYear, years[0]), years[years.length - 1]) : years[years.length - 1];
    var clampedYear = hasYear && y !== taxYear;
    var base = bases[y];
    var oasdi = cfg.payrollTax.oasdiRate * Math.min(salary, base);
    var medicare = cfg.payrollTax.medicareRate * salary;
    var futa = cfg.payrollTax.futaNetRate * Math.min(salary, cfg.payrollTax.futaWageBase);
    return {
      total: oasdi + medicare + futa,
      oasdi: oasdi, medicare: medicare, futa: futa,
      wageBaseYear: y, wageBase: base,
      requestedYear: hasYear ? taxYear : null,
      clampedYear: clampedYear,
    };
  }

  // ------------------------------------------------------- industry comparable

  // National NAICS-sector wage comparable for a role component (corroboration
  // ONLY -- never affects any total). `data.industry` is optional; shaped as
  // { sectors: [[code,title],...], wages: { sectorCode: { occCode: row } },
  // topcode: { sectorCode: { occCode: bitmask } } }. Uses the SAME percentile
  // and hours/weeks basis as the area-based figure, at the occupation's
  // full (unshared) wage rate -- not multiplied by the component's % of time,
  // since it corroborates the occupation's market rate, not this shareholder's
  // partial allocation to it.
  function industryComparable(data, sectorCode, soc, percentile, effHours, weeksWorked, cfg) {
    var ind = data.industry;
    if (!ind || !ind.wages[sectorCode] || !ind.wages[sectorCode][soc]) return null;
    var sectorTitle = sectorCode;
    (ind.sectors || []).forEach(function (s) { if (s[0] === sectorCode) sectorTitle = s[1]; });
    var lk = { row: ind.wages[sectorCode][soc], topcodeMask: (ind.topcode && ind.topcode[sectorCode] && ind.topcode[sectorCode][soc]) || 0 };
    var r = availableAt(lk, percentile, effHours, weeksWorked, cfg);
    if (!r) return null;
    return { code: sectorCode, name: sectorTitle, mid: r.value, percentile: r.percentile, basis: r.basis };
  }

  // ------------------------------------------------------------- cost approach

  // components: [{ roleTitle, soc, pctTime (0-100), percentileOverride?, overrideReason?,
  //                licenseApplies?, yearsExperienceOverride? }]
  function costApproach(input, data, cfg) {
    var sh = input.shareholder;
    var hc = resolveHours(sh, cfg);
    var def = defaultPercentile(sh, cfg);
    var totalPct = 0;
    var out = { components: [], notes: [], low: 0, mid: 0, high: 0, hoursPerWeek: hc.hoursRaw, defaultTier: def };

    if (hc.assumedFullTime) out.notes.push('Hours per week not entered — full-time (' + cfg.fullTimeHoursPerWeek + ') assumed. Enter actual hours; this assumption is disclosed in the memo.');
    if (hc.clampedUncorroborated) out.notes.push('Claimed ' + hc.hoursRaw + ' hrs/week not corroborated by time records — wage scaling capped at ' + cfg.fullTimeHoursPerWeek + '; check the corroboration box after retaining support.');
    if (hc.cappedAt60) out.notes.push('Hours per week capped at ' + cfg.maxHoursScale + ' for wage scaling; document actual hours separately.');

    // SOC group level (detailed vs. broad/minor/major) — fixtures without an
    // `occupations` array must not crash (1.9).
    var occLevel = {};
    (data.occupations || []).forEach(function (o) { occLevel[o[0]] = o[2]; });

    input.roleComponents.forEach(function (rc) {
      var share = (Number(rc.pctTime) || 0) / 100;
      totalPct += Number(rc.pctTime) || 0;
      var lk = lookupWage(data, input.client.areaCode, rc.soc);

      // Per-component tier: an explicit component-level years-experience
      // override wins over the shareholder-wide default (1.8) — one hat
      // priced by 20 years of dentistry shouldn't price an unrelated
      // bookkeeping hat at the same tier.
      var compYears = num(rc.yearsExperienceOverride);
      var tier = compYears !== null ? tierForYears(compYears, cfg) : def;
      var compPercentile = rc.percentileOverride ? Number(rc.percentileOverride) : tier.percentile;
      var compReason = rc.percentileOverride
        ? (rc.overrideReason || 'Preparer override (no reason recorded)')
        : (compYears !== null ? (compYears + ' years relevant experience (component-specific)') : tier.reason);

      // Per-component license floor (1.7): a license/credential floors ONLY
      // the component(s) the preparer marks as requiring it, never the
      // shareholder's whole role (that was the verified bug: a single
      // driver's license text field used to float every hat to the 75th
      // percentile regardless of relevance).
      if (rc.licenseApplies && String(sh.licenses || '').trim() && !rc.percentileOverride && compPercentile <= cfg.licensedMinimumPercentile) {
        compPercentile = cfg.licensedMinimumPercentile;
        compReason = 'Licensed/certified (' + sh.licenses + ') applied to this component — floored at ' + cfg.licensedMinimumPercentile + 'th percentile';
      }

      var comp = {
        roleTitle: rc.roleTitle,
        soc: rc.soc,
        socDisplay: socDisplay(rc.soc),
        pctTime: Number(rc.pctTime) || 0,
        percentile: compPercentile,
        percentileReason: compReason,
        overridden: !!rc.percentileOverride,
      };

      var level = occLevel[rc.soc];
      if (level && level !== 'detailed') {
        comp.broadGroup = true;
        out.notes.push('SOC ' + socDisplay(rc.soc) + ' is a ' + level + ' occupation group, not a detailed occupation — the wage averages dissimilar jobs; select a detailed occupation unless the group is genuinely representative.');
      }

      if (!lk) {
        comp.missing = true;
        out.notes.push('No OEWS wage data found for ' + socDisplay(rc.soc) + ' at any geographic level — component excluded; total is understated until resolved.');
        out.components.push(comp);
        return;
      }
      comp.areaUsed = lk.areaUsed;
      comp.areaUsedName = lk.areaUsedName;
      comp.fellBack = lk.fellBack;
      if (lk.fellBack) out.notes.push(socDisplay(rc.soc) + ' (' + rc.roleTitle + '): no published estimate for ' + lk.requestedAreaName + '; used ' + lk.areaUsedName + ' data.');

      ['low', 'mid', 'high'].forEach(function (band, bi) {
        var p = pctStep(comp.percentile, bi - 1);
        var r = availableAt(lk, p, hc.effHours, hc.weeksWorked, cfg);
        if (r) {
          comp[band] = r.value * share;
          comp[band + 'Detail'] = { percentile: r.percentile, basis: r.basis, topcoded: r.topcoded, substituted: r.substituted };
          if (r.substituted) out.notes.push(socDisplay(rc.soc) + ' (' + rc.roleTitle + '): ' + r.requestedPercentile + 'th percentile not published; nearest published percentile (' + r.percentile + 'th) used for the ' + band + ' band — substitution prefers the lower percentile so suppressed data can never raise the figure.');
          if (r.topcoded) comp.topcoded = true;
          if (r.annualScaleCapped) comp.annualScaleCapped = true;
          out[band] += r.value * share;
        }
      });
      if (comp.topcoded) out.notes.push(socDisplay(rc.soc) + ' (' + rc.roleTitle + '): BLS top-coded wage (' + data.topcodeNote + ') — true market wage may be higher; figure is a floor.');
      if (comp.annualScaleCapped) out.notes.push('SOC ' + socDisplay(rc.soc) + ' publishes annual-only wages; annual figures are not scaled above full-time.');

      // National industry-sector comparable (corroboration only; 4.3) —
      // never affects the totals above.
      if (rc.industryCode) {
        var ic = industryComparable(data, rc.industryCode, rc.soc, comp.percentile, hc.effHours, hc.weeksWorked, cfg);
        if (ic) {
          comp.industryComparable = ic;
          out.notes.push('National ' + ic.name + ' industry comparable for SOC ' + socDisplay(rc.soc) + ' at the ' + ic.percentile +
            'th percentile: $' + Math.round(ic.mid).toLocaleString() + ' — shown for corroboration; the area-based figure remains primary.');
        }
      }
      out.components.push(comp);
    });

    out.totalPctTime = totalPct;
    if (Math.round(totalPct) !== 100) out.notes.push('Role components sum to ' + totalPct + '% of time, not 100% — the blend covers only the allocated share.');
    return out;
  }

  // ----------------------------------------------------------- market approach

  function marketApproach(input, data, cfg, defTier) {
    var rcs = input.roleComponents.slice().sort(function (a, b) { return (b.pctTime || 0) - (a.pctTime || 0); });
    var top = rcs[0];
    var res = { applicable: false };
    if (!top) return res;
    var share = (Number(top.pctTime) || 0) / 100;
    if (share < cfg.dominantShareThreshold) {
      res.reason = 'No single role reaches ' + Math.round(cfg.dominantShareThreshold * 100) + '% of time (largest: ' + socDisplay(top.soc) + ' at ' + top.pctTime + '%). Cost approach controls.';
      return res;
    }
    var lk = lookupWage(data, input.client.areaCode, top.soc);
    if (!lk) { res.reason = 'Dominant role ' + socDisplay(top.soc) + ' has no published OEWS data.'; return res; }
    var hc = resolveHours(input.shareholder, cfg);
    var pct = top.percentileOverride ? Number(top.percentileOverride) : defTier.percentile;
    // Same per-component license floor as the cost approach (1.7): applies
    // only when the dominant component is itself marked license-relevant.
    if (top.licenseApplies && String(input.shareholder.licenses || '').trim() && !top.percentileOverride && pct <= cfg.licensedMinimumPercentile) {
      pct = cfg.licensedMinimumPercentile;
    }
    res.applicable = true;
    res.soc = top.soc; res.socDisplay = socDisplay(top.soc); res.roleTitle = top.roleTitle;
    res.pctTime = top.pctTime; res.percentile = pct;
    res.areaUsedName = lk.areaUsedName; res.fellBack = lk.fellBack;
    ['low', 'mid', 'high'].forEach(function (band, bi) {
      var r = availableAt(lk, pctStep(pct, bi - 1), hc.effHours, hc.weeksWorked, cfg);
      if (r) { res[band] = r.value; res[band + 'Detail'] = { percentile: r.percentile, basis: r.basis, topcoded: r.topcoded, substituted: r.substituted }; if (r.topcoded) res.topcoded = true; }
    });
    return res;
  }

  // ----------------------------------------------------------- income approach

  function incomeApproach(input, proposedSalary, cfg) {
    var f = input.financials || {};
    var nibc = num(f.netIncomeBeforeOfficerComp);
    var res = { applicable: nibc !== null, proposedSalary: proposedSalary };
    if (!res.applicable) { res.reason = 'Net income before officer compensation not provided.'; return res; }
    var taxYear = num((input.shareholder || {}).taxYear);
    var payroll = employerPayrollCost(proposedSalary, taxYear, cfg);
    var pt = cfg.payrollTax;
    res.employerPayrollTax = payroll.total;
    res.payrollTaxDetail = payroll;
    res.payrollTaxNote = 'Employer payroll cost computed as ' + (pt.oasdiRate * 100).toFixed(1) + '% OASDI up to the $' +
      payroll.wageBase.toLocaleString() + ' ' + payroll.wageBaseYear + ' Social Security wage base, ' + (pt.medicareRate * 100).toFixed(2) +
      '% Medicare (uncapped), and ' + (pt.futaNetRate * 100).toFixed(1) + '% net FUTA on the first $' + pt.futaWageBase.toLocaleString() +
      '. State unemployment tax and workers’ compensation premiums are excluded (understates employer cost slightly).' +
      (payroll.clampedYear ? ' Wage base for ' + payroll.requestedYear + ' not on file; the ' + payroll.wageBaseYear + ' base was used.' : '');
    res.residual = nibc - proposedSalary - payroll.total;
    res.residualShare = nibc > 0 ? res.residual / nibc : null;

    // Return on beginning shareholder equity is the true independent-investor
    // test the IRS Job Aid describes; the residual-share screen above is a
    // weaker proxy used only when equity was never provided (Phase 3).
    var equity = num(f.shareholderEquity);
    var hasEquity = equity !== null && equity > 0;
    res.equity = hasEquity ? equity : null;
    res.roe = hasEquity ? res.residual / equity : null;
    res.method = hasEquity ? 'return on equity' : 'residual-share screen';

    if (res.residual < 0) {
      res.verdict = 'negative';
      res.narrative = 'The proposed salary exceeds what net income before officer compensation can support; an unrelated investor would retain a negative return. The market-based figure still controls, but the company’s capacity constraint must be documented (e.g., salary set at capacity with the shortfall explained).';
    } else if (hasEquity) {
      if (res.roe < cfg.investorReturn.required) {
        res.verdict = 'thin';
        res.narrative = 'After the tested compensation, the return on beginning shareholder equity is ' + (res.roe * 100).toFixed(1) +
          '% — below the ' + Math.round(cfg.investorReturn.required * 100) + '% an independent investor would plausibly require. ' +
          'Document why the owner’s services account for substantially all of the enterprise’s earnings, or revisit the wage.';
      } else {
        res.verdict = 'plausible';
        res.narrative = 'After the tested compensation and employer payroll cost, the company earns a ' + (res.roe * 100).toFixed(1) +
          '% return on beginning shareholder equity — a return an independent investor could accept. The independent investor test does not contradict the market-based figure.';
      }
    } else {
      var weakerForm = 'Book equity was not provided, so only a residual-share screen was performed (residual as a share of ' +
        'pre-compensation earnings). This is a weaker form of the independent investor test; enter beginning shareholder equity ' +
        'for the full return-on-equity analysis. ';
      if (res.residualShare !== null && res.residualShare < cfg.thinResidualShare) {
        res.verdict = 'thin';
        res.narrative = weakerForm + 'After the proposed salary, the residual return to the company is under ' + Math.round(cfg.thinResidualShare * 100) +
          '% of pre-compensation earnings. An independent investor test is strained but not failed; document why the owner’s services account for substantially all of the enterprise’s earnings.';
      } else {
        res.verdict = 'plausible';
        res.narrative = weakerForm + 'After the proposed salary and employer payroll cost, the company retains a residual return an unrelated investor could find acceptable. The independent investor test does not contradict the market-based figure.';
      }
    }
    return res;
  }

  // -------------------------------------------------------------------- flags

  function computeFlags(input, range, cfg) {
    var flags = [];
    var f = input.financials || {};
    var hist = (input.compHistory || []).slice().sort(function (a, b) { return a.taxYear - b.taxYear; });
    var salary = num(f.totalOfficerWages);
    var dist = num(f.totalDistributions);
    var nibc = num(f.netIncomeBeforeOfficerComp);
    var payrollTaxYear = num((input.shareholder || {}).taxYear);
    var fc = cfg.flags;

    // 1. Distributions-to-salary ratio (current year, then trailing 3-year aggregate)
    // Blank-vs-zero matters here: ZERO_SALARY_WITH_DISTRIBUTIONS fires only when
    // wages were explicitly entered as 0, never when the field was left blank.
    if (dist !== null && dist > 0) {
      if (salary === 0) {
        flags.push({ id: 'ZERO_SALARY_WITH_DISTRIBUTIONS', severity: 'high',
          title: 'Distributions with zero officer wages',
          detail: 'Distributions of $' + Math.round(dist).toLocaleString() + ' with no officer wages — the Grey / Nu-Look pattern the IRS reclassifies first. Establish wages before any further distributions.' });
      } else if (salary !== null && salary > 0 && dist / salary > fc.distributionsToSalaryRatio) {
        flags.push({ id: 'DIST_RATIO_CURRENT', severity: 'medium',
          title: 'Distributions-to-salary ratio ' + (dist / salary).toFixed(1) + 'x (current year)',
          detail: 'Current-year distributions are ' + (dist / salary).toFixed(1) + '× officer wages (threshold ' + fc.distributionsToSalaryRatio + '×). Not unlawful by itself, but it is the profile examiners screen for.' });
      }
    }

    // 1b. Material inputs missing — checks that depend on them were skipped.
    var missingInputs = [];
    if (dist !== null && dist > 0 && salary === null) missingInputs.push('officer wages paid');
    if (nibc === null) missingInputs.push('net income before officer compensation');
    if (missingInputs.length) {
      flags.push({ id: 'INPUT_INCOMPLETE', severity: 'low',
        title: 'Analysis inputs incomplete',
        detail: 'The following inputs were not provided, so the checks that depend on them were skipped: ' +
          missingInputs.join(', ') + '. Enter them (or enter 0 if truly zero) and re-run.' });
    }
    var last3 = hist.slice(-3);
    if (last3.length === 3) {
      var s3 = last3.reduce(function (s, y) { return s + (Number(y.salaryPaid) || 0); }, 0);
      var d3 = last3.reduce(function (s, y) { return s + (Number(y.distributionsPaid) || 0); }, 0);
      if (s3 > 0 && d3 / s3 > fc.distributionsToSalaryRatio) {
        flags.push({ id: 'DIST_RATIO_TRAILING', severity: 'medium',
          title: 'Distributions-to-salary ratio ' + (d3 / s3).toFixed(1) + 'x (trailing 3 years)',
          detail: 'Aggregate distributions over the last three years are ' + (d3 / s3).toFixed(1) + '× aggregate salary (threshold ' + fc.distributionsToSalaryRatio + '×).' });
      }
    }

    // 2. Recommended salary exceeds earnings capacity (including exact employer payroll cost).
    if (nibc !== null && range) {
      var capacityPayrollCost = employerPayrollCost(range.mid, payrollTaxYear, cfg).total;
      if (range.mid + capacityPayrollCost > nibc) {
        flags.push({ id: 'EXCEEDS_CAPACITY', severity: 'high',
          title: 'Recommended salary exceeds pre-compensation earnings',
          detail: 'Market-based mid recommendation ($' + Math.round(range.mid).toLocaleString() + ') plus estimated employer payroll cost ($' +
            Math.round(capacityPayrollCost).toLocaleString() + ') exceeds net income before officer compensation ($' + Math.round(nibc).toLocaleString() +
            '). Reasonable compensation is capped by what the business can actually pay — document salary set at capacity, and revisit as earnings recover.' });
      }
    }

    // 2b. Combined multi-shareholder capacity (1.11): each shareholder can
    // individually pass the capacity test against the company's FULL NIBC while
    // their recommendations, taken together, exceed what the business can pay
    // all owners at once. `otherShareholders` is populated by buildEngineInput
    // from sibling shareholders' stored analyses for the same tax year.
    if (input.otherShareholders && input.otherShareholders.length && nibc !== null && range) {
      var ownPayrollCost = employerPayrollCost(range.mid, payrollTaxYear, cfg).total;
      var othersMidSum = 0, othersPayrollSum = 0;
      var otherNames = [];
      input.otherShareholders.forEach(function (o) {
        var m = Number(o.recommendedMid) || 0;
        othersMidSum += m;
        othersPayrollSum += employerPayrollCost(m, payrollTaxYear, cfg).total;
        otherNames.push(o.name + ' ($' + Math.round(m).toLocaleString() + ')');
      });
      var combinedTotal = range.mid + ownPayrollCost + othersMidSum + othersPayrollSum;
      if (combinedTotal > nibc) {
        flags.push({ id: 'COMBINED_EXCEEDS_CAPACITY', severity: 'high',
          title: 'Combined shareholder recommendations exceed pre-compensation earnings',
          detail: 'This shareholder\'s recommended mid ($' + Math.round(range.mid).toLocaleString() + ', plus estimated employer payroll cost) together with ' +
            otherNames.join(', ') + ' (each plus estimated employer payroll cost) totals $' + Math.round(combinedTotal).toLocaleString() +
            ', which exceeds net income before officer compensation ($' + Math.round(nibc).toLocaleString() + '). Each shareholder may individually test as reasonable ' +
            'against the company\'s full earnings, but the company cannot pay every owner the recommended figure at the same time — document the constraint or adjust the allocation.' });
      }
    }

    // 3. Watson drift: salary flat/down while distributions climb, tested two ways —
    // the CAGR pair (unchanged), OR a least-squares regression of salary's share of
    // (salary + distributions) over ALL usable years (1.13). The regression catches
    // V-shaped or noisy declines that an endpoints-only erosion test misses; the
    // endpoint shares (sh0/sh1) are kept only for the narrative sentence below.
    if (hist.length >= fc.watson.minYears) {
      var first = hist[0], last = hist[hist.length - 1];
      var n = hist.length - 1;
      var cagr = function (a, b) { return (a > 0 && b > 0) ? Math.pow(b / a, 1 / n) - 1 : null; };
      var sC = cagr(Number(first.salaryPaid), Number(last.salaryPaid));
      var dC = cagr(Number(first.distributionsPaid), Number(last.distributionsPaid));
      var shareOf = function (y) {
        var s = Number(y.salaryPaid) || 0, d = Number(y.distributionsPaid) || 0;
        return (s + d) > 0 ? s / (s + d) * 100 : null;
      };
      var sh0 = shareOf(first), sh1 = shareOf(last);
      // x = taxYear, y = salary share in percentage points, skipping years where
      // salary+distributions === 0 (shareOf returns null there).
      var pts = [];
      hist.forEach(function (y) {
        var sy = shareOf(y);
        if (sy !== null) pts.push({ x: Number(y.taxYear), y: sy });
      });
      var erosion = null;
      if (pts.length >= 3) {
        var xbar = pts.reduce(function (s, p) { return s + p.x; }, 0) / pts.length;
        var ybar = pts.reduce(function (s, p) { return s + p.y; }, 0) / pts.length;
        var sxy = pts.reduce(function (s, p) { return s + (p.x - xbar) * (p.y - ybar); }, 0);
        var sxx = pts.reduce(function (s, p) { return s + (p.x - xbar) * (p.x - xbar); }, 0);
        if (sxx > 0) {
          var slope = sxy / sxx;
          var xs = pts.map(function (p) { return p.x; });
          var span = Math.max.apply(null, xs) - Math.min.apply(null, xs);
          erosion = -slope * span;
        }
      }
      var drifted = (sC !== null && dC !== null && sC <= fc.watson.salaryStallCagr && dC >= fc.watson.distributionGrowthCagr) ||
                    (erosion !== null && erosion >= fc.watson.compShareErosionPoints);
      if (drifted) {
        flags.push({ id: 'WATSON_DRIFT', severity: 'high',
          title: 'Watson pattern: salary stalled while distributions grew',
          detail: 'From ' + first.taxYear + ' to ' + last.taxYear + ', salary ' + (sC === null ? 'is not computable' : 'grew ' + (sC * 100).toFixed(1) + '%/yr') +
            ' while distributions ' + (dC === null ? 'are not computable' : 'grew ' + (dC * 100).toFixed(1) + '%/yr') +
            (sh0 !== null && sh1 !== null ? '; salary share of total owner payout moved from ' + sh0.toFixed(0) + '% to ' + sh1.toFixed(0) + '%' : '') +
            '. A salary that was reasonable when set can become unreasonable as the business grows (Watson v. Commissioner). Reset the salary to current market data.' });
      }
    }

    // 4. Shareholder paid below comparable non-shareholder staff
    var staffWage = num(f.highestNonShareholderWage);
    if (staffWage !== null && staffWage > 0 && salary !== null && salary > 0 && salary < staffWage) {
      flags.push({ id: 'BELOW_STAFF', severity: 'medium',
        title: 'Officer paid less than highest non-shareholder employee',
        detail: 'Officer wages ($' + Math.round(salary).toLocaleString() + ') are below the highest non-shareholder wage ($' + Math.round(staffWage).toLocaleString() + '). Courts treat internal comparables as strong evidence; be prepared to explain the differential in duties.' });
    }

    // 5. Near-zero salary with more than de minimis services
    var hours = Number(input.shareholder.hoursPerWeek) || 0;
    if (salary !== null && salary < fc.nearZeroSalary && hours >= fc.deMinimisHoursPerWeek) {
      flags.push({ id: 'NEAR_ZERO_SALARY', severity: 'high',
        title: 'Near-zero salary with substantial services',
        detail: 'Officer wages under $' + fc.nearZeroSalary.toLocaleString() + ' while performing ~' + hours + ' hours/week of services. This is the fact pattern of Grey and Nu-Look; wages must reflect services actually rendered.' });
    }

    // 6. Planned wages below (or far above) the computed reasonable-compensation range.
    if (salary !== null && salary > 0 && range && range.low > 0 && salary < range.low) {
      var shortfallPct = (range.low - salary) / range.low;
      flags.push({ id: 'BELOW_RANGE', severity: shortfallPct > fc.belowRangeHighShortfall ? 'high' : 'medium',
        title: 'Planned wages below the reasonable-compensation range',
        detail: 'Planned officer wages ($' + Math.round(salary).toLocaleString() + ') fall $' + Math.round(range.low - salary).toLocaleString() +
          ' (' + Math.round(shortfallPct * 100) + '%) below the low end of the reconciled range ($' + Math.round(range.low).toLocaleString() +
          '). This is the primary reclassification exposure this workpaper exists to address — document the justification or adjust the wage.' });
    }
    if (salary !== null && range && range.high > 0 && salary > range.high * fc.aboveRangeRatio) {
      flags.push({ id: 'ABOVE_RANGE', severity: 'low',
        title: 'Planned wages well above the reasonable-compensation range',
        detail: 'Planned wages exceed the high end of the range by more than ' + Math.round((fc.aboveRangeRatio - 1) * 100) +
          '% — not an IRS reclassification risk for an S corporation, but it overpays employment tax; confirm intent.' });
    }

    // 7. Current-year history cross-check (1.12): salary lives in two places —
    // the comp-history row for the tax year, and financials.totalOfficerWages —
    // and can silently disagree. Same check for distributions.
    var taxYearNum = Number((input.shareholder || {}).taxYear);
    if (!isNaN(taxYearNum)) {
      var curHist = null;
      for (var hi = 0; hi < hist.length; hi++) {
        if (Number(hist[hi].taxYear) === taxYearNum) { curHist = hist[hi]; break; }
      }
      if (curHist) {
        var histSalary = num(curHist.salaryPaid);
        var histDist = num(curHist.distributionsPaid);
        var mismatches = [];
        if (histSalary !== null && salary !== null) {
          var salThresh = Math.max(100, 0.01 * Math.max(Math.abs(histSalary), Math.abs(salary)));
          if (Math.abs(histSalary - salary) > salThresh) {
            mismatches.push('salary paid ($' + Math.round(histSalary).toLocaleString() + ' in the comp-history record vs. $' + Math.round(salary).toLocaleString() + ' in financials)');
          }
        }
        if (histDist !== null && dist !== null) {
          var distThresh = Math.max(100, 0.01 * Math.max(Math.abs(histDist), Math.abs(dist)));
          if (Math.abs(histDist - dist) > distThresh) {
            mismatches.push('distributions paid ($' + Math.round(histDist).toLocaleString() + ' in the comp-history record vs. $' + Math.round(dist).toLocaleString() + ' in financials)');
          }
        }
        if (mismatches.length) {
          flags.push({ id: 'HISTORY_MISMATCH', severity: 'medium',
            title: 'Current-year figures disagree between comp history and financials',
            detail: 'For tax year ' + taxYearNum + ', the comp-history record and financials disagree on ' + mismatches.join(' and ') + '. Reconcile the two before finalizing.' });
        }
      }
    }

    return flags;
  }

  // ------------------------------------------------------------ reconciliation

  function reconcile(cost, market, income, cfg) {
    var range = { low: Math.round(cost.low), mid: Math.round(cost.mid), high: Math.round(cost.high) };
    var lines = [];
    lines.push('Primary figure: cost (multiple components) approach — the shareholder’s role is priced as its component occupations, each at the percentile supported by experience and licensure, weighted by documented time allocation.');
    if (market.applicable) {
      var div = cost.mid > 0 ? (market.mid - cost.mid) / cost.mid : 0;
      lines.push('Market approach cross-check: ' + market.socDisplay + ' (' + market.roleTitle + ', ' + market.pctTime + '% of time) prices the full role at $' +
        Math.round(market.low).toLocaleString() + ' / $' + Math.round(market.mid).toLocaleString() + ' / $' + Math.round(market.high).toLocaleString() +
        ' (low/mid/high), ' + (Math.abs(div) < 0.10
          ? 'within 10% of the cost-approach blend — the approaches corroborate each other.'
          : (div > 0 ? 'above' : 'below') + ' the cost-approach blend by ' + Math.abs(div * 100).toFixed(0) + '% — the blend reflects time spent in ' + (div > 0 ? 'lower' : 'higher') + '-paid supporting roles, which is exactly what the components document.'));
    } else if (market.reason) {
      lines.push('Market approach: ' + market.reason);
    }
    if (income.applicable) {
      lines.push('Income approach (independent investor test): ' + income.narrative);
    } else if (income.reason) {
      lines.push('Income approach not performed: ' + income.reason);
    }
    return { range: range, narrative: lines };
  }

  // -------------------------------------------------------------------- main

  // input: { client:{areaCode,...}, shareholder:{...}, roleComponents:[...],
  //          financials:{...}, compHistory:[...], proposedSalary? }
  function analyze(input, data, cfg) {
    if (!input.roleComponents || !input.roleComponents.length) {
      throw new Error('At least one role component is required.');
    }
    var defTier = defaultPercentile(input.shareholder, cfg);
    var cost = costApproach(input, data, cfg);
    var market = marketApproach(input, data, cfg, defTier);
    // Test the shareholder's actual planned wages (not the tool's own recommendation —
    // that would be circular). Falls back to the recommended mid only when no planned
    // wage was entered, so the income approach always has a number to test.
    var salaryNum = num((input.financials || {}).totalOfficerWages);
    var tested = (salaryNum !== null && salaryNum > 0) ? salaryNum : Math.round(cost.mid);
    var testedBasis = (salaryNum !== null && salaryNum > 0)
      ? 'planned officer wages as entered'
      : 'the recommended mid figure (no planned officer wages were entered)';
    var income = incomeApproach(input, tested, cfg);
    income.salaryBasis = testedBasis;
    var rec = reconcile(cost, market, income, cfg);
    var flags = computeFlags(input, rec.range, cfg);
    if (income.verdict === 'negative') {
      flags.unshift({ id: 'RESIDUAL_NEGATIVE', severity: 'high', title: 'Income approach: negative residual return', detail: income.narrative });
    } else if (income.verdict === 'thin') {
      flags.push({ id: 'RESIDUAL_THIN', severity: 'low', title: 'Income approach: thin residual return', detail: income.narrative });
    }
    return {
      oewsRelease: data.release,
      oewsReleaseYear: data.releaseYear,
      defaultTier: defTier,
      costApproach: cost,
      marketApproach: market,
      incomeApproach: income,
      range: rec.range,
      reconciliation: rec.narrative,
      flags: flags,
      generatedAt: null, // stamped by the caller at save time
    };
  }

  return {
    analyze: analyze,
    num: num,
    employerPayrollCost: employerPayrollCost,
    industryComparable: industryComparable,
    lookupWage: lookupWage,
    annualAtPercentile: annualAtPercentile,
    defaultPercentile: defaultPercentile,
    costApproach: costApproach,
    marketApproach: marketApproach,
    incomeApproach: incomeApproach,
    computeFlags: computeFlags,
    socDisplay: socDisplay,
    PCTS: PCTS,
  };
});
