/*
 * loader.js — lazy per-state OEWS data loader.
 *
 * The wage bundle is split into js/data/oews-core.js (national wages, the full
 * area/occupation index, and a fips -> file-path manifest) and one
 * js/data/oews/state-<fips>.js file per state/territory. Under file:// only
 * <script>-tag injection works to load a file on demand — fetch()/XHR are
 * blocked by the browser's same-origin policy for file:// URLs — so ensure()
 * injects a <script> tag rather than using fetch.
 *
 * Each state part file calls window.RCT_DATA_REGISTER(fips, part) as a
 * top-level side effect of executing, so this module must be loaded (wiring
 * up that global) BEFORE any state part file's <script> tag.
 *
 * Backward compatible with the pre-Phase-4 single-file oews-data.js: when
 * RCT_DATA.states is undefined, every fips resolves synchronously as already
 * loaded, since all wages are already in memory in that shape.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RCTDataLoader = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var loaded = {};   // fips -> true once its wages/topcode are merged into RCT_DATA
  var pending = {};  // fips -> array of callbacks waiting on an in-flight <script> load

  function data() {
    return (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this)).RCT_DATA;
  }

  // Merges a state's wages/topcode into RCT_DATA and resolves anything
  // waiting on that fips. Called either by a state part file's own top-level
  // window.RCT_DATA_REGISTER(...) call, or directly by tests.
  function register(fips, part) {
    var d = data();
    if (!d) return;
    d.wages = d.wages || {};
    d.topcode = d.topcode || {};
    Object.keys((part && part.wages) || {}).forEach(function (areaCode) { d.wages[areaCode] = part.wages[areaCode]; });
    Object.keys((part && part.topcode) || {}).forEach(function (areaCode) { d.topcode[areaCode] = part.topcode[areaCode]; });
    loaded[fips] = true;
    var cbs = pending[fips] || [];
    delete pending[fips];
    cbs.forEach(function (cb) { cb(); });
  }

  function fipsForArea(areaCode) {
    var d = data();
    if (!d) return null;
    for (var i = 0; i < (d.areas || []).length; i++) {
      if (d.areas[i][0] === areaCode) return d.areas[i][3];
    }
    return null;
  }

  // ensure(areaCode, cb) — cb(err) once the wage data needed to look up
  // areaCode is available. National ('00') and any already-loaded fips
  // resolve synchronously with no error.
  function ensure(areaCode, cb) {
    var d = data();
    if (!d) { cb(new Error('Wage data not loaded — RCT_DATA is not defined.')); return; }
    // Legacy single-file bundle: no `states` manifest at all means every fips
    // is already in memory.
    if (!d.states) { cb(); return; }
    var fips = fipsForArea(areaCode);
    if (!fips || fips === '00' || loaded[fips]) { cb(); return; }
    var src = d.states[fips];
    if (!src) { cb(new Error('No wage data file registered for this state/territory (fips ' + fips + ') — re-run scripts/refresh-oews.js.')); return; }
    if (pending[fips]) { pending[fips].push(cb); return; }
    pending[fips] = [cb];
    if (typeof document === 'undefined') {
      // Node (tests): there is no <script> tag to inject — the caller is
      // expected to require() the state part file directly and call
      // register() itself, exactly as a real state file would on load.
      var err = new Error('loader.ensure() cannot inject <script> tags outside a browser; require the state file and call register() directly.');
      var waiting = pending[fips];
      delete pending[fips];
      waiting.forEach(function (c) { c(err); });
      return;
    }
    var el = document.createElement('script');
    el.src = src;
    el.onerror = function () {
      var cbs = pending[fips] || [];
      delete pending[fips];
      var loadErr = new Error('Wage data file for this state could not be loaded (' + src + ') — re-run scripts/refresh-oews.js.');
      cbs.forEach(function (c) { c(loadErr); });
    };
    document.head.appendChild(el);
    // el.onload is intentionally not used to resolve callbacks: the state
    // file's own top-level RCT_DATA_REGISTER(...) call already invokes
    // register() (and thus every queued callback) as soon as the script
    // executes, which happens before/around "load" fires either way.
  }

  var api = { ensure: ensure, register: register };
  if (typeof window !== 'undefined') window.RCT_DATA_REGISTER = register;
  return api;
});
