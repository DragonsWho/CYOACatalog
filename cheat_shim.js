/* ---------------------------------------------------------------------------
 * CYOA cheat/saver companion — in-iframe UI for the ICC lineage.
 *
 * Injected into a hosted game's index.html ONLY when the request carries a
 * flag (see cheat.go / hosting.go); games served without one are byte-for-byte
 * untouched. The flag also picks the starting mode (read from location.search):
 *   ?__save=1  — saver mode: a small "save your build" sheet (post/keep-private
 *                + point-bar niceties). The site adds this flag to every hosted
 *                -game iframe, so the sheet is there on a normal game load.
 *   ?__cheat=1 — full cheat mode from load (the /cheat-lab path).
 * On the game page the parent upgrades saver → cheat over postMessage (a
 * 'mode' message from useCheatBridge), so turning cheats on never reloads the
 * game — selections survive. The shim runs inside the game document, reaches
 * the engine store via window.debugApp (the exported $state<App>), and renders
 * its whole UI inside a shadow root so the game's CSS and ours never collide.
 * The look mirrors cyoa.cafe's dark theme (accent #fc3447).
 *
 * Design: floating plates *in* the CYOA, not a separate menu that duplicates
 * structure.
 *   1. One bottom sheet (🎲) with two tabs:
 *        Points — live points per pointType + presets.
 *        Rows   — list of rows (needed for hidden / untappable rows), each
 *                 with a 3-line-clamped description.
 *   2. Long-press a card (.choice-<id>) -> in-place context sheet.
 *
 * Mutation model: write window.debugApp directly (Svelte 5 runes are reactive;
 * startingSum is the live total; allowedChoices==0 means unlimited). Forcing a
 * selection is done by synthesising a real click on the card so the engine's own
 * activateObject path runs. No engine functions are reachable from here (they are
 * module-scoped), so everything goes through the app state object or the DOM.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';
  if (window.__cyoaCheatLoaded) return;
  window.__cyoaCheatLoaded = true;

  var BIG = 999999;

  // UI mode. 'save' = the friendly build-saver sheet (default when injected via
  // ?__save=1); 'cheat' = the full cheat menu (?__cheat=1, or upgraded live by
  // the parent's 'mode' message). Card long-press / per-card buttons exist only
  // in cheat mode.
  var mode = /[?&]__cheat=1/.test(location.search) ? 'cheat' : 'save';

  // Gate + host-bridge state. The shim runs inside the game iframe (on
  // author.cyoa.cafe) and cannot read the user's cyoa.cafe session, so posting a
  // build and checking the "have they posted a build here?" gate go through the
  // parent page (cyoa.cafe) over postMessage. Cheats stay locked until a build
  // is posted; if no trusted parent handshakes (a crafted standalone ?__cheat=1
  // URL) there's nothing to gate against, so we unlock locally.
  var gateUnlocked = null;   // null = unknown/checking, false = locked, true = unlocked
  var hostOrigin = null;     // exact origin of the cyoa.cafe parent, once it handshakes
  var hostPresent = false;   // did a trusted parent announce itself?
  var currentGameId = null;  // games record id, provided by the parent
  var standaloneTimer = null;

  // ---- engine reach (multi-generation ICC) ----------------------------------
  // The rich cheat *model* (rows / pointTypes / requireds / allowedChoices /
  // scores / numMultipleTimesPluss …) is shared across the whole ICC lineage —
  // only the path to the reactive store differs by generation. So we probe the
  // known stores (newest → oldest) and cache the winning accessor; every mutation
  // helper below keeps writing the state object directly. The store-access ladder
  // mirrors the community browser extension (iccplus-extension content script).
  //
  //   window.debugApp                                   -> Svelte 5 runes (ICC+2)
  //   #app .__vue__.$store.state.app                    -> Vue 2 + Vuex (classic ICC)
  //   #__nuxt .__vue_app__.$nuxt.$pinia … .file.data    -> Nuxt 3 + Pinia (ltouroumov)
  //
  // Reactivity note: Svelte runes and Vue 2 fire on direct property assignment
  // (existing keys), which is all we do — so those generations re-render for free.
  // The Nuxt path reads through `_rawValue` (raw object under a Vue 3 shallowRef);
  // reads are fine, but in-place writes are memoized away, so nuxt edits are flushed
  // by commitStore() (a fresh-identity reassign of the store ref) and selection goes
  // through the store's own reactive `setSelected` action. See the nuxt block below.
  //
  // DOM-anchored features (force-select a card, long-press menu, per-card button,
  // hidden-row detection, native Build-Form import) differ by generation, so they
  // go through a small per-engine layer (engineKind + the helpers below):
  //   ICC+2 (svelte): cards carry a `.choice-<id>` class, rows a `.row-<id>-bg`,
  //     and the import UI is an mdc dialog — everything is addressable in the DOM.
  //   classic ICC (vue2): cards render NO id in the DOM at all (v-for :key only),
  //     so we reach a card through the Vue component tree — each card is an
  //     `AppObject` component bound to `object` (its choice); we find it by
  //     object.id, read selection truth from `object.isActive`, and force-select
  //     by synth-clicking its rendered face so the engine's own handler runs.
  //     Node→id goes the other way via `el.__vue__.object.id` (Vue 2 tags every
  //     component root element). Classic has no cheap hidden-row signal and no
  //     mdc import dialog, so those degrade (rowHidden→false, build-load falls
  //     back to clicking cards).
  //   Nuxt (vue3, ltouroumov cyoa-editor): a wholly separate modern engine that
  //     shares ICC's data shape. Cards render as `<div id="obj-<id>">`; selection
  //     goes through the Pinia store's `setSelected` action (isActive lives in the
  //     store, not on the choice); and because state sits under a shallowRef behind
  //     memoizing computeds, in-place edits are flushed with commitStore(). See the
  //     dedicated nuxt block below.
  // The floating sheet's state cheats (points, limits, requirements, reveal-by-
  // flag) are pure store writes; on classic/svelte they re-render on assignment,
  // on nuxt they re-render once commitStore() reassigns the store ref.
  var STORE_ACCESSORS = [
    function () { return window.debugApp; },
    function () { return document.querySelector('#app').__vue__.$store.state.app; },
    function () { return document.getElementById('__nuxt').__vue_app__.$nuxt.$pinia.state._rawValue.project.store._value.file.data; }
  ];
  var storeAccessor = null;   // cached winner once detected
  function isAppShape(a) { return !!(a && Array.isArray(a.rows) && Array.isArray(a.pointTypes)); }
  function getApp() {
    if (storeAccessor) {
      var cached; try { cached = storeAccessor(); } catch (e) { cached = null; }
      if (isAppShape(cached)) return cached;
      storeAccessor = null;   // store went away (re-render/reload): re-probe below
    }
    for (var i = 0; i < STORE_ACCESSORS.length; i++) {
      var a; try { a = STORE_ACCESSORS[i](); } catch (e) { a = null; }
      if (isAppShape(a)) { storeAccessor = STORE_ACCESSORS[i]; return a; }
    }
    return null;
  }
  function ready() { return isAppShape(getApp()); }

  // Which generation won the store probe (drives the per-engine DOM layer below).
  function engineKind() {
    var idx = STORE_ACCESSORS.indexOf(storeAccessor);
    return idx === 1 ? 'classic' : idx === 2 ? 'nuxt' : 'iccplus2';
  }

  // ---- classic ICC (Vue 2) card access via the component tree ---------------
  // Classic renders no card id in the DOM, so a card is reached through its
  // AppObject component (bound to `object` == the choice, with an activateObject
  // method). We walk the tree from #app's root vm; trees are small (~150 nodes).
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
  // Toggle a classic card by synth-clicking its rendered face (the engine's @click
  // lives on a descendant of the wrapper $el, so a click must bubble up from
  // inside it — clicking $el itself doesn't reach the handler). We try a few
  // candidate descendants and stop as soon as object.isActive actually flips.
  function fireClickSeq(el) {
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  }
  function classicSelect(id) {
    var vm = classicVmById(id); if (!vm) return false;
    var before = vm.object.isActive;
    // Preferred: call the engine's own handler directly with (object, row) —
    // exactly what the card's @click invokes (`activateObject(object,row)`).
    // Works across every build, including newer ones whose card DOM (v-dialog
    // wrappers etc.) defeats a synthetic descendant click. Buttons are skipped
    // by the engine's own @click, so we skip them too.
    if (typeof vm.activateObject === 'function' && !vm.object.isButtonObject) {
      try { vm.activateObject(vm.object, vm.row); } catch (e) {}
      if (vm.object.isActive !== before) return true;
    }
    // Fallback: synth-click a face descendant (unusual components / multi-select).
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

  // ---- nuxt (ltouroumov cyoa-editor, Vue 3 + Pinia) -------------------------
  // A wholly separate modern engine (github.com/ltouroumov/cyoa-editor) that
  // happens to share ICC's data shape (rows / pointTypes / scores). Its runtime
  // is nothing like the classic lineage: state lives in a Pinia *setup* store
  // ('project'), the on-screen point total is a `computed` over startingSum +
  // selections, and card selection goes through the store's own `setSelected`
  // action. Two consequences drive this layer:
  //   1. Selection: never poke DOM — call `store.setSelected(id, want)`. It is
  //      fully reactive (and runs the engine's own activate/deactivate/limit
  //      rules), and selection truth lives in `store.selected`, not `o.isActive`.
  //   2. Everything else (points, labels, visibility, limits, reqs, scores…) is
  //      an in-place edit of `file.data`, which sits under a `shallowRef` behind
  //      memoizing computeds — so a plain write never re-renders. commitStore()
  //      reassigns that ref with fresh-identity file/data/rows/pointTypes arrays,
  //      which invalidates the whole computed chain and flushes every edit at once.
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
  // Flush in-place edits so the Vue 3 computed chain re-runs. No-op on classic /
  // svelte (their direct writes are already reactive). Fresh identities are given
  // at every level a cheat can touch (rows + pointTypes arrays, data, file) so the
  // memoized `project`→`pointTypes`/`projectRows` computeds are forced to recompute.
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
  // Selection truth, per generation: classic/svelte stamp `isActive` on the
  // choice; nuxt keeps it in the store's `selected` map keyed by id.
  function isChoiceActive(o) {
    if (!o) return false;
    if (engineKind() === 'nuxt') return nuxtIsSelected(o.id);
    return !!o.isActive;
  }

  // ---- per-engine DOM layer -------------------------------------------------
  // node -> choice id (long-press / card-button detection).
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
      // ltouroumov renders each card as <div id="obj-<id>"> (ViewProjectObj.vue).
      var n = node;
      for (var j = 0; j < 16 && n; j++) {
        if (n.id && n.id.indexOf('obj-') === 0) return n.id.slice(4);
        n = n.parentElement;
      }
      return null;
    }
    return tokenId(node, 'choice-');
  }
  // choice id -> the card's element (for anchoring the menu / decorating it).
  function cardElFor(id) {
    var k = engineKind();
    if (k === 'classic') { var vm = classicVmById(id); return vm ? vm.$el : null; }
    if (k === 'nuxt') return document.getElementById('obj-' + id);
    return document.querySelector('[class~="choice-' + id + '"]');
  }

  // Lazily-captured originals so "Reset" can undo without a giant snapshot.
  var orig = { points: null, limits: {}, reqs: {}, scores: {}, labels: {}, vis: {},
    multi: {}, multiDef: null, filters: null, showAddons: null };
  function clone(x) { try { return JSON.parse(JSON.stringify(x)); } catch (e) { return x; } }

  // ---- data helpers ---------------------------------------------------------
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

  // Walk rows + their objects (cards may be nested via addons' objects arrays).
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

  // Row rendered-but-hidden detection via the DOM anchor .row-<id>-bg.hidden.
  // Classic ICC has no such anchor and no cheap hidden signal, so we don't flag
  // hidden rows there (better than falsely badging every row "hidden").
  function rowHidden(rowId) {
    if (engineKind() !== 'iccplus2') return false;   // only ICC+2 has the .row-<id>-bg anchor
    var bg = document.querySelector('[class~="row-' + rowId + '-bg"]');
    if (!bg) return true;               // not in DOM at all -> effectively hidden
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

  // Brief human-readable requirement summary (mirrors the engine's getReqText,
  // but via shim-reachable lookups). Used to show at a glance what gates a row.
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

  // ---- mutations (all through window.debugApp) ------------------------------
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

  // Point-bar label. The on-screen label is beforeText/afterText (not the
  // internal `name`), so rename edits whichever the author used. (Visibility is
  // handled separately below — it differs by engine generation.)
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
  // Point-bar visibility spans two engine generations:
  //  - newer/heavy classic + ICC+2 honor isNotShownPointBar (checkPointEnable).
  //    Detected at runtime: the heavy engine stamps `initValue` on every
  //    pointType at mount, and the flag itself already sits on gated points.
  //  - older/light classic has NO hide flag at all; a score shows iff
  //    activatedId=='' || app.activated.includes(activatedId). There we hide by
  //    parking activatedId on a sentinel that is never activated, and show by
  //    clearing it — snapshotting the original so Reset restores conditional pts.
  var VIS_SENTINEL = '__cheat_hidden__';
  function visByFlag() {
    var pts = getApp().pointTypes;
    if (!pts.length) return false;
    var k = engineKind();
    // ICC+2 (svelte) always honors isNotShownPointBar (the feature's origin).
    if (k === 'iccplus2') return true;
    // Classic Vuex: heavy builds honor the flag (and stamp initValue on every
    // point at mount); light builds have neither and hide via activatedId only.
    if (k === 'classic') return ('initValue' in pts[0]) || ('isNotShownPointBar' in pts[0]);
    // Other engines (e.g. ltouroumov nuxt) carry initValue too but do NOT honor
    // isNotShownPointBar, so trust only the flag's actual presence.
    return 'isNotShownPointBar' in pts[0];
  }
  function activatedList() { var a = getApp().activated; return a && a.indexOf ? a : []; }
  function isPointShown(i) {
    var p = getApp().pointTypes[i];
    if (!p) return true;
    var gated = p.activatedId && p.activatedId !== VIS_SENTINEL;
    if (visByFlag()) {
      if (gated) return activatedList().indexOf(p.activatedId) !== -1 || !p.isNotShownPointBar;
      return p.activatedId !== VIS_SENTINEL && !p.isNotShownPointBar;
    }
    return p.activatedId === '' || activatedList().indexOf(p.activatedId) !== -1;
  }
  // Reactively set a (possibly new) property on a Vuex-state point in classic:
  // Vue 2 won't re-render on a freshly-added key unless it goes through $set.
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
    var show = !isPointShown(i);            // desired new state
    if (visByFlag()) {
      pSet(p, 'isNotShownPointBar', !show);
      if (show) {
        // a stale activatedId gate would keep it managed/hidden: neutralize it
        if (p.activatedId && p.activatedId !== '' && activatedList().indexOf(p.activatedId) === -1) p.activatedId = '';
      } else if (p.activatedId && activatedList().indexOf(p.activatedId) !== -1) {
        // a live gate would force it visible despite the flag: park the gate
        p.activatedId = VIS_SENTINEL;
      }
    } else {
      p.activatedId = show ? '' : VIS_SENTINEL;
    }
  }
  // The label as it was before ANY of our edits (from the snapshot), so the user
  // can always peek at the author's original wording.
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
  // Compact a long point name: "Health Points" -> "He.Po", single word -> first 4
  // ("Willpower" -> "Will"). Empty stays empty.
  function shortenLabel(text) {
    var s = (text || '').trim();
    if (!s) return s;
    var words = s.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return words[0].slice(0, 2) + '.' + words[1].slice(0, 2);
    return s.slice(0, 4);
  }
  // Bulk one-tap: shorten every point label. Works off each ORIGINAL label, so
  // repeated taps are idempotent and it never shortens an already-short value.
  function shortenAllLabels() {
    var app = getApp();
    app.pointTypes.forEach(function (p, i) {
      var short = shortenLabel(originalLabel(i));
      if (short) setPointLabel(i, short);
    });
  }

  // Bridge to the game's own save/load/export UI. Engine functions aren't on
  // window, so we synth-click the pointbar's menu icon (the only stable anchor).
  // Returns false if the game hides its point bar (then there's nothing to open).
  function gameMenuAnchor() { return document.querySelector('.pointbar-icons'); }
  function openGameMenu() {
    var btn = gameMenuAnchor();
    if (!btn) return false;
    fireClick(btn);
    return true;
  }

  function snapLimit(row) { if (!(row.id in orig.limits)) orig.limits[row.id] = row.allowedChoices; }
  function setRowLimit(row, val) { snapLimit(row); row.allowedChoices = val; }
  function unlimitRow(row) { setRowLimit(row, 0); }        // 0 == unlimited
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
  // De-randomise: fix random behaviour so results are deterministic.
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

  // ---- multiselect (unlimited copies) ---------------------------------------
  // A "multi-select" card can be picked many times; the per-card cap is
  // choice.numMultipleTimesPluss (defaults to app.defaultChoiceMaxNum, ~99).
  // Raise both to BIG so it's effectively unlimited. One card selected many
  // times still counts as one toward the row limit, so this is independent of
  // "Unlock all rows".
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

  // ---- reveal hidden content ------------------------------------------------
  // ICC hides choices via per-styling "visible filters": a card whose
  // requirements aren't met is fully hidden when reqFilterVisibleIsOn is set
  // (likewise unsel/sel filters — engine isShown in AppObject.svelte). The
  // active styling may be app.styling or a private row/choice/design-group
  // override, so we clear the flags on every styling object we can reach.
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
  // Force every addon to render (app.showAllAddons > 0 overrides the engine's
  // per-addon hide rules). Kept high so the engine's own decrements can't zero it.
  function revealAllAddons() {
    var app = getApp();
    if (orig.showAddons == null) orig.showAddons = app.showAllAddons;
    app.showAllAddons = BIG;
  }
  // Sections (rows) are hidden purely by their requirements; clearing the
  // row-level requireds reveals them (each card keeps its own gating).
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
      p.isNotShownPointBar = o.flag;   // undefined restores the "shown" default
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
    commitStore();                       // flush restores on nuxt
    if (panelOpen) renderPanel();
  }

  // Dispatch a real click so the engine's own Svelte handlers run.
  function fireClick(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  // Force-select via a real click so the engine's own activateObject runs.
  // ICC+2 addresses the card by its `.choice-<id>` class; classic reaches it
  // through the Vue component tree (see classicSelect).
  function forceClickCard(choiceId) {
    // This is an intentional programmatic selection, so make sure a lingering
    // long-press suppression flag doesn't make onClickCapture swallow our click
    // before the engine's own handler sees it.
    suppressClick = false;
    var k = engineKind();
    if (k === 'classic') return classicSelect(choiceId);
    // nuxt: toggle through the store's own action (reactive; runs the engine's
    // activate/deactivate/row-limit rules). No commitStore() needed — the
    // `selected` ref updates on its own.
    if (k === 'nuxt') return nuxtSetSelected(choiceId, !nuxtIsSelected(choiceId));
    var el = document.querySelector('[class~="choice-' + choiceId + '"]');
    if (!el) return false;
    fireClick(el);
    return true;
  }

  // ---- per-card access mode -------------------------------------------------
  // Two ways to open a card's context menu: long-press (default) or a small
  // grey button pinned to each card's top-right (a fallback for browsers where
  // the long-press is flaky). Persisted per game-origin in localStorage.
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
    // :scope > so a card nested inside another card doesn't make the outer one
    // think it's already decorated (its button is our own direct child only).
    if (!cardEl || cardEl.querySelector(':scope > .' + CARD_BTN_CLASS)) return;
    var cid = cardIdFromNode(cardEl);
    if (!cid) return;
    if (getComputedStyle(cardEl).position === 'static') { cardEl.style.position = 'relative'; cardEl.setAttribute('data-cheat-pos', '1'); }
    cardEl.appendChild(makeCardBtn(cid));
  }
  function decorateAllCards() {
    if (mode !== 'cheat') return;           // per-card buttons are a cheat-mode thing
    if (gateUnlocked !== true) return;      // no per-card cheat buttons while locked
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
      // Cards can appear later (addons / reveals); keep decorating new ones.
      if (!cardObserver && window.MutationObserver) {
        cardObserver = new MutationObserver(scheduleDecorate);
        cardObserver.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
      undecorateAllCards();
    }
  }
  // A click on our card button (found anywhere in the event path) opens that
  // card's menu. Handled here at document capture — which runs BEFORE the card's
  // own capture-phase activateObject — so stopping it prevents an accidental
  // selection.
  function cardBtnInPath(e) {
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n && n.classList && n.classList.contains(CARD_BTN_CLASS)) return n;
    }
    return null;
  }

  // ---- build capture + gate bridge ------------------------------------------
  // Read the player's current selection as a shareable build: a readable summary
  // (points + chosen cards) plus a plain comma-separated id list in `code` — the
  // traditional "build string" people already paste into comments. We don't
  // re-import it (manual copy-paste is enough), so this stays simple.
  // Section (row) names ride along so the site can render a build as
  // "Race: Demon / Sex: Male / Drawbacks: Weak, Short" instead of a flat list of
  // card titles. Kept compact: `summary.rows` holds each contributing section's
  // name once, and every choice carries `r` = its index into that array. Only
  // `row.title` counts as a name (`titleText` is the section's *description* —
  // a whole paragraph, useless as a label); a nameless section yields an
  // unlabelled group. Readers that predate this field just ignore it.
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
        // Nested addon cards are attributed to their top-level section, which is
        // the grouping the reader cares about.
        if (!(i in rowIdx)) { rowIdx[i] = rowNames.length; rowNames.push(buildRowName(r)); }
        choices.push({ id: o.id, title: choiceTitle(o), r: rowIdx[i] });
        ids.push(o.id);
      });
    });
    var points = app.pointTypes.map(function (p, i) {
      return { name: currentLabel(i) || p.name || ('Points ' + (i + 1)), value: p.startingSum };
    });
    // `code` uses bare-comma joining to match ICC's own Build Form import format
    // (so it round-trips through the native loader and manual paste alike).
    return { count: choices.length, code: ids.join(','),
      summary: { count: choices.length, points: points, rows: rowNames, choices: choices } };
  }

  function hostname(origin) { try { return new URL(origin).hostname; } catch (e) { return ''; } }
  // Trust only cyoa.cafe (any subdomain) and localhost for dev.
  function allowedHost(o) {
    var h = hostname(o);
    return /(^|\.)cyoa\.cafe$/i.test(h) || /^(localhost|127\.0\.0\.1)$/i.test(h);
  }

  // Announce readiness to the parent (its origin is unknown until it replies, so '*').
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
  // By default a build is upserted host-side: re-saving overwrites your one
  // build for this game instead of adding another. forceNew=true opts into a
  // separate second build. isPublic: true → also posted as a comment in the
  // thread; false → private (only you see it, still unlocks the cheats);
  // undefined → the host keeps the overwritten build's visibility.
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
  // ---- load a saved build --------------------------------------------------
  // Loading isn't gated: it drives ICC's own Build Form import (right-click the
  // point-bar menu icon → "Area To Import Activated Choices" → Import), which is
  // a stock player feature. That native path uses loadActivated()/selectObjectL,
  // which reproduces the selection *ignoring requirements* — unlike a plain card
  // click (activateObject → selectObject), which enforces them and so silently
  // refuses gated cards. We can't call loadActivated() directly (it's a private
  // module binding; only window.debugApp is exposed), so we operate its dialog.

  // Set a value on a native input/textarea so Svelte's bind:value (which reads on
  // the 'input' event) actually picks it up — assigning .value alone won't fire.
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
  // Drive ICC's Build Form: force-enable the import opener (its right-click
  // handler only renders when app.importedChoicesIsOpen), open the dialog, fill
  // the import textarea, click Import. Returns true once it owns the ICC path.
  function loadViaBuildForm(code) {
    var app = getApp();
    if (!app) return false;
    try { app.importedChoicesIsOpen = true; } catch (e) {} // reveal the R-click opener
    var opened = false, tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (!opened) {
        var opener = document.querySelector('[aria-label="Open Import Window"]');
        if (opener) {
          // buildContext (oncontextmenu) sets currentDialog = 'appBuildForm'.
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
            btn.click();                       // → loadActivated(idList)
            setTimeout(closeOpenDialog, 60);
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
  // Fallback for engines without the Build Form: click each wanted card (honest
  // path — cards behind unmet requirements may refuse; clear them from the menu).
  function loadByClick(want) {
    var app = getApp();
    if (!app) { toast('Game not ready yet — try again.'); return; }
    var toSelect = [], toDeselect = [];
    app.rows.forEach(function (r) {
      eachChoice(r, function (o) {
        if (want[o.id] && !isChoiceActive(o)) toSelect.push(o.id);
        else if (!want[o.id] && isChoiceActive(o)) toDeselect.push(o.id);
      });
    });
    toSelect.forEach(function (id) { forceClickCard(id); });
    toDeselect.forEach(function (id) { forceClickCard(id); });
    if (panelOpen) renderPanel();
    toast('Build loaded (best-effort).');
  }
  function applyBuild(code) {
    // The build string may have been stored with ", " spacing; the native import
    // splits on a bare comma, so normalize before either path.
    var norm = String(code || '').replace(/\s*,\s*/g, ',').replace(/^,+|,+$/g, '').trim();
    if (!norm) { toast('This build has no cards to load.'); return; }
    // Only ICC+2 ships the mdc Build-Form; on other generations that path would
    // spin for seconds then fail, so go straight to clicking cards there.
    if (engineKind() === 'iccplus2' && loadViaBuildForm(norm)) return;
    var want = {};
    norm.split(',').forEach(function (s) { if (s) want[s] = true; });
    loadByClick(want);
  }
  function onHostMessage(e) {
    var d = e.data;
    if (!d || d.source !== 'cyoacafe-cheat-host') return;
    if (!allowedHost(e.origin)) return;
    hostOrigin = e.origin;
    if (!hostPresent) {
      hostPresent = true;
      if (standaloneTimer) { clearTimeout(standaloneTimer); standaloneTimer = null; }
    }
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
        // The "unlocked!" flourish only makes sense inside the cheat menu; the
        // saver sheet talks about builds, not cheats.
        var mentionUnlock = mode === 'cheat' && wasLocked;
        toast(d.isPublic === false
          ? (mentionUnlock ? 'Build saved privately — cheats unlocked!' : 'Build saved (private).')
          : (mentionUnlock ? 'Build posted — cheats unlocked!' : 'Build posted.'));
        onGateResolved();
      } else { toast(d.error || 'Could not save the build.'); }
    } else if (d.kind === 'loadBuild') {
      applyBuild(d.code);
    } else if (d.kind === 'mode') {
      setMode(d.mode === 'cheat' ? 'cheat' : 'save');
    }
  }
  // Live mode switch (the parent's Cheats toggle). No reload: the game keeps its
  // state; we just swap the FAB face and the sheet contents, and (un)decorate
  // cards to match the new mode.
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    updateFab();
    closeCardMenu();
    onGateResolved();
  }
  // Called whenever the gate (or the mode) flips: (un)decorate cards to match,
  // and re-render an open panel so it swaps to the right contents.
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

  // ---- UI (shadow DOM), styled to match cyoa.cafe ---------------------------
  var host, root, fab, panel, cardMenu, panelOpen = false, activeTab = 'points', rowQuery = '';

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
    '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}',
    '.wrap{position:fixed;inset:0;pointer-events:none;z-index:2147483000;color:#dcdcdc}',
    '.wrap>*{pointer-events:auto}',
    '.fab{position:fixed;left:calc(env(safe-area-inset-left,0px) + 14px);',
    'bottom:calc(env(safe-area-inset-bottom,0px) + 10px);',
    'width:40px;height:40px;border-radius:8px;',
    'background:#fc3447;color:#fff;border:none;cursor:pointer;',
    'box-shadow:0 2px 10px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:0}',
    '.fab:active{transform:scale(.94)}',
    '.fab svg{width:34px;height:34px;display:block}',
    '.panel{position:fixed;left:0;right:0;bottom:0;max-height:72vh;overflow:auto;',
    'background:#151515;color:#dcdcdc;border-top:1px solid #2b2b2b;border-radius:14px 14px 0 0;',
    'padding:12px 14px 22px;box-shadow:0 -6px 24px rgba(0,0,0,.55);',
    // Extra px past 100% so a short/empty sheet can never peek during viewport
    // jitter; visibility flips hidden only after the slide-out finishes.
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
    // Тонкий тёмный скроллбар для прокручиваемых блоков панели (в тон #151515),
    // вместо жирного нативного белого. Живёт в shadow-root — на игру не влияет.
    '.panel,.cardmenu{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}',
    '.panel::-webkit-scrollbar,.cardmenu::-webkit-scrollbar{width:8px;height:8px}',
    '.panel::-webkit-scrollbar-track,.cardmenu::-webkit-scrollbar-track{background:transparent}',
    '.panel::-webkit-scrollbar-thumb,.cardmenu::-webkit-scrollbar-thumb{',
    'background:rgba(255,255,255,.12);border-radius:8px;border:2px solid transparent;background-clip:padding-box}',
    '.panel::-webkit-scrollbar-thumb:hover,.cardmenu::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.26)}',
    // Desktop: the sheet stops stretching edge-to-edge and becomes a ~400px
    // card pinned above the FAB, bottom-left. (The closed transform gets extra
    // travel so it clears its higher anchor before visibility flips.)
    '@media (min-width:700px){',
    '.panel{left:calc(env(safe-area-inset-left,0px) + 14px);right:auto;',
    'width:400px;max-width:calc(100vw - 28px);max-height:min(72vh,640px);',
    'bottom:calc(env(safe-area-inset-bottom,0px) + 60px);',
    'border:1px solid #2b2b2b;border-radius:14px;padding-bottom:14px;',
    'transform:translateY(calc(100% + 128px))}',
    '.panel.open{transform:translateY(0)}',
    '}'
  ].join('');

  // Rounded isometric die (3 faces, six pips each). Rendered as white line-art
  // on the red button: the body + pips use currentColor (white on the FAB), and
  // the faces are painted the FAB's own red so they read as "cut out" — leaving
  // the white rounded outline, the inverted-Y edges and the white pips. On the
  // grey per-card button the faces just show as small red panels, still a die.
  var FAB_RED = '#fc3447';
  // viewBox is cropped to the die's own bounds (~x 42-158, y 35-169) instead of
  // the full 0-200 canvas, so the art fills the button instead of floating in a
  // third of it. Kept square + centred on (100,102) to avoid any distortion.
  var DIE_SVG = '<svg viewBox="30 32 140 140" fill="none" aria-hidden="true" focusable="false">' +
    '<path d="M 91.34,40 Q 100,35 108.66,40 L 149.34,63.5 Q 158,68.5 158,78.5 L 158,125.5 ' +
      'Q 158,135.5 149.34,140.5 L 108.66,164 Q 100,169 91.34,164 L 50.66,140.5 ' +
      'Q 42,135.5 42,125.5 L 42,78.5 Q 42,68.5 50.66,63.5 Z" ' +
      'fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<g transform="matrix(-0.58,-0.335,0,0.67,100,102)">' +
      '<rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill="' + FAB_RED + '"/>' +
      '<circle cx="22" cy="28" r="10" fill="currentColor"/><circle cx="50" cy="28" r="10" fill="currentColor"/><circle cx="78" cy="28" r="10" fill="currentColor"/>' +
      '<circle cx="22" cy="72" r="10" fill="currentColor"/><circle cx="50" cy="72" r="10" fill="currentColor"/><circle cx="78" cy="72" r="10" fill="currentColor"/>' +
    '</g>' +
    '<g transform="matrix(0.58,-0.335,0,0.67,100,102)">' +
      '<rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill="' + FAB_RED + '"/>' +
      '<circle cx="28" cy="22" r="10" fill="currentColor"/><circle cx="28" cy="50" r="10" fill="currentColor"/><circle cx="28" cy="78" r="10" fill="currentColor"/>' +
      '<circle cx="72" cy="22" r="10" fill="currentColor"/><circle cx="72" cy="50" r="10" fill="currentColor"/><circle cx="72" cy="78" r="10" fill="currentColor"/>' +
    '</g>' +
    '<g transform="matrix(-0.58,-0.335,0.58,-0.335,100,102)">' +
      '<rect x="3" y="3" width="94" height="94" rx="10" ry="10" fill="' + FAB_RED + '"/>' +
      '<circle cx="28" cy="22" r="10" fill="currentColor"/><circle cx="28" cy="50" r="10" fill="currentColor"/><circle cx="28" cy="78" r="10" fill="currentColor"/>' +
      '<circle cx="72" cy="22" r="10" fill="currentColor"/><circle cx="72" cy="50" r="10" fill="currentColor"/><circle cx="72" cy="78" r="10" fill="currentColor"/>' +
    '</g>' +
    '</svg>';

  // Saver-mode FAB face: the "assignment turned in" clipboard (same glyph the
  // site uses for builds — thread cards, catalog badge), white on the red FAB.
  var BUILD_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<path d="M18 9l-1.41-1.42L10 14.17l-2.59-2.58L6 13l4 4zM19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5' +
    'c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 ' +
    '.45-1 1-1z"/></svg>';

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

  // The hosted game's OWN native scrollbar renders as a fat light/white bar,
  // clashing with the dark site chrome around the iframe. ICC/Vue/Svelte games
  // scroll a nested full-viewport container (not html/body), so we can't target
  // the root scroller — style ALL scrollbars in the game document with a thin
  // neutral-grey overlay that reads on both light and dark games. Appended last
  // in <head> so it wins over a game's own scrollbar rule on equal specificity.
  // Cosmetic + revertible: drop this call to restore native behaviour.
  function styleHostScrollbar() {
    try {
      if (document.getElementById('cyoa-scrollbar-style')) return;
      var s = document.createElement('style');
      s.id = 'cyoa-scrollbar-style';
      s.textContent =
        '*{scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.55) transparent}' +
        '::-webkit-scrollbar{width:10px;height:10px}' +
        '::-webkit-scrollbar-track{background:transparent}' +
        '::-webkit-scrollbar-thumb{' +
        'background:rgba(128,128,128,.5);border-radius:8px;border:2px solid transparent;background-clip:padding-box}' +
        '::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.75)}';
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* non-fatal cosmetic */ }
  }

  // FAB face follows the mode: clipboard = "save your build", die = cheats.
  // (The die art is cropped tight so it wants the full 34px; the stock 24x24
  // clipboard glyph reads right a bit smaller.)
  function updateFab() {
    if (!fab) return;
    fab.innerHTML = mode === 'cheat' ? DIE_SVG : BUILD_SVG;
    fab.title = mode === 'cheat' ? 'Cheats' : 'Save your build';
    var svg = fab.firstChild;
    if (svg && svg.style && mode !== 'cheat') { svg.style.width = '24px'; svg.style.height = '24px'; }
  }

  function openPanel() { panelOpen = true; renderPanel(); panel.classList.add('open'); }
  function closePanel() { panelOpen = false; panel.classList.remove('open'); }

  // One bottom sheet. Saver mode: a small "save your build" sheet with point-bar
  // niceties. Cheat mode: two tabs (Points | Rows); the card context menu stays a
  // separate anchored popup (long-press) — it's contextual by nature.
  function renderPanel() {
    panel.innerHTML = '';
    var hd = el('div', 'hd');
    hd.appendChild(el('h3', null, mode === 'cheat' ? 'Cheats' : 'Your build'));
    // The card-menu hint only applies once cheats are unlocked.
    if (mode === 'cheat' && gateUnlocked === true) {
      hd.appendChild(el('span', 'hdhint', cardBtnMode
        ? 'Tap the die button on a card for its own settings & requirements.'
        : 'Long-press a card for its own settings & requirements.'));
    }
    var x = el('button', 'x', '✕'); x.addEventListener('click', closePanel); hd.appendChild(x);
    panel.appendChild(hd);

    if (mode !== 'cheat') { renderSaverInto(panel); return; }

    // Locked (or still checking): show only the "post a build to unlock" prompt.
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

  // Shown while cheats are locked: a friendly "play it straight, then post your
  // build to unlock" prompt with the current selection count and a post button.
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

  // Saver mode: posting a build is a player feature, not a cheat, so this sheet
  // is available on every game load. It also carries the "not really cheating"
  // point-bar niceties (show/hide, rename, shorten) — labels can be too long for
  // a phone's point bar. Point VALUES are cheat-menu-only.
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
      // Already has a build for this game: same choices as the cheat menu.
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
      container.appendChild(el('div', 'sec', 'Point bar'));
      container.appendChild(el('div', 'hint', '👁 show / hide in the game bar · rename the label'));
      var tools = el('div', 'presets');
      tools.appendChild(mkBtn('✂ Shorten labels', 'sm', function () { shortenAllLabels(); commitStore(); renderPanel(); }));
      container.appendChild(tools);
      app.pointTypes.forEach(function (p, i) { appendPointBarRow(container, p, i); });
    }

    var extra = el('div', 'presets');
    if (gameMenuAnchor()) {
      extra.appendChild(mkBtn('Save / load / export image', '', function () { openGameMenu(); closePanel(); }));
    }
    if (extra.childNodes.length) container.appendChild(extra);
  }

  // One point-bar row: visibility eye + editable label (+ the author's original
  // underneath once renamed). Shared by the saver sheet and the cheat Points tab
  // (the latter adds the value editor on top).
  function appendPointBarRow(body, p, i, valsNode) {
    var vis = isPointShown(i);
    var row = el('div', 'prow' + (vis ? '' : ' dim'));

    var eye = el('button', 'btn icon', vis ? '👁' : '🚫');
    eye.title = vis ? 'Shown in the point bar — tap to hide' : 'Hidden — tap to show';
    eye.addEventListener('click', function () { togglePointVis(i); commitStore(); renderPanel(); });
    row.appendChild(eye);

    var name = el('input', 'pedit'); name.type = 'text';
    name.value = currentLabel(i);
    name.placeholder = p.name || ('Points ' + (i + 1));
    name.addEventListener('change', function () { setPointLabel(i, name.value); commitStore(); renderPanel(); });
    row.appendChild(name);

    if (valsNode) row.appendChild(valsNode);
    body.appendChild(row);

    // When we've renamed this one, show the author's original underneath so
    // the user can still tell what it was.
    var orgName = originalLabel(i);
    if (orgName && orgName !== currentLabel(i)) {
      body.appendChild(el('div', 'porig', 'orig: ' + orgName));
    }
  }

  function renderPointsInto(body) {
    var app = getApp();
    // Show/hide works on every generation now: newer builds via isNotShownPointBar,
    // older/light classic via the activatedId gate (see isPointShown/togglePointVis).
    body.appendChild(el('div', 'sec', 'Point bar'));
    body.appendChild(el('div', 'hint', '👁 show / hide in the game bar · rename the label · set the value'));
    // One-tap bulk shortener for games that cram many long point names.
    var tools = el('div', 'presets');
    tools.appendChild(mkBtn('✂ Shorten labels', 'sm', function () { shortenAllLabels(); commitStore(); renderPanel(); }));
    body.appendChild(tools);
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

    // Surface content the author hid until requirements are met: fully-hidden
    // cards (visible filters), addons, and whole sections gated by row reqs.
    body.appendChild(el('div', 'sec', 'Reveal hidden'));
    var rv = el('div', 'presets');
    rv.appendChild(mkBtn('Show hidden cards', '', function () { showHiddenCards(); commitStore(); }));
    if ('showAllAddons' in app) rv.appendChild(mkBtn('Show all addons', '', function () { revealAllAddons(); commitStore(); }));
    rv.appendChild(mkBtn('Expand hidden sections', '', function () { revealHiddenRows(); commitStore(); if (activeTab === 'rows') renderPanel(); }));
    body.appendChild(rv);

    // Update the build you already saved (keeps its public/private state), or
    // deliberately save a separate second one — shared or private. Plus the
    // game's own save/load/export menu when its point-bar anchor exists.
    body.appendChild(el('div', 'sec', 'Build'));
    var bp = el('div', 'presets');
    bp.appendChild(mkBtn('Update my build', 'p', function () { postBuild(false); }));
    bp.appendChild(mkBtn('Post as new build', '', function () { postBuild(true, true); }));
    bp.appendChild(mkBtn('Save new private build', '', function () { postBuild(true, false); }));
    if (gameMenuAnchor()) {
      bp.appendChild(mkBtn('Save / load / export image', '', function () { openGameMenu(); closePanel(); }));
    }
    body.appendChild(bp);

    // How to open a card's own menu: long-press, or a small button per card
    // (fallback for devices/browsers where the long-press misbehaves).
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

  // Does a row (or any of its cards) match the query? Reads the store, not the
  // DOM, so hidden cards and cards inside gated-shut sections are searchable.
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
    title.appendChild(el('span', 'rname', rowTitle(r, i)));   // one line, ellipsis
    rowBadges(r).forEach(function (t) { title.appendChild(el('span', 'badge', t)); });
    item.appendChild(title);

    var req = reqSummary(r.requireds);
    if (req) item.appendChild(el('div', 'rreq', '⚑ needs: ' + req));   // one line, ellipsis

    var desc = stripHtml(r.titleText);
    if (desc) item.appendChild(el('div', 'desc', desc));   // clamped to 3 lines via CSS

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

  // ---- long-press card context menu -----------------------------------------
  function tokenId(elm, prefix) {
    var cur = elm;
    while (cur && cur !== document.body) {
      if (cur.classList) {
        for (var i = 0; i < cur.classList.length; i++) {
          var c = cur.classList[i];
          if (c.indexOf(prefix) === 0) {
            var rest = c.slice(prefix.length);
            // exclude compound row tokens like row-<id>-bg / -header
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

  // Stop the mobile browser from starting a text selection / callout during our
  // long-press: kill user-select for the press window and block selectstart.
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
    if (mode !== 'cheat') return;           // card cheats live in cheat mode only
    if (gateUnlocked !== true) return;      // no card cheats until a build unlocks them
    if (inOurUI(e)) return;
    if (cardBtnInPath(e)) return;           // our card button handles its own click
    var cid = cardIdFromNode(e.target);
    if (!cid) return;                       // only cards get the long-press
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
    // Never swallow clicks inside our own shadow UI — a lingering suppressClick
    // (from a long-press whose follow-up click never fired) must not eat the very
    // next tap on our panel/menu buttons.
    if (inOurUI(e)) return;
    var cb = cardBtnInPath(e);
    if (cb) {
      // Never let this reach the card's activateObject; open our menu instead.
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

    // position: prefer below the card, clamp to viewport
    var mw = cardMenu.offsetWidth, mh = cardMenu.offsetHeight;
    var left = Math.min(Math.max(8, rect.left), window.innerWidth - mw - 8);
    var top = rect.bottom + 8;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 8);
    cardMenu.style.left = left + 'px';
    cardMenu.style.top = top + 'px';
  }
  function refreshCardMenu(choiceId) { openCardMenu(choiceId); }

  // Tapping outside our shadow UI dismisses the card menu and/or the sheet.
  // A tap inside anything of ours (FAB, panel, card menu) has `host` in its
  // composedPath (shadow children compose up through the host), so it's spared.
  function onDocPointer(e) {
    if (!cardMenu && !panelOpen) return;
    var path = e.composedPath ? e.composedPath() : [];
    var inHost = path.indexOf(host) !== -1;
    if (cardMenu && path.indexOf(cardMenu) === -1 && !inHost) closeCardMenu();
    if (panelOpen && !inHost) closePanel();
  }

  // Esc closes the topmost thing we own (card menu first, then the sheet). In
  // native fullscreen the browser eats Esc to exit — that's fine, the sticky ✕
  // and tap-outside still work there.
  function onKeyDown(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc' && e.keyCode !== 27) return;
    if (cardMenu) { closeCardMenu(); e.stopPropagation(); e.preventDefault(); return; }
    if (panelOpen) { closePanel(); e.stopPropagation(); e.preventDefault(); }
  }

  // ---- init -----------------------------------------------------------------
  function init() {
    loadCardPref();
    build();
    // Gate bridge: listen for the parent, announce we're ready, and if no trusted
    // parent handshakes shortly (standalone ?__cheat=1), unlock locally. Card
    // decoration is deferred to onGateResolved so it never appears while locked.
    window.addEventListener('message', onHostMessage);
    announceReady();
    // Standalone unlock only matters for a hand-crafted ?__cheat=1 URL; in saver
    // mode the site is always the parent (it added the ?__save flag).
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
    else if (++tries > 400) clearInterval(iv);   // ~200s; give up quietly (no ICC store found)
  }, 500);
})();
