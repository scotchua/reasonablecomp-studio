/* Pure audit-workpaper completion checks. No wage calculation occurs here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RCTReadiness = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function evaluate(yr, analysis, data, cfg, currentInputFingerprint) {
    yr = yr || {};
    var roles = yr.roleComponents || [];
    var total = roles.reduce(function (sum, role) { return sum + (Number(role.pctTime) || 0); }, 0);
    var overridesOk = roles.every(function (role) {
      return !role.percentileOverride || String(role.overrideReason || '').trim().length >= 12;
    });
    var rev = yr.revenueSources || {};
    var revTotal = (Number(rev.shareholderServicesPct) || 0) + (Number(rev.employeeServicesPct) || 0) + (Number(rev.capitalEquipmentPct) || 0);
    var highFlags = (analysis && analysis.flags || []).filter(function (flag) { return flag.severity === 'high'; });
    var responses = yr.flagResponses || {};
    var highFlagsOk = highFlags.every(function (flag) { return String(responses[flag.id] || '').trim().length >= 12; });
    var evidence = yr.evidence || {};
    var requiredEvidence = cfg.auditRequiredEvidence || [];
    var evidenceCount = requiredEvidence.filter(function (key) { return evidence[key]; }).length;
    var items = [
      { id: 'profile', label: 'Duties and service hours documented', blocking: true, complete: !!String(yr.duties || '').trim() && Number(yr.hoursPerWeek) > 0 },
      { id: 'roles', label: 'SOC roles selected and time reconciles to 100%', blocking: true, complete: roles.length > 0 && roles.every(function (r) { return !!r.soc; }) && Math.abs(total - 100) < 0.01, detail: 'Current allocation: ' + total.toFixed(1) + '%' },
      { id: 'overrides', label: 'Every percentile override has a specific rationale', blocking: true, complete: overridesOk },
      { id: 'revenue', label: 'Source of gross receipts reconciles to 100%', blocking: true, complete: Math.abs(revTotal - 100) < 0.01 && String(rev.notes || '').trim().length >= 20, detail: 'Current allocation: ' + revTotal.toFixed(1) + '%' },
      { id: 'analysis', label: 'Analysis uses current inputs and the current OEWS release', blocking: true, complete: !!analysis && analysis.oewsRelease === data.release && !!analysis.inputFingerprint && analysis.inputFingerprint === currentInputFingerprint },
      { id: 'flags', label: 'All high-severity flags have preparer responses', blocking: true, complete: highFlagsOk, detail: highFlags.length + ' high-severity flag(s)' },
      { id: 'approval', label: 'Professional conclusion approved and dated', blocking: true, complete: !!String((yr.approval || {}).approvedBy || '').trim() && !!String((yr.approval || {}).approvedDate || '').trim() },
      { id: 'evidence', label: 'Core evidence retained in the client file', blocking: false, complete: evidenceCount === requiredEvidence.length, detail: evidenceCount + ' of ' + requiredEvidence.length + ' core items' },
    ];
    var completeWeight = 0, totalWeight = 0;
    items.forEach(function (item) {
      var weight = (cfg.auditReadinessWeights && cfg.auditReadinessWeights[item.id]) || 1;
      totalWeight += weight;
      if (item.complete) completeWeight += weight;
    });
    var blockers = items.filter(function (item) { return item.blocking && !item.complete; });
    return {
      score: totalWeight ? Math.round(completeWeight / totalWeight * 100) : 0,
      finalizable: blockers.length === 0,
      blockers: blockers,
      items: items,
      roleTotalPct: total,
      revenueTotalPct: revTotal,
      evidenceCount: evidenceCount,
      evidenceRequired: requiredEvidence.length,
    };
  }

  return { evaluate: evaluate };
});
