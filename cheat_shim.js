// CYOA cheat/saver companion, runs INSIDE a hosted game's document (ICC lineage). Injected only
// when the request carries a flag (cheat.go / hosting.go): ?__save=1 = build-saver sheet (the site
// adds it to every hosted iframe), ?__cheat=1 = full cheat mode. On the game page the parent
// upgrades save→cheat via a postMessage 'mode' (useCheatBridge) — no reload, selections survive.
// UI lives in a shadow root (no CSS collisions). Engine functions are module-scoped and
// unreachable: everything goes through the reactive store object or synthesized DOM clicks (so the
// engine's own rules run).

(function () {
  'use strict';
  if (window.__cyoaCheatLoaded) return;
  window.__cyoaCheatLoaded = true;

  var BIG = 999999;

  var mode = /[?&]__cheat=1/.test(location.search) ? 'cheat' : 'save';

  // Strip our flag from the URL before the engine sees it. The flag is only for the server, but
  // some engines keep state in location.search: "The Fay Path" decodes it as base64 → '__save=1'
  // throws during init → cell click bindings and svg-pan-zoom never attach (game looks fine, dead
  // to clicks). Edit the raw string, not URLSearchParams: bare codes like `?a3f1` would be mangled.
  // Cost: if the game calls location.reload(), the shim is gone until src changes — acceptable.
  try {
    if (/[?&]__(save|cheat)=1(&|$)/.test(location.search)) {
      var kept = location.search.slice(1).split('&').filter(function (p) {
        return p !== '__save=1' && p !== '__cheat=1';
      }).join('&');
      history.replaceState(history.state, '',
        location.pathname + (kept ? '?' + kept : '') + location.hash);
    }
  } catch (e) { }

  // The shim (on author.cyoa.cafe) can't see the cyoa.cafe session, so posting a build and the "has
  // posted a build" gate go through the parent over postMessage. Cheats stay locked until a build
  // is posted; with no trusted parent (standalone ?__cheat=1 URL) there is nothing to gate against
  // → unlock locally.
  var gateUnlocked = null;
  var hostOrigin = null;
  var hostPresent = false;
  var currentGameId = null;
  var standaloneTimer = null;

  // Engine reach across ICC generations. Data model
  // (rows/pointTypes/requireds/allowedChoices/scores/...) is shared; only the path to the reactive
  // store differs. Probe newest→oldest, cache the winner (ladder mirrors iccplus-extension):
  // window.debugApp → ICC+2 (Svelte 5 runes)
  // #app.__vue__.$store.state.app → classic ICC (Vue 2 + Vuex)
  // #__nuxt ... $pinia ... file.data → ltouroumov cyoa-editor (Nuxt 3 + Pinia)
  // Svelte runes and Vue 2 re-render on direct assignment to existing keys. Nuxt state sits under a
  // shallowRef behind memoizing computeds: in-place writes don't render → commitStore() after
  // edits; selection via the store's setSelected action.
  // DOM per engine: ICC+2 cards have `.choice-<id>`, rows `.row-<id>-bg`, mdc import dialog.
  // Classic renders NO card id in DOM → reach cards via the Vue component tree (AppObject bound to
  // `object`; truth = object.isActive; node→id via el.__vue__.object.id); no hidden-row signal, no
  // mdc dialog. Nuxt cards are `<div id="obj-<id>">`, selection truth in store.selected.
  var STORE_ACCESSORS = [
    function () { return window.debugApp; },
    function () { return document.querySelector('#app').__vue__.$store.state.app; },
    function () { return document.getElementById('__nuxt').__vue_app__.$nuxt.$pinia.state._rawValue.project.store._value.file.data; }
  ];
  var storeAccessor = null;
  function isAppShape(a) { return !!(a && Array.isArray(a.rows) && Array.isArray(a.pointTypes)); }
  function getApp() {
    if (storeAccessor) {
      var cached; try { cached = storeAccessor(); } catch (e) { cached = null; }
      if (isAppShape(cached)) return cached;
      storeAccessor = null;
    }
    for (var i = 0; i < STORE_ACCESSORS.length; i++) {
      var a; try { a = STORE_ACCESSORS[i](); } catch (e) { a = null; }
      if (isAppShape(a)) { storeAccessor = STORE_ACCESSORS[i]; return a; }
    }
    return null;
  }
  function ready() { return isAppShape(getApp()); }

  function engineKind() {
    var idx = STORE_ACCESSORS.indexOf(storeAccessor);
    return idx === 1 ? 'classic' : idx === 2 ? 'nuxt' : 'iccplus2';
  }

  function vueRoot() { try { return document.querySelector('#app').__vue__; } catch (e) { return null; } }
  function classicEachVm(cb) {
    var root = vueRoot(); if (!root) return;
    var seen = [];
    (function walk(vm, d) {
      if (!vm || d > 60 || seen.indexOf(vm) !== -1) return;
      seen.push(vm); cb(vm);
      var ch = vm.$children || [];
      for (var i = 0; i < ch.length; i++) walk(ch[i], d + 1);
    })(root, 0);
  }
  function classicVmById(id) {
    var found = null;
    classicEachVm(function (vm) {
      if (!found && vm && vm.object && vm.object.id === id && typeof vm.activateObject === 'function') found = vm;
    });
    return found;
  }
  // Classic: the engine's @click sits on a descendant of the wrapper $el — clicking $el doesn't
  // reach it; click candidates until object.isActive flips.
  function fireClickSeq(el) {
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  }
  function classicSelect(id) {
    var vm = classicVmById(id); if (!vm) return false;
    var before = vm.object.isActive;
    // Preferred: call the engine handler activateObject(object,row) directly (what @click invokes);
    // robust against newer card DOM (v-dialog wrappers) that defeats synthetic clicks. Buttons are
    // skipped by the engine's @click, so we skip them too.
    if (typeof vm.activateObject === 'function' && !vm.object.isButtonObject) {
      try { vm.activateObject(vm.object, vm.row); } catch (e) {}
      if (vm.object.isActive !== before) return true;
    }
    if (!vm.$el) return vm.object.isActive !== before;
    var kids = vm.$el.querySelectorAll('*');
    var candidates = [
      vm.$el.querySelector('[style*="background"]'),
      vm.$el.firstElementChild,
      kids.length ? kids[kids.length - 1] : null,
      vm.$el
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      fireClickSeq(candidates[i]);
      if (vm.object.isActive !== before) return true;
    }
    return vm.object.isActive !== before;
  }

  // Nuxt (github.com/ltouroumov/cyoa-editor): separate engine sharing ICC's data shape. 1)
  // Selection: never poke DOM — store.setSelected(id, want) (reactive, runs the engine's rules);
  // truth in store.selected. 2) Everything else is an in-place edit of file.data under a shallowRef
  // → invisible until commitStore().
  function nuxtStoreInstance() {
    try { return document.getElementById('__nuxt').__vue_app__.$nuxt.$pinia._s.get('project'); }
    catch (e) { return null; }
  }
  function nuxtIsSelected(id) {
    var s = nuxtStoreInstance();
    return !!(s && s.selected && (id in s.selected));
  }
  function nuxtSetSelected(id, want) {
    var s = nuxtStoreInstance();
    if (!s || typeof s.setSelected !== 'function') return false;
    try { s.setSelected(id, want); } catch (e) { return false; }
    return true;
  }
  // Fresh identities at every level a cheat touches (rows, pointTypes, data, file) so memoized
  // project→pointTypes/projectRows computeds recompute. No-op on classic/svelte.
  function commitStore() {
    if (engineKind() !== 'nuxt') return;
    var s = nuxtStoreInstance();
    if (!s) return;
    var raw = s.store;
    if (!raw || !raw.file || !raw.file.data) return;
    var d = raw.file.data;
    var newData = Object.assign({}, d, {
      rows: (d.rows || []).slice(),
      pointTypes: (d.pointTypes || []).slice()
    });
    var newFile = Object.assign({}, raw.file, { data: newData });
    try { s.store = Object.assign({}, raw, { file: newFile }); } catch (e) {}
  }
  function isChoiceActive(o) {
    if (!o) return false;
    if (engineKind() === 'nuxt') return nuxtIsSelected(o.id);
    return !!o.isActive;
  }
  // Multi-take cards are ALSO isActive, so the take count is a separate truth; encoded in build
  // strings as `<id>/ON#<n>`. Classic + ICC+2: counter on the choice only for the
  // isMultipleUseVariable flavour (the multipleScoreId flavour counts into a pointType; ICC
  // exporters skip it, so do we). Nuxt: store.selected is id→count. 0 = ordinary single take, no
  // suffix.
  function choiceTakes(o) {
    if (!o || !o.isSelectableMultiple) return 0;
    if (engineKind() === 'nuxt') {
      var s = nuxtStoreInstance();
      var v = s && s.selected ? s.selected[o.id] : 0;
      return typeof v === 'number' && isFinite(v) ? v : 0;
    }
    if (!o.isMultipleUseVariable) return 0;
    var n = o.multipleUseVariable;
    return typeof n === 'number' && isFinite(n) ? n : 0;
  }
  // Drive the engine's own +/- handlers (selectedOneMore/Less) so points/requirements/min/max rules
  // run.
  function setChoiceTakes(id, n) {
    var k = engineKind();
    if (k === 'nuxt') {
      var s = nuxtStoreInstance();
      if (!s || typeof s.incSelected !== 'function') return;
      var cur = (s.selected && typeof s.selected[id] === 'number') ? s.selected[id] : 0;
      for (var g = 0; g < 200 && cur < n; g++, cur++) s.incSelected(id, 1);
      if (typeof s.decSelected === 'function') {
        for (var h = 0; h < 200 && cur > n; h++, cur--) s.decSelected(id, 1);
      }
      return;
    }
    if (k !== 'classic') return;
    var f = findChoice(id);
    if (f && (f.choice.multipleUseVariable || 0) === n) return;
    var vm = classicVmById(id);
    if (!vm || typeof vm.selectedOneMore !== 'function') return;
    for (var i = 0; i < 200 && (vm.object.multipleUseVariable || 0) < n; i++) {
      var before = vm.object.multipleUseVariable;
      vm.selectedOneMore(vm.object, vm.row);
      if (vm.object.multipleUseVariable === before) break;
    }
    for (var j = 0; j < 200 && (vm.object.multipleUseVariable || 0) > n; j++) {
      var was = vm.object.multipleUseVariable;
      vm.selectedOneLess(vm.object, vm.row);
      if (vm.object.multipleUseVariable === was) break;
    }
  }

  // Per-card state beyond selection; a build missing it is a different build:
  // /WORD# typed name — engine substitutes it via app.words[].replaceText through ALL game text.
  // /IMG#  uploaded picture — engine holds a base64 data URL; the host swaps it for a link to our
  // copy before storing (engine renders plain URLs fine).
  // /RND#  which cards a random roll picked — without it a loaded build re-rolls.
  // /RS#   rolled point values `scoreIndex:value`. ICC+2 only: the classic importer never parses it
  // and the suffix would stay glued to the id, dropping the card.
  function choiceWord(o) {
    if (!o || !o.textfieldIsOn || !o.customTextfieldIsOn) return '';
    return typeof o.wordChangeSelect === 'string' ? o.wordChangeSelect : '';
  }
  function choiceImage(o) {
    if (!o || !o.isImageUpload) return '';
    var img = o.image;
    // The engine parks the original art in `defaultImage` when an upload starts, so "differs from
    // default" == "player's own picture".
    if (typeof img !== 'string' || !img || img === o.defaultImage) return '';
    return img;
  }
  function choiceRandoms(o) {
    if (!o || !o.isActivateRandom) return null;
    var list = o.isSelectableMultiple ? o.activatedRandomMul : o.activatedRandom;
    if (list && o.isSelectableMultiple && typeof list.flat === 'function') list = list.flat(2);
    if (!list || !list.length) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i]) out.push(String(list[i]));
    return out.length ? out : null;
  }
  // /RS#: ~2 in 5 hosted ICC+2 bundles export it but their importer can't read it — the leftover
  // suffix is treated as part of the id and the whole card vanishes. Ask the engine's own (cached)
  // script whether it parses /RS#; assume "no" until answered (re-rolled points < vanished card).
  var rsSupported = false;
  function probeRandomScoreSupport() {
    if (engineKind() !== 'iccplus2') return;
    var src = '', ss = document.getElementsByTagName('script');
    for (var i = 0; i < ss.length; i++) {
      if (ss[i].src && /\/app\.[^/]*\.js(\?|$)/.test(ss[i].src)) { src = ss[i].src; break; }
    }
    if (!src) return;
    try {
      fetch(src, { credentials: 'omit' })
        .then(function (r) { return r.text(); })
        .then(function (t) { rsSupported = t.indexOf('/RS#') !== -1; })
        .catch(function () {});
    } catch (e) {}
  }
  function choiceRandomScores(o) {
    if (!rsSupported || engineKind() !== 'iccplus2' || !o || !o.scores || !o.scores.length) return null;
    var out = [];
    for (var i = 0; i < o.scores.length; i++) {
      var s = o.scores[i];
      if (s && s.isRandom && s.setValue) out.push(i + ':' + s.value);
    }
    return out.length ? out : null;
  }
  // Suffix ORDER matters: every ICC importer peels suffixes in a fixed order; any other order
  // leaves garbage on the id and the card is silently dropped.
  function nativeToken(c) {
    var k = engineKind();
    var t = c.id;
    if (c.n) t += '/ON#' + c.n;
    // Nuxt importer matches /^id(\/ON#\d+)?(,…)*$/ and rejects the WHOLE build on anything else.
    // Send nothing more.
    if (k === 'nuxt') return t;
    if (c.rs && c.rs.length) t += '/RS#' + c.rs.join('/AND#');
    if (c.rnd && c.rnd.length) t += '/RND#' + c.rnd.join('/AND#').split('/ON#').join('/RON#');
    // Multi-take cards stop here in every ICC exporter; their importer (selectedOneMoreI) only
    // peels /RND#, so /WORD# would stay glued to the id.
    if (c.n) return t;
    if (typeof c.w === 'string' && c.w !== '') t += '/WORD#' + c.w.split(',').join('/CHAR#');
    if (c.img) t += '/IMG#' + String(c.img).split(',').join('/CHAR#');
    return t;
  }
  // Names are substituted via the word map keyed by idOfTheTextfieldWord; writing only onto the
  // card restores data but not prose.
  function applyWord(o) {
    var app = getApp();
    if (!app || !app.words) return;
    var root = vueRoot();
    for (var i = 0; i < app.words.length; i++) {
      var w = app.words[i];
      if (w.id !== o.idOfTheTextfieldWord) continue;
      w.replaceText = o.wordChangeSelect;
      if (!app.wordMap) continue;
      // Vue 2 can't see a new key on a plain object; $set can.
      if (root && typeof root.$set === 'function') root.$set(app.wordMap, w.id, w.replaceText);
      else app.wordMap[w.id] = w.replaceText;
    }
  }
  // Mirrors the engine importer incl. moving the current picture into `defaultImage` (keeps "player
  // changed it" true on re-save). Also writes names back onto cards for importers that only updated
  // the word map.
  function syncWordFields(want) {
    var app = getApp(); if (!app) return;
    app.rows.forEach(function (r) {
      eachChoice(r, function (o) {
        var c = want[o.id];
        if (c && typeof c.w === 'string' && c.w !== '' && o.customTextfieldIsOn) {
          o.wordChangeSelect = c.w;
        }
      });
    });
    commitStore();
  }
  function applyChoiceExtras(o, want) {
    if (!o || !want) return;
    if (o.isImageUpload && want.img) {
      o.defaultImage = typeof o.image === 'string' ? o.image : '';
      o.image = want.img;
    }
    if (o.textfieldIsOn && typeof want.w === 'string' && want.w !== '') {
      if (o.customTextfieldIsOn) o.wordChangeSelect = want.w;
      applyWord(o);
    }
  }

  function cardIdFromNode(node) {
    var k = engineKind();
    if (k === 'classic') {
      var cur = node;
      for (var i = 0; i < 12 && cur; i++) {
        var vm = cur.__vue__;
        if (vm && vm.object && vm.object.id != null && typeof vm.activateObject === 'function') return vm.object.id;
        cur = cur.parentElement;
      }
      return null;
    }
    if (k === 'nuxt') {
      var n = node;
      for (var j = 0; j < 16 && n; j++) {
        if (n.id && n.id.indexOf('obj-') === 0) return n.id.slice(4);
        n = n.parentElement;
      }
      return null;
    }
    return tokenId(node, 'choice-');
  }
  function cardElFor(id) {
    var k = engineKind();
    if (k === 'classic') { var vm = classicVmById(id); return vm ? vm.$el : null; }
    if (k === 'nuxt') return document.getElementById('obj-' + id);
    return document.querySelector('[class~="choice-' + id + '"]');
  }

  var orig = { points: null, limits: {}, reqs: {}, scores: {}, labels: {}, vis: {},
    multi: {}, multiDef: null, filters: null, showAddons: null };
  function clone(x) { try { return JSON.parse(JSON.stringify(x)); } catch (e) { return x; } }

  function stripHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.innerHTML = s;
    return (d.textContent || '').trim();
  }
  function rowTitle(r, i) {
    return stripHtml(r.title) || stripHtml(r.titleText) || ('Row ' + (i + 1));
  }
  function choiceTitle(c) { return stripHtml(c.title) || ('Card ' + (c.id || '')); }

  function eachChoice(row, fn) {
    if (!row.objects) return;
    for (var i = 0; i < row.objects.length; i++) {
      var o = row.objects[i];
      fn(o, row);
      if (o.objects && o.objects.length) eachChoice(o, fn);
    }
  }
  function findChoice(id) {
    var app = getApp(), found = null;
    for (var i = 0; i < app.rows.length && !found; i++) {
      eachChoice(app.rows[i], function (o, r) {
        if (!found && o.id === id) found = { choice: o, row: r };
      });
    }
    return found;
  }
  function findRow(id) {
    var app = getApp();
    for (var i = 0; i < app.rows.length; i++) if (app.rows[i].id === id) return app.rows[i];
    return null;
  }

  // Only ICC+2 has the `.row-<id>-bg.hidden` anchor. Classic has no cheap signal → never flag rows
  // hidden there (better than badging every row).
  function rowHidden(rowId) {
    if (engineKind() !== 'iccplus2') return false;
    var bg = document.querySelector('[class~="row-' + rowId + '-bg"]');
    if (!bg) return true;
    return bg.classList.contains('hidden');
  }
  function rowBadges(r) {
    var b = [];
    if (rowHidden(r.id)) b.push('hidden');
    if (r.isResultRow) b.push('result');
    if (r.isInfoRow) b.push('info');
    if (r.isButtonRow) b.push('button');
    return b;
  }

  function pointName(id) {
    var pts = getApp().pointTypes || [];
    for (var i = 0; i < pts.length; i++) if (pts[i].id === id) return pts[i].name || 'points';
    return 'points';
  }
  function reqText(req) {
    if (!req) return '';
    switch (req.type) {
      case 'id': {
        var id = String(req.reqId || '').split('/ON#')[0].split('/D#')[0];
        var f = findChoice(id);
        return f ? choiceTitle(f.choice) : id;
      }
      case 'points':
        return req.reqPoints + ' ' + pointName(req.reqId);
      case 'or': {
        var parts = (req.orRequireds || []).map(reqText).filter(Boolean);
        return parts.length ? parts.join(' / ') : 'one of several';
      }
      case 'selFromRows': {
        var rows = (req.selRows || []).map(function (rid) {
          var rr = findRow(rid); return rr ? rowTitle(rr, 0) : '';
        }).filter(Boolean);
        return (req.selNum != null ? req.selNum + ' from ' : '') + (rows.join(', ') || 'rows');
      }
      case 'selFromGroups':
        return (req.selNum != null ? req.selNum + ' from ' : '') + 'groups';
      case 'selFromWhole':
        return (req.selNum != null ? req.selNum + ' selections' : 'selections');
    }
    return '';
  }
  function reqSummary(list) {
    if (!list || !list.length) return '';
    var parts = [];
    for (var i = 0; i < list.length; i++) { var t = reqText(list[i]); if (t) parts.push(t); }
    return parts.join(' · ');
  }

  function snapPoints() {
    if (!orig.points) orig.points = getApp().pointTypes.map(function (p) { return p.startingSum; });
  }
  function setPoint(idx, val) {
    snapPoints();
    var p = getApp().pointTypes[idx];
    if (p) p.startingSum = val;
  }
  function maxPoints() {
    snapPoints();
    getApp().pointTypes.forEach(function (p) { p.startingSum = BIG; });
  }

  // On-screen label is beforeText/afterText, not internal `name`; rename whichever the author used.
  function pointLabelField(p) {
    if (p.beforeText && p.beforeText.trim()) return 'beforeText';
    if (p.afterText && p.afterText.trim()) return 'afterText';
    return 'beforeText';
  }
  function snapLabel(i) {
    var p = getApp().pointTypes[i];
    if (!(i in orig.labels)) orig.labels[i] = { before: p.beforeText, after: p.afterText };
  }
  function setPointLabel(i, val) {
    var p = getApp().pointTypes[i];
    if (!p) return;
    snapLabel(i);
    p[pointLabelField(p)] = val;
  }
  // Point-bar visibility, two generations: heavy classic + ICC+2 honor isNotShownPointBar (heavy
  // engine stamps `initValue` on every pointType at mount). Light classic has no hide flag: a score
  // shows iff activatedId=='' || activated includes it → hide by parking activatedId on a
  // never-activated sentinel; snapshot original for Reset.
  var VIS_SENTINEL = '__cheat_hidden__';
  var visAll = false, visCalibrated = false;
  // Check ANY point for the field, not pts[0]: authors often flag only counters #5..#24; reading
  // pts[0] alone put 24 hidden bookkeeping chips on screen where the author shows 4.
  function has(pts, key) {
    for (var i = 0; i < pts.length; i++) {
      if (pts[i] && key in pts[i]) return true;
    }
    return false;
  }
  function visByFlag() {
    var pts = getApp().pointTypes;
    if (!pts.length) return false;
    var k = engineKind();
    if (k === 'iccplus2') return true;
    if (k === 'classic') return has(pts, 'initValue') || has(pts, 'isNotShownPointBar');
    // Nuxt carries initValue too but does NOT honor isNotShownPointBar: trust only the flag's
    // presence.
    return has(pts, 'isNotShownPointBar');
  }
  function activatedList() { var a = getApp().activated; return a && a.indexOf ? a : []; }
  // activatedId may also name an app.variables[].id (boolean toggled by a button). The engine's
  // checkPointEnable resolves variables first; so must we, or variable-gated points stay hidden
  // forever.
  function variableTrue(id) {
    var vs = getApp().variables;
    if (!vs || !vs.length) return null;
    for (var j = 0; j < vs.length; j++) {
      if (vs[j] && vs[j].id === id) return !!vs[j].isTrue;
    }
    return null;
  }
  // Authors use spare point types as hidden ending counters; no store field marks them, so the
  // rendered screen decides (calibrateScreenVisibility).
  var screenHidden = {}, screenCalibrated = false;
  function isPointShown(i) {
    if (screenHidden[i]) return false;
    return isPointShownByModel(i);
  }
  function isPointShownByModel(i) {
    var p = getApp().pointTypes[i];
    if (!p) return true;
    if (visAll) return p.activatedId !== VIS_SENTINEL;
    var gated = p.activatedId && p.activatedId !== VIS_SENTINEL;
    if (visByFlag()) {
      if (gated) return variableTrue(p.activatedId) === true || activatedList().indexOf(p.activatedId) !== -1 || !p.isNotShownPointBar;
      return p.activatedId !== VIS_SENTINEL && !p.isNotShownPointBar;
    }
    return p.activatedId === '' || variableTrue(p.activatedId) === true || activatedList().indexOf(p.activatedId) !== -1;
  }
  function pSet(p, key, val) {
    if (!(key in p) && engineKind() === 'classic') {
      var r = vueRoot();
      if (r && typeof r.$set === 'function') { r.$set(p, key, val); return; }
    }
    p[key] = val;
  }
  function snapVis(i) {
    var p = getApp().pointTypes[i];
    if (!(i in orig.vis)) orig.vis[i] = { flag: p.isNotShownPointBar, act: p.activatedId };
  }
  function togglePointVis(i) {
    var p = getApp().pointTypes[i];
    if (!p) return;
    snapVis(i);
    var show = !isPointShown(i);
    // Explicit user request overrides the author's screen.
    if (show) delete screenHidden[i];
    if (visByFlag()) {
      pSet(p, 'isNotShownPointBar', !show);
      if (show) {
        if (p.activatedId && p.activatedId !== '' && activatedList().indexOf(p.activatedId) === -1) p.activatedId = '';
      } else if (p.activatedId && (activatedList().indexOf(p.activatedId) !== -1 || variableTrue(p.activatedId) === true)) {
        p.activatedId = VIS_SENTINEL;
      }
    } else {
      p.activatedId = show ? '' : VIS_SENTINEL;
    }
  }
  function originalLabel(i) {
    if (i in orig.labels) {
      var o = orig.labels[i];
      if (o.before && o.before.trim()) return o.before.trim();
      if (o.after && o.after.trim()) return o.after.trim();
      return '';
    }
    var p = getApp().pointTypes[i];
    return (p[pointLabelField(p)] || '').trim();
  }
  function currentLabel(i) {
    var p = getApp().pointTypes[i];
    return (p[pointLabelField(p)] || '').trim();
  }
  function shortenLabel(text) {
    var s = (text || '').trim();
    if (!s) return s;
    var words = s.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return words[0].slice(0, 2) + '.' + words[1].slice(0, 2);
    return s.slice(0, 4);
  }
  function shortenAllLabels() {
    var app = getApp();
    app.pointTypes.forEach(function (p, i) {
      var short = shortenLabel(originalLabel(i));
      if (short) setPointLabel(i, short);
    });
    rememberAllLabels();
  }

  // Visible number is startingSum (live total; initValue = original). Integers print bare,
  // fractions via decimalPlaces (default 2) — otherwise "12.00" where the author wrote "12".
  function fmtPointValue(p) {
    var v = p.startingSum;
    if (typeof v !== 'number' || !isFinite(v)) return v == null ? '' : String(v);
    if (v % 1 === 0) return String(v);
    var d = typeof p.decimalPlaces !== 'undefined' ? p.decimalPlaces : 2;
    return String(parseFloat(v.toFixed(d)));
  }
  // Author colours come in two shapes: bar colours are strings (often 8-digit hex, alpha matters),
  // point colours are whatever the picker stored — on classic a Vuetify object {hex,hexa,rgba,...}.
  // Reading only strings made every classic game fall back to our default palette. One parser,
  // alpha kept.
  function rgbaOf(c) {
    if (typeof c === 'string') {
      var fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i
        .exec(c.trim());
      if (fn) {
        var al = fn[4] == null ? 1 : (/%$/.test(fn[4]) ? parseFloat(fn[4]) / 100 : +fn[4]);
        return { r: +fn[1], g: +fn[2], b: +fn[3], a: isFinite(al) ? al : 1 };
      }
      var m = /^#?([0-9a-f]{3,8})$/i.exec(c.trim());
      if (!m) return null;
      var h = m[1];
      if (h.length === 3 || h.length === 4) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + (h.length === 4 ? h[3] + h[3] : '');
      }
      if (h.length !== 6 && h.length !== 8) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    if (!c || typeof c !== 'object') return null;
    var src = c.rgba || (typeof c.r === 'number' ? c : null);
    if (src && typeof src.r === 'number') {
      var a = typeof src.a === 'number' ? src.a
            : (typeof c.alpha === 'number' ? c.alpha : 1);
      return { r: src.r | 0, g: src.g | 0, b: src.b | 0, a: a };
    }
    if (typeof c.hexa === 'string' && c.hexa) return rgbaOf(c.hexa);
    if (typeof c.hex === 'string' && c.hex) return rgbaOf(c.hex);
    return null;
  }
  function hexOf(x) {
    return '#' + [x.r, x.g, x.b].map(function (n) {
      return ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2);
    }).join('');
  }
  function toCss(c) {
    var x = rgbaOf(c);
    if (!x || x.a === 0) return '';
    if (x.a >= 0.999) return hexOf(x);
    return 'rgba(' + (x.r | 0) + ',' + (x.g | 0) + ',' + (x.b | 0) + ',' +
      (Math.round(x.a * 100) / 100) + ')';
  }
  function toHex(c) { var x = rgbaOf(c); return x ? hexOf(x) : ''; }
  function styling() { var a = getApp(); return (a && a.styling) || {}; }
  // Precedence as in AppPointBar: point's own colour paints the whole chip; bar-wide
  // positive/negative colour paints the number on top (red-on-negative is meaning). '' label colour
  // = inherit bar text colour.
  function pointColors(p) {
    var neg = p.startingSum < 0;
    if (barPrefs && barPrefs.skin === 'dark') {
      return { label: '', value: defaultPointFg(neg) };
    }
    var priv = p.pointPrivateColorIsOn
      ? toCss(neg ? p.privateNegativeColor : p.privateColor) : '';
    var s = styling();
    var wide = toCss(neg ? s.barPointNeg : s.barPointPos);
    return {
      label: priv ? readable(priv, '') : '',
      value: readable(wide || priv, '') || readable(defaultPointFg(neg), defaultFg()),
    };
  }

  function relLum(c) {
    var v = [c.r, c.g, c.b].map(function (n) {
      n /= 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function mixOver(fg, bg) {
    if (!fg) return bg;
    if (fg.a >= 0.999) return fg;
    var a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a),
             b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  var DARK_BG = 'rgba(14,14,14,.94)';
  // Paint with: player's pick, else the author's bar colour, else our dark default. Repainting a
  // white author bar black made the game look foreign.
  function barBgCss() {
    if (barPrefs && barPrefs.bg) return barPrefs.bg;
    if (!barPrefs || barPrefs.skin !== 'dark') {
      var a = authorBarBg();
      if (a) return a;
    }
    return DARK_BG;
  }
  // Author bars sit on a static page background; ours floats over scrolling art. Translucent bars
  // (a<.72, ~30 games) get flattened onto their page bg and given enough opacity to read.
  var MIN_BAR_ALPHA = 0.72;
  function authorBarBg() {
    var c = rgbaOf(styling().barBackgroundColor);
    if (!c || c.a === 0) return '';
    if (c.a >= MIN_BAR_ALPHA) return toCss(c);
    var flat = mixOver(c, pageBgRgb());
    flat.a = MIN_BAR_ALPHA;
    return toCss(flat);
  }
  function pageBgRgb() {
    var under = rgbaOf(toCss(styling().backgroundColor));
    return mixOver(under, { r: 18, g: 18, b: 18, a: 1 });
  }
  function barBgRgb() {
    var bg = rgbaOf(barBgCss()) || { r: 14, g: 14, b: 14, a: 1 };
    if (bg.a >= 0.999) return bg;
    return mixOver(bg, pageBgRgb());
  }
  // Decide by "does dark ink read better", not luminance: mid-tone bars (beige #9A997B of a Worm
  // CYOA family) look dark by luminance yet only take dark text.
  var WHITE = { r: 255, g: 255, b: 255, a: 1 }, BLACK = { r: 0, g: 0, b: 0, a: 1 };
  function barIsLight() {
    var bg = barBgRgb();
    return contrast(BLACK, bg) >= contrast(WHITE, bg);
  }
  function defaultFg() { return barIsLight() ? '#141414' : '#e8e8e8'; }
  function defaultPointFg(neg) {
    if (barIsLight()) return neg ? '#b3261e' : '#1a7a2e';
    return neg ? '#ff7a7a' : '#7ae07a';
  }
  // Author text colour can become invisible on OUR paint (player override or our fallback bg): keep
  // it when legible, else swap in a legible default.
  function contrast(fg, bg) {
    var l1 = relLum(mixOver(fg, bg)), l2 = relLum(bg);
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function shade(fg, toWhite, k) {
    var t = toWhite ? 255 : 0;
    return {
      r: fg.r + (t - fg.r) * k, g: fg.g + (t - fg.g) * k,
      b: fg.b + (t - fg.b) * k, a: fg.a
    };
  }
  // Darken/lighten the author's colour until legible (3:1, WCAG large-text) instead of replacing it
  // with a stock colour.
  function readable(c, fallback) {
    if (!c) return fallback;
    var fg = rgbaOf(c);
    if (!fg) return c;
    var bg = barBgRgb();
    if (contrast(fg, bg) >= 3) return c;
    var toWhite = !barIsLight();
    for (var k = 0.15; k < 1.001; k += 0.15) {
      var s = shade(fg, toWhite, k);
      if (contrast(s, bg) >= 3) return toCss(s);
    }
    return fallback;
  }
  // Some points have an icon and NO text; dropping icons makes them nameless numbers.
  function pointIconSrc(p) {
    if (!p.iconIsOn) return null;
    var src = (p.negativeIconIsOn && p.startingSum < 0) ? p.negativeImage : p.image;
    return (typeof src === 'string' && src) ? src : null;
  }

  // Engine functions aren't on window: open the game's save/load/export UI by synth-clicking the
  // point bar menu icon (only stable anchor). False if the game hides its bar.
  function gameMenuAnchor() { return document.querySelector('.pointbar-icons'); }
  function openGameMenu() {
    var btn = gameMenuAnchor();
    if (!btn) return false;
    fireClick(btn);
    return true;
  }

  function snapLimit(row) { if (!(row.id in orig.limits)) orig.limits[row.id] = row.allowedChoices; }
  function setRowLimit(row, val) { snapLimit(row); row.allowedChoices = val; }
  function unlimitRow(row) { setRowLimit(row, 0); }
  function removeAllLimits() { getApp().rows.forEach(unlimitRow); }

  function snapReqs(kind, obj) {
    var key = kind + ':' + obj.id;
    if (!(key in orig.reqs)) orig.reqs[key] = clone(obj.requireds || []);
  }
  function clearReqs(kind, obj) { if (obj.requireds && obj.requireds.length) { snapReqs(kind, obj); obj.requireds = []; } }
  function revealReqs(obj) {
    if (!obj.requireds) return;
    obj.requireds = obj.requireds.map(function (q) {
      var n = clone(q); n.showRequired = true; n.hideRequired = false; return n;
    });
  }
  function removeAllRequirements() {
    var app = getApp();
    app.rows.forEach(function (r) {
      clearReqs('row', r);
      eachChoice(r, function (o) { clearReqs('choice', o); });
    });
  }

  function snapScores(choice) { if (!(choice.id in orig.scores)) orig.scores[choice.id] = clone(choice.scores || []); }
  function zeroScores(choice) {
    if (!choice.scores || !choice.scores.length) return;
    snapScores(choice);
    choice.scores = choice.scores.map(function (s) {
      var n = clone(s); n.value = 0; n.isRandom = false; n.setValue = 0; return n;
    });
  }
  function unRandomRow(row) {
    row.buttonRandom = false;
    row.isWeightedRandom = false;
    eachChoice(row, function (o) {
      o.isActivateRandom = false;
      if (o.scores) o.scores = o.scores.map(function (s) {
        if (s.isRandom) { var n = clone(s); n.isRandom = false; return n; }
        return s;
      });
    });
  }
  function removeAllRandomness() { getApp().rows.forEach(unRandomRow); }

  // Multi-select cap = choice.numMultipleTimesPluss (default app.defaultChoiceMaxNum ~99); raise
  // both. A card taken many times still counts once toward the row limit.
  function snapMulti(c) { if (!(c.id in orig.multi)) orig.multi[c.id] = c.numMultipleTimesPluss; }
  function unlimitMulti(c) {
    if (!c.isSelectableMultiple) return false;
    snapMulti(c);
    c.numMultipleTimesPluss = BIG;
    return true;
  }
  function removeAllMultiLimits() {
    var app = getApp();
    if (orig.multiDef == null && typeof app.defaultChoiceMaxNum !== 'undefined') orig.multiDef = app.defaultChoiceMaxNum;
    if (typeof app.defaultChoiceMaxNum !== 'undefined') app.defaultChoiceMaxNum = BIG;
    app.rows.forEach(function (r) { eachChoice(r, function (o) { unlimitMulti(o); }); });
  }

  // ICC hides cards via per-styling visible filters (reqFilterVisibleIsOn etc., engine isShown in
  // AppObject.svelte). Active styling may be app.styling or a row/choice/design-group override →
  // clear flags on every styling object reachable.
  var VIS_FLAGS = ['reqFilterVisibleIsOn', 'unselFilterVisibleIsOn', 'selFilterVisibleIsOn'];
  function collectStylings() {
    var app = getApp(), out = [];
    function push(s) { if (s && typeof s === 'object' && out.indexOf(s) === -1) out.push(s); }
    push(app.styling);
    (app.rows || []).forEach(function (r) {
      push(r.styling);
      eachChoice(r, function (o) { push(o.styling); });
    });
    ['objectDesignGroups', 'rowDesignGroups'].forEach(function (k) {
      (app[k] || []).forEach(function (g) { push(g.styling); });
    });
    return out;
  }
  function showHiddenCards() {
    var stylings = collectStylings();
    if (!orig.filters) {
      orig.filters = stylings.map(function (s) {
        var snap = { s: s };
        VIS_FLAGS.forEach(function (f) { snap[f] = s[f]; });
        return snap;
      });
    }
    stylings.forEach(function (s) { VIS_FLAGS.forEach(function (f) { s[f] = false; }); });
  }
  // app.showAllAddons > 0 overrides per-addon hide rules; kept high so the engine's own decrements
  // can't zero it.
  function revealAllAddons() {
    var app = getApp();
    if (orig.showAddons == null) orig.showAddons = app.showAllAddons;
    app.showAllAddons = BIG;
  }
  function revealHiddenRows() {
    getApp().rows.forEach(function (r) { clearReqs('row', r); });
  }

  function resetAll() {
    var app = getApp();
    if (orig.points) { app.pointTypes.forEach(function (p, i) { if (i < orig.points.length) p.startingSum = orig.points[i]; }); orig.points = null; }
    Object.keys(orig.limits).forEach(function (id) { var r = findRow(id); if (r) r.allowedChoices = orig.limits[id]; });
    orig.limits = {};
    Object.keys(orig.reqs).forEach(function (key) {
      var parts = key.split(':'), kind = parts[0], id = parts.slice(1).join(':');
      var obj = kind === 'row' ? findRow(id) : (findChoice(id) || {}).choice;
      if (obj) obj.requireds = clone(orig.reqs[key]);
    });
    orig.reqs = {};
    Object.keys(orig.scores).forEach(function (id) { var f = findChoice(id); if (f) f.choice.scores = clone(orig.scores[id]); });
    orig.scores = {};
    Object.keys(orig.labels).forEach(function (i) {
      var p = app.pointTypes[i]; if (p) { p.beforeText = orig.labels[i].before; p.afterText = orig.labels[i].after; }
    });
    orig.labels = {};
    Object.keys(orig.vis).forEach(function (i) {
      var p = app.pointTypes[i]; if (!p) return;
      var o = orig.vis[i];
      p.isNotShownPointBar = o.flag;
      p.activatedId = o.act;
    });
    orig.vis = {};
    Object.keys(orig.multi).forEach(function (id) { var f = findChoice(id); if (f) f.choice.numMultipleTimesPluss = orig.multi[id]; });
    orig.multi = {};
    if (orig.multiDef != null) { app.defaultChoiceMaxNum = orig.multiDef; orig.multiDef = null; }
    if (orig.filters) {
      orig.filters.forEach(function (snap) { VIS_FLAGS.forEach(function (f) { snap.s[f] = snap[f]; }); });
      orig.filters = null;
    }
    if (orig.showAddons != null) { app.showAllAddons = orig.showAddons; orig.showAddons = null; }
    commitStore();
    if (panelOpen) renderPanel();
  }

  function fireClick(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function forceClickCard(choiceId) {
    // Programmatic selection: clear a lingering long-press suppression flag or onClickCapture
    // swallows our click.
    suppressClick = false;
    var k = engineKind();
    if (k === 'classic') return classicSelect(choiceId);
    if (k === 'nuxt') return nuxtSetSelected(choiceId, !nuxtIsSelected(choiceId));
    var el = document.querySelector('[class~="choice-' + choiceId + '"]');
    if (!el) return false;
    fireClick(el);
    return true;
  }

  // Custom bar settings are a per-game, per-device view preference (localStorage). labels/vis are
  // replayed into the engine store, not a parallel model, so native bar mode shows the same edits.
  var BAR_PREFS_V = 1;
  var barPrefs = null;
  var barPrefsKey = null;

  function prefsKey() {
    if (barPrefsKey) return barPrefsKey;
    // Key per game, not per origin: one author subdomain hosts many games.
    var p = location.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '');
    barPrefsKey = 'cyoaBar:' + location.host + (p || '/');
    return barPrefsKey;
  }
  function defaultPrefs() {
    return { v: BAR_PREFS_V, mode: 'custom', skin: 'author', font: 0, fg: null, bg: null,
             icc: true, labels: {}, vis: {} };
  }
  function loadBarPrefs() {
    var d = defaultPrefs();
    try {
      var raw = localStorage.getItem(prefsKey());
      if (raw) {
        var got = JSON.parse(raw);
        // Unknown/older pref shapes are discarded, not migrated (cosmetic).
        if (got && got.v === BAR_PREFS_V) {
          if (got.mode === 'native' || got.mode === 'custom') d.mode = got.mode;
          if (got.skin === 'dark' || got.skin === 'author') d.skin = got.skin;
          if (typeof got.font === 'number') d.font = got.font;
          if (typeof got.fg === 'string' || got.fg === null) d.fg = got.fg;
          if (typeof got.bg === 'string' || got.bg === null) d.bg = got.bg;
          if (typeof got.icc === 'boolean') d.icc = got.icc;
          if (got.labels && typeof got.labels === 'object') d.labels = got.labels;
          if (got.vis && typeof got.vis === 'object') d.vis = got.vis;
        }
      }
    } catch (e) { }
    barPrefs = d;
  }
  function saveBarPrefs() {
    try { localStorage.setItem(prefsKey(), JSON.stringify(barPrefs)); } catch (e) {}
  }
  function replayBarPrefs() {
    var app = getApp(); if (!app) return;
    var n = app.pointTypes.length;
    Object.keys(barPrefs.labels).forEach(function (k) {
      var i = +k; if (i >= 0 && i < n) setPointLabel(i, barPrefs.labels[k]);
    });
    Object.keys(barPrefs.vis).forEach(function (k) {
      var i = +k; if (i >= 0 && i < n) setPointVis(i, !!barPrefs.vis[k]);
    });
  }
  function setPointVis(i, show) {
    if (isPointShown(i) !== !!show) togglePointVis(i);
  }

  function rememberLabel(i) {
    if (!barPrefs) return;
    var cur = currentLabel(i);
    if (cur && cur !== originalLabel(i)) barPrefs.labels[i] = cur;
    else delete barPrefs.labels[i];
    saveBarPrefs();
  }
  // Only HIDING is persisted. Persisting "shown" would force activatedId-gated points visible from
  // load and spoil counters the author reveals later.
  function rememberVis(i) {
    if (!barPrefs) return;
    if (isPointShown(i)) delete barPrefs.vis[i];
    else barPrefs.vis[i] = false;
    saveBarPrefs();
  }
  function rememberAllLabels() {
    var app = getApp();
    if (!app || !barPrefs) return;
    app.pointTypes.forEach(function (p, i) { rememberLabel(i); });
  }

  var CARD_BTN_CLASS = 'cyoa-cheat-cardbtn';
  var cardBtnMode = false;
  var cardObserver = null, decorateTimer = null;

  function loadCardPref() {
    try { cardBtnMode = localStorage.getItem('cyoaCheatCardBtn') === '1'; } catch (e) { cardBtnMode = false; }
  }
  function saveCardPref() {
    try { localStorage.setItem('cyoaCheatCardBtn', cardBtnMode ? '1' : '0'); } catch (e) {}
  }

  function makeCardBtn(cid) {
    var b = document.createElement('button');
    b.className = CARD_BTN_CLASS;
    b.type = 'button';
    b.setAttribute('data-cheat-card', cid);
    b.innerHTML = DIE_SVG;
    b.setAttribute('aria-label', 'Cheat options');
    b.style.cssText = 'position:absolute;top:4px;right:4px;z-index:60;width:22px;height:22px;' +
      'padding:0;margin:0;border:none;border-radius:6px;background:rgba(20,20,20,.55);color:#fff;' +
      'line-height:1;cursor:pointer;opacity:.45;display:flex;align-items:center;' +
      'justify-content:center;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none';
    var svg = b.firstChild; if (svg && svg.style) { svg.style.width = '18px'; svg.style.height = '18px'; svg.style.display = 'block'; }
    return b;
  }
  function decorateCard(cardEl) {
    // `:scope >` so a nested card doesn't make the outer one look decorated.
    if (!cardEl || cardEl.querySelector(':scope > .' + CARD_BTN_CLASS)) return;
    var cid = cardIdFromNode(cardEl);
    if (!cid) return;
    if (getComputedStyle(cardEl).position === 'static') { cardEl.style.position = 'relative'; cardEl.setAttribute('data-cheat-pos', '1'); }
    cardEl.appendChild(makeCardBtn(cid));
  }
  function decorateAllCards() {
    if (mode !== 'cheat') return;
    if (gateUnlocked !== true) return;
    var app = getApp();
    if (!app) return;
    app.rows.forEach(function (r) {
      eachChoice(r, function (o) {
        if (o.id == null) return;
        var elm = cardElFor(o.id);
        if (elm) decorateCard(elm);
      });
    });
  }
  function undecorateAllCards() {
    document.querySelectorAll('.' + CARD_BTN_CLASS).forEach(function (b) { b.remove(); });
    document.querySelectorAll('[data-cheat-pos="1"]').forEach(function (c) { c.style.position = ''; c.removeAttribute('data-cheat-pos'); });
  }
  function scheduleDecorate() {
    if (decorateTimer) return;
    decorateTimer = setTimeout(function () { decorateTimer = null; if (cardBtnMode) decorateAllCards(); }, 300);
  }
  function setCardBtnMode(on) {
    cardBtnMode = !!on;
    saveCardPref();
    if (cardBtnMode) {
      decorateAllCards();
      if (!cardObserver && window.MutationObserver) {
        cardObserver = new MutationObserver(scheduleDecorate);
        cardObserver.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
      undecorateAllCards();
    }
  }
  // Handled at document capture — runs BEFORE the card's own capture-phase activateObject — so
  // stopping it prevents an accidental selection.
  function cardBtnInPath(e) {
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.classList && n.classList.contains(CARD_BTN_CLASS)) return n;
    }
    return null;
  }

  // Build capture: readable summary + `code` = comma-separated id list (the classic "build
  // string"). summary.rows lists each section name once; each choice has `r` = index into it. Only
  // row.title is a name (titleText is a paragraph description). Old readers ignore the field.
  var BUILD_ROW_NAME_MAX = 60;
  function buildRowName(r) {
    var name = stripHtml(r.title);
    return name.length > BUILD_ROW_NAME_MAX ? name.slice(0, BUILD_ROW_NAME_MAX - 1) + '…' : name;
  }
  function serializeBuild() {
    var app = getApp(), choices = [], ids = [], rowNames = [], rowIdx = {};
    app.rows.forEach(function (r, i) {
      eachChoice(r, function (o) {
        if (!isChoiceActive(o)) return;
        if (!(i in rowIdx)) { rowIdx[i] = rowNames.length; rowNames.push(buildRowName(r)); }
        // Multi-take count travels both as `n` (readable) and `/ON#n` in code — without the suffix
        // the engine importer takes it zero times.
        var n = choiceTakes(o);
        var c = { id: o.id, title: choiceTitle(o), r: rowIdx[i] };
        if (n) c.n = n;
        var w = choiceWord(o); if (w) c.w = w;
        var img = choiceImage(o); if (img) c.img = img;
        var rnd = choiceRandoms(o); if (rnd) c.rnd = rnd;
        var rs = choiceRandomScores(o); if (rs) c.rs = rs;
        choices.push(c);
        ids.push(nativeToken(c));
      });
    });
    var points = app.pointTypes.map(function (p, i) {
      return { name: currentLabel(i) || p.name || ('Points ' + (i + 1)), value: p.startingSum };
    });
    // Bare-comma join = ICC's native Build Form import format (round-trips through native loader
    // and manual paste).
    return { count: choices.length, code: ids.join(','),
      summary: { count: choices.length, points: points, rows: rowNames, choices: choices } };
  }

  function hostname(origin) { try { return new URL(origin).hostname; } catch (e) { return ''; } }
  // Trust only cyoa.cafe (any subdomain) and localhost.
  function allowedHost(o) {
    var h = hostname(o);
    return /(^|\.)cyoa\.cafe$/i.test(h) || /^(localhost|127\.0\.0\.1)$/i.test(h);
  }

  // Parent origin unknown until it replies, hence '*'.
  function announceReady() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'cyoacafe-cheat', kind: 'ready' }, '*');
      }
    } catch (e) {}
  }
  function sendToHost(msg) {
    if (!hostOrigin) return false;
    try {
      msg.source = 'cyoacafe-cheat';
      window.parent.postMessage(msg, hostOrigin);
      return true;
    } catch (e) { return false; }
  }
  // Host upserts by default: re-saving overwrites your one build for this game; forceNew=true adds
  // a second. isPublic true → also posted in the thread; false → private (still unlocks cheats);
  // undefined → keep previous visibility.
  function postBuild(forceNew, isPublic) {
    var b = serializeBuild();
    if (!b.count) { toast('Select at least one card first.'); return; }
    var msg = { kind: 'postBuild', build: { code: b.code, summary: b.summary }, newBuild: !!forceNew };
    if (isPublic !== undefined) msg.isPublic = !!isPublic;
    if (!sendToHost(msg)) {
      toast('Open this game through cyoa.cafe to save a build.');
      return;
    }
    toast('Saving your build…');
  }

  // Loading drives ICC's own Build Form import (stock feature, not gated). Native
  // loadActivated()/selectObjectL reproduces selection IGNORING requirements, unlike a card click
  // (activateObject) which refuses gated cards. loadActivated is a private binding, so we operate
  // its dialog.
  // Svelte bind:value listens to 'input'; assigning .value alone isn't seen.
  function setFieldValue(elm, value) {
    var proto = elm.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(elm, value);
    elm.dispatchEvent(new Event('input', { bubbles: true }));
    elm.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function findFieldByLabel(text) {
    var labels = document.querySelectorAll('.mdc-floating-label, label');
    for (var i = 0; i < labels.length; i++) {
      if ((labels[i].textContent || '').indexOf(text) !== -1) {
        var field = labels[i].closest('.mdc-text-field, label');
        var f = field && field.querySelector('textarea, input');
        if (f) return f;
      }
    }
    return null;
  }
  function findButtonByText(text) {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      if ((bs[i].textContent || '').indexOf(text) !== -1) return bs[i];
    }
    return null;
  }
  function closeOpenDialog() {
    var x = document.querySelector('.mdc-dialog--open [data-mdc-dialog-action]');
    if (x) { x.click(); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  // Import opener only renders when app.importedChoicesIsOpen: force it, open the dialog, fill
  // textarea, click Import.
  function loadViaBuildForm(code) {
    var app = getApp();
    if (!app) return false;
    try { app.importedChoicesIsOpen = true; } catch (e) {}
    var opened = false, tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (!opened) {
        var opener = document.querySelector('[aria-label="Open Import Window"]');
        if (opener) {
          opener.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
          opened = true;
        }
      } else {
        var ta = findFieldByLabel('Area To Import');
        var btn = findButtonByText('Import Choices');
        if (ta && btn) {
          clearInterval(iv);
          setFieldValue(ta, code);
          setTimeout(function () {
            btn.click();
            setTimeout(closeOpenDialog, 60);
            // Older ICC+2 importers put the typed name into the word map but not back onto the
            // card; the next save would silently drop the name. Writing it again is harmless on
            // newer bundles.
            setTimeout(function () { syncWordFields(parseBuildCode(code)); }, 80);
            if (panelOpen) renderPanel();
            toast('Build loaded.');
          }, 40);
          return;
        }
      }
      if (tries > 80) { clearInterval(iv); toast('Could not open the import form.'); }
    }, 50);
    return true;
  }
  function loadByClick(want) {
    var app = getApp();
    if (!app) { toast('Game not ready yet — try again.'); return; }
    var toSelect = [], toDeselect = [], toCount = [];
    app.rows.forEach(function (r) {
      eachChoice(r, function (o) {
        var w = want[o.id];
        // Multi-take cards are driven by their counter: a click does nothing on classic and sets 1
        // take on nuxt. Old builds with a bare id → take once.
        if (o.isSelectableMultiple) {
          toCount.push({ id: o.id, n: w ? (w.n || 1) : 0 });
          return;
        }
        if (w && !isChoiceActive(o)) toSelect.push(o.id);
        else if (!w && isChoiceActive(o)) toDeselect.push(o.id);
      });
    });
    toSelect.forEach(function (id) { forceClickCard(id); });
    toDeselect.forEach(function (id) { forceClickCard(id); });
    toCount.forEach(function (t) { setChoiceTakes(t.id, t.n); });
    // Names/pictures AFTER the clicks: selecting is what gives a card its text field/image slot,
    // and on classic the click resets the picture.
    app.rows.forEach(function (r) {
      eachChoice(r, function (o) {
        var w = want[o.id];
        if (w && (w.w || w.img)) applyChoiceExtras(o, w);
      });
    });
    commitStore();
    if (panelOpen) renderPanel();
    toast('Build loaded (best-effort).');
  }
  // Hand the whole string to classic's own importer (root App `newActivated` + loadActivated()):
  // restores rolled randoms, which clicking can't (clicking re-rolls). Used only when tokens need
  // it; plain selections use the click path (failures visible per card).
  function classicImporterVm() {
    var found = null;
    classicEachVm(function (vm) {
      if (!found && vm && typeof vm.loadActivated === 'function' && 'newActivated' in vm) found = vm;
    });
    return found;
  }
  function loadViaClassicImporter(norm) {
    var vm = classicImporterVm(); if (!vm) return false;
    try {
      vm.newActivated = norm;
      vm.loadActivated();
    } catch (e) { return false; }
    return true;
  }

  // Peel in the engine's order (image, word, roll data): payloads are free text and may contain a
  // later suffix's marker. /RND# and /RS# are dropped: only the native importer can replay rolls.
  function parseBuildCode(norm) {
    var want = {};
    norm.split(',').forEach(function (tok) {
      if (!tok) return;
      var img = '', w = '', i;
      i = tok.indexOf('/IMG#');
      if (i >= 0) { img = tok.slice(i + 5); tok = tok.slice(0, i); }
      i = tok.indexOf('/WORD#');
      if (i >= 0) { w = tok.slice(i + 6); tok = tok.slice(0, i); }
      var id = tok.split('/')[0];
      if (!id) return;
      var m = /\/ON#(-?\d+)/.exec(tok);
      var c = { n: m ? parseInt(m[1], 10) : 0 };
      // Commas inside names/URLs were escaped on export.
      if (w) c.w = w.split('/CHAR#').join(',');
      if (img) c.img = img.split('/CHAR#').join(',');
      want[id] = c;
    });
    return want;
  }
  function codeHasRolls(norm) { return norm.indexOf('/RND#') >= 0 || norm.indexOf('/RS#') >= 0; }
  function applyBuild(code) {
    // Stored strings may use ", "; native import splits on bare comma.
    var norm = String(code || '').replace(/\s*,\s*/g, ',').replace(/^,+|,+$/g, '').trim();
    if (!norm) { toast('This build has no cards to load.'); return; }
    // Only ICC+2 ships the mdc Build Form; elsewhere that path spins for seconds then fails.
    if (engineKind() === 'iccplus2' && loadViaBuildForm(norm)) return;
    if (engineKind() === 'classic' && codeHasRolls(norm) && loadViaClassicImporter(norm)) {
      if (panelOpen) renderPanel();
      toast('Build loaded.');
      return;
    }
    loadByClick(parseBuildCode(norm));
  }
  function onHostMessage(e) {
    var d = e.data;
    if (!d || d.source !== 'cyoacafe-cheat-host') return;
    if (!allowedHost(e.origin)) return;
    var firstContact = !hostOrigin;
    hostOrigin = e.origin;
    if (!hostPresent) {
      hostPresent = true;
      if (standaloneTimer) { clearTimeout(standaloneTimer); standaloneTimer = null; }
    }
    // The bar decision was made before the handshake with no origin to send to. Re-send now
    // (including "no"), else the page keeps its buttons over ours or hides them wrongly.
    if (firstContact) sendToHost({ kind: 'barTakeover', active: barActive() });
    if (d.kind === 'hello') {
      if (d.gameId) currentGameId = d.gameId;
    } else if (d.kind === 'gate') {
      if (d.gameId) currentGameId = d.gameId;
      gateUnlocked = !!d.unlocked;
      onGateResolved();
    } else if (d.kind === 'buildResult') {
      if (d.ok) {
        var wasLocked = gateUnlocked !== true;
        gateUnlocked = true;
        var mentionUnlock = mode === 'cheat' && wasLocked;
        // A note = build saved but part of it wasn't (picture the host couldn't store); tell the
        // player instead of plain success.
        toast(d.note ? d.note : d.isPublic === false
          ? (mentionUnlock ? 'Build saved privately — cheats unlocked!' : 'Build saved (private).')
          : (mentionUnlock ? 'Build posted — cheats unlocked!' : 'Build posted.'));
        onGateResolved();
      } else { toast(d.error || 'Could not save the build.'); }
    } else if (d.kind === 'loadBuild') {
      applyBuild(d.code);
    } else if (d.kind === 'mode') {
      setMode(d.mode === 'cheat' ? 'cheat' : 'save');
    } else if (d.kind === 'viewState') {
      hostView.immersive = !!d.immersive;
      hostView.fullscreen = !!d.fullscreen;
      syncBar();
    }
    if (firstContact) syncBar();
  }
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    updateFab();
    closeCardMenu();
    onGateResolved();
  }
  function onGateResolved() {
    if (gateUnlocked === true && mode === 'cheat') {
      if (cardBtnMode) setCardBtnMode(true);
    } else {
      if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
      undecorateAllCards();
    }
    if (panelOpen) renderPanel();
  }

  var toastEl = null, toastTimer = null;
  function toast(text) {
    if (!root) return;
    if (!toastEl) { toastEl = el('div', 'toast'); root.querySelector('.wrap').appendChild(toastEl); }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.classList.remove('show'); }, 2600);
  }

  var host, root, fab, panel, cardMenu, panelOpen = false, activeTab = 'points', rowQuery = '';

  var FAB_BG = '#7c1d2b';
  var UI_FONTS = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:' + UI_FONTS + ';',
    '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}',
    '.bar,.bar *{font-family:inherit}',
    '.wrap{position:fixed;inset:0;pointer-events:none;z-index:2147483000;color:#dcdcdc}',
    '.wrap>*{pointer-events:auto}',
    '.fab{position:fixed;left:calc(env(safe-area-inset-left,0px) + 14px);',
    'bottom:calc(env(safe-area-inset-bottom,0px) + 10px);',
    'width:40px;height:40px;border-radius:8px;',
    'background:' + FAB_BG + ';color:#fff;border:none;cursor:pointer;',
    'box-shadow:0 2px 10px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:0}',
    '.fab:active{transform:scale(.94)}',
    '.fab svg{width:34px;height:34px;display:block}',
    '.panel{position:fixed;left:0;right:0;bottom:0;max-height:72vh;overflow:auto;',
    'background:#151515;color:#dcdcdc;border-top:1px solid #2b2b2b;border-radius:14px 14px 0 0;',
    'padding:12px 14px 22px;box-shadow:0 -6px 24px rgba(0,0,0,.55);',
    // Extra travel past 100% so an empty sheet can't peek during viewport jitter; visibility:hidden
    // only after the slide-out.
    'transform:translateY(calc(100% + 32px));visibility:hidden;',
    'transition:transform .22s ease,visibility 0s linear .22s}',
    '.panel.open{transform:translateY(0);visibility:visible;transition:transform .22s ease,visibility 0s}',
    '.hd{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}',
    '.hd h3{margin:0;font-size:15px;font-weight:600;color:#fff;flex:none}',
    '.hdhint{flex:1 1 auto;min-width:0;font-size:11px;color:#8a8a8a;line-height:1.3}',
    '.x{background:none;border:none;color:#9a9a9a;font-size:20px;cursor:pointer;line-height:1;padding:4px}',
    '.sec{margin-top:8px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#8a8a8a;margin-bottom:6px}',
    '.prow{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}',
    '.prow.dim{opacity:.5}',
    '.pname{flex:1;min-width:0;font-size:13px;color:#dcdcdc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.porig{font-size:10px;color:#777;margin:-2px 0 6px 42px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pvals{display:flex;gap:6px;align-items:center}',
    'input.pedit{flex:1 1 110px;min-width:80px;background:#0b0b0b;border:1px solid #2b2b2b;color:#dcdcdc;',
    'border-radius:8px;padding:7px 8px;font-size:13px}',
    'input.pedit:focus{outline:none;border-color:#fc3447}',
    'input.num{width:52px;background:#0b0b0b;border:1px solid #2b2b2b;color:#fff;border-radius:8px;',
    'padding:7px 4px;font-size:14px;text-align:center}',
    'input.num:focus{outline:none;border-color:#fc3447}',
    'input.color{width:40px;height:32px;padding:2px;background:#0b0b0b;border:1px solid #2b2b2b;',
    'border-radius:8px;cursor:pointer}',
    '.btn{background:#1c1c1c;border:1px solid #333;color:#dcdcdc;border-radius:8px;padding:8px 10px;',
    'font-size:13px;cursor:pointer;white-space:nowrap}',
    '.btn:active{background:#262626}',
    '.btn.p{background:#fc3447;border-color:#fc3447;color:#fff}',
    '.btn.p:active{background:#e02b3d}',
    '.btn.sm{padding:6px 9px;font-size:12px}',
    '.btn.icon{width:34px;height:34px;padding:0;font-size:16px;display:flex;align-items:center;justify-content:center}',
    '.presets{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}',
    '.seg{display:flex;gap:4px;background:#0b0b0b;border:1px solid #2b2b2b;border-radius:9px;padding:3px;margin:2px 0 6px}',
    '.seg button{flex:1;background:none;border:none;color:#9a9a9a;font-size:13px;font-weight:600;',
    'padding:7px 10px;border-radius:6px;cursor:pointer}',
    '.seg button.active{background:#fc3447;color:#fff}',
    '.prow .seg{margin:0;flex:0 0 auto}',
    '.body{margin-top:2px}',
    '.desc{font-size:11px;color:#9a9a9a;margin:1px 0 6px;display:-webkit-box;-webkit-line-clamp:3;',
    '-webkit-box-orient:vertical;overflow:hidden;line-height:1.35}',
    '.ritem{border:1px solid #262626;border-radius:10px;padding:9px 10px;margin:8px 0;background:#0f0f0f}',
    '.rtitle{font-size:13px;color:#eee;margin-bottom:4px;display:flex;gap:6px;align-items:center;flex-wrap:nowrap}',
    '.rname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rreq{font-size:11px;color:#d0a24e;margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.meta{font-size:11px;color:#8a8a8a;margin-bottom:6px}',
    '.badge{font-size:10px;background:rgba(252,52,71,.16);color:#ff8a94;border-radius:5px;padding:1px 6px}',
    '.ractions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.cardmenu{position:fixed;z-index:2147483001;width:min(280px,92vw);background:#151515;color:#dcdcdc;',
    'border:1px solid #333;border-radius:12px;padding:10px 12px;box-shadow:0 8px 28px rgba(0,0,0,.6)}',
    '.cmtitle{font-size:13px;font-weight:600;margin-bottom:2px;color:#fff;padding-right:18px}',
    '.cmstate{font-size:11px;color:#8a8a8a;margin-bottom:8px}',
    '.cmbtns{display:flex;flex-wrap:wrap;gap:6px}',
    '.hint{font-size:11px;color:#777;margin-top:8px}',
    '.locked{padding:6px 2px 4px}',
    '.lockttl{font-size:15px;font-weight:600;color:#fff;margin-bottom:6px}',
    '.lockmsg{font-size:13px;color:#c9c9c9;line-height:1.4;margin-bottom:8px}',
    '.lockmeta{font-size:12px;color:#8a8a8a;margin-bottom:10px}',
    '.toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%) translateY(8px);',
    'max-width:80vw;background:#0b0b0b;color:#fff;border:1px solid #333;border-radius:10px;',
    'padding:9px 14px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.6);opacity:0;',
    'pointer-events:none;transition:opacity .2s,transform .2s;text-align:center;z-index:2147483002}',
    '.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.panel,.cardmenu{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}',
    '.panel::-webkit-scrollbar,.cardmenu::-webkit-scrollbar{width:8px;height:8px}',
    '.panel::-webkit-scrollbar-track,.cardmenu::-webkit-scrollbar-track{background:transparent}',
    '.panel::-webkit-scrollbar-thumb,.cardmenu::-webkit-scrollbar-thumb{',
    'background:rgba(255,255,255,.12);border-radius:8px;border:2px solid transparent;background-clip:padding-box}',
    '.panel::-webkit-scrollbar-thumb:hover,.cardmenu::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.26)}',
    '.bar{position:fixed;left:0;right:0;bottom:0;display:flex;align-items:center;gap:8px;',
    'padding:6px calc(env(safe-area-inset-right,0px) + 8px) calc(env(safe-area-inset-bottom,0px) + 6px) ',
    'calc(env(safe-area-inset-left,0px) + 8px);',
    'border-top:1px solid var(--line,rgba(255,255,255,.10));box-shadow:0 -4px 18px rgba(0,0,0,.45)}',
    '.bar .chips{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;justify-content:center;',
    'align-content:center;',
    // `safe center` degrades to flex-start on overflow; plain `center` clips the first AND last row
    // out of scroll reach. Keep both declarations (fallback for engines without `safe`).
    'align-content:safe center;',
    'gap:2px 10px;max-height:calc(5.2em + 6px);overflow-y:auto;overscroll-behavior:contain;',
    'scrollbar-width:thin;scrollbar-color:var(--btnbd,rgba(255,255,255,.18)) transparent}',
    // WebKit paints its default light track unless the track is styled too (white stripe next to
    // long point lists).
    '.bar .chips::-webkit-scrollbar{width:8px}',
    '.bar .chips::-webkit-scrollbar-track{background:transparent}',
    '.bar .chips::-webkit-scrollbar-corner{background:transparent}',
    '.bar .chips::-webkit-scrollbar-thumb{background:var(--btnbd,rgba(255,255,255,.16));',
    'border-radius:8px;border:2px solid transparent;background-clip:padding-box}',
    '.bar .chips::-webkit-scrollbar-thumb:hover{background:var(--hi,rgba(255,255,255,.3));',
    'background-clip:padding-box}',
    '.bar .chip{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;line-height:1.3}',
    '.bar .clbl{opacity:.85}',
    '.bar .cval{font-weight:700;font-variant-numeric:tabular-nums}',
    '.bar .cicon{max-height:1.4em;width:auto;display:block}',
    '.bar .bbtns{flex:0 0 auto;display:flex;align-items:center;gap:6px}',
    '.bar .fab{position:static;width:32px;height:32px;border-radius:7px;box-shadow:none}',
    '.bar .fab svg{width:26px;height:26px}',
    '.bar .btn.icon{width:32px;height:32px;font-size:15px;color:var(--icon,inherit);',
    'background:var(--btnbg,rgba(255,255,255,.07));border-color:var(--btnbd,rgba(255,255,255,.16))}',
    '.bar .btn.icon svg{width:18px;height:18px;display:block;fill:currentColor}',
    '.bar .btn.fs{background:' + FAB_BG + ';border-color:transparent;color:#fff}',
    '.bar .btn.fs.on{background:var(--btnbg,rgba(255,255,255,.07));',
    'border-color:var(--btnbd,rgba(255,255,255,.16));color:var(--fg,inherit)}',
    '.wrap.hasbar .panel{padding-bottom:calc(env(safe-area-inset-bottom,0px) + 76px)}',
    '.wrap.hasbar .toast{bottom:104px}',
    '@media (min-width:700px){',
    '.panel{left:calc(env(safe-area-inset-left,0px) + 14px);right:auto;',
    'width:400px;max-width:calc(100vw - 28px);max-height:min(72vh,640px);',
    'bottom:calc(env(safe-area-inset-bottom,0px) + 60px);',
    'border:1px solid #2b2b2b;border-radius:14px;padding-bottom:14px;',
    'transform:translateY(calc(100% + 128px))}',
    '.panel.open{transform:translateY(0)}',
    '.wrap.hasbar .panel{bottom:calc(env(safe-area-inset-bottom,0px) + 92px);padding-bottom:14px}',
    '}'
  ].join('');

  var FAB_RED = '#fc3447';
  // viewBox cropped to the die's bounds so the art fills the button. Faces painted the button's
  // colour (cut-out look); pips stay currentColor.
  function dieSvg(face) {
  return '<svg viewBox="30 32 140 140" fill="none" aria-hidden="true" focusable="false">' +
    '<path d="M 91.34,40 Q 100,35 108.66,40 L 149.34,63.5 Q 158,68.5 158,78.5 L 158,125.5 ' +
      'Q 158,135.5 149.34,140.5 L 108.66,164 Q 100,169 91.34,164 L 50.66,140.5 ' +
      'Q 42,135.5 42,125.5 L 42,78.5 Q 42,68.5 50.66,63.5 Z" ' +
      'fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<g transform="matrix(-0.58,-0.335,0,0.67,100,102)">' +
      '<rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill="' + face + '"/>' +
      '<circle cx="22" cy="28" r="10" fill="currentColor"/><circle cx="50" cy="28" r="10" fill="currentColor"/><circle cx="78" cy="28" r="10" fill="currentColor"/>' +
      '<circle cx="22" cy="72" r="10" fill="currentColor"/><circle cx="50" cy="72" r="10" fill="currentColor"/><circle cx="78" cy="72" r="10" fill="currentColor"/>' +
    '</g>' +
    '<g transform="matrix(0.58,-0.335,0,0.67,100,102)">' +
      '<rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill="' + face + '"/>' +
      '<circle cx="28" cy="22" r="10" fill="currentColor"/><circle cx="28" cy="50" r="10" fill="currentColor"/><circle cx="28" cy="78" r="10" fill="currentColor"/>' +
      '<circle cx="72" cy="22" r="10" fill="currentColor"/><circle cx="72" cy="50" r="10" fill="currentColor"/><circle cx="72" cy="78" r="10" fill="currentColor"/>' +
    '</g>' +
    '<g transform="matrix(-0.58,-0.335,0.58,-0.335,100,102)">' +
      '<rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill="' + face + '"/>' +
      '<circle cx="28" cy="22" r="10" fill="currentColor"/><circle cx="28" cy="50" r="10" fill="currentColor"/><circle cx="28" cy="78" r="10" fill="currentColor"/>' +
      '<circle cx="72" cy="22" r="10" fill="currentColor"/><circle cx="72" cy="50" r="10" fill="currentColor"/><circle cx="72" cy="78" r="10" fill="currentColor"/>' +
    '</g>' +
    '</svg>';
  }
  var DIE_SVG = dieSvg(FAB_RED);

  var BUILD_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<path d="M18 9l-1.41-1.42L10 14.17l-2.59-2.58L6 13l4 4zM19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5' +
    'c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 ' +
    '.45-1 1-1z"/></svg>';

  function viewSvg(d) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  }
  var ICON_EXPAND   = viewSvg('M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z');
  var ICON_COLLAPSE = viewSvg('M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59z');
  var ICON_FS       = viewSvg('M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z');
  var ICON_FS_EXIT  = viewSvg('M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z');

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function build() {
    host = document.createElement('div');
    host.id = 'cyoa-cheat-host';
    root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style'); style.textContent = CSS; root.appendChild(style);

    var wrap = el('div', 'wrap');

    fab = el('button', 'fab');
    fab.addEventListener('click', function () { panelOpen ? closePanel() : openPanel(); });
    wrap.appendChild(fab);
    updateFab();

    panel = el('div', 'panel');
    wrap.appendChild(panel);

    root.appendChild(wrap);
    document.body.appendChild(host);
    styleHostScrollbar();
  }

  // Games scroll a nested full-viewport container, not html/body, so style ALL scrollbars in the
  // game document; appended last in <head> to win on equal specificity. Re-run from syncBar()
  // (~150ms) so mid-game bar changes re-theme; hostScrollbarSig skips no-op writes.
  var hostScrollbarSig = '';
  function styleHostScrollbar() {
    try {
      var t = barStyleValues();
      var sig = t.btnBd + '\x01' + t.hi;
      if (sig === hostScrollbarSig) return;
      hostScrollbarSig = sig;

      var s = document.getElementById('cyoa-scrollbar-style');
      if (!s) {
        s = document.createElement('style');
        s.id = 'cyoa-scrollbar-style';
        (document.head || document.documentElement).appendChild(s);
      }
      s.textContent =
        '*{scrollbar-width:thin;scrollbar-color:' + t.btnBd + ' transparent}' +
        '::-webkit-scrollbar{width:10px;height:10px}' +
        '::-webkit-scrollbar-track{background:transparent}' +
        '::-webkit-scrollbar-corner{background:transparent}' +
        '::-webkit-scrollbar-thumb{' +
        'background:' + t.btnBd + ';border-radius:8px;border:2px solid transparent;background-clip:padding-box}' +
        '::-webkit-scrollbar-thumb:hover{background:' + t.hi + ';background-clip:padding-box}';
    } catch (e) { }
  }

  // Custom point bar: the engine bar is one unwrapped line, so on phones long point names fall
  // off-screen; ours wraps chips and adopts the engine's icon buttons.
  // 1) The native bar is HIDDEN, never removed: `.pointbar-icons` is the only anchor for
  // save/load/export/import dialogs (openGameMenu/applyBuild); a detached node can't be
  // synth-clicked.
  // 2) Take over only when barCompatible() proves we read the same numbers the native bar shows.
  // Any doubt → author's bar stays.
  var bar = null;
  var barCompat = null;
  var barSig = '';
  var barTimer = null;
  var nativeBarEl = null;

  function nativeIconButtons() {
    var icons = Array.prototype.slice.call(document.querySelectorAll('.pointbar-icons'));
    if (icons.length) return icons;
    // Non-ICC+2 generations ship unlabelled icon buttons: take clickable leaves inside the bar
    // (classic has mdi-format-list-checks and mdi-checkbox-marked-circle-outline).
    var nb = findNativeBar();
    if (!nb) return [];
    return Array.prototype.slice.call(nb.querySelectorAll('button, [role=button], .v-btn'))
      .filter(function (b) {
        if (b.querySelector('button, [role=button], .v-btn')) return false;
        var r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
  }

  // Finding the bar: class names only work on ICC+2. Classic (Vue 2 + Vuetify, most of the
  // catalogue) renders points in .v-bottom-navigation with no "pointbar" class — class search found
  // it on 2 of 40 live games. Anchors first, then a generic search by what the node CONTAINS.
  function findNativeBar() {
    if (nativeBarEl && nativeBarEl.isConnected) return nativeBarEl;
    var needles = pointNeedles();
    var a = barFromAnchors();
    // ICC+2 puts icon buttons in a different <section> whose class also matches /app-?bar/; the
    // anchor walk stops one level short on a strip without point text. Trust it only if it holds
    // the points.
    if (a && (!needles.length || holdsAllPoints(a, needles))) { nativeBarEl = a; return a; }
    nativeBarEl = barFromPointText() || a;
    return nativeBarEl;
  }

  function barFromAnchors() {
    var seed = document.querySelector('.pointbar-icons') ||
      document.querySelector('[class*=pointbar-center]');
    if (!seed) return null;
    var node = seed;
    for (var i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      var cls = String(node.className || '');
      if (/app-?bar|toolbar|pointbar/i.test(cls) || node.tagName === 'HEADER' || node.tagName === 'NAV') {
        return node;
      }
    }
    return seed.parentElement || seed;
  }

  function pointNeedles() {
    var app = getApp(), out = [];
    if (!app) return out;
    app.pointTypes.forEach(function (p, i) {
      if (!isPointShown(i)) return;
      out.push({ lbl: currentLabel(i), val: fmtPointValue(p) });
    });
    // Nothing counts as shown but the engine may still draw a bar (build ignoring its hide flag):
    // fall back to all points to locate it; calibrateVisibility() judges.
    if (!out.length) {
      app.pointTypes.forEach(function (p, i) {
        out.push({ lbl: currentLabel(i), val: fmtPointValue(p) });
      });
    }
    return out;
  }

  // Store fields are a guess (some classic builds carry isNotShownPointBar and ignore it; others
  // gate every point and print them anyway). The author's bar is evidence: overrule only when EVERY
  // point we call hidden is printed there, label+value adjacent. Measure before touching the store.
  // Visible text via Range (counts text in 0×0 wrappers; display:none/visibility:hidden yield
  // nothing).
  function visibleText(root) {
    var out = '', painted = false;
    try {
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false), tn, rng, rects, i, cs;
      while ((tn = w.nextNode())) {
        if (!tn.nodeValue || !tn.nodeValue.trim() || !tn.parentElement) continue;
        cs = window.getComputedStyle(tn.parentElement);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        rng = document.createRange();
        rng.selectNodeContents(tn);
        rects = rng.getClientRects();
        for (i = 0; i < rects.length; i++) {
          if (rects[i].width > 0 && rects[i].height > 0) { painted = true; break; }
        }
        rng.detach && rng.detach();
        if (i < rects.length) out += tn.nodeValue;
      }
    } catch (e) { return (root.textContent || '').replace(/\s+/g, ''); }
    return painted ? out.replace(/\s+/g, '') : null;
  }

  function calibrateVisibility() {
    var app = getApp();
    if (!app || visCalibrated) return;
    var pts = app.pointTypes, i, p, judgeable = [];
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (isPointShown(i)) continue;
      if (p.activatedId === VIS_SENTINEL) continue;
      var lbl = currentLabel(i);
      if (!lbl) continue;
      judgeable.push([(lbl + fmtPointValue(p)).replace(/\s+/g, ''),
                      (fmtPointValue(p) + lbl).replace(/\s+/g, '')]);
    }
    if (!judgeable.length) return;
    var nb = findNativeBar();
    if (!nb) return;
    // PAINTED text only, not textContent: engines keep hidden ending counters in markup behind CSS;
    // textContent sees 24 where the player sees 4.
    var t = visibleText(nb);
    if (t === null) return;
    for (i = 0; i < judgeable.length; i++) {
      if (t.indexOf(judgeable[i][0]) === -1 && t.indexOf(judgeable[i][1]) === -1) {
        visCalibrated = true; return;
      }
    }
    visAll = true;
    visCalibrated = true;
    nativeBarEl = null;
  }
  function holdsAllPoints(node, needles) {
    var t = (node.textContent || '').replace(/\s+/g, ' ');
    for (var i = 0; i < needles.length; i++) {
      if (t.indexOf(needles[i].val) === -1) return false;
      if (needles[i].lbl && t.indexOf(needles[i].lbl) === -1) return false;
    }
    return true;
  }

  function barFromPointText() {
    var needles = pointNeedles();
    if (!needles.length) return null;
    // Search on the longest label; short ones match half the page. Names also appear in card text,
    // so these are start points to walk up from.
    var key = '';
    needles.forEach(function (n) { if (n.lbl && n.lbl.length > key.length) key = n.lbl; });
    if (!key) key = needles[0].val;
    if (!key) return null;
    // Walk text nodes: textContent on every element re-serializes huge subtrees.
    var cands = [];
    try {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      while (cands.length < 60 && w.nextNode()) {
        var tn = w.currentNode;
        if (tn.nodeValue && tn.nodeValue.indexOf(key) !== -1 && tn.parentElement) {
          cands.push(tn.parentElement);
        }
      }
    } catch (e) { return null; }
    var vh = window.innerHeight || 800, vw = window.innerWidth || 400;
    var best = null, bestScore = -1;
    cands.forEach(function (c) {
      var node = c;
      for (var i = 0; i < 10 && node && node !== document.body; i++) {
        var r = node.getBoundingClientRect();
        if (r.height > vh * 0.45) break;
        // Don't stop at zero-sized nodes: engines wrap point text in 0×0 spans (display:contents /
        // clipped); the bar is 1–2 levels up.
        if (r.height && r.width >= vw * 0.5 && holdsAllPoints(node, needles)) {
          var cs = window.getComputedStyle(node), sc = 0;
          if (cs.position === 'fixed' || cs.position === 'sticky') sc += 4;
          if (Math.round(r.bottom) >= vh - 4 || Math.round(r.top) <= 4) sc += 2;
          sc += Math.max(0, 2 - r.height / 60);
          if (sc > bestScore) { bestScore = sc; best = node; }
        }
        node = node.parentElement;
      }
    });
    return best;
  }

  // Takeover safety check: every value (and non-empty label) we'd show must already appear in the
  // native bar's text; an unseen engine whose store we misread simply fails here. MUST run before
  // replayBarPrefs() on a pristine store+DOM (re-renders are async; a fresh rename would fail
  // spuriously). The author's bar decides which points are visible (hidden ending counters live in
  // its markup behind CSS). One shot, while the native bar is still visible — after collapse
  // nothing paints there.
  function calibrateScreenVisibility(nb) {
    var app = getApp();
    if (!app || screenCalibrated) return;
    var t = visibleText(nb);
    if (t === null) return;
    var hide = {}, kept = 0;
    app.pointTypes.forEach(function (p, i) {
      if (!isPointShownByModel(i)) return;
      var lbl = currentLabel(i).replace(/\s+/g, '');
      if (t.indexOf(fmtPointValue(p).replace(/\s+/g, '')) !== -1 &&
          (!lbl || t.indexOf(lbl) !== -1)) { kept++; return; }
      hide[i] = true;
    });
    // Nothing matched → we're reading this bar wrong (icon labels, canvas, unknown value format).
    // Don't hide everything on that basis; keep the model's answer.
    if (!kept) return;
    screenHidden = hide;
    screenCalibrated = true;
  }

  function barCompatible() {
    var app = getApp();
    if (!app || !app.pointTypes.length) return false;
    var nb = findNativeBar();
    if (!nb) return false;
    calibrateScreenVisibility(nb);
    var txt = (nb.textContent || '').replace(/\s+/g, ' ');
    var shown = 0, ok = 0;
    app.pointTypes.forEach(function (p, i) {
      if (!isPointShown(i)) return;
      shown++;
      if (txt.indexOf(fmtPointValue(p)) === -1) return;
      var lbl = currentLabel(i);
      if (lbl && txt.indexOf(lbl) === -1) return;
      ok++;
    });
    return shown > 0 && ok === shown;
  }

  var NATIVE_HIDE_ID = 'cyoa-nativebar-style';
  // Collapsed, not display:none (rule 1): dispatchEvent skips hit-testing so zero-height
  // transparent nodes still take programmatic clicks; detached/undisplayed subtrees are riskier for
  // engines that read layout before opening dialogs. Verified: ICC+ drawer and all its dialogs
  // render at the ROOT of ViewerMain.svelte, classic ICC dialogs on Vuetify's app root — collapsing
  // the bar can't swallow them. Symptom if some engine nests its popup in the bar: "game menu opens
  // but nothing visible" → exclude that engine here, don't un-collapse for all.
  var nativeInlineSaved = null;
  // border-width too: with border-box a zero height still paints the author's border (2px sliver on
  // "The Obelisk").
  var NATIVE_HIDE_PROPS = ['height', 'min-height', 'padding-top', 'padding-bottom',
                           'margin', 'border-width'];
  function setNativeBarHidden(hide) {
    var nb = findNativeBar();
    if (nb) {
      if (hide) {
        // Some authors ship `height:…!important` for the bar in a <style> the engine appends AFTER
        // ours (wins on order). Inline !important beats any stylesheet; keep the rule as backup.
        if (nb.getAttribute('data-cyoa-nativebar') !== 'off') {
          nativeInlineSaved = nb.getAttribute('style') || '';
        }
        nb.setAttribute('data-cyoa-nativebar', 'off');
        NATIVE_HIDE_PROPS.forEach(function (k) { nb.style.setProperty(k, '0', 'important'); });
        nb.style.setProperty('overflow', 'hidden', 'important');
        nb.style.setProperty('opacity', '0', 'important');
        nb.style.setProperty('pointer-events', 'none', 'important');
      } else {
        nb.removeAttribute('data-cyoa-nativebar');
        if (nativeInlineSaved !== null) {
          if (nativeInlineSaved) nb.setAttribute('style', nativeInlineSaved);
          else nb.removeAttribute('style');
          nativeInlineSaved = null;
        }
      }
    }
    var s = document.getElementById(NATIVE_HIDE_ID);
    if (!hide) { if (s) s.remove(); return; }
    if (s) return;
    s = document.createElement('style');
    s.id = NATIVE_HIDE_ID;
    s.textContent = '[data-cyoa-nativebar=off]{height:0!important;min-height:0!important;' +
      'padding-top:0!important;padding-bottom:0!important;margin:0!important;' +
      'border-width:0!important;' +
      'overflow:hidden!important;opacity:0!important;pointer-events:none!important}';
    (document.head || document.documentElement).appendChild(s);
  }

  function barActive() { return barPrefs && barPrefs.mode === 'custom' && barCompat === true; }

  // One verdict at init is too early: engines hydrate async and "not painted yet" looks like
  // "misread store" — that alone lost a third of the catalogue. Retry for a few seconds (~10s); a
  // false verdict is cheap to revisit, a wrong takeover isn't.
  var compatTries = 0, compatTimer = null;
  function scheduleCompatRetry() {
    if (compatTimer) return;
    compatTimer = setInterval(function () {
      compatTries++;
      nativeBarEl = null;
      calibrateVisibility();
      if (barCompatible()) {
        barCompat = true;
        clearInterval(compatTimer); compatTimer = null;
        applyBarMode();
        renderPanel();
      } else if (compatTries >= 20) {
        clearInterval(compatTimer); compatTimer = null;
      }
    }, 500);
  }

  // Fullscreen requested from INSIDE the iframe: the embed has allow="fullscreen"
  // (GameContent.tsx), so a real tap here is user activation. Routing via the parent loses
  // activation (doesn't survive postMessage). iOS Safari (iPhone) has no element fullscreen → ask
  // the parent for its CSS immersive mode (not activation-gated).
  function fsElement() { return document.documentElement; }
  function fsSupported() {
    var e = fsElement();
    return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) &&
      !!(e.requestFullscreen || e.webkitRequestFullscreen);
  }
  function fsActive() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function toggleFullscreen() {
    try {
      if (fsSupported()) {
        if (fsActive()) {
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else {
          var e = fsElement();
          (e.requestFullscreen || e.webkitRequestFullscreen).call(e);
        }
        return;
      }
    } catch (err) { }
    if (!sendToHost({ kind: 'fullscreen' })) toast('Fullscreen is not available here.');
  }

  // "Expand to the page" = the other page-drawn button: site chrome folds away, game fills the
  // viewport inside the page. Only the parent can do that; it reports back via `viewState`. Our bar
  // makes the page hide its buttons, so we must offer both.
  var hostView = { immersive: false, fullscreen: false };
  function expandAvailable() { return hostPresent && !!hostOrigin; }
  function toggleExpand() {
    if (!sendToHost({ kind: 'expand' })) toast('Open this game through cyoa.cafe to expand it.');
  }
  // Parent-side state counts too: an iframe in fullscreen makes the PARENT's fullscreenElement the
  // iframe; the iOS fallback is the parent's immersive mode, invisible from here.
  function fsOn() { return fsActive() || hostView.fullscreen; }

  function buildBar() {
    bar = el('div', 'bar');
    root.querySelector('.wrap').appendChild(bar);
  }

  // Don't clone the engine's <i class="mdi …">: its webfont rule lives in the game document and
  // doesn't reach the shadow root (blank box). Classic bar buttons have no aria-label; the mdi
  // class is the only hint.
  function proxyGlyph(label, node) {
    if (/backpack/i.test(label)) return '🎒';
    if (/import|list|menu|save|load/i.test(label)) return '☰';
    var mdi = '';
    if (node) {
      var ic = node.querySelector('[class*="mdi-"]') || node;
      var m = String(ic.className || '').match(/mdi-[a-z0-9-]+/);
      if (m) mdi = m[0];
    }
    if (/backpack|bag/.test(mdi)) return '🎒';
    if (/list|format-list/.test(mdi)) return '≣';
    if (/check/.test(mdi)) return '✔';
    if (/cog|settings/.test(mdi)) return '⚙';
    if (/menu|dots/.test(mdi)) return '☰';
    if (/save|download|upload|import|export/.test(mdi)) return '💾';
    return '•';
  }

  // Authors restyle the number via their own CSS, not app.styling (Gyaru Glam: bar font Pinlock has
  // blank digits 3-9, a loading.css rule swaps the value to another font). Styling alone → invisible
  // number. Copy the native value leaf's computed font (+ its size relative to the parent, clamped)
  // only when set on the leaf itself — an inherited bar font is already handled by authorFont.
  function nativeValueFont(p) {
    var nb = findNativeBar();
    var want = fmtPointValue(p);
    if (!nb || !want) return null;
    var leaves = nb.querySelectorAll('span, div, b, strong, i, em');
    for (var i = 0; i < leaves.length; i++) {
      var e = leaves[i];
      if (e.children.length || !e.parentElement || (e.textContent || '').trim() !== want) continue;
      var cs = getComputedStyle(e), up = getComputedStyle(e.parentElement);
      if (!cs.fontFamily || cs.fontFamily === up.fontFamily) return null;
      var k = parseFloat(cs.fontSize) / parseFloat(up.fontSize);
      k = isFinite(k) ? Math.round(Math.min(2, Math.max(0.5, k)) * 100) / 100 : 1;
      return { family: cs.fontFamily, scale: k };
    }
    return null;
  }

  function renderBar() {
    if (!bar) return;
    var app = getApp();
    if (!app) return;
    bar.innerHTML = '';

    var chips = el('div', 'chips');
    app.pointTypes.forEach(function (p, i) {
      if (!isPointShown(i)) return;
      var chip = el('div', 'chip');
      var src = pointIconSrc(p);
      if (src) {
        var im = document.createElement('img');
        im.className = 'cicon';
        im.src = src;
        im.alt = '';
        // Not the author's iconWidth/iconHeight: those match their font size; ours is
        // user-scalable. CSS caps it.
        chip.appendChild(im);
      }
      var col = pointColors(p);
      if (col.label) chip.style.color = col.label;
      var lbl = currentLabel(i);
      if (lbl) chip.appendChild(el('span', 'clbl', lbl));
      var val = el('span', 'cval', fmtPointValue(p));
      if (col.value) val.style.color = col.value;
      var vf = barPrefs.skin !== 'dark' && nativeValueFont(p);
      if (vf) {
        val.style.fontFamily = vf.family + ',' + UI_FONTS;
        if (vf.scale !== 1) val.style.fontSize = vf.scale + 'em';
      }
      chip.appendChild(val);
      chips.appendChild(chip);
    });

    var left = el('div', 'bbtns'), right = el('div', 'bbtns');
    if (fab) left.appendChild(fab);
    if (barPrefs.icc !== false) {
      nativeIconButtons().forEach(function (nb, idx) {
        var label = nb.getAttribute('aria-label') || 'Game button';
        var pb = el('button', 'btn icon', proxyGlyph(label, nb));
        pb.title = label;
        pb.addEventListener('click', function () { fireClick(nb); });
        (idx === 0 ? left : right).appendChild(pb);
      });
    }
    var on = fsOn();
    if (expandAvailable() && !on) {
      var ex = el('button', 'btn icon');
      ex.innerHTML = hostView.immersive ? ICON_COLLAPSE : ICON_EXPAND;
      ex.title = hostView.immersive ? 'Back to the page' : 'Expand to the page';
      ex.addEventListener('click', function () { toggleExpand(); });
      right.appendChild(ex);
    }
    if (!hostView.immersive || on) {
      var fs = el('button', 'btn icon fs' + (on ? ' on' : ''));
      fs.innerHTML = on ? ICON_FS_EXIT : ICON_FS;
      fs.title = on ? 'Exit fullscreen' : 'Fullscreen';
      fs.addEventListener('click', function () { toggleFullscreen(); setTimeout(syncBar, 120); });
      right.appendChild(fs);
    }
    bar.appendChild(left);
    bar.appendChild(chips);
    bar.appendChild(right);

    applyBarStyle();
  }

  // Resolved live on every render: player's picks > author's > ours. A choice can repaint the bar
  // mid-game (ICC changePointBar writes into app.styling).
  function barStyleValues() {
    var s = styling();
    var author = barPrefs.skin !== 'dark';
    var bg = barBgCss();
    var fg = barPrefs.fg || readable(author ? toCss(s.barTextColor) : '', defaultFg());
    var t = rgbaOf(fg) || { r: 220, g: 220, b: 220, a: 1 };
    var soft = function (a) {
      return 'rgba(' + (t.r | 0) + ',' + (t.g | 0) + ',' + (t.b | 0) + ',' + a + ')';
    };
    // barIconColor exists on ICC+ builds only.
    var icon = (author && !barPrefs.fg && readable(toCss(s.barIconColor), '')) || fg;
    return {
      bg: bg, fg: fg, icon: icon,
      font: author ? authorFont(s) : '',
      size: barPrefs.font || (author ? authorFontSize(s) : 0) || 13,
      line: soft(0.18), btnBg: soft(0.09), btnBd: soft(0.24), hi: soft(0.4),
    };
  }
  // @font-face from the game document does reach the shadow root, but an unresolvable name must not
  // fall back to browser serif.
  function authorFont(s) {
    var f = typeof s.barTextFont === 'string' ? s.barTextFont.trim() : '';
    if (!f || /^(inherit|initial|unset)$/i.test(f)) return '';
    return '"' + f.replace(/["\\;]/g, '') + '",' + UI_FONTS;
  }
  // Author size clamped: desktop-made games can carry a 30px bar that eats a third of a phone.
  function authorFontSize(s) {
    var n = parseFloat(s.barTextSize);
    if (!isFinite(n) || n <= 0) return 0;
    var cap = (window.innerWidth || 400) < 520 ? 15 : 20;
    return Math.min(cap, Math.max(10, Math.round(n)));
  }
  function applyBarStyle() {
    if (!bar) return;
    var t = barStyleValues();
    bar.style.color = t.fg;
    bar.style.background = t.bg;
    bar.style.fontSize = t.size + 'px';
    bar.style.fontFamily = t.font || UI_FONTS;
    bar.style.setProperty('--fg', t.fg);
    bar.style.setProperty('--icon', t.icon);
    bar.style.setProperty('--line', t.line);
    bar.style.setProperty('--btnbg', t.btnBg);
    bar.style.setProperty('--btnbd', t.btnBd);
    bar.style.setProperty('--hi', t.hi);
  }

  // We live outside the engine's reactivity (runes / Vue 2 / Pinia differ): poll a cheap
  // visible-state signature every 150ms, re-render only on change.
  function barSignature() {
    var app = getApp();
    if (!app) return '';
    var out = [];
    app.pointTypes.forEach(function (p, i) {
      if (!isPointShown(i)) return;
      var col = pointColors(p);
      out.push(i + '' + currentLabel(i) + '' + fmtPointValue(p) +
        '' + col.label + '' + col.value + '' + (pointIconSrc(p) || ''));
    });
    var t = barStyleValues();
    out.push([t.bg, t.fg, t.icon, t.font, t.size].join(''));
    out.push((fsOn() ? 'fs' : '') + (hostView.immersive ? 'im' : '') +
      (expandAvailable() ? 'ex' : ''));
    return out.join('');
  }
  function syncBar() {
    styleHostScrollbar();

    if (!barActive()) return;
    // Vue/Svelte can swap the bar node on re-render; the new node lacks our collapse attribute →
    // re-assert (re-search only when the node changed).
    if (!nativeBarEl || !nativeBarEl.isConnected ||
        nativeBarEl.getAttribute('data-cyoa-nativebar') !== 'off') {
      nativeBarEl = null;
      setNativeBarHidden(true);
    }
    var sig = barSignature();
    if (sig === barSig) return;
    barSig = sig;
    renderBar();
  }

  function applyBarMode() {
    var active = barActive();
    setNativeBarHidden(active);
    var wrap = root.querySelector('.wrap');
    if (active) {
      if (!bar) buildBar();
      bar.style.display = '';
      barSig = '';
      syncBar();
    } else {
      if (bar) bar.style.display = 'none';
      if (fab && fab.parentNode !== wrap) wrap.appendChild(fab);
    }
    if (wrap) wrap.classList.toggle('hasbar', active);
    // The page's expand/fullscreen buttons sit OVER the iframe in the corner our bar uses and
    // swallow our clicks; the page can't see our bar, so tell it. Only while our bar is up.
    sendToHost({ kind: 'barTakeover', active: !!active });
  }

  function setBarMode(m) {
    barPrefs.mode = m === 'native' ? 'native' : 'custom';
    saveBarPrefs();
    applyBarMode();
  }

  function updateFab() {
    if (!fab) return;
    fab.innerHTML = mode === 'cheat' ? dieSvg(FAB_BG) : BUILD_SVG;
    fab.title = mode === 'cheat' ? 'Cheats' : 'Save your build';
    var svg = fab.firstChild;
    if (svg && svg.style && mode !== 'cheat') { svg.style.width = '24px'; svg.style.height = '24px'; }
  }

  function openPanel() { panelOpen = true; renderPanel(); panel.classList.add('open'); }
  function closePanel() { panelOpen = false; panel.classList.remove('open'); }

  function renderPanel() {
    panel.innerHTML = '';
    var hd = el('div', 'hd');
    hd.appendChild(el('h3', null, mode === 'cheat' ? 'Cheats' : 'Your build'));
    if (mode === 'cheat' && gateUnlocked === true) {
      hd.appendChild(el('span', 'hdhint', cardBtnMode
        ? 'Tap the die button on a card for its own settings & requirements.'
        : 'Long-press a card for its own settings & requirements.'));
    }
    var x = el('button', 'x', '✕'); x.addEventListener('click', closePanel); hd.appendChild(x);
    panel.appendChild(hd);

    if (mode !== 'cheat') { renderSaverInto(panel); return; }

    if (gateUnlocked !== true) { renderLockedInto(panel); return; }

    var seg = el('div', 'seg');
    var tp = el('button', activeTab === 'points' ? 'active' : null, 'Points');
    var tr = el('button', activeTab === 'rows' ? 'active' : null, 'Rows');
    tp.addEventListener('click', function () { if (activeTab !== 'points') { activeTab = 'points'; renderPanel(); } });
    tr.addEventListener('click', function () { if (activeTab !== 'rows') { activeTab = 'rows'; renderPanel(); } });
    seg.appendChild(tp); seg.appendChild(tr);
    panel.appendChild(seg);

    var body = el('div', 'body');
    panel.appendChild(body);
    if (activeTab === 'points') renderPointsInto(body); else renderRowsInto(body);
  }

  function renderLockedInto(container) {
    var box = el('div', 'locked');
    if (gateUnlocked === null && hostPresent) {
      box.appendChild(el('div', 'lockttl', 'Checking…'));
      box.appendChild(el('div', 'lockmsg', 'Checking whether you have a build for this game…'));
      container.appendChild(box);
      return;
    }
    box.appendChild(el('div', 'lockttl', 'Cheats are locked'));
    box.appendChild(el('div', 'lockmsg',
      'Play it straight first: make your choices, then save your build to unlock the cheat tools for this game. ' +
      'Post it in the comments to share it — or keep it private, visible only to you.'));
    var b = serializeBuild();
    box.appendChild(el('div', 'lockmeta', b.count
      ? (b.count + ' card' + (b.count === 1 ? '' : 's') + ' selected — ready to save.')
      : 'No cards selected yet — pick your choices in the game first.'));
    var pr = el('div', 'presets');
    pr.appendChild(mkBtn('Post publicly & unlock', 'p', function () { postBuild(false, true); }));
    pr.appendChild(mkBtn('Keep private & unlock', '', function () { postBuild(false, false); }));
    box.appendChild(pr);
    container.appendChild(box);
  }

  // Saver mode: posting a build is a player feature, available on every load. Point-bar niceties
  // (show/hide, rename, shorten) are here too; point VALUES are cheat-only.
  function renderSaverInto(container) {
    var app = getApp();
    var box = el('div', 'locked');
    box.appendChild(el('div', 'lockmsg',
      'Save your current choices as a build: post it in the comments to share it, or keep it private, visible only to you.'));
    var b = serializeBuild();
    box.appendChild(el('div', 'lockmeta', b.count
      ? (b.count + ' card' + (b.count === 1 ? '' : 's') + ' selected.')
      : 'No cards selected yet — pick your choices in the game first.'));
    var pr = el('div', 'presets');
    if (gateUnlocked === true) {
      pr.appendChild(mkBtn('Update my build', 'p', function () { postBuild(false); }));
      pr.appendChild(mkBtn('Post as new build', '', function () { postBuild(true, true); }));
      pr.appendChild(mkBtn('Save new private build', '', function () { postBuild(true, false); }));
    } else {
      pr.appendChild(mkBtn('Post to comments', 'p', function () { postBuild(false, true); }));
      pr.appendChild(mkBtn('Keep private', '', function () { postBuild(false, false); }));
    }
    box.appendChild(pr);
    container.appendChild(box);

    if (app.pointTypes.length) {
      appendBarSettings(container, 'show / hide · rename to fit');
      app.pointTypes.forEach(function (p, i) { appendPointBarRow(container, p, i); });
    }

    var extra = el('div', 'presets');
    if (gameMenuAnchor()) {
      extra.appendChild(mkBtn('Save / load / export image', '', function () { openGameMenu(); closePanel(); }));
    }
    if (extra.childNodes.length) container.appendChild(extra);
  }

  function appendBarSettings(container, rowsHint) {
    var app = getApp();
    if (!app || !app.pointTypes.length) return;

    container.appendChild(el('div', 'sec', 'Point bar'));

    if (barCompat === false) {
      container.appendChild(el('div', 'hint',
        'This game draws its bar in a way we can\'t reproduce safely, so the ' +
        'author\'s own bar is left alone. Renaming and hiding still work.'));
    } else {
      var seg = el('div', 'seg');
      var mine = el('button', barPrefs.mode === 'custom' ? 'active' : null, 'Fitted');
      var orig = el('button', barPrefs.mode === 'native' ? 'active' : null, 'Original');
      mine.addEventListener('click', function () {
        if (barPrefs.mode !== 'custom') { setBarMode('custom'); renderPanel(); }
      });
      orig.addEventListener('click', function () {
        if (barPrefs.mode !== 'native') { setBarMode('native'); renderPanel(); }
      });
      seg.appendChild(mine); seg.appendChild(orig);
      container.appendChild(seg);
      container.appendChild(el('div', 'hint',
        'Fitted keeps the game\'s own colours and font, but wraps long point names ' +
        'over several lines and lets you size them. Original is the author\'s bar, ' +
        'exactly as they made it.'));
    }

    if (barActive()) {
      var srow = el('div', 'prow');
      srow.appendChild(el('span', 'pname', 'Text size'));
      var svals = el('div', 'pvals');
      var minus = el('button', 'btn icon', '−');
      var num = el('input', 'num'); num.type = 'number';
      num.value = barStyleValues().size;
      var plus = el('button', 'btn icon', '+');
      var setFont = function (v) {
        v = Math.min(22, Math.max(9, v || 13));
        barPrefs.font = v; num.value = v; saveBarPrefs(); applyBarStyle(); syncBar();
      };
      minus.addEventListener('click', function () { setFont((parseInt(num.value, 10) || 13) - 1); });
      plus.addEventListener('click', function () { setFont((parseInt(num.value, 10) || 13) + 1); });
      num.addEventListener('change', function () { setFont(parseInt(num.value, 10)); });
      svals.appendChild(minus); svals.appendChild(num); svals.appendChild(plus);
      srow.appendChild(svals);
      container.appendChild(srow);

      var krow = el('div', 'prow');
      krow.appendChild(el('span', 'pname', 'Colours'));
      var kseg = el('div', 'seg');
      var kauth = el('button', barPrefs.skin !== 'dark' ? 'active' : null, 'Author');
      var kdark = el('button', barPrefs.skin === 'dark' ? 'active' : null, 'Dark');
      var setSkin = function (v) {
        if ((barPrefs.skin === 'dark') === (v === 'dark')) return;
        barPrefs.skin = v;
        // Explicit overrides go with the skin switch, otherwise "Author" would still show ours.
        barPrefs.fg = null; barPrefs.bg = null;
        saveBarPrefs(); syncBar(); renderPanel();
      };
      kauth.addEventListener('click', function () { setSkin('author'); });
      kdark.addEventListener('click', function () { setSkin('dark'); });
      kseg.appendChild(kauth); kseg.appendChild(kdark);
      krow.appendChild(kseg);
      container.appendChild(krow);

      var theme = barStyleValues();
      var crow = el('div', 'prow');
      crow.appendChild(el('span', 'pname', 'Text / background'));
      var cvals = el('div', 'pvals');
      cvals.appendChild(colorInput(theme.fg,
        function (v) { barPrefs.fg = v; saveBarPrefs(); syncBar(); }));
      cvals.appendChild(colorInput(theme.bg,
        function (v) { barPrefs.bg = v; saveBarPrefs(); syncBar(); }));
      crow.appendChild(cvals);
      container.appendChild(crow);

      var irow = el('div', 'prow');
      irow.appendChild(el('span', 'pname', 'Game buttons'));
      var iseg = el('div', 'seg');
      var ion = el('button', barPrefs.icc !== false ? 'active' : null, 'Show');
      var ioff = el('button', barPrefs.icc === false ? 'active' : null, 'Hide');
      var setIcc = function (v) {
        if ((barPrefs.icc !== false) === v) return;
        barPrefs.icc = v; saveBarPrefs(); renderBar(); renderPanel();
      };
      ion.addEventListener('click', function () { setIcc(true); });
      ioff.addEventListener('click', function () { setIcc(false); });
      iseg.appendChild(ion); iseg.appendChild(ioff);
      irow.appendChild(iseg);
      container.appendChild(irow);

      var rr = el('div', 'presets');
      rr.appendChild(mkBtn('Reset look', 'sm', function () {
        barPrefs.font = 0; barPrefs.fg = null; barPrefs.bg = null; barPrefs.icc = true;
        barPrefs.skin = 'author';
        saveBarPrefs(); applyBarStyle(); renderBar(); renderPanel();
      }));
      container.appendChild(rr);
    }

    container.appendChild(el('div', 'hint', '👁 ' + (rowsHint || 'show / hide · rename')));
    var tools = el('div', 'presets');
    tools.appendChild(mkBtn('✂ Shorten labels', 'sm', function () {
      shortenAllLabels(); commitStore(); renderPanel(); syncBar();
    }));
    container.appendChild(tools);
  }

  function colorInput(value, onPick) {
    var c = el('input', 'color');
    c.type = 'color';
    c.value = normHex(value);
    c.addEventListener('change', function () { onPick(c.value); });
    return c;
  }
  // <input type=color> accepts only #rrggbb; our colours arrive as 8-digit hex, shorthand, rgba()
  // or names → fall back when irreducible.
  function normHex(v) { return toHex(v) || '#e8e8e8'; }

  function appendPointBarRow(body, p, i, valsNode) {
    var vis = isPointShown(i);
    var row = el('div', 'prow' + (vis ? '' : ' dim'));

    var eye = el('button', 'btn icon', vis ? '👁' : '🚫');
    eye.title = vis ? 'Shown in the point bar — tap to hide' : 'Hidden — tap to show';
    eye.addEventListener('click', function () {
      togglePointVis(i);
      rememberVis(i);
      commitStore(); renderPanel(); syncBar();
    });
    row.appendChild(eye);

    var name = el('input', 'pedit'); name.type = 'text';
    name.value = currentLabel(i);
    name.placeholder = p.name || ('Points ' + (i + 1));
    name.addEventListener('change', function () {
      setPointLabel(i, name.value);
      rememberLabel(i);
      commitStore(); renderPanel(); syncBar();
    });
    row.appendChild(name);

    if (valsNode) row.appendChild(valsNode);
    body.appendChild(row);

    var orgName = originalLabel(i);
    if (orgName && orgName !== currentLabel(i)) {
      body.appendChild(el('div', 'porig', 'orig: ' + orgName));
    }
  }

  function renderPointsInto(body) {
    var app = getApp();
    appendBarSettings(body, 'show / hide · rename · set the value');
    app.pointTypes.forEach(function (p, i) {
      var vals = el('div', 'pvals');
      var minus = el('button', 'btn icon', '−');
      var input = el('input', 'num'); input.type = 'number'; input.value = p.startingSum;
      var plus = el('button', 'btn icon', '+');
      function commit(v) { setPoint(i, v); input.value = v; commitStore(); }
      minus.addEventListener('click', function () { commit((parseFloat(input.value) || 0) - 5); });
      plus.addEventListener('click', function () { commit((parseFloat(input.value) || 0) + 5); });
      input.addEventListener('change', function () { var v = parseFloat(input.value); if (!isNaN(v)) { setPoint(i, v); commitStore(); } });
      vals.appendChild(minus); vals.appendChild(input); vals.appendChild(plus);
      appendPointBarRow(body, p, i, vals);
    });

    body.appendChild(el('div', 'sec', 'Presets'));
    var pr = el('div', 'presets');
    pr.appendChild(mkBtn('Max points', '', function () { maxPoints(); commitStore(); renderPanel(); }));
    pr.appendChild(mkBtn('Unlock all rows', '', function () { removeAllLimits(); commitStore(); }));
    pr.appendChild(mkBtn('Unlimited multi-select', '', function () { removeAllMultiLimits(); commitStore(); }));
    pr.appendChild(mkBtn('Clear all requirements', '', function () { removeAllRequirements(); commitStore(); }));
    pr.appendChild(mkBtn('Remove randomness', '', function () { removeAllRandomness(); commitStore(); }));
    pr.appendChild(mkBtn('Reset', 'p', function () { resetAll(); }));
    body.appendChild(pr);

    body.appendChild(el('div', 'sec', 'Reveal hidden'));
    var rv = el('div', 'presets');
    rv.appendChild(mkBtn('Show hidden cards', '', function () { showHiddenCards(); commitStore(); }));
    if ('showAllAddons' in app) rv.appendChild(mkBtn('Show all addons', '', function () { revealAllAddons(); commitStore(); }));
    rv.appendChild(mkBtn('Expand hidden sections', '', function () { revealHiddenRows(); commitStore(); if (activeTab === 'rows') renderPanel(); }));
    body.appendChild(rv);

    body.appendChild(el('div', 'sec', 'Build'));
    var bp = el('div', 'presets');
    bp.appendChild(mkBtn('Update my build', 'p', function () { postBuild(false); }));
    bp.appendChild(mkBtn('Post as new build', '', function () { postBuild(true, true); }));
    bp.appendChild(mkBtn('Save new private build', '', function () { postBuild(true, false); }));
    if (gameMenuAnchor()) {
      bp.appendChild(mkBtn('Save / load / export image', '', function () { openGameMenu(); closePanel(); }));
    }
    body.appendChild(bp);

    body.appendChild(el('div', 'sec', 'Card menu access'));
    var cseg = el('div', 'seg');
    var lpBtn = el('button', cardBtnMode ? null : 'active', 'Long-press');
    var btBtn = el('button', cardBtnMode ? 'active' : null, 'Button on card');
    lpBtn.addEventListener('click', function () { if (cardBtnMode) { setCardBtnMode(false); renderPanel(); } });
    btBtn.addEventListener('click', function () { if (!cardBtnMode) { setCardBtnMode(true); renderPanel(); } });
    cseg.appendChild(lpBtn); cseg.appendChild(btBtn);
    body.appendChild(cseg);
  }

  function mkBtn(txt, extra, fn) {
    var b = el('button', 'btn' + (extra ? ' ' + extra : ''), txt);
    b.addEventListener('click', fn);
    return b;
  }

  // Search reads the store, not the DOM, so hidden cards and cards in gated sections are findable.
  function rowMatches(r, i, q) {
    if (!q) return true;
    if (rowTitle(r, i).toLowerCase().indexOf(q) !== -1) return true;
    if (stripHtml(r.titleText).toLowerCase().indexOf(q) !== -1) return true;
    var hit = false;
    eachChoice(r, function (o) {
      if (hit) return;
      if (choiceTitle(o).toLowerCase().indexOf(q) !== -1 ||
          stripHtml(o.text).toLowerCase().indexOf(q) !== -1) hit = true;
    });
    return hit;
  }

  function renderRowsInto(body) {
    var app = getApp();
    body.appendChild(el('div', 'sec', 'Rows (' + app.rows.length + ')'));

    var search = el('input', 'pedit'); search.type = 'search';
    search.placeholder = 'Search rows & cards (incl. hidden)…';
    search.value = rowQuery;
    search.style.flex = 'none'; search.style.width = '100%'; search.style.margin = '0 0 8px';
    body.appendChild(search);

    var list = el('div');
    body.appendChild(list);

    function renderList() {
      list.innerHTML = '';
      var q = rowQuery.trim().toLowerCase(), shown = 0;
      app.rows.forEach(function (r, i) {
        if (!rowMatches(r, i, q)) return;
        shown++;
        list.appendChild(buildRowItem(r, i));
      });
      if (!shown) list.appendChild(el('div', 'hint', 'No rows or cards match “' + rowQuery.trim() + '”.'));
    }
    // Re-render only the list per keystroke so the search box keeps focus.
    search.addEventListener('input', function () { rowQuery = search.value; renderList(); });
    renderList();
  }

  function buildRowItem(r, i) {
    var item = el('div', 'ritem');
    var title = el('div', 'rtitle');
    title.appendChild(el('span', 'rname', rowTitle(r, i)));
    rowBadges(r).forEach(function (t) { title.appendChild(el('span', 'badge', t)); });
    item.appendChild(title);

    var req = reqSummary(r.requireds);
    if (req) item.appendChild(el('div', 'rreq', '⚑ needs: ' + req));

    var desc = stripHtml(r.titleText);
    if (desc) item.appendChild(el('div', 'desc', desc));

    var cnt = r.objects ? r.objects.length : 0;
    item.appendChild(el('div', 'meta', cnt + ' cards · selected ' + (r.currentChoices || 0) +
      ' · limit ' + (r.allowedChoices ? r.allowedChoices : '∞')));

    var acts = el('div', 'ractions');
    var lim = el('input', 'num'); lim.type = 'number'; lim.value = r.allowedChoices;
    lim.title = 'Allowed choices (0 = unlimited)';
    lim.style.width = '40px'; lim.style.padding = '7px 3px';
    lim.addEventListener('change', function () { var v = parseInt(lim.value, 10); if (!isNaN(v)) { setRowLimit(r, v); commitStore(); } });
    acts.appendChild(lim);
    var inf = mkBtn('∞', 'sm', function () { unlimitRow(r); lim.value = 0; commitStore(); });
    inf.title = 'Unlimited choices';
    acts.appendChild(inf);
    acts.appendChild(mkBtn('clear req.', 'sm', function () {
      clearReqs('row', r); eachChoice(r, function (o) { clearReqs('choice', o); }); commitStore();
    }));
    acts.appendChild(mkBtn('no random', 'sm', function () { unRandomRow(r); commitStore(); }));
    item.appendChild(acts);
    return item;
  }

  function tokenId(elm, prefix) {
    var cur = elm;
    while (cur && cur !== document.body) {
      if (cur.classList) {
        for (var i = 0; i < cur.classList.length; i++) {
          var c = cur.classList[i];
          if (c.indexOf(prefix) === 0) {
            var rest = c.slice(prefix.length);
            if (prefix === 'row-' && (rest.indexOf('-bg') !== -1 || rest.indexOf('-header') !== -1)) continue;
            return rest;
          }
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  var lpTimer = null, lpStart = null, lpCard = null, lpActive = false, suppressClick = false;

  // Block mobile text selection/callout during a long-press (user-select off for the press + block
  // selectstart).
  function setNoSelect(on) {
    var s = document.documentElement.style;
    s.webkitUserSelect = on ? 'none' : '';
    s.userSelect = on ? 'none' : '';
    s.webkitTouchCallout = on ? 'none' : '';
  }
  function clearSelection() { try { var s = window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); } catch (e) {} }

  function inOurUI(e) {
    if (!host) return false;
    if (e.target === host) return true;
    return e.composedPath ? e.composedPath().indexOf(host) !== -1 : false;
  }

  function onDown(e) {
    if (mode !== 'cheat') return;
    if (gateUnlocked !== true) return;
    if (inOurUI(e)) return;
    if (cardBtnInPath(e)) return;
    var cid = cardIdFromNode(e.target);
    if (!cid) return;
    var t = e.touches ? e.touches[0] : e;
    lpStart = { x: t.clientX, y: t.clientY };
    lpCard = cid; lpActive = true;
    setNoSelect(true);
    lpTimer = setTimeout(function () {
      lpTimer = null; suppressClick = true;
      clearSelection();
      if (navigator.vibrate) try { navigator.vibrate(15); } catch (e2) {}
      openCardMenu(lpCard);
    }, 450);
  }
  function onMove(e) {
    if (!lpTimer) return;
    var t = e.touches ? e.touches[0] : e;
    if (Math.abs(t.clientX - lpStart.x) > 10 || Math.abs(t.clientY - lpStart.y) > 10) { clearTimeout(lpTimer); lpTimer = null; }
  }
  function endPress() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    lpActive = false;
    setNoSelect(false);
  }
  function onClickCapture(e) {
    // Never swallow clicks inside our own shadow UI: a lingering suppressClick (long-press whose
    // click never fired) would eat the next tap on our buttons.
    if (inOurUI(e)) return;
    var cb = cardBtnInPath(e);
    if (cb) {
      e.stopPropagation(); e.preventDefault();
      if (!suppressClick) openCardMenu(cb.getAttribute('data-cheat-card'));
      suppressClick = false;
      return;
    }
    if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
  }
  function onSelectStart(e) { if (lpActive) e.preventDefault(); }
  function onContextMenu(e) { if (lpActive || suppressClick) e.preventDefault(); }

  function closeCardMenu() { if (cardMenu) { cardMenu.remove(); cardMenu = null; } }

  function openCardMenu(choiceId) {
    closeCardMenu();
    var f = findChoice(choiceId);
    if (!f) return;
    var c = f.choice;
    var anchor = cardElFor(choiceId);
    var rect = anchor ? anchor.getBoundingClientRect() : { left: 20, top: 80, bottom: 120, width: 200 };

    cardMenu = el('div', 'cardmenu');
    cardMenu.appendChild(el('div', 'cmtitle', choiceTitle(c)));
    var reqN = c.requireds ? c.requireds.length : 0;
    cardMenu.appendChild(el('div', 'cmstate',
      (isChoiceActive(c) ? 'selected' : 'not selected') + ' · ' + reqN + ' reqs' +
      (c.scores ? ' · ' + c.scores.length + ' scores' : '')));

    var btns = el('div', 'cmbtns');
    btns.appendChild(mkBtn(isChoiceActive(c) ? 'Deselect' : 'Select', 'sm p', function () {
      forceClickCard(choiceId); closeCardMenu();
    }));
    if (reqN) {
      btns.appendChild(mkBtn('Clear requirements', 'sm', function () { clearReqs('choice', c); commitStore(); refreshCardMenu(choiceId); }));
      btns.appendChild(mkBtn('Reveal requirements', 'sm', function () { revealReqs(c); commitStore(); refreshCardMenu(choiceId); }));
    }
    if (c.scores && c.scores.length) {
      btns.appendChild(mkBtn('Zero out costs', 'sm', function () { zeroScores(c); commitStore(); refreshCardMenu(choiceId); }));
    }
    if (c.isSelectableMultiple) {
      btns.appendChild(mkBtn('Unlimited copies', 'sm', function () { unlimitMulti(c); commitStore(); refreshCardMenu(choiceId); }));
    }
    btns.appendChild(mkBtn('Remove randomness', 'sm', function () {
      c.isActivateRandom = false;
      if (c.scores) c.scores = c.scores.map(function (s) { if (s.isRandom) { var n = clone(s); n.isRandom = false; return n; } return s; });
      commitStore();
      refreshCardMenu(choiceId);
    }));
    var close = el('button', 'x', '✕'); close.style.position = 'absolute'; close.style.top = '4px'; close.style.right = '6px';
    close.addEventListener('click', closeCardMenu);
    cardMenu.style.position = 'fixed';
    cardMenu.appendChild(close);
    cardMenu.appendChild(btns);

    root.querySelector('.wrap').appendChild(cardMenu);

    var mw = cardMenu.offsetWidth, mh = cardMenu.offsetHeight;
    var left = Math.min(Math.max(8, rect.left), window.innerWidth - mw - 8);
    var top = rect.bottom + 8;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 8);
    cardMenu.style.left = left + 'px';
    cardMenu.style.top = top + 'px';
  }
  function refreshCardMenu(choiceId) { openCardMenu(choiceId); }

  // Taps inside our UI have `host` in composedPath (shadow children compose up through the host).
  function onDocPointer(e) {
    if (!cardMenu && !panelOpen) return;
    var path = e.composedPath ? e.composedPath() : [];
    var inHost = path.indexOf(host) !== -1;
    if (cardMenu && path.indexOf(cardMenu) === -1 && !inHost) closeCardMenu();
    if (panelOpen && !inHost) closePanel();
  }

  // In native fullscreen the browser eats Esc to exit; ✕ and tap-outside still work.
  function onKeyDown(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc' && e.keyCode !== 27) return;
    if (cardMenu) { closeCardMenu(); e.stopPropagation(); e.preventDefault(); return; }
    if (panelOpen) { closePanel(); e.stopPropagation(); e.preventDefault(); }
  }

  function init() {
    loadCardPref();
    loadBarPrefs();
    // Fire-and-forget: only needed at build save; the shim must not wait on the network to come up.
    probeRandomScoreSupport();
    build();
    // Compatibility FIRST on a pristine store/DOM (async re-renders), then replay remembered
    // renames/hides.
    calibrateVisibility();
    barCompat = barCompatible();
    replayBarPrefs();
    commitStore();
    applyBarMode();
    if (barCompat !== true) scheduleCompatRetry();
    barTimer = setInterval(syncBar, 150);
    document.addEventListener('fullscreenchange', syncBar);
    document.addEventListener('webkitfullscreenchange', syncBar);
    window.addEventListener('message', onHostMessage);
    announceReady();
    if (mode === 'cheat') {
      standaloneTimer = setTimeout(function () {
        if (!hostPresent && gateUnlocked === null) { gateUnlocked = true; onGateResolved(); }
      }, 1500);
    }
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', endPress, true);
    document.addEventListener('pointercancel', endPress, true);
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('selectstart', onSelectStart, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('pointerdown', onDocPointer, false);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', function () { closeCardMenu(); });
  }

  var tries = 0;
  var iv = setInterval(function () {
    if (ready()) { clearInterval(iv); init(); }
    else if (++tries > 400) clearInterval(iv);
  }, 500);
})();
