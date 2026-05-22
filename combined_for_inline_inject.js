/* combined_for_inline_inject.js -- hand-scraper-postflop-flop-turn
 *
 * Tier 1 + 2 + 3 fixes (2026-05-22) on top of all earlier phases:
 *   - Tier 1: all-terminals-cached + per-card-manifest + modal-cleanup
 *   - Tier 2: Categories panel locator + humanCategoryExploration
 *   - Tier 3: cfg.shuffle_cards (random visit order) + human_like.partial_browse_chance
 *
 * POST-TIER hotfixes (2026-05-22 second + third pass):
 *   - cached_flop_terminals now set BEFORE saveCheckpoint on fresh flop walks
 *   - Categories panel locator rewritten: walks UP from chevrons (not from
 *     the 'Categories' tab label, which is in a separate DOM subtree on the
 *     live trainer), uses plain includes() with a 2+ label requirement
 *     (\b word boundaries fail because labels are smushed against their
 *     percentages: "Quads100%0.39%Full House81%19%...").
 *   - humanCategoryExploration new timings: 5-8s settle on entry, 1-3s
 *     between successive chevron clicks, 5-15s settle after the last click.
 *     NEVER collapses (leaves expanded chevrons as natural human reading
 *     state). Live-verified on 4s4d2c that clicking chevrons expands
 *     subcategory rows.
 *
 * Banner identifier kept stable: bootstrap grep checks for
 *   'hand-scraper-postflop-flop-turn'
 */

/* ==================== 1) WALKER (tier 2 noise) ==================== */
/* multi_street_walker.js - DOM-only walker for the PLO Master Mind postflop trainer.
 *
 * Installs window.__W with primitives for DFS, modal handling, alias-aware card
 * picks (with post-click no-sim recovery), and back-navigation.
 *
 * NEVER reloads the page. All state changes via DOM clicks only.
 *
 * Install order: this FIRST, then scrape_helpers.js, then scrape_multistreet.js.
 *
 * v18 changes from v15 (walker):
 *   - ALL-IN NO-DESCEND: when the DFS iteration loop picks an All-in action
 *     (code 'A'), the walker no longer recurses into a fresh dfsStreet for
 *     the N-A child node. Instead it inline-records N-A: pays the 3-5 s
 *     interNodeWait, waits for the panel to stabilize, snapshots N-A's
 *     childrenSpec (Call/Fold, both terminal in heads-up postflop), and
 *     pushes the node record. No iteration loop is entered under N-A. The
 *     trainer's /range/url capture for N-A is still made by the click, so
 *     all per-All-in opponent-range data is preserved.
 *   - BACK-OUT CHAIN COLLAPSE: after each child recursion (or inline All-in
 *     record) returns, the walker first checks whether THIS depth still has
 *     un-walked iterable siblings. If not, it `return`s without doing its
 *     own header-click back-out. The nearest ancestor whose iteration is
 *     NOT exhausted does ONE click to navigate URL from wherever (possibly
 *     several levels deeper than its own state.node) directly back to its
 *     own state.node. Per-ancestor single-click back-out is preserved
 *     (clicking a breadcrumb at any index navigates URL.node to that depth
 *     in one click regardless of current depth), so total back-out cost
 *     collapses from N clicks (deep branch) to 1 click. NO DATA LOSS:
 *     intermediate-depth All-in lines (e.g. R100-A in a R100-R200-A branch)
 *     are still walked by the natural DFS unwind because their parent's
 *     iteration loop continues normally after this depth returns.
 *
 * v15 changes from v14 (walker):
 *   - dfsStreet now sleeps a random 3-5 seconds at the START of every node
 *     visit (every recursive call) so the trainer / DOM has time to settle
 *     between successive node walks. The range is configurable via
 *     window.__msNodeWaitMin / window.__msNodeWaitMax (defaults: 3000 / 5000 ms).
 *     Set both to 0 to disable.
 *
 * v8 changes from v7:
 *   - REPLACED v7's rigid "originalActionLabels" signature check with
 *     stability-based detection. The trainer asynchronously reveals additional
 *     bet sizings AFTER navigation/step-back; v7 treated this as a click race
 *     and abandoned bet branches, producing partial walks ("only check line").
 *   - waitForActionPanelStable() polls the active block's action signature
 *     until it sees the same labels twice >=stableGapMs apart, then returns.
 *   - dfsStreet now uses re-snapshot-per-iteration with a walkedLabels Set,
 *     instead of iterating over a stale captured action list.
 *   - pickCardCommit now requires action panel STABILITY (same labels twice
 *     ~600ms apart) before declaring commit.
 *
 * v7 changes from v6 (kept):
 *   - clickActionAndWait/clickHeaderAndWait return {success, after, expected}.
 *   - dfsStreet retries each action click once on failure, refuses to descend
 *     when URL doesn't match expected childPath.
 *   - replaySegments throws on failed click (with one retry).
 *
 * v6 changes from v5 (still in effect):
 *   - listCanonicalCards is DEPRECATED. Orchestrator uses fused walk-and-scrape.
 *   - dismissNoSimPopupIfAny() — proactively closes "Generate solve?" popup.
 *
 * v5 changes from v4 (still in effect):
 *   - isStreetCloser('Check') is now scoped to current-street segments via
 *     state.streetEntryNode.
 */
(function installMultiStreetWalker() {
  const ACTION_CODE = {
    'Check':'C','Fold':'F','Call':'C',
    '1/5 pot':'R20','1/4 pot':'R25','1/3 pot':'R33','1/2 pot':'R50',
    '2/3 pot':'R66','3/4 pot':'R75','Pot':'R100',
    'All in':'A','All-in':'A','Allin':'A',
  };
  const DYNAMIC_LABEL_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*pot\s*$/i;
  function codeForLabel(label) {
    if (label == null) return null;
    if (label in ACTION_CODE) return ACTION_CODE[label];
    const m = DYNAMIC_LABEL_RE.exec(label);
    if (!m) return null;
    const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
    if (!den) return null;
    const pct = Math.round((num / den) * 100);
    const code = 'R' + pct;
    window.__msDynamicLabels = window.__msDynamicLabels || {};
    if (!(label in window.__msDynamicLabels)) {
      window.__msDynamicLabels[label] = code;
      try {
        (window.__msResult?.warnings || window.__msDynamicWarnings || (window.__msDynamicWarnings = []))
          .push(`dynamic label resolution: "${label}" -> code "${code}" (not in static ACTION_CODE; consider adding to v11+)`);
      } catch (_) {}
    }
    return code;
  }
  const STATIC_REVERSE = { R33:'1/3 pot', R50:'1/2 pot', R66:'2/3 pot', R75:'3/4 pot', R100:'Pot' };
  function labelForCodeFromActions(seg, ab) {
    if (STATIC_REVERSE[seg]) {
      if (ab.actions.find(a => a.label === STATIC_REVERSE[seg] && !a.disabled)) {
        return STATIC_REVERSE[seg];
      }
    }
    if (!/^R\d+$/.test(seg)) return null;
    for (const a of ab.actions) {
      if (a.disabled) continue;
      if (codeForLabel(a.label) === seg) return a.label;
    }
    return null;
  }
  const ACTION_RE  = /^(Check|Fold|Call|All\s*-?\s*in|Pot|\d+\/\d+\s*pot|Raise)\b/i;
  const CHOSEN_RE  = /(?:^|\s)bg-(?:call|fold|check|raise|bet|allin|pot|action)-\d/;
  const PLAYER_RE  = /^(BB|SB|UTG|MP|CO|BTN|HJ|LJ)(\d+(?:\.\d+)?)$/i;
  const ROW_SUIT   = ['s','h','d','c'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $$    = sel => [...document.querySelectorAll(sel)];

  function _nodeWaitMs() {
    const minDef = 3000, maxDef = 5000;
    const wMin = (typeof window.__msNodeWaitMin === 'number') ? window.__msNodeWaitMin : minDef;
    const wMax = (typeof window.__msNodeWaitMax === 'number') ? window.__msNodeWaitMax : maxDef;
    if (wMin <= 0 && wMax <= 0) return 0;
    const lo = Math.max(0, Math.min(wMin, wMax));
    const hi = Math.max(0, Math.max(wMin, wMax));
    if (hi === 0) return 0;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  // PHASE 4: human-like primitives. All gated on window.__msHumanCfg; default off.
  function _hcfg() { return window.__msHumanCfg || {}; }
  function _hRange(name, defLo, defHi) {
    const r = _hcfg()[name];
    if (Array.isArray(r) && r.length === 2 && typeof r[0] === 'number' && typeof r[1] === 'number') return r;
    return [defLo, defHi];
  }
  function _hPickInt(lo, hi) {
    lo = Math.max(0, lo|0); hi = Math.max(lo, hi|0);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  function _hChance(name, def) {
    const v = _hcfg()[name];
    return (typeof v === 'number' && v >= 0 && v <= 1) ? v : def;
  }

  async function interNodeWait() {
    let ms = _nodeWaitMs();
    if (Math.random() < _hChance('long_pause_chance', 0)) {
      const [lo, hi] = _hRange('long_pause_range_ms', 15000, 90000);
      if (hi > 0) ms = _hPickInt(lo, hi);
    }
    if (ms > 0) {
      window.__msNodeWaitStats = window.__msNodeWaitStats || { count: 0, total_ms: 0, last_ms: 0, long_pauses: 0 };
      window.__msNodeWaitStats.count++;
      window.__msNodeWaitStats.total_ms += ms;
      window.__msNodeWaitStats.last_ms = ms;
      if (ms >= 12000) window.__msNodeWaitStats.long_pauses++;
      await sleep(ms);
    }
  }

  async function humanNodeBrowseHover(k) {
    try {
      const blocks = readBlocks();
      if (!blocks.length) return 0;
      const pool = blocks.slice();
      const targets = [];
      for (let i = 0; i < k && pool.length; i++) {
        targets.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
      for (const b of targets) {
        const el = b.headerEl || b.blockEl;
        if (!el) continue;
        try {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
        } catch (_) {}
        await sleep(200 + Math.floor(Math.random() * 600));
      }
      window.__msHumanStats = window.__msHumanStats || { node_hovers: 0, category_bursts: 0, turn_hovers: 0 };
      window.__msHumanStats.node_hovers += targets.length;
      return targets.length;
    } catch (e) { return 0; }
  }

  // Cached Categories panel (re-located if missing or detached).
  // Same logic as hand-scraper/scripts/expand_tree.js -- battle-tested.
  function _msFindCategoriesPanel() {
    if (window.__msCatPanel && document.contains(window.__msCatPanel)) {
      return window.__msCatPanel;
    }
    let catLabel = null;
    try {
      catLabel = [...document.querySelectorAll('*')].find(
        e => (e.textContent || '').trim() === 'Categories' && e.children.length === 0
      );
    } catch (_) {}
    if (!catLabel) return null;
    // POST-TIER-3 FIX v2 (2026-05-22): the trainer renders category labels
    //   smushed against percentages with no separator ("Quads100%0.39%Full
    //   House81%19%..."), so \b word boundaries fail. Switch to plain
    //   includes() with a 2+ label requirement to avoid Pair/Air false
    //   positives. Also start the walk from chevrons (not the 'Categories'
    //   tab label) because on the live trainer the tab label and the
    //   content panel are in SEPARATE DOM subtrees -- the original
    //   walk-up-from-label approach can never reach the panel.
    const CATEGORY_LABELS = [
      'Unpaired', 'One pair', 'One Pair', 'Two pair', 'Two Pair',
      'Trips', 'Quads', 'Full House', 'Straight', 'Flush',
      'Draws', 'Air', 'Overpair'
    ];
    function _msIsCategoryPanel(el) {
      const txt = el.textContent || '';
      if (!/\d+\.\d{2}%/.test(txt)) return false;
      let nMatch = 0;
      for (const lbl of CATEGORY_LABELS) {
        if (txt.includes(lbl)) { nMatch++; if (nMatch >= 2) return true; }
      }
      return false;
    }
    // Walk up from every chevron (not from the Categories tab label).
    const _chevrons = document.querySelectorAll('.flex.size-4.shrink-0.items-center.cursor-pointer');
    for (const _ch of _chevrons) {
      let _n = _ch;
      for (let _i = 0; _i < 15 && _n; _i++) {
        if (_n !== document.body && _msIsCategoryPanel(_n)) {
          window.__msCatPanel = _n;
          return _n;
        }
        _n = _n.parentElement;
      }
    }
    // Fallback: if no chevrons (rare), retain the old walk-up-from-label path
    let panel = catLabel;
    while (panel) {
      const txt = panel.textContent || '';
      if (panel !== document.body && _msIsCategoryPanel(panel)) {
        // Exclude the whole app shell (which also contains everything else)
        let w = 9999;
        try { w = panel.getBoundingClientRect().width; } catch (_) {}
        if (w < 700) {
          window.__msCatPanel = panel;
          return panel;
        }
      }
      panel = panel.parentElement;
    }
    return null;
  }

  // PHASE 4 (revised): humanCategoryExploration uses the exact panel locator +
  // chevron selector from hand-scraper/scripts/expand_tree.js. Clicks random K
  // chevron wrappers in the Categories panel (bottom-left). No /range/url
  // calls. Caller's category_selector cfg knob can override the chevron
  // selector if the trainer DOM changes later.
  // TIER 2 FIX #4: ensure the Categories tab is active so its panel renders.
  //   The tab label is the leaf element with textContent === 'Categories'.
  //   Clicking the nearest clickable ancestor activates the tab.
  //   Idempotent via window.__msCategoriesTabActivated.
  async function activateCategoriesTab() {
    if (window.__msCategoriesTabActivated) return true;
    try {
      // If the Categories panel is already locatable, the tab is active.
      if (_msFindCategoriesPanel()) {
        window.__msCategoriesTabActivated = true;
        return true;
      }
      const catLabel = [...document.querySelectorAll('*')].find(
        e => (e.textContent || '').trim() === 'Categories' && e.children.length === 0
      );
      if (!catLabel) return false;
      // Walk up to find a clickable ancestor (cursor:pointer, BUTTON, or role=tab).
      let clickable = catLabel;
      for (let i = 0; i < 6 && clickable; i++) {
        const tag = (clickable.tagName || '').toUpperCase();
        const role = clickable.getAttribute && clickable.getAttribute('role');
        let cur = '';
        try { cur = getComputedStyle(clickable).cursor || ''; } catch (_) {}
        if (cur === 'pointer' || tag === 'BUTTON' || role === 'tab') break;
        clickable = clickable.parentElement;
      }
      if (!clickable) clickable = catLabel.parentElement;
      if (!clickable) return false;
      clickable.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(150 + Math.floor(Math.random() * 250));
      clickable.click();
      await sleep(600 + Math.floor(Math.random() * 600));
      const ok = !!_msFindCategoriesPanel();
      window.__msCategoriesTabActivated = ok;
      return ok;
    } catch (e) {
      return false;
    }
  }

  // TIER 2 FIX #5: pretendPartialBrowse -- pure-noise hover-only browse of
  //   the currently-open turn modal. Hovers 3-5 random non-used cells with
  //   small dwell pauses, optionally triggers a small category burst. NEVER
  //   clicks a card (zero /range/url calls). Caller passes currentTerminal
  //   so it can be logged.
  async function pretendPartialBrowse(currentTerminal) {
    try {
      if (modalKind() !== 'turn') return 0;
      const cells = readModalCells('turn');
      if (!cells.length) return 0;
      const pool = cells.filter(c => c.status === 'ok');
      if (!pool.length) return 0;
      const k = 3 + Math.floor(Math.random() * 3); // 3-5
      const picks = [];
      const poolCopy = pool.slice();
      for (let i = 0; i < k && poolCopy.length; i++) {
        picks.push(poolCopy.splice(Math.floor(Math.random() * poolCopy.length), 1)[0]);
      }
      for (const cell of picks) {
        if (!cell.el) continue;
        try {
          cell.el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          cell.el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        } catch (_) {}
        await sleep(600 + Math.floor(Math.random() * 1400));
      }
      // Optional category nudge during the browse (50% chance).
      if (Math.random() < 0.5) {
        try { await humanCategoryExploration(1); } catch (_) {}
      }
      window.__msHumanStats = window.__msHumanStats || { node_hovers: 0, category_bursts: 0, turn_hovers: 0, partial_browses: 0 };
      window.__msHumanStats.partial_browses = (window.__msHumanStats.partial_browses || 0) + 1;
      return picks.length;
    } catch (e) {
      return 0;
    }
  }

  async function humanCategoryExploration(k) {
    // POST-TIER-3 FIX v2 (2026-05-22): new timing per user request.
    //   - Wait 5-8s on entry so a fresh node has time to fully render the
    //     Categories panel (slow VPN connections can need this).
    //   - 1-3s gap between successive chevron clicks.
    //   - 5-15s wait after the last click (lets the trainer settle and
    //     mimics a human reading the expanded subcategories).
    //   - DO NOT collapse the chevrons back. Leave them expanded; the
    //     subsequent walker action picks up cleanly because the chevrons
    //     are non-destructive UI state.
    const cfg = _hcfg();
    function _rint(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
    // Initial settle wait — at least 5 s, random up to 8 s.
    await sleep(_rint(5000, 8000));
    try { await activateCategoriesTab(); } catch (_) {}
    const panel = _msFindCategoriesPanel();
    if (!panel) {
      // Categories panel not found — maybe slow render or different tab.
      // Quietly no-op rather than fall back to dangerous heuristics.
      return 0;
    }
    const chevronSel = cfg.category_selector || '.flex.size-4.shrink-0.items-center.cursor-pointer';
    let chevrons = [];
    try { chevrons = [...panel.querySelectorAll(chevronSel)]; } catch (_) {}
    if (!chevrons.length) return 0;
    // Pick K random distinct chevrons. K typically 1-2 per call.
    const picks = [];
    const pool = chevrons.slice();
    for (let i = 0; i < k && pool.length; i++) {
      picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    if (!picks.length) return 0;
    // Click each with 1-3s gap. No collapse afterward.
    for (let i = 0; i < picks.length; i++) {
      try { picks[i].click(); } catch (_) {}
      if (i < picks.length - 1) {
        await sleep(_rint(1000, 3000));
      }
    }
    // Final settle wait: 5-15s after the last click.
    await sleep(_rint(5000, 15000));
    // Stats
    window.__msHumanStats = window.__msHumanStats || { node_hovers: 0, category_bursts: 0, turn_hovers: 0, partial_browses: 0 };
    window.__msHumanStats.category_bursts = (window.__msHumanStats.category_bursts || 0) + 1;
    return picks.length;
  }

  async function humanTurnBrowseHover(targetCard, k) {
    try {
      const cells = readModalCells('turn');
      if (!cells.length) return 0;
      const pool = cells.filter(c => c.card !== targetCard && c.status === 'ok');
      if (!pool.length) return 0;
      const picks = [];
      const poolCopy = pool.slice();
      for (let i = 0; i < k && poolCopy.length; i++) {
        picks.push(poolCopy.splice(Math.floor(Math.random() * poolCopy.length), 1)[0]);
      }
      for (const cell of picks) {
        if (!cell.el) continue;
        try {
          cell.el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
          cell.el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
        } catch (_) {}
        await sleep(400 + Math.floor(Math.random() * 800));
      }
      window.__msHumanStats = window.__msHumanStats || { node_hovers: 0, category_bursts: 0, turn_hovers: 0 };
      window.__msHumanStats.turn_hovers += picks.length;
      return picks.length;
    } catch (e) { return 0; }
  }

  // ------------------- PHASE 7: detectUnexpectedState -------------------
  // Returns null if everything looks normal, else a {reason, detail} object.
  // Caller (orchestrator) sets window.__msEmergencyStop = true on detection
  // and aborts the run at the next safe boundary.
  function detectUnexpectedState() {
    try {
      // Title check
      const title = (document.title || "").trim();
      if (!/PLO\s*(?:Master\s*Mind|Trainer)/i.test(title) && title.length > 0) {
        return { reason: "title_mismatch", detail: { title } };
      }
      // URL check
      const path = location.pathname;
      const params = new URLSearchParams(location.search);
      const isPostflop = (params.get("type") === "postflop") || /postflop/i.test(path);
      if (!isPostflop) {
        return { reason: "url_not_postflop", detail: { href: location.href } };
      }
      // Captcha / login indicators
      const recaptcha = document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], div.g-recaptcha, [data-captcha]');
      if (recaptcha) {
        return { reason: "captcha_detected", detail: { tag: recaptcha.tagName } };
      }
      // "Sign in" / "Log in" buttons appearing in body (heuristic)
      const loginBtns = $$('button,a').filter(el => /\b(sign\s*in|log\s*in|login|signin)\b/i.test((el.textContent||"").trim()));
      if (loginBtns.length > 0 && !document.querySelector('[data-app-loaded]') ) {
        // Only flag if the trainer's main panel ISN'T visible
        const trainerVisible = readBlocks().length > 0 || $$('.bg-neutral-950.px-2').length > 0;
        if (!trainerVisible) {
          return { reason: "login_required", detail: { n_login_buttons: loginBtns.length } };
        }
      }
      // HTTP 4xx/5xx on /range/url tracked elsewhere; just check sticky flag.
      if (window.__msUnexpectedHttp) {
        return { reason: "http_error", detail: window.__msUnexpectedHttp };
      }
    } catch (e) {
      return { reason: "detect_exception", detail: { message: e.message } };
    }
    return null;
  }

  // ------------------- PHASE 7: emitEmergencyStopFile -------------------
  // Browser Blob download. Same approach as resume.json files. The cron
  // pre-flight uses merge_resumes.py check-emergency-stop, which reads
  // <device>.active in the ingest folder once the file is moved.
  function emitEmergencyStopFile(payload) {
    try {
      const dev = (window.__msHumanCfg && window.__msHumanCfg.device_name) ||
                  (window.__msLaunchCfg && window.__msLaunchCfg.device_name) || 'unknown';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      // Two file emits: a timestamped detail file + a sentinel.
      const detail = Object.assign({
        ts: new Date().toISOString(), device: dev,
        url: location.href, page_title: document.title,
      }, payload || {});
      const detailName  = `${dev}_${ts}.emergencystop.json`;
      const sentinelName = `${dev}.active.emergencystop.json`;
      for (const [name, body] of [[detailName, detail], [sentinelName, detail]]) {
        try {
          const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click();
          setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
        } catch (e) {
          console.warn('[hand-scraper phase7] emitEmergencyStopFile failed for', name, e && e.message);
        }
      }
      console.warn('[hand-scraper phase7] EMERGENCY STOP emitted:', detail);
    } catch (_) {}
  }

  let _humanNodeCount = 0;
  let _humanNextCategoryAt = null;
  let _humanNextNodeBrowseAt = null;
  function _humanNextInterval(rangeName) {
    const [lo, hi] = _hRange(rangeName, 0, 0);
    if (lo <= 0 || hi <= 0) return null;
    return _hPickInt(lo, hi);
  }
  async function maybeHumanLikeNoiseBetweenNodes() {
    _humanNodeCount++;
    if (_humanNextCategoryAt === null) _humanNextCategoryAt = _humanNextInterval('category_every_n_range');
    if (_humanNextNodeBrowseAt === null) _humanNextNodeBrowseAt = _humanNextInterval('node_hover_every_n_range');
    if (_humanNextCategoryAt !== null && _humanNodeCount >= _humanNextCategoryAt) {
      const k = _hPickInt(..._hRange('category_count_range', 1, 2));
      if (k > 0) await humanCategoryExploration(k);
      _humanNextCategoryAt = _humanNodeCount + (_humanNextInterval('category_every_n_range') || 0);
    }
    if (_humanNextNodeBrowseAt !== null && _humanNodeCount >= _humanNextNodeBrowseAt) {
      const k = _hPickInt(..._hRange('node_hover_count_range', 1, 3));
      if (k > 0) await humanNodeBrowseHover(k);
      _humanNextNodeBrowseAt = _humanNodeCount + (_humanNextInterval('node_hover_every_n_range') || 0);
    }
  }

  const urlObj      = () => new URL(location.href);
  const urlNode     = () => urlObj().searchParams.get('node') || '';
  const urlTurn     = () => urlObj().searchParams.get('turn');
  const urlRiver    = () => urlObj().searchParams.get('river');
  const urlSuitMap  = () => urlObj().searchParams.get('suitMap');
  const urlTree     = () => urlObj().searchParams.get('tree');
  const urlFlop     = () => urlObj().searchParams.get('flop');

  function readBlocks() {
    const out = [];
    for (const el of $$('div.bg-neutral-987-5.cursor-pointer.rounded-md')) {
      const cls = el.className?.toString() || '';
      const headerEl = el.querySelector('.bg-neutral-950.px-2');
      const headerText = headerEl ? (headerEl.textContent || '').trim() : '';
      if (!headerText || /^(flop|turn|river)$/i.test(headerText)) continue;
      const m = headerText.match(PLAYER_RE);
      if (!m) continue;
      const seen = new Set();
      const actions = [];
      for (const a of [...el.querySelectorAll('.cursor-pointer')].filter(c => c !== el)) {
        const t = (a.textContent || '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        if (!ACTION_RE.test(t) || t.length > 18) continue;
        const acls = (a.className || '').toString();
        actions.push({ label: t, el: a, chosen: CHOSEN_RE.test(acls), disabled: /pointer-events-none/.test(acls) });
      }
      out.push({ player: m[1].toUpperCase(), stack: parseFloat(m[2]), headerEl, blockEl: el, isActive: /border-additinal-active/.test(cls), actions });
    }
    return out;
  }
  const activeBlock = () => readBlocks().find(b => b.isActive) || null;
  function lastVisitedChosen() {
    const blocks = readBlocks();
    let last = null;
    for (const b of blocks) { if (b.isActive) break; last = b; }
    if (!last) return null;
    const c = last.actions.find(a => a.chosen);
    return c ? c.label : null;
  }

  function modalKind() {
    const h = $$('h4').find(h => /^Select (turn|river)$/.test((h.textContent || '').trim()));
    return h ? (/turn/.test(h.textContent) ? 'turn' : 'river') : null;
  }
  function hasNoSimPopup() { return $$('h4').some(h => /Generate/.test(h.textContent || '')); }
  async function dismissNoSimPopupIfAny() {
    if (!hasNoSimPopup()) return false;
    const popupHeading = $$('h4').find(h => /Generate/.test(h.textContent || ''));
    if (!popupHeading) return false;
    let container = popupHeading;
    for (let k = 0; k < 12 && container.parentElement; k++) {
      if (container.querySelector('button')) break;
      container = container.parentElement;
    }
    const btns = [...container.querySelectorAll('button')];
    let target = btns.find(b => /cancel|close|×|✕|x$/i.test((b.textContent || '').trim()));
    if (!target) target = btns[0];
    if (!target) return false;
    target.click();
    await sleep(500);
    if (hasNoSimPopup()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
    }
    return !hasNoSimPopup();
  }
  function modalRoot(kind) {
    const heading = $$('h4').find(el => (el.textContent || '').trim() === `Select ${kind}`);
    if (!heading) return null;
    let m = heading;
    for (let k = 0; k < 20; k++) {
      if (!m.parentElement) break;
      if ((m.textContent || '').includes(`Load random ${kind}`)) break;
      m = m.parentElement;
    }
    if (!(m.textContent || '').includes(`Load random ${kind}`) && m.parentElement) m = m.parentElement;
    return m;
  }
  function readModalCells(kind) {
    const m = modalRoot(kind);
    if (!m) return [];
    const cells52 = [...m.querySelectorAll('div')].filter(d => {
      const t = (d.textContent || '').trim();
      if (!/^[2-9TJQKA]$/.test(t)) return false;
      const cls = (d.className || '').toString();
      return /h-7\s/.test(cls) || /w-5\.5/.test(cls);
    });
    const byParent = new Map();
    for (const c of cells52) {
      const p = c.parentElement;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(c);
    }
    const rows = [...byParent.values()];
    const cells = [];
    rows.forEach((row, rIdx) => {
      const suit = ROW_SUIT[rIdx];
      row.forEach(cell => {
        const rank = (cell.textContent || '').trim();
        const cls = (cell.className || '').toString();
        let status = 'ok';
        if (/pointer-events-none/.test(cls) && /opacity-0\b/.test(cls)) status = 'used';
        else if (/opacity-20/.test(cls)) status = 'dim';
        cells.push({ card: rank + suit, rank, suit, row: rIdx, status, el: cell });
      });
    });
    return cells;
  }
  async function closeModalX() {
    const k = modalKind();
    if (!k) return false;
    const m = modalRoot(k);
    if (!m) return false;
    const btn = m.querySelector('button');
    if (!btn) return false;
    btn.click();
    await sleep(700);
    return modalKind() === null;
  }
  async function reopenChipModal(kind) {
    const re = kind === 'turn' ? /^[Tt]urn[2-9TJQKA]/ : /^[Rr]iver[2-9TJQKA]/;
    const chip = $$('div').find(d => {
      const cls = d.className?.toString() || '';
      if (!/cursor-pointer/.test(cls) || !/rounded-md/.test(cls)) return false;
      return re.test((d.textContent || '').replace(/\s+/g, ''));
    });
    if (!chip) throw new Error(`no ${kind} chip`);
    chip.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && modalKind() !== kind) await sleep(100);
    await sleep(200);
  }

  async function clickActionAndWait(actionEl, expectedNode = null, timeoutMs = 4000) {
    const before = urlNode();
    actionEl.click();
    const t0 = Date.now();
    let succeeded = false;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(80);
      if (expectedNode !== null) {
        if (urlNode() === expectedNode) { succeeded = true; break; }
      } else if (urlNode() !== before) { succeeded = true; break; }
    }
    await sleep(220);
    return { success: succeeded, before, after: urlNode(), expected: expectedNode };
  }
  async function clickHeaderAndWait(headerEl, expectedNode, timeoutMs = 4000) {
    headerEl.click();
    const t0 = Date.now();
    let succeeded = false;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(80);
      if (urlNode() === expectedNode) { succeeded = true; break; }
    }
    await sleep(220);
    return { success: succeeded, after: urlNode(), expected: expectedNode };
  }
  async function clickCardAndWait(cellEl, kind, timeoutMs = 5000) {
    const beforeKey = `${urlTurn()}|${urlRiver()}|${urlSuitMap()}|${modalKind()}`;
    cellEl.click();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(100);
      if (`${urlTurn()}|${urlRiver()}|${urlSuitMap()}|${modalKind()}` !== beforeKey) break;
    }
    const t1 = Date.now();
    while (Date.now() - t1 < 3000) {
      await sleep(100);
      if (activeBlock()) break;
    }
    await sleep(300);
  }

  function currentStreetSegs(state) {
    const node = state.node || '';
    const entry = state.streetEntryNode || '';
    if (!node) return [];
    if (entry && node === entry) return [];
    if (entry && node.startsWith(entry + '-')) {
      return node.slice(entry.length + 1).split('-');
    }
    return node.split('-');
  }
  function isStreetCloser(label, state) {
    if (state.street === 'river') return false;
    if (label === 'Call') return true;
    if (label === 'Check') {
      const segs = currentStreetSegs(state);
      return segs.length > 0 && segs[segs.length - 1] === 'C';
    }
    return false;
  }
  function nodeKey(state) {
    return `node=${state.node || ''}|turn=${state.turn || ''}|river=${state.river || ''}|sm=${state.suitMap || ''}`;
  }

  async function waitForActionPanelStable(maxMs = 4000, stableGapMs = 500) {
    const t0 = Date.now();
    let prev = null;
    while (Date.now() - t0 < maxMs) {
      const ab = activeBlock();
      if (ab && ab.actions.length > 0) {
        const sig = ab.actions.map(a => `${a.label}|${a.disabled ? 'd' : 'e'}`).join(',');
        if (prev && prev.sig === sig && (Date.now() - prev.ts) >= stableGapMs) {
          return ab;
        }
        if (!prev || prev.sig !== sig) prev = { sig, ts: Date.now() };
      }
      await sleep(150);
    }
    return activeBlock();
  }

  // v18: helpers for the new dfsStreet logic.
  const ALL_IN_LABELS = new Set(['All in', 'All-in', 'Allin']);
  function _v18_isAllInPick(pick) {
    if (!pick) return false;
    if (pick.code === 'A') return true;
    if (ALL_IN_LABELS.has(pick.label)) return true;
    return false;
  }
  function _v18_countIterable(actions, state) {
    let n = 0;
    for (const a of actions) {
      if (a.disabled) continue;
      if (a.label === 'Fold') continue;
      if (isStreetCloser(a.label, state)) continue;
      const code = codeForLabel(a.label);
      if (!code) continue;
      n++;
    }
    return n;
  }

  async function dfsStreet(state, walkResult, opts = {}) {
    // v15: random 3-5s inter-node wait at the start of every node visit.
    // Configurable via window.__msNodeWaitMin / window.__msNodeWaitMax.
    await maybeHumanLikeNoiseBetweenNodes();
    await interNodeWait();
    // Auto-init streetEntryNode on first call into a street.
    if (state.streetEntryNode === undefined) state.streetEntryNode = state.node || '';
    await sleep(80);
    const active = await waitForActionPanelStable(4000, 500);
    if (!active || active.actions.length === 0) {
      walkResult.warnings.push(`no active at ${nodeKey(state)} (no stable panel after wait)`);
      return;
    }
    const prevChosen = lastVisitedChosen();
    const childrenSpec = active.actions.map(a => {
      const code   = codeForLabel(a.label);
      const closer = isStreetCloser(a.label, state);
      return {
        label: a.label, code, disabled: a.disabled,
        closes_street: closer ? (state.street === 'flop' ? 'turn' : 'river') : null,
        child_path: (a.disabled || closer || a.label === 'Fold') ? null
                  : (code ? (state.node ? `${state.node}-${code}` : code) : null),
      };
    });
    walkResult.nodes.push({
      key: nodeKey(state),
      node: state.node, turn: state.turn, river: state.river, suitMap: state.suitMap || null,
      street: state.street,
      actor: active.player, stack: active.stack, prev_chosen: prevChosen,
      children: childrenSpec,
    });
    if (opts.onNodeRecorded) {
      try { await opts.onNodeRecorded(state, walkResult.nodes[walkResult.nodes.length - 1]); }
      catch (e) { walkResult.warnings.push(`onNodeRecorded: ${e.message}`); }
    }
    const blocksNow = readBlocks();
    const myIndex = blocksNow.findIndex(b => b.isActive);

    const walkedLabels = new Set();
    let iterSafety = 0;
    while (iterSafety++ < 12) {
      const abIter = await waitForActionPanelStable(4000, 500);
      if (!abIter || abIter.actions.length === 0) {
        walkResult.warnings.push(`iteration: no stable active block at ${state.node || '(root)'}`);
        break;
      }
      // v18: total iterable count from this fresh snapshot is used post-recursion
      // to decide whether we still owe a per-level back-out (we don't if we've
      // walked every iterable sibling at this depth).
      const iterableTotal = _v18_countIterable(abIter.actions, state);

      let pick = null;
      for (const a of abIter.actions) {
        if (a.disabled) continue;
        if (a.label === 'Fold') continue;
        if (isStreetCloser(a.label, state)) continue;
        if (walkedLabels.has(a.label)) continue;
        const code = codeForLabel(a.label);
        if (!code) {
          walkResult.warnings.push(`unknown label "${a.label}" at ${state.node || '(root)'} (not Check/Call/Fold/Allin and not a recognizable N/M pot label)`);
          walkedLabels.add(a.label);
          continue;
        }
        pick = { label: a.label, code, el: a.el };
        break;
      }
      if (!pick) break;

      walkedLabels.add(pick.label);
      const childPath = state.node ? `${state.node}-${pick.code}` : pick.code;
      const pickIsAllIn = _v18_isAllInPick(pick);

      let clickResult = await clickActionAndWait(pick.el, childPath);
      if (!clickResult.success) {
        walkResult.warnings.push(`click "${pick.label}" at ${state.node || '(root)'} timed out (got "${clickResult.after}" expected "${childPath}") - retrying`);
        await sleep(400);
        const ab2 = activeBlock();
        const retryEl = ab2?.actions.find(a => a.label === pick.label && !a.disabled)?.el;
        if (retryEl) {
          clickResult = await clickActionAndWait(retryEl, childPath);
        }
        if (!clickResult.success) {
          walkResult.warnings.push(`click "${pick.label}" at ${state.node || '(root)'} FAILED on retry — skipping (got "${clickResult.after}" expected "${childPath}")`);
          continue;
        }
      }

      if (urlNode() !== childPath) {
        walkResult.warnings.push(`URL mismatch after click: expected "${childPath}" got "${urlNode()}" — skipping recursion for "${pick.label}"`);
        continue;
      }

      // v18: All-in NO-DESCEND. Inline-record N-A; do not recurse.
      // The post-All-in opponent decision is a leaf (Call=showdown, Fold=line
      // closed), so we record N-A and its terminal childrenSpec without
      // entering an iteration loop under N-A. The trainer's /range/url
      // capture for N-A is made by the click above, so range data for the
      // post-All-in spot is fully preserved.
      if (pickIsAllIn) {
        await maybeHumanLikeNoiseBetweenNodes();
    await interNodeWait();
        const abAllIn = await waitForActionPanelStable(4000, 500);
        if (!abAllIn || abAllIn.actions.length === 0) {
          walkResult.warnings.push(`all-in node ${childPath}: no stable action panel after click (capture may still be valid)`);
        } else {
          const allInState = { ...state, node: childPath };
          const allInChildren = abAllIn.actions.map(a => {
            const ccode = codeForLabel(a.label);
            const closer = isStreetCloser(a.label, allInState);
            return {
              label: a.label, code: ccode, disabled: a.disabled,
              closes_street: closer ? (allInState.street === 'flop' ? 'turn' : 'river') : null,
              child_path: null,
            };
          });
          const allInNodeRec = {
            key: nodeKey(allInState),
            node: childPath,
            turn: allInState.turn,
            river: allInState.river,
            suitMap: allInState.suitMap || null,
            street: allInState.street,
            actor: abAllIn.player,
            stack: abAllIn.stack,
            prev_chosen: pick.label,
            children: allInChildren,
            v18_all_in_no_descend: true,
          };
          walkResult.nodes.push(allInNodeRec);
          if (opts.onNodeRecorded) {
            try { await opts.onNodeRecorded(allInState, allInNodeRec); }
            catch (e) { walkResult.warnings.push(`onNodeRecorded all-in: ${e.message}`); }
          }
        }
      } else {
        await dfsStreet({ ...state, node: childPath }, walkResult, opts);
      }

      // v18: BACK-OUT CHAIN COLLAPSE. If this depth has no more un-walked
      // iterable siblings, return without clicking a header. The nearest
      // ancestor whose iteration is NOT exhausted will do ONE click that
      // navigates URL from wherever (possibly several levels deeper than
      // its own state.node) directly back to its own state.node. Result:
      // total back-out clicks for a deep All-in branch collapse from N
      // (per-level chain) to 1 (single ancestor click). No data loss —
      // intermediate-depth All-in lines (e.g. R100-A in R100-R200-A) are
      // still walked by the parent's iteration continuing after this
      // depth returns.
      if (walkedLabels.size >= iterableTotal) {
        return;
      }

      // Per-level back-out (this depth still has more to walk)
      const blocksAfter = readBlocks();
      const myBlockNow = blocksAfter[myIndex];
      if (!myBlockNow) {
        walkResult.warnings.push(`back-out OOB at ${state.node || '(root)'}`);
        return;
      }
      const headerResult = await clickHeaderAndWait(myBlockNow.headerEl, state.node);
      if (!headerResult.success || urlNode() !== state.node) {
        walkResult.warnings.push(`back-out wrong: exp="${state.node}" got="${urlNode()}"`);
        return;
      }
    }
    if (iterSafety >= 12) {
      walkResult.warnings.push(`iteration safety exhausted at ${state.node || '(root)'} (walked: [${[...walkedLabels].join(',')}])`);
    }
  }

  function segToLabel(seg, ab) {
    if (seg === 'C') {
      if (ab.actions.find(a => a.label === 'Call' && !a.disabled)) return 'Call';
      if (ab.actions.find(a => a.label === 'Check' && !a.disabled)) return 'Check';
      return null;
    }
    if (seg === 'A') return 'All-in';
    if (seg === 'F') return 'Fold';
    return labelForCodeFromActions(seg, ab);
  }
  async function replaySegments(segments, walkResult) {
    let pathSoFar = urlNode();
    for (const seg of segments) {
      const ab = activeBlock();
      if (!ab) throw new Error(`no active during replay at ${pathSoFar} seg=${seg}`);
      const label = segToLabel(seg, ab);
      if (!label) throw new Error(`unknown seg ${seg}`);
      const actEl = ab.actions.find(a => a.label === label && !a.disabled)?.el;
      if (!actEl) throw new Error(`no enabled "${label}" at ${pathSoFar}`);
      const expected = pathSoFar ? `${pathSoFar}-${seg}` : seg;
      let r = await clickActionAndWait(actEl, expected);
      if (!r.success) {
        await sleep(400);
        const ab2 = activeBlock();
        const retryEl = ab2?.actions.find(a => a.label === label && !a.disabled)?.el;
        if (retryEl) r = await clickActionAndWait(retryEl, expected);
        if (!r.success) throw new Error(`replay click "${label}" failed at ${pathSoFar} (got "${r.after}" expected "${expected}")`);
      }
      pathSoFar = expected;
    }
  }
  async function navBackTo(targetNode, targetTurn, targetRiver) {
    let safety = 0;
    while (safety++ < 30) {
      if (urlNode() === targetNode &&
          (urlTurn()  || null) === (targetTurn  || null) &&
          (urlRiver() || null) === (targetRiver || null)) return true;
      const blocks = readBlocks();
      let target = null;
      for (const b of blocks) { if (b.actions.some(a => a.chosen)) target = b; }
      if (!target) break;
      const beforeKey = `${urlNode()}|${urlTurn()}|${urlRiver()}`;
      target.headerEl.click();
      await sleep(700);
      if (`${urlNode()}|${urlTurn()}|${urlRiver()}` === beforeKey) break;
    }
    return urlNode() === targetNode &&
           (urlTurn()  || null) === (targetTurn  || null) &&
           (urlRiver() || null) === (targetRiver || null);
  }

  async function pickCardCommit(card, kind) {
    if (modalKind() !== kind) throw new Error(`pickCardCommit: ${kind} modal not open`);
    const cells = readModalCells(kind);
    const cell = cells.find(c => c.card === card);
    if (!cell) throw new Error(`pickCardCommit: ${card} not in modal`);
    if (cell.status === 'used') throw new Error(`pickCardCommit: ${card} is used`);
    if (cell.status === 'dim')  throw new Error(`pickCardCommit: ${card} no-sim`);
    await clickCardAndWait(cell.el, kind);
    if (hasNoSimPopup()) {
      await closeModalX();
      throw new Error(`pickCardCommit: ${card} triggered no-sim popup post-click`);
    }
    const sm = urlSuitMap();
    const actualForKind = kind === 'turn' ? urlTurn() : urlRiver();
    const isAlias = !!(sm && actualForKind && actualForKind !== card);
    if (!isAlias) {
      const settledAb = await waitForActionPanelStable(5000, 600);
      if (!settledAb || settledAb.actions.length === 0) {
        throw new Error(`pickCardCommit: ${card} committed but action panel not stable (5s timeout)`);
      }
      return { committed: actualForKind, was_alias: false };
    }
    await reopenChipModal(kind);
    const cells2 = readModalCells(kind);
    const ccell = cells2.find(c => c.card === actualForKind);
    if (!ccell) throw new Error(`alias recovery: canonical ${actualForKind} not in modal`);
    await clickCardAndWait(ccell.el, kind);
    const settledAlias = await waitForActionPanelStable(5000, 600);
    if (!settledAlias || settledAlias.actions.length === 0) {
      throw new Error(`pickCardCommit: alias-canonical ${actualForKind} committed but action panel not stable (5s timeout)`);
    }
    return { committed: actualForKind, was_alias: true, alias_requested: card, suitMap_was: sm };
  }

  async function listCanonicalCards(kind, n, recover) {
    const result = { canonicals: [], aliases: [], errors: [] };
    const tried = new Set();
    if (modalKind() !== kind) {
      try { await recover(); } catch (e) { result.errors.push(`initial recover: ${e.message}`); return result; }
    }
    if (modalKind() !== kind) { result.errors.push('modal not open after recover'); return result; }
    let safety = 0;
    while (result.canonicals.length < n && safety++ < 60) {
      if (modalKind() !== kind) {
        try { await recover(); } catch (e) { result.errors.push(`recover: ${e.message}`); return result; }
        if (modalKind() !== kind) { result.errors.push('modal not open after recover'); return result; }
      }
      const cells = readModalCells(kind);
      const candidate = cells.find(c => c.status === 'ok' && !tried.has(c.card));
      if (!candidate) { result.errors.push('exhausted'); return result; }
      tried.add(candidate.card);
      const before = `${urlTurn()}|${urlRiver()}|${urlSuitMap()}|${modalKind()}`;
      candidate.el.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        await sleep(120);
        if (`${urlTurn()}|${urlRiver()}|${urlSuitMap()}|${modalKind()}` !== before) break;
      }
      await sleep(300);
      if (hasNoSimPopup()) { await closeModalX(); await sleep(300); continue; }
      const sm = urlSuitMap();
      const actualForKind = kind === 'turn' ? urlTurn() : urlRiver();
      const isAlias = !!(sm && actualForKind && actualForKind !== candidate.card);
      if (isAlias) result.aliases.push({ requested: candidate.card, canonical: actualForKind, suitMap: sm });
      else result.canonicals.push(candidate.card);
      let bs = 0;
      while ((kind === 'turn' ? urlTurn() : urlRiver()) && bs++ < 5) {
        const blocks = readBlocks();
        let lastChosen = null;
        for (const b of blocks) { if (b.actions.some(a => a.chosen)) lastChosen = b; }
        if (!lastChosen) break;
        const beforeUrl = urlNode();
        lastChosen.headerEl.click();
        await sleep(700);
        if (urlNode() === beforeUrl) break;
      }
    }
    return result;
  }

  window.__W = {
    ACTION_CODE, ROW_SUIT,
    codeForLabel, labelForCodeFromActions,
    urlObj, urlNode, urlTurn, urlRiver, urlSuitMap, urlTree, urlFlop,
    sleep,
    readBlocks, activeBlock, lastVisitedChosen,
    modalKind, modalRoot, readModalCells, hasNoSimPopup, dismissNoSimPopupIfAny,
    clickActionAndWait, clickHeaderAndWait, clickCardAndWait,
    closeModalX, reopenChipModal,
    replaySegments, navBackTo,
    dfsStreet, nodeKey,
    pickCardCommit, listCanonicalCards,
    waitForActionPanelStable,
    interNodeWait,
    humanNodeBrowseHover, humanCategoryExploration, humanTurnBrowseHover,
    maybeHumanLikeNoiseBetweenNodes,
    // PHASE 7
    detectUnexpectedState, emitEmergencyStopFile,
    // TIER 2
    activateCategoriesTab, pretendPartialBrowse,
  };
  window.__msV18WalkerInstalled = true;
  window.__msPhase4HumanLikeInstalled = true;
  window.__msPhase7SafetyInstalled = true;
  window.__msTier2NoiseInstalled = true;
  return 'multi-street walker installed (window.__W) [tier 2 noise: categories-tab activate + partial-browse; phase 7 safety detect + emergency stop emit; phase 4 human-like noise (long pauses + hover bursts + category exploration); v18 all-in no-descend + back-out chain collapse; v15 random 3-5s inter-node wait; v13 plomm envelope support; v11 dynamic bet sizings + 1/5 pot static]';
})();

/* ==================== 2) HELPERS ==================== */
/* scrape_helpers.js - Interceptors, binary blob decoder, per-node CSV+meta
 * processor, and zip writer for the multi-street scraper. Installs
 * window.__msHelpers.
 *
 * Requires window.__W (walker) to be installed first.
 *
 * v15 changes from v14:
 *   - Banner bumped only. No semantic changes vs v14 in this module.
 *
 * v14 (kept):
 *   - labelToTypeSize consults LABEL_TO_API_SUFFIX before the regex
 *     fallback so `2/3 pot` maps to RAISE66 (not RAISE67).
 *
 * v13 (kept):
 *   - PLOMM envelope support via the trainer's range-wasm worker + Comlink.
 */
(function installMSHelpers() {
  if (typeof window.__W === 'undefined') throw new Error('walker missing - install multi_street_walker.js first');
  const W = window.__W;

  const LABEL_TO_API_SUFFIX = {
    'Check':'CHECK','Call':'CALL','Fold':'FOLD',
    '1/5 pot':'RAISE20','1/4 pot':'RAISE25','1/3 pot':'RAISE33',
    '1/2 pot':'RAISE50','2/3 pot':'RAISE66',
    '3/4 pot':'RAISE75','Pot':'RAISE100',
    'All in':'ALLIN','All-in':'ALLIN','Allin':'ALLIN',
  };
  const API_TO_COL = {
    'CHECK':'Check','CALL':'Call','FOLD':'Fold',
    'RAISE20':'Raise20','RAISE25':'Raise25','RAISE33':'Raise33',
    'RAISE50':'Raise50','RAISE66':'Raise66',
    'RAISE75':'Raise75','RAISE100':'Raise100','ALLIN':'Allin',
  };
  const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const SUITS = ['c','d','h','s'];
  const HEADER_SIZE = 5;
  const MISSING_EV_VALUE = -2147483648;
  const SIZING_OF_CODE = {
    R20: 1/5, R25: 1/4, R33: 1/3, R50: 1/2, R66: 2/3, R75: 3/4, R100: 1,
  };

  const FRACTIONAL_LABEL_RE = /^\s*(\d+)\s*\/\s*(\d+)\s*pot\s*$/i;
  const R_CODE_RE = /^R(\d+)$/;

  function apiSuffixForLabel(label) {
    if (label == null) return null;
    if (label in LABEL_TO_API_SUFFIX) return LABEL_TO_API_SUFFIX[label];
    const m = FRACTIONAL_LABEL_RE.exec(label);
    if (!m) return null;
    const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
    if (!den) return null;
    const pct = Math.round((num / den) * 100);
    return 'RAISE' + pct;
  }
  function colForApiSuffix(suffix) {
    if (suffix == null) return null;
    if (suffix in API_TO_COL) return API_TO_COL[suffix];
    const m = /^RAISE(\d+)$/.exec(suffix);
    if (m) return 'Raise' + m[1];
    return suffix;
  }
  function sizingOfCode(seg) {
    if (seg in SIZING_OF_CODE) return SIZING_OF_CODE[seg];
    const m = R_CODE_RE.exec(seg);
    if (!m) return null;
    return parseInt(m[1], 10) / 100;
  }
  function isRaiseSeg(seg) { return sizingOfCode(seg) != null; }

  function installInterceptors() {
    window._capturedRequests = window._capturedRequests || [];
    function note(rec) { window._capturedRequests.push(rec); }
    if (!window.__msFetchPatched) {
      const origFetch = window.fetch;
      window.fetch = function(input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url);
          const method = (init && init.method) || (input && input.method) || 'GET';
          let headers = {};
          if (init && init.headers) { new Headers(init.headers).forEach((v, k) => headers[k] = v); }
          else if (input && input.headers) { try { input.headers.forEach((v, k) => headers[k] = v); } catch (e) {} }
          if (url && url.includes('execute-api')) note({ source: 'fetch', url, method, headers, t: Date.now() });
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
      window.__msFetchPatched = true;
    }
    if (!window.__msXhrPatched) {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSet  = XMLHttpRequest.prototype.setRequestHeader;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__url = url; this.__method = method; this.__headers = {};
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
        this.__headers = this.__headers || {}; this.__headers[k] = v;
        return origSet.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (this.__url && this.__url.includes('execute-api')) {
          note({ source: 'xhr', url: this.__url, method: this.__method, headers: this.__headers, t: Date.now() });
        }
        return origSend.apply(this, arguments);
      };
      window.__msXhrPatched = true;
    }
  }

  function captureKey(node, turn, river) { return `${node || ''}|${turn || ''}|${river || ''}`; }
  function enumerateCaptures(walk) {
    const reqs = window._capturedRequests || [];
    const wantTree = walk.tree;
    const wantFlop = walk.flop;
    const byKey = new Map();
    for (let i = reqs.length - 1; i >= 0; i--) {
      const r = reqs[i];
      if (!r || !r.url) continue;
      let u; try { u = new URL(r.url); } catch (e) { continue; }
      if (!u.pathname.endsWith('/range/url')) continue;
      if (!u.pathname.includes('/' + wantTree + '/')) continue;
      const flopParam = u.searchParams.get('flop');
      if (flopParam && flopParam !== wantFlop) continue;
      const node  = u.searchParams.get('node')  || '';
      const turn  = u.searchParams.get('turn')  || '';
      const river = u.searchParams.get('river') || '';
      const key = captureKey(node, turn, river);
      if (!byKey.has(key)) byKey.set(key, { url: r.url, headers: r.headers, node, turn, river });
    }
    return byKey;
  }

  function decodeBlobToMap(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < HEADER_SIZE) throw new Error('blob too small');
    const typeTag = dv.getUint8(0);
    const recCount = dv.getInt32(1, false);
    let cardsPer, recSize;
    if (typeTag === 10) { cardsPer = 4; recSize = 16; }
    else if (typeTag === 30) { cardsPer = 5; recSize = 17; }
    else throw new Error(`unknown type tag ${typeTag}`);
    const expected = HEADER_SIZE + recCount * recSize;
    if (dv.byteLength < expected) throw new Error('blob truncated');
    const map = new Map();
    for (let a = 0; a < recCount; a++) {
      let o = HEADER_SIZE + recSize * a;
      let key = 0;
      const cards = new Uint8Array(cardsPer);
      for (let k = 0; k < cardsPer; k++) {
        const b = dv.getUint8(o++); cards[k] = b; key = key * 64 + b;
      }
      const freq = dv.getFloat32(o, false); o += 4;
      const ev   = dv.getInt32(o, false);   o += 4;
      const wt   = dv.getFloat32(o, false); o += 4;
      map.set(key, { freq, ev, wt, cards });
    }
    return { map, cardsPer, recCount, typeTag };
  }
  function comboString(cards) {
    let s = '';
    for (let k = 0; k < cards.length; k++) {
      const b = cards[k];
      s += RANKS[b % 13] + SUITS[(b / 13) | 0];
    }
    return s;
  }

  function computePotAndCommitment(nodePath, walkNodesByKey, treeName) {
    const startingPotBb = (
      treeName.includes('_SRP') ? 6 :
      treeName.includes('_3BP') ? 14 :
      treeName.includes('_4BP') ? 36 : 1.5
    );
    if (!nodePath) return { pot_bb: startingPotBb, committed_bb: 0 };
    let pot = startingPotBb;
    const committed = { BB: 0, SB: 0 };
    let actor = 'BB';
    const segs = nodePath.split('-');
    let walkedSoFar = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === 'C' || seg === 'F') {
        if (i > 0) {
          const prev = segs[i-1];
          if (isRaiseSeg(prev) || prev === 'A') {
            const otherActor = (actor === 'BB') ? 'SB' : 'BB';
            const diff = committed[otherActor] - committed[actor];
            if (diff > 0) { committed[actor] += diff; pot += diff; }
          }
        }
      } else if (isRaiseSeg(seg)) {
        const betBb = sizingOfCode(seg) * pot;
        committed[actor] += betBb; pot += betBb;
      } else if (seg === 'A') {
        const fromKey = walkedSoFar;
        let fromNode = null;
        for (const [k, v] of walkNodesByKey) { if (v.node === fromKey) { fromNode = v; break; } }
        if (fromNode && fromNode.stack != null) {
          const betBb = fromNode.stack; committed[actor] += betBb; pot += betBb;
        } else {
          const betBb = pot; committed[actor] += betBb; pot += betBb;
        }
      }
      walkedSoFar = walkedSoFar ? `${walkedSoFar}-${seg}` : seg;
      actor = (actor === 'BB') ? 'SB' : 'BB';
    }
    return { pot_bb: pot, committed_bb: committed[actor] };
  }
  const flopClassFromFlop = (flop) =>
    (!flop || flop.length < 6) ? (flop || '') : (flop[0] + flop[2] + flop[4]);

  function isQuotaResponse(status, bodyText) {
    if (status === 429) return true;
    if (typeof bodyText === 'string' && bodyText.length < 500 &&
        /\b(exceeded|quota|rate[\s_-]?limit)\b/i.test(bodyText)) return true;
    return false;
  }
  function flagQuotaExceeded(detail) {
    if (window.__msQuotaExceeded) return;
    window.__msQuotaExceeded = {
      when: new Date().toISOString(),
      detail: detail || null,
    };
    console.warn('[hand-scraper-postflop] QUOTA EXCEEDED:', detail);
  }
  function quotaError(detail) {
    return new Error('QUOTA_EXCEEDED: ' + (detail || 'trainer returned 429 / quota error'));
  }

  function labelToTypeSize(label) {
    if (label === 'Fold')                                              return { type: 0, size: 0,   suffix: 'FOLD' };
    if (label === 'Check')                                             return { type: 1, size: 0,   suffix: 'CHECK' };
    if (label === 'Call')                                              return { type: 2, size: 0,   suffix: 'CALL' };
    if (label === 'All in' || label === 'All-in' || label === 'Allin') return { type: 7, size: 0,   suffix: 'ALLIN' };
    // v14: consult LABEL_TO_API_SUFFIX before regex fallback so `2/3 pot`
    // maps to RAISE66 (not RAISE67) — the trainer's WASM blob keys on 66.
    if (label in LABEL_TO_API_SUFFIX) {
      const suffix = LABEL_TO_API_SUFFIX[label];
      const sm = /^RAISE(\d+)$/.exec(suffix);
      if (sm) return { type: 5, size: parseInt(sm[1], 10), suffix };
    }
    if (label === 'Pot')                                               return { type: 5, size: 100, suffix: 'RAISE100' };
    const m = FRACTIONAL_LABEL_RE.exec(label);
    if (m) {
      const pct = Math.round((parseInt(m[1], 10) / parseInt(m[2], 10)) * 100);
      return { type: 5, size: pct, suffix: 'RAISE' + pct };
    }
    return null;
  }

  async function ensurePlommWorker() {
    if (window.__plommWorker && window.__plommWorker.wrap) return window.__plommWorker;
    const Comlink = await import('https://cdn.jsdelivr.net/npm/comlink@4.4.1/dist/esm/comlink.mjs');
    const workerUrl = performance.getEntriesByType('resource')
      .map(e => e.name)
      .find(n => /range-wasm\.worker[^\/]*\.js$/.test(n));
    if (!workerUrl) {
      throw new Error('range-wasm.worker URL not found in resource list — open the trainer in this tab before scraping');
    }
    const wkr = new Worker(new URL(workerUrl, location.href), { type: 'module' });
    const wrap = Comlink.wrap(wkr);
    window.__plommWorker = { wkr, wrap, Comlink, workerUrl };
    return window.__plommWorker;
  }

  async function decodePlommViaWorker(walkNode, env, capture, chipsPerBb) {
    const { wrap } = await ensurePlommWorker();
    const labelInfos = walkNode.children.map(c => ({ child: c, info: labelToTypeSize(c.label) }));
    const unknown = labelInfos.filter(x => !x.info);
    if (unknown.length) {
      throw new Error(`unsupported action labels at ${walkNode.key}: ${unknown.map(x => x.child.label).join(',')}`);
    }
    const keys       = labelInfos.map(x => x.info.suffix);
    const type_codes = labelInfos.map(x => x.info.type);
    const size_codes = labelInfos.map(x => x.info.size);
    const is_fold    = labelInfos.map(x => x.child.label === 'Fold');
    const isTurnOrRiver = !!(capture.turn || capture.river);

    const loadResult = await wrap.loadPlo({
      url: env.url,
      keys, type_codes, size_codes, is_fold,
      ev_factor: 1.0,
      is_turn_or_river: isTurnOrRiver,
      turn_invest: 0,
      is_icm: false,
    });
    try {
      const buf = loadResult.memory.buffer;
      const decoded = {};
      const cardsPer = 5;
      for (const range of loadResult.ranges) {
        const n = range.count;
        const comboKeys    = new Int32Array(buf, range.offsets.comboKey, n);
        const freqs        = new Float32Array(buf, range.offsets.freq, n);
        const evs          = new Float32Array(buf, range.offsets.ev, n);
        const comboWeights = new Float32Array(buf, range.offsets.comboWeight, n);
        const map = new Map();
        for (let i = 0; i < n; i++) {
          const cw = comboWeights[i];
          if (cw < 0.005) continue;
          const k = comboKeys[i];
          const cards = new Uint8Array(cardsPer);
          cards[0] = (k >> 24) & 0x3F;
          cards[1] = (k >> 18) & 0x3F;
          cards[2] = (k >> 12) & 0x3F;
          cards[3] = (k >>  6) & 0x3F;
          cards[4] =  k        & 0x3F;
          map.set(k, {
            freq: freqs[i],
            ev:   evs[i] * chipsPerBb,
            wt:   cw,
            cards,
          });
        }
        decoded[range.key] = { map, cardsPer, recCount: n, typeTag: 30 };
      }
      return decoded;
    } finally {
      try { await wrap.release(loadResult.sessionId); } catch (e) {}
    }
  }

  async function processNode(walkNode, capture, walk, chipsPerBb) {
    if (window.__msQuotaExceeded) throw quotaError(window.__msQuotaExceeded.detail);
    const auth = capture.headers.Authorization || capture.headers.authorization;
    if (!auth) throw new Error(`no auth for ${walkNode.key}`);
    const envResp = await fetch(capture.url, { headers: { Authorization: auth } });
    if (!envResp.ok) {
      let bodyText = '';
      try { bodyText = await envResp.text(); } catch (e) {}
      if (isQuotaResponse(envResp.status, bodyText)) {
        flagQuotaExceeded(`envelope HTTP ${envResp.status}: ${bodyText.slice(0, 120)}`);
        throw quotaError(`envelope HTTP ${envResp.status}: ${bodyText.slice(0, 120)}`);
      }
      throw new Error(`envelope HTTP ${envResp.status}: ${bodyText.slice(0, 120)}`);
    }
    let env;
    try { env = JSON.parse(await envResp.text()); }
    catch (e) {
      throw new Error(`envelope parse failed: ${e.message}`);
    }

    let decodedByApiSuffix;
    if (env.format === 'plomm') {
      decodedByApiSuffix = await decodePlommViaWorker(walkNode, env, capture, chipsPerBb);
    } else if (env.format === 'binary' || (env.urls && Array.isArray(env.urls))) {
      decodedByApiSuffix = {};
      for (const u of env.urls) {
        const blobResp = await fetch(u.url);
        if (!blobResp.ok) {
          let bodyText = '';
          try { bodyText = await blobResp.text(); } catch (e) {}
          if (isQuotaResponse(blobResp.status, bodyText)) {
            flagQuotaExceeded(`blob HTTP ${blobResp.status}: ${bodyText.slice(0, 120)}`);
            throw quotaError(`blob HTTP ${blobResp.status}: ${bodyText.slice(0, 120)}`);
          }
          throw new Error(`blob HTTP ${blobResp.status}`);
        }
        const buf = await blobResp.arrayBuffer();
        const decoded = decodeBlobToMap(buf);
        const apiSuffix = u.key.split('_').slice(-1)[0];
        decodedByApiSuffix[apiSuffix] = decoded;
      }
    } else {
      throw new Error(`unexpected envelope format "${env.format}"`);
    }

    const foldAvailable = walkNode.children.some(c => c.label === 'Fold');
    const actionOrder = [];
    for (const child of walkNode.children) {
      if (child.label === 'Fold') continue;
      const apiSuffix = apiSuffixForLabel(child.label);
      if (!apiSuffix) continue;
      const dec = decodedByApiSuffix[apiSuffix];
      if (!dec) continue;
      actionOrder.push({ label: child.label, api_suffix: apiSuffix, col: colForApiSuffix(apiSuffix), closes_street: child.closes_street, decoded: dec });
    }
    if (!actionOrder.length) throw new Error(`no action blobs at ${walkNode.key}`);
    const cardsPer = actionOrder[0].decoded.cardsPer;
    for (const a of actionOrder) if (a.decoded.cardsPer !== cardsPer) throw new Error(`cardsPer mismatch at ${walkNode.key}`);
    const orderedKeys = []; const seen = new Set(); const keyToCards = new Map();
    for (const a of actionOrder) {
      for (const [k, rec] of a.decoded.map) {
        if (!seen.has(k)) { seen.add(k); orderedKeys.push(k); keyToCards.set(k, rec.cards); }
      }
    }
    const { pot_bb: potBb, committed_bb: committedBb } =
      computePotAndCommitment(walkNode.node, walk.nodesByKeyShortcut || new Map(), walk.tree);
    const potChips = potBb * chipsPerBb;
    const foldEv = -committedBb * chipsPerBb;
    const colTokens = actionOrder.map(a => a.col);
    const header = ['Combo'];
    if (foldAvailable) header.push('Fold_Freq');
    for (const t of colTokens) header.push(`${t}_Freq`);
    header.push('Preferred_Action');
    for (const t of colTokens) header.push(`${t}_EV_chips`);
    for (const t of colTokens) header.push(`${t}_EV_PctOfPot`);
    for (const t of colTokens) header.push(`${t}_EV_DiffVsFold_PctOfPot`);
    let refIdx = colTokens.indexOf('Call');
    if (refIdx < 0) refIdx = colTokens.indexOf('Check');
    if (refIdx >= 0) {
      for (let i = 0; i < colTokens.length; i++) {
        if (i === refIdx) continue;
        const t = colTokens[i];
        if (t === 'Fold' || t === 'Call' || t === 'Check') continue;
        header.push(`${t}_EV_DiffVsCall_PctOfPot`);
      }
    }
    header.push('Weight');
    const rows = [header.join(',')];
    let totalWeightSum = 0;
    const perActionTotalWeight = {};
    if (foldAvailable) perActionTotalWeight['Fold'] = 0;
    for (const a of actionOrder) perActionTotalWeight[a.col] = 0;
    for (const key of orderedKeys) {
      const cards = keyToCards.get(key);
      const cells = [comboString(cards)];
      const recs = actionOrder.map(a => a.decoded.map.get(key));
      let canonicalWeight = null;
      for (const r of recs) if (r) { canonicalWeight = r.wt; break; }
      if (canonicalWeight == null) continue;
      const freqs = recs.map(r => r ? r.freq : 0);
      let foldFreq = 0;
      if (foldAvailable) {
        let s = 0; for (const f of freqs) s += f;
        foldFreq = Math.max(0, 1 - s);
        cells.push(foldFreq.toFixed(6));
      }
      for (const f of freqs) cells.push(f.toFixed(6));
      let bestLabel, bestFreq;
      if (foldAvailable) { bestLabel = 'Fold'; bestFreq = foldFreq; }
      else { bestLabel = actionOrder[0].label; bestFreq = freqs[0]; }
      for (let i = 0; i < actionOrder.length; i++) {
        if (freqs[i] > bestFreq) { bestFreq = freqs[i]; bestLabel = actionOrder[i].label; }
      }
      cells.push(bestLabel);
      const evs = recs.map(r => (r && r.ev !== MISSING_EV_VALUE && Number.isFinite(r.ev)) ? r.ev : null);
      for (const ev of evs) cells.push(ev == null ? '' : String(Math.round(ev)));
      for (const ev of evs) cells.push(ev == null ? '' : (ev / potChips * 100).toFixed(2));
      for (const ev of evs) cells.push(ev == null ? '' : ((ev - foldEv) / potChips * 100).toFixed(2));
      if (refIdx >= 0) {
        const refEv = evs[refIdx];
        for (let i = 0; i < actionOrder.length; i++) {
          if (i === refIdx) continue;
          const t = colTokens[i];
          if (t === 'Fold' || t === 'Call' || t === 'Check') continue;
          const ev = evs[i];
          if (ev == null || refEv == null) cells.push('');
          else cells.push(((ev - refEv) / potChips * 100).toFixed(2));
        }
      }
      cells.push(canonicalWeight.toFixed(6));
      rows.push(cells.join(','));
      totalWeightSum += canonicalWeight;
      if (foldAvailable) perActionTotalWeight['Fold'] += foldFreq * canonicalWeight;
      for (let i = 0; i < actionOrder.length; i++) {
        const r = recs[i];
        if (r) perActionTotalWeight[actionOrder[i].col] += r.freq * r.wt;
      }
    }
    const csvText = rows.join('\n') + '\n';
    const meta = {
      tree: walk.tree, flop: walk.flop, flop_class: flopClassFromFlop(walk.flop),
      street: walkNode.street,
      node: walkNode.node || '__root__',
      turn: walkNode.turn || null, river: walkNode.river || null,
      suit_map: walkNode.suitMap || null,
      capture_url_node: capture.node,
      capture_url_turn: capture.turn || null,
      capture_url_river: capture.river || null,
      active_player: walkNode.actor,
      active_player_stack_bb: walkNode.stack,
      previous_action: walkNode.prev_chosen,
      fold_available: foldAvailable,
      available_actions: walkNode.children.map(c => ({
        label: c.label, code: c.code,
        api_suffix: apiSuffixForLabel(c.label),
        column: c.label === 'Fold' ? 'Fold' : colForApiSuffix(apiSuffixForLabel(c.label)),
        node_code: (c.disabled || c.closes_street) ? null : c.code,
        terminal: !!c.closes_street || c.disabled,
        closes_street: c.closes_street, disabled: c.disabled,
      })),
      pot_bb: potBb, pot_chips: potChips, chips_per_bb: chipsPerBb,
      committed_bb_at_decision: committedBb,
      union_combo_count: orderedKeys.length,
      blob_record_counts: actionOrder.map(a => ({ col: a.col, n: a.decoded.recCount })),
      blob_total_weight_sum: totalWeightSum,
      per_action_total_weight: perActionTotalWeight,
      per_action_freq_share: Object.fromEntries(
        Object.entries(perActionTotalWeight).map(([k, v]) => [k, totalWeightSum > 0 ? v / totalWeightSum : 0])
      ),
      scrape_started_at: walk.started_at,
    };
    return { csvText, meta };
  }

  function crc32(arr) {
    let table = window.__crc32Table;
    if (!table) {
      table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
      }
      window.__crc32Table = table;
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < arr.length; i++) c = (c >>> 8) ^ table[(c ^ arr[i]) & 0xFF];
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const DEFLATE_THRESHOLD_BYTES = 1_500_000_000;
  const ZIP32_MAX = 0xFFFFFFFF;

  function resetZipCompressionState() {
    window.__msZipFallback = null;
  }

  async function deflateRaw(dataBytes) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(dataBytes);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.byteLength; }
    return out;
  }

  async function buildZip(files) {
    const enc = new TextEncoder();

    const prepped = new Array(files.length);
    let zipRaw = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const nameBytes = enc.encode(f.name);
      const dataBytes = enc.encode(f.content);
      prepped[i] = { nameBytes, dataBytes, sz: dataBytes.length, crc: crc32(dataBytes) };
      zipRaw += dataBytes.length;
    }

    let useDeflate = false;
    if (zipRaw >= DEFLATE_THRESHOLD_BYTES) {
      if (typeof CompressionStream !== 'undefined') {
        useDeflate = true;
      } else {
        window.__msZipFallback = {
          reason: 'CompressionStream API unavailable; using STORE',
          zipRaw, threshold: DEFLATE_THRESHOLD_BYTES, ts: Date.now(),
        };
      }
    }

    if (useDeflate) {
      try {
        for (const p of prepped) {
          p.compBytes = await deflateRaw(p.dataBytes);
          p.dataBytes = null;
        }
      } catch (e) {
        useDeflate = false;
        window.__msZipFallback = {
          reason: `CompressionStream threw: ${e.message}; using STORE`,
          zipRaw, threshold: DEFLATE_THRESHOLD_BYTES, ts: Date.now(),
        };
        for (let i = 0; i < files.length; i++) {
          if (!prepped[i].dataBytes) {
            prepped[i].dataBytes = enc.encode(files[i].content);
          }
          prepped[i].compBytes = null;
        }
      }
    }

    const method = useDeflate ? 8 : 0;
    const local = []; const central = [];
    let offset = 0;

    for (const p of prepped) {
      const { nameBytes, sz, crc } = p;
      const payload = useDeflate ? p.compBytes : p.dataBytes;
      const compSz = payload.length;
      if (sz > ZIP32_MAX || compSz > ZIP32_MAX || offset > ZIP32_MAX) {
        throw new Error(`zip32 size limit exceeded (file=${enc.decode(nameBytes)}, sz=${sz}, comp=${compSz}, offset=${offset}); ZIP64 not implemented`);
      }
      const lfh = new Uint8Array(30 + nameBytes.length);
      const ldv = new DataView(lfh.buffer);
      ldv.setUint32(0,  0x04034b50, true);
      ldv.setUint16(4,  20, true); ldv.setUint16(6,  0,  true);
      ldv.setUint16(8,  method, true); ldv.setUint16(10, 0,  true);
      ldv.setUint16(12, 0,  true); ldv.setUint32(14, crc, true);
      ldv.setUint32(18, compSz, true); ldv.setUint32(22, sz, true);
      ldv.setUint16(26, nameBytes.length, true); ldv.setUint16(28, 0, true);
      lfh.set(nameBytes, 30);
      local.push(lfh, payload);
      const cdh = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cdh.buffer);
      cdv.setUint32(0,  0x02014b50, true);
      cdv.setUint16(4,  20, true); cdv.setUint16(6,  20, true);
      cdv.setUint16(8,  0,  true); cdv.setUint16(10, method, true);
      cdv.setUint16(12, 0,  true); cdv.setUint16(14, 0,  true);
      cdv.setUint32(16, crc, true); cdv.setUint32(20, compSz, true);
      cdv.setUint32(24, sz, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true); cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true); cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true); cdv.setUint32(42, offset, true);
      cdh.set(nameBytes, 46);
      central.push(cdh);
      offset += lfh.length + payload.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    if (centralSize > ZIP32_MAX || centralStart > ZIP32_MAX) {
      throw new Error(`zip32 central-dir limit exceeded (centralStart=${centralStart}, centralSize=${centralSize}); ZIP64 not implemented`);
    }
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0,  0x06054b50, true);
    edv.setUint16(8,  prepped.length, true);
    edv.setUint16(10, prepped.length, true);
    edv.setUint32(12, centralSize, true);
    edv.setUint32(16, centralStart, true);
    const totalSize = offset + centralSize + 22;
    const out = new Uint8Array(totalSize);
    let pos = 0;
    for (const a of local)   { out.set(a, pos); pos += a.length; }
    for (const c of central) { out.set(c, pos); pos += c.length; }
    out.set(eocd, pos);
    out.__zipMethod = method;
    return out;
  }

  window.__msHelpers = {
    installInterceptors, enumerateCaptures, captureKey,
    decodeBlobToMap, comboString, computePotAndCommitment, processNode,
    crc32, buildZip,
    DEFLATE_THRESHOLD_BYTES,
    resetZipCompressionState,
    isQuotaResponse, flagQuotaExceeded, quotaError,
    LABEL_TO_API_SUFFIX, API_TO_COL, RANKS, SUITS, SIZING_OF_CODE,
    apiSuffixForLabel, colForApiSuffix, sizingOfCode, isRaiseSeg,
    labelToTypeSize, ensurePlommWorker, decodePlommViaWorker,
  };
  return 'multi-street helpers installed (window.__msHelpers) [v15 banner-only republish; v14 labelToTypeSize static-map fix; v13 plomm envelope support; v11 dynamic bet sizings]';
})();

/* ==================== 3) ORCHESTRATOR (tier 1 + 2/3) ==================== */
/* scrape_multistreet.js - flop+turn tree scraper for the PLO Master Mind
 * postflop trainer. Walks (flop -> every canonical turn under every flop
 * terminal), captures /range/url envelopes, decodes binary/plomm blobs,
 * and emits ONE flop zip plus one turn-chunk zip per N turn cards walked
 * (default N=5).
 *
 * Requires window.__W (walker) and window.__msHelpers to be installed first.
 *
 * POST-v18 CHANGES — checkpoint hygiene bug fixes (2026-05-20)
 *   - FLOP EMIT ORDER: __msEmitResumeFile('after_flop_zip') now fires AFTER
 *     saveCheckpoint(), matching the turn-chunk path. Previously the inverted
 *     order let stale window.__msCheckpoint / localStorage state from a prior
 *     run leak into the new run's first resume.json (mismatched flop names
 *     between the freshly-emitted zip and the resume.json checkpoint).
 *   - FRESH-LAUNCH STATE CLEAR: every non-resume invocation now clears
 *     window.__msCheckpoint, localStorage __msCheckpoint_v15,
 *     window.__msCachedFlopTerminals, and window.__msAllResumeFiles at
 *     startup. Resume invocations (cfg.skip_flop_walk === true) preserve
 *     prior state because that IS the work being resumed.
 *
 * v17 CHANGES — genuine flop-walk skip + auto resume.json + byte-threshold + bug fix
 *   - cfg.skip_flop_walk + cfg.cached_flop_terminals: bypass the flop DFS on
 *     resume. The resume.json file (auto-emitted alongside every zip) carries
 *     the terminal structure forward across tabs/chats.
 *   - cfg.emit_resume_file (default true): trigger a JSON download alongside
 *     every zip, containing a full v1 capsule + cached_flop_terminals.
 *   - cfg.chunk_max_raw_bytes (default Infinity): OR trigger alongside
 *     turn_cards_per_chunk. Whichever fires first emits the chunk.
 *   - BUG FIX: completedTerminals only populated when the cell loop exits
 *     naturally (no more cells). Abort/quota/safety-overflow/turn_card_limit
 *     no longer mark interrupted terminals as fully done.
 *
 * v15 CHANGES — pacing + chunking + pause/checkpoint
 *   - The walker now sleeps a random 3-5 seconds at the START of every
 *     node visit (see multi_street_walker.js v15 notes). Configurable via
 *     `cfg.node_wait_min_ms` / `cfg.node_wait_max_ms` (defaults 3000 / 5000;
 *     set both to 0 to disable).
 *   - Turn-chunk emit trigger changed from a 1.5 GB raw-bytes threshold to
 *     a turn-card-count threshold. Default: a chunk zip is emitted as soon
 *     as N=5 turn cards have been walked + scraped into the chunk buffer.
 *     Configurable via `cfg.turn_cards_per_chunk` (default 5).
 *   - After EVERY emitted zip (flop OR turn chunk) the orchestrator:
 *       (a) records a checkpoint into window.__msCheckpoint AND into
 *           localStorage under key '__msCheckpoint_v15'.
 *       (b) sets window.__msPaused = true and awaits until something
 *           clears it. The user calls window.__msContinue() to resume.
 *     The checkpoint is sufficient information for a fresh-tab post-reload
 *     resume (see __buildPostReloadResumeCfg) AND, while the tab is alive,
 *     the orchestrator simply waits and continues in-place — no state
 *     reconstruction needed.
 *     Disable the auto-pause with `cfg.auto_continue: true` (the checkpoint
 *     is still saved either way).
 *
 * v10 (kept): post-reload resume support — skip_flop_zip,
 *   chunk_index_start_per_terminal.
 *
 * v7 (kept): zero-walk circuit breaker, strict click-failure handling,
 *   pickCardCommit DOM-settle wait.
 *
 * v6 (kept): fused walk-and-scrape per flop terminal; cross-terminal
 *   alias/dim cache; defensive no-sim popup dismissal; suitMap hard reset.
 *
 * v5 (kept): cheap modal reopen between turn cards.
 *
 * NEVER reload the page during a run - reload wipes interceptors, walker state,
 * capture buffer, and all in-memory zips. The run is unrecoverable in-tab;
 * use __buildPostReloadResumeCfg to start fresh from the saved checkpoint.
 */
(function installMSOrchestrator() {
  if (typeof window.__W === 'undefined') throw new Error('walker missing - install multi_street_walker.js first');
  if (typeof window.__msHelpers === 'undefined') throw new Error('helpers missing - install scrape_helpers.js first');
  const W = window.__W;
  const H = window.__msHelpers;
  const sleep = W.sleep;

  // -------------------------------------------------------------------------
  // v15: global pause / continue / checkpoint helpers
  // -------------------------------------------------------------------------
  // The orchestrator awaits __msPaused becoming falsy after every zip emit.
  // Users continue with __msContinue(), inspect with __msShowProgress(),
  // and (rarely) abort with __msAbort().

  const CHECKPOINT_KEY = '__msCheckpoint_v15';

  function saveCheckpoint(snapshot) {
    const ckpt = Object.assign({
      version: 'v15',
      timestamp: new Date().toISOString(),
    }, snapshot || {});
    window.__msCheckpoint = ckpt;
    try {
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(ckpt));
    } catch (e) {
      // localStorage may be unavailable (private mode, quota) — checkpoint
      // still lives on window.__msCheckpoint while the tab is alive.
      console.warn('[hand-scraper] localStorage save failed:', e && e.message);
    }
    return ckpt;
  }

  if (typeof window.__msContinue !== 'function') {
    window.__msContinue = function() {
      window.__msPaused = false;
      console.log('[hand-scraper] resume signal sent (window.__msContinue)');
    };
  }
  if (typeof window.__msAbort !== 'function') {
    window.__msAbort = function() {
      window.__msAborted = true;
      window.__msPaused = false;
      console.log('[hand-scraper] abort signal sent (window.__msAbort)');
    };
  }
  if (typeof window.__msShowProgress !== 'function') {
    window.__msShowProgress = function() {
      const c = window.__msCheckpoint || (function() {
        try { return JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || 'null'); }
        catch (e) { return null; }
      })();
      console.log('[hand-scraper] progress:', c);
      console.log('[hand-scraper] paused?', !!window.__msPaused, 'aborted?', !!window.__msAborted);
      return c;
    };
  }

  async function pauseUntilContinue(reason) {
    if (window.__msAborted) return;
    window.__msPaused = true;
    window.__msPausedReason = reason;
    window.__msPausedAt = new Date().toISOString();
    console.log(`[hand-scraper] PAUSED after ${reason}.`);
    console.log('[hand-scraper] Resume: window.__msContinue()  |  Progress: window.__msShowProgress()  |  Abort: window.__msAbort()');
    while (window.__msPaused === true && !window.__msAborted) {
      await sleep(500);
    }
    window.__msPausedReason = null;
    window.__msPausedAt = null;
    if (!window.__msAborted) console.log('[hand-scraper] Resumed.');
  }

  async function ensureFlopRoot() {
    let safety = 0;
    while (safety++ < 30) {
      if (W.urlNode() === '' && !W.urlTurn() && !W.urlRiver()) return true;
      if (W.modalKind()) await W.closeModalX();
      const blocks = W.readBlocks();
      let target = null;
      for (const b of blocks) { if (b.actions.some(a => a.chosen)) target = b; }
      if (!target) break;
      const before = `${W.urlNode()}|${W.urlTurn()}|${W.urlRiver()}`;
      target.headerEl.click();
      await sleep(700);
      if (`${W.urlNode()}|${W.urlTurn()}|${W.urlRiver()}` === before) break;
    }
    if (W.modalKind()) await W.closeModalX();
    return W.urlNode() === '' && !W.urlTurn() && !W.urlRiver();
  }
  async function replayFromFlopRoot(targetNode, walkResult) {
    if (!await ensureFlopRoot()) return false;
    if (!targetNode) return true;
    const segs = targetNode.split('-');
    try { await W.replaySegments(segs, walkResult); }
    catch (e) { walkResult.warnings.push(`replay to ${targetNode}: ${e.message}`); return false; }
    return W.urlNode() === targetNode;
  }
  async function openModalByCloser(closerLabel) {
    const ab = W.activeBlock();
    if (!ab) return false;
    const ce = ab.actions.find(a => a.label === closerLabel && !a.disabled)?.el;
    if (!ce) return false;
    const before = W.urlNode();
    ce.click();
    let t0 = Date.now();
    while (Date.now() - t0 < 4000 && W.urlNode() === before) await sleep(100);
    while (Date.now() - t0 < 6000 && !W.modalKind()) await sleep(100);
    return !!W.modalKind();
  }

  async function stabilizeBackToTerminal(ftTerminalNode) {
    if (W.modalKind()) await W.closeModalX();
    if (W.urlNode() === ftTerminalNode) return true;
    let safety = 0;
    while (safety++ < 30) {
      const blocks = W.readBlocks();
      let target = null;
      for (const b of blocks) { if (b.actions.some(a => a.chosen)) target = b; }
      if (!target) return false;
      const before = W.urlNode();
      target.headerEl.click();
      await sleep(700);
      if (W.urlNode() === before) return false;
      if (W.urlNode() === ftTerminalNode) {
        if (W.modalKind()) await W.closeModalX();
        return true;
      }
    }
    return false;
  }

  async function reopenTurnModalCheapOrFull(ft, walkResult) {
    if (await stabilizeBackToTerminal(ft.terminal_node)) {
      try {
        await W.reopenChipModal('turn');
        if (W.modalKind() === 'turn') return { ok: true, path: 'cheap' };
      } catch (e) { /* fall through */ }
    }
    if (!await replayFromFlopRoot(ft.parent, walkResult)) return { ok: false, path: 'replay-failed' };
    if (!await openModalByCloser(ft.via)) return { ok: false, path: 'closer-failed' };
    return { ok: true, path: 'replay' };
  }

  function identifyTerminals(walkedNodes, street) {
    return walkedNodes
      .filter(n => n.street === street)
      .map(n => {
        const closer = n.children.find(c => c.closes_street && !c.disabled);
        if (!closer) return null;
        const terminalNode = n.node ? `${n.node}-${closer.code}` : closer.code;
        return { parent: n.node, terminal_node: terminalNode, via: closer.label, code: closer.code };
      })
      .filter(x => x);
  }

  async function processSegment(segmentKind, nodeSubset, captures, walk, chipsPerBb, layoutCtx) {
    const flop = walk.flop;
    const filesToZip = [];
    const perNodeStats = [];
    const matchErrors = [];
    let aborted = false;
    for (const node of nodeSubset) {
      if (window.__msQuotaExceeded) { aborted = true; break; }
      const key = H.captureKey(node.node, node.turn, node.river);
      const capture = captures.get(key);
      if (!capture) { matchErrors.push(`no capture for ${key}`); continue; }
      try {
        const t0 = performance.now();
        const { csvText, meta } = await H.processNode(node, capture, walk, chipsPerBb);
        const dt = (performance.now() - t0) / 1000;
        perNodeStats.push({
          street: node.street, node: node.node || '(root)',
          turn: node.turn, river: node.river,
          union: meta.union_combo_count, csv_kb: (csvText.length / 1024) | 0, sec: dt.toFixed(1),
        });
        const nodeFs = node.node ? node.node.replace(/-/g, '_') : '(root)';
        let folderPath;
        if (segmentKind === 'flop') {
          folderPath = `${flop}/${nodeFs}`;
        } else if (segmentKind === 'turn_node') {
          folderPath = layoutCtx.dropFlopTerminalWrapper
            ? `${layoutCtx.turn_card}/${nodeFs}`
            : `${layoutCtx.flop_terminal}/${layoutCtx.turn_card}/${nodeFs}`;
        } else {
          throw new Error(`unknown segmentKind ${segmentKind}`);
        }
        filesToZip.push({ name: `${folderPath}_combos.csv`, content: csvText });
        filesToZip.push({ name: `${folderPath}_meta.json`,  content: JSON.stringify(meta, null, 2) });
      } catch (e) {
        matchErrors.push(`process ${key}: ${e.message}`);
        if (/^QUOTA_EXCEEDED/.test(e.message) || window.__msQuotaExceeded) { aborted = true; break; }
      }
    }
    return { filesToZip, perNodeStats, matchErrors, aborted };
  }

  async function emitZip(zipName, filesToZip, allZipsRegistry, downloadDelayMs = 500) {
    if (!filesToZip.length) return null;
    const zipBytes = await H.buildZip(filesToZip);
    const entry = {
      name: zipName, bytes: zipBytes, size: zipBytes.byteLength,
      files: filesToZip.length, t: Date.now(),
      method: zipBytes.__zipMethod === 8 ? 'DEFLATE' : 'STORE',
    };
    allZipsRegistry.push(entry);
    window.__lastZipBytes = zipBytes;
    window.__lastZipName  = zipName;
    try {
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl; a.download = zipName;
      document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(dlUrl); }, 1000);
      entry.download_triggered = true;
    } catch (e) {
      entry.download_triggered = false; entry.download_error = e.message;
    }
    await sleep(downloadDelayMs);
    return entry;
  }

  window.__scrapeMultiStreet = async function(cfg) {
    cfg = cfg || {};
    const scope = cfg.scope || 'flop+turn';
    const chipsPerBb = cfg.chipsPerBb || 2000;
    const dryRun = cfg.dryRun === true;
    const downloadDelayMs = cfg.download_delay_ms || 500;
    // v15: configurable inter-node wait — orchestrator forwards into walker globals.
    if (typeof cfg.node_wait_min_ms === 'number') window.__msNodeWaitMin = cfg.node_wait_min_ms;
    if (typeof cfg.node_wait_max_ms === 'number') window.__msNodeWaitMax = cfg.node_wait_max_ms;
    // v15: turn-cards-per-chunk threshold (default 5).
    let   turnCardsPerChunk = (typeof cfg.turn_cards_per_chunk === 'number' && cfg.turn_cards_per_chunk > 0) ? cfg.turn_cards_per_chunk : 5;
    // PHASE 1 (session mode): per-card zip + resume.json naming.
    //   zip_per_card  forces turnCardsPerChunk = 1 so every chunk-emit is
    //                 exactly one card (atomic per-card output).
    //   device_name   string identifying the device (lives only inside the
    //                 resume.json filename + payload, NOT in the zip name --
    //                 zip names stay clean: <tree>_<flop>_<terminal>_<card>.zip).
    //   session_id    string tagging this run; appears inside the resume.json
    //                 payload + run log entries.
    const zipPerCard = cfg.zip_per_card === true;
    const deviceName = (typeof cfg.device_name === 'string' && cfg.device_name.length > 0) ? cfg.device_name : null;
    const sessionId  = (typeof cfg.session_id  === 'string' && cfg.session_id.length  > 0) ? cfg.session_id  : null;
    if (zipPerCard) { turnCardsPerChunk = 1; }
    // PHASE 2: optional explicit card targets per terminal. When provided
    //   for a terminal, the walker visits ONLY those cards, in the order
    //   given. Caller (planner) typically pre-shuffles. When absent for
    //   a terminal, the existing top-to-bottom DOM order is used.
    //   Shape: { 'C-R50-C': ['Qs','9s','Td'], 'R66-C': ['As'], ... }
    const targetCardsPerTerminal = (cfg.target_cards_per_terminal && typeof cfg.target_cards_per_terminal === 'object')
      ? cfg.target_cards_per_terminal
      : null;
    // PHASE 4: human-like noise cfg. Default null -> all off. When provided,
    //   gets exported to window.__msHumanCfg for the walker to read.
    if (cfg.human_like && typeof cfg.human_like === 'object') {
      window.__msHumanCfg = Object.assign({}, cfg.human_like);
    } else {
      window.__msHumanCfg = window.__msHumanCfg || {};
    }
    const humanCfg = window.__msHumanCfg;
    // v15: auto-continue defaults to false → orchestrator pauses after each zip.
    const autoContinue = cfg.auto_continue === true;
    // v17: byte-size OR trigger — flush chunk when raw bytes >= this many,
    //      OR when card count hits turnCardsPerChunk (whichever fires first).
    //      Default Infinity (only card count controls; legacy v15 behavior).
    const chunkMaxRawBytes = (typeof cfg.chunk_max_raw_bytes === 'number' && cfg.chunk_max_raw_bytes > 0) ? cfg.chunk_max_raw_bytes : Infinity;
    // v17: skip the flop tree walk entirely on resume. Requires
    //      cfg.cached_flop_terminals to be non-empty (the resume capsule provides
    //      this). When set, the orchestrator goes directly to the per-terminal
    //      turn loop without re-walking the flop DFS or re-emitting the flop zip.
    const skipFlopWalk = cfg.skip_flop_walk === true &&
      Array.isArray(cfg.cached_flop_terminals) && cfg.cached_flop_terminals.length > 0;
    // v17: emit a resume.json file alongside every zip download by default.
    //      Set cfg.emit_resume_file: false to disable. The file is a full v1
    //      capsule with cached_flop_terminals baked in, so a future resume can
    //      genuinely skip the flop walk.
    const emitResumeFile = cfg.emit_resume_file !== false;

    window.__msProgress = {
      phase: 'starting', t_start: Date.now(),
      nodes_walked: 0, zips_emitted: 0,
      last_zip: null, last_node: null,
      reopen_stats: { cheap: 0, replay: 0, failed: 0 },
      auto_continue: autoContinue,
      turn_cards_per_chunk: turnCardsPerChunk,
      node_wait_ms_range: [
        (typeof window.__msNodeWaitMin === 'number') ? window.__msNodeWaitMin : 3000,
        (typeof window.__msNodeWaitMax === 'number') ? window.__msNodeWaitMax : 5000,
      ],
    };
    window.__msResult = null;
    window.__msError = null;
    window.__msAllZips = [];
    window.__msQuotaExceeded = null;
    window.__msPaused = false;
    window.__msAborted = false;
    // POST-v18 BUG FIX (checkpoint hygiene): clear stale checkpoint state at
    //   the start of every fresh (non-resume) launch. Without this, a prior
    //   run's checkpoint (still on window.__msCheckpoint and/or in
    //   localStorage under '__msCheckpoint_v15') leaks into the first
    //   resume.json emitted on the new run -- observable as a flop mismatch
    //   between the URL / flop_zip filename (new run) and the
    //   checkpoint.flop / zips_emitted inside the resume.json (old run).
    //   A resume invocation supplies cfg.skip_flop_walk + cfg.cached_flop_terminals;
    //   in that case we keep the existing checkpoint because it IS this run's
    //   prior state being carried forward.
    if (cfg.skip_flop_walk !== true) {
      window.__msCheckpoint = null;
      try { localStorage.removeItem(CHECKPOINT_KEY); } catch (_) {}
      window.__msCachedFlopTerminals = null;
      window.__msAllResumeFiles = [];
    }
    if (typeof H.resetZipCompressionState === 'function') {
      H.resetZipCompressionState();
    }
    if (!window.__msCanonCache) window.__msCanonCache = { turn: new Map(), river: new Map() };

    const result = {
      scope, dryRun, chipsPerBb,
      tree: W.urlTree(), flop: W.urlFlop(),
      started_at: new Date().toISOString(),
      nodes: [], warnings: [], events: [], aliases: [],
      summary: {}, zips: [],
      // PHASE 2: card map captured at first turn-modal open per terminal.
      //   Shape: { [terminal]: {recorded_at, recorded_by_device, total_cells,
      //                         available: [...], used: [...], dim_dom: [...]} }
      terminal_card_maps: {},
    };
    const log = (kind, data) => result.events.push({ ts: Date.now(), kind, ...(data || {}) });
    const flop = result.flop;

    // v15 checkpoint: completed terminal list + per-terminal "next chunk index"
    // are tracked across the run so the checkpoint always reflects what's safe
    // to skip if the user reloads the tab.
    const completedTerminals = [];                  // terminals whose work is fully on disk
    const nextChunkIndexPerTerminal = {};           // term -> next chunk index for resume
    const completedCardsPerTerminal = {};           // term -> [canonical cards already in emitted zips]

    function buildCheckpoint(extra) {
      return {
        scope, chipsPerBb, turn_cards_per_chunk: turnCardsPerChunk,
        chunk_max_raw_bytes: (chunkMaxRawBytes === Infinity ? null : chunkMaxRawBytes),
        tree: result.tree, flop: result.flop,
        started_at: result.started_at,
        flop_emitted: !!result.flop_zip_emitted_at,
        // v17: cache the flop terminal structure so a fresh-tab resume can
        //      pass cfg.skip_flop_walk=true and bypass the flop DFS entirely.
        cached_flop_terminals: window.__msCachedFlopTerminals
          ? window.__msCachedFlopTerminals.slice()
          : null,
        flop_walk_skipped_on_this_run: !!result.flop_walk_skipped,
        completed_terminals: completedTerminals.slice(),
        next_chunk_index_per_terminal: Object.assign({}, nextChunkIndexPerTerminal),
        completed_cards_per_terminal: Object.fromEntries(
          Object.entries(completedCardsPerTerminal).map(([k, v]) => [k, v.slice()])
        ),
        // PHASE 2: card map snapshots collected at first per-terminal open.
        terminal_card_maps: Object.assign({}, result.terminal_card_maps || {}),
        aliases: result.aliases.slice(),
        zips_emitted: result.zips.map(z => ({
          kind: z.kind, name: z.name,
          flop_terminal: z.flop_terminal || null,
          chunk_index: z.chunk_index || null,
          turn_cards: z.turn_cards || null,
        })),
        progress: window.__msProgress,
        extra: extra || null,
      };
    }

    try {
      window._capturedRequests = [];
      H.installInterceptors();
      // TIER 1 FIX (#7): defensive modal close at run start. If a previous
      //   session ended with the turn modal open (or the user manually opened
      //   one), the walker can fail to identify blocks correctly. Always
      //   start from a clean DOM.
      try {
        if (W.modalKind && W.modalKind()) {
          await W.closeModalX();
          await sleep(300);
        }
      } catch (_) {}
      // TIER 2 FIX #4: activate Categories tab so humanCategoryExploration
      //   can find the panel. No-op if already active. Safe -- only clicks
      //   a tab, no quota impact.
      try {
        if (typeof W.activateCategoriesTab === 'function') {
          await W.activateCategoriesTab();
        }
      } catch (_) {}
      window.__msProgress.phase = 'walking';

      // v17: skip the flop walk entirely if the caller provided cached terminals.
      //      Used by the resume-capsule apply path so a fresh tab doesn't re-walk
      //      the flop DFS (~10-30s and ~8 quota calls on a typical board).
      let flopNodes;
      let captures;
      if (skipFlopWalk) {
        log('flop_walk_skipped', {
          reason: 'cfg.skip_flop_walk=true + cached_flop_terminals provided',
          n_cached_terminals: cfg.cached_flop_terminals.length,
        });
        window.__msProgress.phase = 'flop_walk_skipped';
        result.flop_walk_skipped = true;
        flopNodes = []; // empty — no flop scrape work on this run
        captures = new Map();
        result.summary.flop_nodes = 0;
        // Cache the provided terminals on window so buildCheckpoint picks them up.
        window.__msCachedFlopTerminals = cfg.cached_flop_terminals.slice();
        result.nodesByKeyShortcut = new Map();
      } else {
        log('phase', { name: 'walk_flop' });
        await ensureFlopRoot();
        const flopNodeStartIdx = result.nodes.length;
        await W.dfsStreet({ node: '', turn: null, river: null, street: 'flop' }, result, {
          onNodeRecorded: async (state, node) => { node._segment = { kind: 'flop' }; },
        });
        await ensureFlopRoot();
        flopNodes = result.nodes.slice(flopNodeStartIdx);
        result.summary.flop_nodes = flopNodes.length;
        window.__msProgress.nodes_walked = result.nodes.length;
        log('walk_flop_done', { n: flopNodes.length });

        await sleep(500);
        captures = H.enumerateCaptures(result);
        log('captures_enumerated', { phase: 'flop', n_captures: captures.size });

        result.nodesByKeyShortcut = new Map();
        for (const n of result.nodes) result.nodesByKeyShortcut.set(n.key, n);
      }

      // POST-TIER-1 HOTFIX (2026-05-22): set window.__msCachedFlopTerminals
      //   BEFORE the flop zip is emitted + saveCheckpoint runs. Previously
      //   this assignment lived after the zip emit path, which meant the
      //   auto-emitted resume.json on `after_flop_zip` always had
      //   cached_flop_terminals: [] on a fresh run.
      if (!skipFlopWalk && flopNodes && flopNodes.length) {
        try {
          const _earlyTerminals = identifyTerminals(flopNodes, 'flop');
          window.__msCachedFlopTerminals = _earlyTerminals.map(t => ({
            parent: t.parent, terminal_node: t.terminal_node, via: t.via, code: t.code,
          }));
        } catch (_) { /* defensive */ }
      }

      if (!dryRun && !skipFlopWalk) {
        window.__msProgress.phase = 'scraping_flop';
        const flopZipName = `${result.tree}_${result.flop}_flop.zip`;
        const flopSeg = await processSegment('flop', flopNodes, captures, result, chipsPerBb, {});
        const flopManifest = {
          tree: result.tree, flop: result.flop, scope, chipsPerBb,
          segment_kind: 'flop',
          n_flop_nodes: flopNodes.length,
          n_scraped: flopSeg.perNodeStats.length,
          n_match_errors: flopSeg.matchErrors.length,
          match_errors: flopSeg.matchErrors,
          per_node_stats: flopSeg.perNodeStats,
          started_at: result.started_at,
          finished_at: new Date().toISOString(),
        };
        flopSeg.filesToZip.push({ name: `${flop}/flop_manifest.json`, content: JSON.stringify(flopManifest, null, 2) });

        if (scope === 'flop+turn') {
          // TIER 1 FIX: pre-create folders for ALL terminals in the flop zip,
          //   ignoring cfg.flop_terminal_filter. The filter controls what gets
          //   WALKED on this run, but the on-disk per-flop tree should always
          //   contain every terminal directory so downstream tooling sees the
          //   full structure.
          const allTerminals = identifyTerminals(flopNodes, 'flop');
          flopManifest.pre_created_terminal_folders = allTerminals.map(t => t.terminal_node);
          flopSeg.filesToZip[flopSeg.filesToZip.length - 1].content = JSON.stringify(flopManifest, null, 2);
          for (const t of allTerminals) {
            flopSeg.filesToZip.push({ name: `${flop}/${t.terminal_node}/.keep`, content: '' });
          }
          log('pre_created_terminal_folders', { n: allTerminals.length, list: allTerminals.map(t => t.terminal_node) });
        }

        if (cfg.skip_flop_zip === true) {
          log('flop_zip_skipped', { reason: 'cfg.skip_flop_zip=true', name: flopZipName, n_files: flopSeg.filesToZip.length });
          result.flop_zip_skipped = true;
        } else {
          const zipEntry = await emitZip(flopZipName, flopSeg.filesToZip, window.__msAllZips, downloadDelayMs);
          if (zipEntry) {
            result.zips.push({ kind: 'flop', name: flopZipName, files: zipEntry.files, size: zipEntry.size });
            window.__msProgress.zips_emitted++;
            window.__msProgress.last_zip = flopZipName;
            result.flop_zip_emitted_at = new Date().toISOString();
          }
          log('flop_zip_emitted', { name: flopZipName, files: zipEntry?.files });
          // POST-v18 BUG FIX (flop emit order): checkpoint MUST be saved BEFORE
          //   __msEmitResumeFile so the resume.json captures this-run state, not
          //   leftover state from a prior run. The turn-chunk path below was
          //   already in the correct order; only the flop path was inverted.
          saveCheckpoint(buildCheckpoint({ last_event: 'flop_zip_emitted', last_zip: flopZipName }));
          // v17: emit resume.json alongside the flop zip (now reads the
          //   just-saved checkpoint).
          if (emitResumeFile && typeof window.__msEmitResumeFile === 'function') {
            try {
              await window.__msEmitResumeFile('after_flop_zip', downloadDelayMs);
            } catch (e) {
              result.warnings.push(`emit_resume_file (after_flop_zip) failed: ${e.message}`);
            }
          }
          if (!autoContinue) await pauseUntilContinue(`flop zip emitted (${flopZipName})`);
        }
      }
      if (skipFlopWalk) {
        // No flop zip emitted this run; still save a checkpoint snapshot so the
        // resume.json reflects "we resumed and skipped the flop walk".
        saveCheckpoint(buildCheckpoint({ last_event: 'flop_walk_skipped_on_resume' }));
        if (emitResumeFile && typeof window.__msEmitResumeFile === 'function') {
          try {
            await window.__msEmitResumeFile('after_flop_walk_skipped', downloadDelayMs);
          } catch (e) {
            result.warnings.push(`emit_resume_file (after_flop_walk_skipped) failed: ${e.message}`);
          }
        }
      }

      if (scope === 'flop') {
        delete result.nodesByKeyShortcut;
        try { if (W.modalKind && W.modalKind()) { await W.closeModalX(); } } catch (_) {}
      result.finished_at = new Date().toISOString();
        result.elapsed_s = Math.round((Date.now() - window.__msProgress.t_start) / 1000);
        window.__msProgress.phase = 'done';
        window.__msResult = result;
        return result;
      }

      if (window.__msQuotaExceeded || window.__msAborted) {
        result.aborted_due_to_quota = !!window.__msQuotaExceeded;
        result.aborted_by_user = !!window.__msAborted;
        if (window.__msQuotaExceeded) {
          result.quota_detail = window.__msQuotaExceeded;
          result.warnings.push(`ABORT: quota exceeded during flop scrape -- ${window.__msQuotaExceeded.detail}`);
          log('quota_abort', { phase: 'after_flop', detail: window.__msQuotaExceeded });
        } else {
          result.warnings.push('ABORT: user-initiated abort');
          log('user_abort', { phase: 'after_flop' });
        }
        delete result.nodesByKeyShortcut;
        try { if (W.modalKind && W.modalKind()) { await W.closeModalX(); } } catch (_) {}
      result.finished_at = new Date().toISOString();
        result.elapsed_s = Math.round((Date.now() - window.__msProgress.t_start) / 1000);
        window.__msProgress.phase = window.__msQuotaExceeded ? 'aborted_quota' : 'aborted_user';
        window.__msResult = result;
        return result;
      }

      let flopTerminals;
      if (skipFlopWalk) {
        // v17: use the cached terminals provided in cfg (from the resume capsule).
        flopTerminals = cfg.cached_flop_terminals.slice();
        log('flop_terminals_from_cache', { n: flopTerminals.length, list: flopTerminals.map(t => t.terminal_node) });
      } else {
        flopTerminals = identifyTerminals(flopNodes, 'flop');
      }
      // TIER 1 FIX: cache the FULL terminal list (unfiltered) so the ledger has
      //   the complete structural picture even when the run filters to a subset.
      //   Only the walk loop below sees the filtered list.
      window.__msCachedFlopTerminals = flopTerminals.map(t => ({
        parent: t.parent, terminal_node: t.terminal_node, via: t.via, code: t.code,
      }));
      const allTerminalsForLedger = flopTerminals.slice();
      if (cfg.flop_terminal_filter) flopTerminals = flopTerminals.filter(t => cfg.flop_terminal_filter(t.terminal_node));
      result.summary.flop_terminals = flopTerminals.length;
      result.summary.flop_terminals_all = allTerminalsForLedger.length;
      log('flop_terminals_identified', {
        n_walked: flopTerminals.length, n_all: allTerminalsForLedger.length,
        list: flopTerminals.map(t => t.terminal_node),
        all_list: allTerminalsForLedger.map(t => t.terminal_node),
        from_cache: !!skipFlopWalk,
      });

      for (const ft of flopTerminals) {
        if (window.__msQuotaExceeded || window.__msAborted) {
          log('quota_or_user_abort', { phase: 'flop_terminal_loop', terminal: ft.terminal_node });
          break;
        }
        log('flop_terminal_start', { terminal: ft.terminal_node });

        const fullReopen = async () => {
          if (!await replayFromFlopRoot(ft.parent, result)) return false;
          return openModalByCloser(ft.via);
        };
        if (!await fullReopen()) {
          result.warnings.push(`open turn modal at ${ft.terminal_node}`);
          continue;
        }

        if (!window.__msCanonCache.turnAliasMap) {
          window.__msCanonCache.turnAliasMap = new Map();
        }
        if (!window.__msCanonCache.turnAliasMap.has(result.flop)) {
          window.__msCanonCache.turnAliasMap.set(result.flop, new Map());
        }
        if (!window.__msCanonCache.turnDimSet) {
          window.__msCanonCache.turnDimSet = new Map();
        }
        if (!window.__msCanonCache.turnDimSet.has(result.flop)) {
          window.__msCanonCache.turnDimSet.set(result.flop, new Set());
        }
        const knownAliases = window.__msCanonCache.turnAliasMap.get(result.flop);
        const knownDim = window.__msCanonCache.turnDimSet.get(result.flop);
        const turnCardAliases = [];

        await W.dismissNoSimPopupIfAny();

        const explicitCards = (cfg.turn_cards_per_terminal && cfg.turn_cards_per_terminal[ft.terminal_node]) || null;
        const turnCardLimit = cfg.turn_card_limit || 999;

        const chunkIndexStart = (cfg.chunk_index_start_per_terminal && cfg.chunk_index_start_per_terminal[ft.terminal_node]) || 1;
        const chunkState = {
          files: [],
          rawBytes: 0,
          chunkIndex: chunkIndexStart,
          contents: [],
          n_emitted: 0,
        };
        completedCardsPerTerminal[ft.terminal_node] = completedCardsPerTerminal[ft.terminal_node] || [];
        nextChunkIndexPerTerminal[ft.terminal_node] = chunkIndexStart;

        async function flushChunk(reason) {
          if (chunkState.files.length === 0) return null;
          const idxStr = String(chunkState.chunkIndex).padStart(3, '0');
          // PHASE 1: zip name pattern depends on zipPerCard mode.
          //   Off (legacy): <tree>_<flop>_<terminal>_turn_chunk<NNN>.zip
          //   On  (per-card): <tree>_<flop>_<terminal>_<turn_card>.zip
          // Capture card name BEFORE the chunk reset later in this function.
          const cardForName = (zipPerCard && chunkState.contents[0] && chunkState.contents[0].turn_card)
            ? chunkState.contents[0].turn_card
            : null;
          const chunkZipName = (zipPerCard && cardForName)
            ? `${result.tree}_${result.flop}_${ft.terminal_node}_${cardForName}.zip`
            : `${result.tree}_${result.flop}_${ft.terminal_node}_turn_chunk${idxStr}.zip`;
          const chunkManifest = {
            tree: result.tree, flop: result.flop, scope, chipsPerBb,
            segment_kind: 'turn_card_chunk',
            flop_terminal: ft.terminal_node,
            chunk_index: chunkState.chunkIndex,
            flush_reason: reason,
            turn_cards: chunkState.contents.map(c => c.turn_card),
            n_turn_cards: chunkState.contents.length,
            n_files: chunkState.files.length,
            chunk_raw_bytes: chunkState.rawBytes,
            turn_cards_per_chunk_cfg: turnCardsPerChunk,
            per_card: chunkState.contents,
            started_at: result.started_at,
            finished_at: new Date().toISOString(),
          };
          // TIER 1 FIX: per-card manifest name in zip_per_card mode.
          //   Legacy chunk mode keeps _chunk<NNN>_manifest.json so old zips
          //   on disk stay extractable.
          const manifestName = (zipPerCard && cardForName)
            ? `_${cardForName}_manifest.json`
            : `_chunk${idxStr}_manifest.json`;
          const filesWithManifest = chunkState.files.concat([{
            name: manifestName,
            content: JSON.stringify(chunkManifest, null, 2),
          }]);
          log('chunk_flush_start', {
            name: chunkZipName, reason, raw_bytes: chunkState.rawBytes,
            n_turn_cards: chunkState.contents.length, n_files: chunkState.files.length,
          });
          const zipEntry = await emitZip(chunkZipName, filesWithManifest, window.__msAllZips, downloadDelayMs);
          if (zipEntry) {
            result.zips.push({
              kind: 'turn_card_chunk', name: chunkZipName,
              flop_terminal: ft.terminal_node,
              chunk_index: chunkState.chunkIndex,
              turn_cards: chunkState.contents.map(c => c.turn_card),
              raw_bytes: chunkState.rawBytes,
              files: zipEntry.files, size: zipEntry.size,
              method: zipEntry.method,
              flush_reason: reason,
            });
            window.__msProgress.zips_emitted++;
            window.__msProgress.last_zip = chunkZipName;
          }
          log('chunk_flush_done', { name: chunkZipName, files: zipEntry?.files, size: zipEntry?.size, method: zipEntry?.method });
          // v15: mark these cards as completed-on-disk, advance the next-chunk-index
          for (const c of chunkState.contents) {
            completedCardsPerTerminal[ft.terminal_node].push(c.turn_card);
          }
          nextChunkIndexPerTerminal[ft.terminal_node] = chunkState.chunkIndex + 1;
          chunkState.n_emitted++;
          chunkState.chunkIndex++;
          chunkState.files = [];
          chunkState.rawBytes = 0;
          chunkState.contents = [];
          // v15: checkpoint + pause after each chunk zip.
          saveCheckpoint(buildCheckpoint({ last_event: 'turn_chunk_emitted', last_zip: chunkZipName, last_terminal: ft.terminal_node }));
          // v17 + PHASE 1: emit resume.json alongside the chunk zip.
          //   Legacy: event = `after_<terminal>_chunk<NNN>`; flat filename.
          //   Phase 1 (zipPerCard): event = `after_<terminal>_<card>`; filename
          //   becomes `<tree>_<flop>_<terminal>_<card>_<device>_resume.json` and
          //   the JSON payload is augmented with device/session_id/session_meta.
          if (emitResumeFile && typeof window.__msEmitResumeFile === 'function') {
            try {
              const safeFt = ft.terminal_node.replace(/[^A-Za-z0-9_-]/g, '_');
              if (zipPerCard && cardForName) {
                await window.__msEmitResumeFile(
                  `after_${safeFt}_${cardForName}`,
                  downloadDelayMs,
                  {
                    zip_per_card: true,
                    terminal: ft.terminal_node,
                    card: cardForName,
                    device: deviceName,
                    session_id: sessionId,
                  }
                );
              } else {
                await window.__msEmitResumeFile(`after_${safeFt}_chunk${idxStr}`, downloadDelayMs);
              }
            } catch (e) {
              result.warnings.push(`emit_resume_file (chunk ${chunkZipName}) failed: ${e.message}`);
            }
          }
          // TIER 2 FIX #5: optional partial-browse noise BEFORE the pause.
          //   Lets human_like.partial_browse_chance control how often a
          //   between-card "looked at other cards" burst fires. Pure noise:
          //   no clicks on cards, no extra /range/url calls.
          try {
            const pbChance = (humanCfg && typeof humanCfg.partial_browse_chance === 'number')
              ? humanCfg.partial_browse_chance : 0;
            if (pbChance > 0 && Math.random() < pbChance && typeof W.pretendPartialBrowse === 'function') {
              await W.pretendPartialBrowse(ft.terminal_node);
            }
          } catch (_) {}
          if (!autoContinue) await pauseUntilContinue(`turn chunk emitted (${chunkZipName})`);
          return zipEntry;
        }

        let canonicalsWalkedThisTerminal = 0;
        let cellSafety = 0;
        const CELL_SAFETY_MAX = 80;
        let zeroWalkCount = 0;
        let zeroWalkRunStreak = 0;
        // v17: only push to completedTerminals when the cell loop exits naturally
        //      because no more cells remain. Abort / quota / safety overflow /
        //      turnCardLimit / break-from-handleOneCell all leave this false.
        let terminalFullyDone = false;
        let terminalExitReason = 'unknown';

        async function ensureTurnModalAtTerminal() {
          if (W.modalKind() === 'turn' && W.urlNode() === ft.terminal_node && !W.urlSuitMap()) {
            return { ok: true, path: 'already_ready' };
          }
          const r = await reopenTurnModalCheapOrFull(ft, result);
          if (!r.ok) return { ok: false, path: r.path };
          if (W.urlSuitMap()) {
            log('suitmap_persisted_forcing_full_replay', { terminal: ft.terminal_node, suitMap: W.urlSuitMap() });
            if (!await replayFromFlopRoot(ft.parent, result)) return { ok: false, path: 'replay-failed' };
            if (!await openModalByCloser(ft.via)) return { ok: false, path: 'closer-failed' };
            window.__msProgress.reopen_stats.replay++;
            return { ok: true, path: 'replay-suitmap-forced' };
          }
          window.__msProgress.reopen_stats[r.path]++;
          return r;
        }

        async function handleOneCell(targetCard, cellStatus) {
          if (window.__msQuotaExceeded || window.__msAborted) return 'break';

          if (explicitCards && !explicitCards.includes(targetCard)) return 'continue';
          if (cfg.turn_card_filter && !cfg.turn_card_filter(ft.terminal_node, targetCard)) return 'continue';
          if (canonicalsWalkedThisTerminal >= turnCardLimit) return 'break';

          if (cellStatus === 'dim') {
            knownDim.add(targetCard);
            return 'continue';
          }
          if (cellStatus === 'used') return 'continue';
          if (knownDim.has(targetCard)) return 'continue';
          if (knownAliases.has(targetCard)) {
            const canonical = knownAliases.get(targetCard);
            const aliasRec = {
              street: 'turn', flop_terminal: ft.terminal_node,
              requested: targetCard, canonical,
              suitMap: '(cross-terminal cache hit)',
              cross_terminal_cached: true,
            };
            result.aliases.push(aliasRec);
            turnCardAliases.push(aliasRec);
            return 'continue';
          }

          window.__msProgress.last_node = `${ft.terminal_node}/${targetCard}/turn-click`;
          log('turn_cell_click', { terminal: ft.terminal_node, card: targetCard });

          await W.dismissNoSimPopupIfAny();

          let commit;
          try {
            commit = await W.pickCardCommit(targetCard, 'turn');
          } catch (e) {
            if (/no-sim|Generate/i.test(e.message)) {
              knownDim.add(targetCard);
              await W.dismissNoSimPopupIfAny();
              log('turn_cell_dim_recovered', { card: targetCard });
              const er = await ensureTurnModalAtTerminal();
              if (!er.ok) return 'break';
              return 'continue';
            }
            result.warnings.push(`[${ft.terminal_node}/${targetCard}] commit: ${e.message}`);
            log('turn_cell_skip', { card: targetCard, reason: e.message });
            await W.dismissNoSimPopupIfAny();
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) return 'break';
            return 'continue';
          }

          if (commit.was_alias) {
            const aliasRec = {
              street: 'turn', flop_terminal: ft.terminal_node,
              requested: commit.alias_requested, canonical: commit.committed,
              suitMap: commit.suitMap_was,
            };
            result.aliases.push(aliasRec);
            turnCardAliases.push(aliasRec);
            knownAliases.set(commit.alias_requested, commit.committed);
            log('turn_alias_recorded', {
              requested: commit.alias_requested, canonical: commit.committed,
              suitMap: commit.suitMap_was,
            });
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) return 'break';
            return 'continue';
          }

          const turnCardStats = { turn: [] };
          const turnCardErrors = [];
          const turnCardWarnings = [];
          const turnCardNodes = [];
          const aliasesScopedToThisCard = turnCardAliases.filter(a => a.canonical === commit.committed);
          const turnCardFiles = [];

          window.__msProgress.last_node = `${ft.terminal_node}/${commit.committed}/turn-walking`;
          const turnNodeStartIdx = result.nodes.length;
          log('walk_turn_start', { turn: commit.committed, terminal: ft.terminal_node });
          await W.dfsStreet({
            node: W.urlNode(), turn: commit.committed, river: null, suitMap: null, street: 'turn',
          }, result, {
            onNodeRecorded: async (state, node) => {
              node._segment = { kind: 'turn_card', flop_terminal: ft.terminal_node, turn_card: commit.committed };
            },
          });
          log('walk_turn_done', { turn: commit.committed });
          const turnNodes = result.nodes.slice(turnNodeStartIdx);
          turnCardNodes.push(...turnNodes);
          window.__msProgress.nodes_walked = result.nodes.length;
          canonicalsWalkedThisTerminal++;

          const turnStreetNodesThisCard = turnNodes.filter(n => n.street === 'turn').length;
          if (turnStreetNodesThisCard === 0) {
            zeroWalkCount++;
            zeroWalkRunStreak++;
            log('zero_walk_detected', {
              terminal: ft.terminal_node, card: commit.committed,
              streak: zeroWalkRunStreak, total: zeroWalkCount,
            });
            result.warnings.push(`[${ft.terminal_node}/${commit.committed}] turn DFS recorded ZERO nodes (likely click race / DOM transient)`);
            if (zeroWalkRunStreak >= 3) {
              log('zero_walk_circuit_breaker_hard_reset', { terminal: ft.terminal_node, streak: zeroWalkRunStreak });
              result.warnings.push(`[${ft.terminal_node}] hard reset triggered after ${zeroWalkRunStreak} consecutive zero walks`);
              if (!await replayFromFlopRoot(ft.parent, result) || !await openModalByCloser(ft.via)) {
                result.warnings.push(`[${ft.terminal_node}] hard reset failed — aborting terminal`);
                window.__msProgress.reopen_stats.failed++;
                return 'break';
              }
              window.__msProgress.reopen_stats.replay++;
              zeroWalkRunStreak = 0;
            }
            if (zeroWalkCount >= 6) {
              result.warnings.push(`[${ft.terminal_node}] ABORT: ${zeroWalkCount} total zero walks at this terminal — aborting to prevent runaway loop`);
              log('zero_walk_terminal_abort', { terminal: ft.terminal_node, total: zeroWalkCount });
              return 'break';
            }
          } else {
            zeroWalkRunStreak = 0;
          }

          if (!dryRun) {
            window.__msProgress.phase = 'scraping_turn_card';
            await sleep(400);
            captures = H.enumerateCaptures(result);
            const dropWrapper = (scope === 'flop+turn');
            const turnCardInsidePath = dropWrapper
              ? `${commit.committed}`
              : `${ft.terminal_node}/${commit.committed}`;

            const turnNodesOnly = turnCardNodes.filter(n => n.street === 'turn');
            const tSeg = await processSegment('turn_node', turnNodesOnly, captures, result, chipsPerBb,
              { flop_terminal: ft.terminal_node, turn_card: commit.committed, dropFlopTerminalWrapper: dropWrapper });
            turnCardFiles.push(...tSeg.filesToZip);
            turnCardStats.turn = tSeg.perNodeStats;
            turnCardErrors.push(...tSeg.matchErrors);

            if (aliasesScopedToThisCard.length) {
              turnCardFiles.push({
                name: `${turnCardInsidePath}/aliases.json`,
                content: JSON.stringify(aliasesScopedToThisCard, null, 2),
              });
            }

            const tcManifest = {
              tree: result.tree, flop: result.flop, scope, chipsPerBb,
              segment_kind: 'turn_card',
              flop_terminal: ft.terminal_node,
              turn_card_canonical: commit.committed,
              turn_card_requested: targetCard,
              was_alias: commit.was_alias,
              n_turn_nodes: turnCardStats.turn.length,
              n_match_errors: turnCardErrors.length,
              match_errors: turnCardErrors,
              n_warnings: turnCardWarnings.length,
              warnings: turnCardWarnings,
              n_aliases: aliasesScopedToThisCard.length,
              per_turn_node_stats: turnCardStats.turn,
              started_at: result.started_at,
              finished_at: new Date().toISOString(),
            };
            turnCardFiles.push({
              name: `${turnCardInsidePath}/turn_card_manifest.json`,
              content: JSON.stringify(tcManifest, null, 2),
            });

            const hasRealContent = turnCardStats.turn.length > 0;
            if (!hasRealContent) {
              log('turn_card_skipped_empty', {
                terminal: ft.terminal_node, card: commit.committed,
                reason: window.__msQuotaExceeded ? 'quota_exceeded' : 'no_nodes_processed',
                n_match_errors: turnCardErrors.length,
              });
              for (const w of turnCardWarnings) result.warnings.push(`[${ft.terminal_node}/${commit.committed}] ${w}`);
              result.warnings.push(`[${ft.terminal_node}/${commit.committed}] turn card skipped (no real content; ${turnCardErrors.length} match errors)`);
              const er = await ensureTurnModalAtTerminal();
              if (!er.ok) return 'break';
              return 'walked';
            }

            let cardRawBytes = 0;
            for (const f of turnCardFiles) cardRawBytes += new Blob([f.content]).size;
            chunkState.files.push(...turnCardFiles);
            chunkState.rawBytes += cardRawBytes;
            chunkState.contents.push({
              turn_card: commit.committed,
              turn_card_requested: targetCard,
              n_turn_nodes: turnCardStats.turn.length,
              raw_bytes: cardRawBytes,
              n_files: turnCardFiles.length,
            });
            log('turn_card_buffered', {
              terminal: ft.terminal_node, card: commit.committed,
              card_raw_bytes: cardRawBytes,
              chunk_raw_bytes: chunkState.rawBytes,
              chunk_idx: chunkState.chunkIndex,
              chunk_n_cards: chunkState.contents.length,
            });

            for (const w of turnCardWarnings) result.warnings.push(`[${ft.terminal_node}/${commit.committed}] ${w}`);

            // v15: flush on turn-card-count threshold (default 5).
            // v17: also flush on raw-bytes threshold (default Infinity), whichever first.
            if (chunkState.contents.length >= turnCardsPerChunk) {
              await flushChunk('turn_card_count_threshold');
            } else if (chunkState.rawBytes >= chunkMaxRawBytes) {
              await flushChunk('chunk_max_raw_bytes_threshold');
            }
          }

          const er = await ensureTurnModalAtTerminal();
          if (!er.ok) {
            result.warnings.push(`[${ft.terminal_node}] reopen modal after walking ${commit.committed} failed: ${er.path}`);
            window.__msProgress.reopen_stats.failed++;
            return 'break';
          }
          return 'walked';
        }

        const visitedThisTerminal = new Set();
        outer:
        while (cellSafety++ < CELL_SAFETY_MAX) {
          if (window.__msQuotaExceeded || window.__msAborted) {
            terminalExitReason = window.__msQuotaExceeded ? 'quota_exceeded' : 'user_abort';
            log('quota_or_user_abort', { phase: 'cell_loop', terminal: ft.terminal_node });
            break;
          }
          // PHASE 7: safety detection at safe boundary.
          //   If unexpected state (captcha, login redirect, page change),
          //   emit emergency-stop file + abort the run gracefully.
          if (typeof W.detectUnexpectedState === 'function' && !window.__msEmergencyStop) {
            const bad = W.detectUnexpectedState();
            if (bad) {
              window.__msEmergencyStop = true;
              window.__msAborted = true;
              terminalExitReason = 'emergency_stop';
              try {
                W.emitEmergencyStopFile({
                  device: cfg.device_name || null,
                  session_id: cfg.session_id || null,
                  tree: result.tree, flop: result.flop, terminal: ft.terminal_node,
                  reason: bad.reason, detail: bad.detail,
                });
              } catch (_) {}
              result.warnings.push(`EMERGENCY STOP: ${bad.reason} -- check Drive emergency_stops/ and clear <device>.active.emergencystop.json to resume`);
              log('emergency_stop', { terminal: ft.terminal_node, reason: bad.reason });
              break outer;
            }
          }
          if (canonicalsWalkedThisTerminal >= turnCardLimit) { terminalExitReason = 'turn_card_limit'; break; }
          if (W.modalKind() !== 'turn') {
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) {
              result.warnings.push(`[${ft.terminal_node}] modal not openable: ${er.path}`);
              break outer;
            }
          }
          await W.dismissNoSimPopupIfAny();
          const cells = W.readModalCells('turn');

          // PHASE 2: capture full card map once per terminal (first cell read).
          //   Drives state/card_maps/<tree>/<flop>/<terminal>.json downstream
          //   so other devices/sessions can pick cards without re-inspecting.
          if (!result.terminal_card_maps[ft.terminal_node]) {
            result.terminal_card_maps[ft.terminal_node] = {
              recorded_at: new Date().toISOString(),
              recorded_by_device: deviceName || null,
              recorded_by_session: sessionId || null,
              total_cells: cells.length,
              available: cells.filter(c => c.status === 'ok').map(c => c.card),
              used:      cells.filter(c => c.status === 'used').map(c => c.card),
              dim_dom:   cells.filter(c => c.status === 'dim').map(c => c.card),
            };
            log('terminal_card_map_captured', {
              terminal: ft.terminal_node,
              n_available: result.terminal_card_maps[ft.terminal_node].available.length,
              n_used:      result.terminal_card_maps[ft.terminal_node].used.length,
              n_dim_dom:   result.terminal_card_maps[ft.terminal_node].dim_dom.length,
            });
          }

          // PHASE 2: target-cards-aware cell pick.
          //   With targetCardsPerTerminal[terminal] provided: iterate the
          //   given list in order, pick the first card that maps to an
          //   available cell. Aliased/dim cards are recorded as alias-hits
          //   and skipped (consistent with legacy behavior).
          //   Without: fall back to legacy top-to-bottom DOM order.
          let target = null;
          const targetList = (targetCardsPerTerminal && Array.isArray(targetCardsPerTerminal[ft.terminal_node]))
            ? targetCardsPerTerminal[ft.terminal_node]
            : null;
          const cellByCard = new Map(cells.map(c => [c.card, c]));
          let iterCards = targetList ? targetList : cells.map(c => c.card);
          // TIER 3 FIX #6: random visit order when no explicit targetList and
          //   cfg.shuffle_cards is true. Deterministic top-to-bottom order
          //   only applies in legacy / debug mode.
          if (!targetList && cfg.shuffle_cards === true && iterCards.length > 1) {
            iterCards = iterCards.slice();
            for (let i = iterCards.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [iterCards[i], iterCards[j]] = [iterCards[j], iterCards[i]];
            }
          }

          for (const wantedCard of iterCards) {
            if (visitedThisTerminal.has(wantedCard)) continue;
            const c = cellByCard.get(wantedCard);
            if (!c) continue;                 // wanted card not in modal (e.g. typo)
            if (c.status === 'used') continue;
            if (knownAliases.has(c.card) || knownDim.has(c.card)) {
              visitedThisTerminal.add(c.card);
              if (knownAliases.has(c.card)) {
                const canonical = knownAliases.get(c.card);
                const aliasRec = {
                  street: 'turn', flop_terminal: ft.terminal_node,
                  requested: c.card, canonical,
                  suitMap: '(cross-terminal cache hit)',
                  cross_terminal_cached: true,
                };
                result.aliases.push(aliasRec);
                turnCardAliases.push(aliasRec);
              }
              continue;
            }
            target = c;
            break;
          }
          if (!target) {
            terminalFullyDone = true;
            terminalExitReason = 'no_more_cells';
            break outer;
          }
          visitedThisTerminal.add(target.card);
          // PHASE 4: hover 1-3 sibling cards before committing to target.
          //   No clicks -> no /range/url. Gated on cfg.human_like.turn_hover_count_range.
          try {
            const hr = humanCfg && humanCfg.turn_hover_count_range;
            if (Array.isArray(hr) && hr.length === 2 && hr[1] > 0) {
              const lo = Math.max(0, hr[0]|0), hi = Math.max(lo, hr[1]|0);
              const k = lo + Math.floor(Math.random() * (hi - lo + 1));
              if (k > 0 && typeof W.humanTurnBrowseHover === 'function') {
                await W.humanTurnBrowseHover(target.card, k);
              }
            }
          } catch (_) {}
          const verdict = await handleOneCell(target.card, target.status);
          if (verdict === 'break') break outer;
        }
        log('cell_loop_done', {
          terminal: ft.terminal_node,
          canonicals_walked: canonicalsWalkedThisTerminal,
          aliases_recorded: turnCardAliases.length,
          dim_known: knownDim.size,
        });

        if (chunkState.files.length > 0) {
          await flushChunk('terminal_boundary');
        }
        // v17 BUG FIX: only mark the terminal fully done when the cell loop
        //              exited because there were no more cells to walk. An
        //              abort / quota / safety overflow / turn_card_limit
        //              exit leaves work incomplete and MUST NOT mark the
        //              terminal as done (otherwise resume skips it).
        if (terminalFullyDone) {
          completedTerminals.push(ft.terminal_node);
          log('flop_terminal_done', {
            terminal: ft.terminal_node,
            chunks_emitted: chunkState.n_emitted,
            exit_reason: terminalExitReason,
          });
          // v15: refresh checkpoint at terminal boundary (no extra pause —
          // pause already fired when the boundary chunk was emitted, OR there
          // was nothing to emit and we just mark the terminal done.)
          saveCheckpoint(buildCheckpoint({ last_event: 'terminal_done', last_terminal: ft.terminal_node }));
        } else {
          log('flop_terminal_interrupted', {
            terminal: ft.terminal_node,
            chunks_emitted: chunkState.n_emitted,
            exit_reason: terminalExitReason,
            canonicals_walked: canonicalsWalkedThisTerminal,
          });
          saveCheckpoint(buildCheckpoint({
            last_event: 'terminal_interrupted',
            last_terminal: ft.terminal_node,
            terminal_exit_reason: terminalExitReason,
          }));
        }
      }

      delete result.nodesByKeyShortcut;
      if (window.__msQuotaExceeded) {
        result.aborted_due_to_quota = true;
        result.quota_detail = window.__msQuotaExceeded;
      }
      if (window.__msAborted) {
        result.aborted_by_user = true;
      }
      result.summary.reopen_stats = window.__msProgress.reopen_stats;
      try { if (W.modalKind && W.modalKind()) { await W.closeModalX(); } } catch (_) {}
      result.finished_at = new Date().toISOString();
      result.elapsed_s = Math.round((Date.now() - window.__msProgress.t_start) / 1000);
      window.__msProgress.phase = window.__msQuotaExceeded ? 'aborted_quota' : (window.__msAborted ? 'aborted_user' : 'done');
      window.__msResult = result;
      saveCheckpoint(buildCheckpoint({ last_event: 'run_finished' }));
      return result;
    } catch (e) {
      delete result.nodesByKeyShortcut;
      window.__msError = { message: e.message, stack: (e.stack || '').slice(0, 1500) };
      window.__msProgress.phase = 'error';
      result.error = e.message;
      window.__msResult = result;
      try { saveCheckpoint(buildCheckpoint({ last_event: 'error', error: e.message })); } catch (_) {}
      throw e;
    }
  };

  window.__msCheckpointHygieneFixed = true;
  window.__msPhase1SessionModeInstalled = true;
  window.__msPhase2CardMapsInstalled = true;
  window.__msPhase3SessionWrapperInstalled = true;
  window.__msPhase4OrchestratorWiredInstalled = true;
  window.__msPhase7EmergencyHookInstalled = true;
  window.__msTier1FixesInstalled = true;
  window.__msTier23OrchInstalled = true;
  window.__msCachedTerminalsEarlySetInstalled = true; // POST-TIER-1 HOTFIX 2026-05-22
  window.__msCategoriesPanelBroadLabelsInstalled = true; // POST-TIER-3 HOTFIX 2026-05-22 (declared here for probe convenience)

  // ---------------------------------------------------------------------
  // PHASE 3: __scrapeSession -- convenience wrapper for the multi-device
  // session workflow. Takes a session spec produced by build_plan.py:
  //
  //   {
  //     tree: 'PLO5C_100_2_SB_BB_3BP',
  //     flop: 'Js8c2h',
  //     terminal: 'C-R50-C',
  //     cards: ['Qs','9s','Td'],          // walked in this order
  //     device: 'main',
  //     session_id: '9e3d-...-fa1b',
  //     cached_flop_terminals: [...],     // from ledger (Phase 1)
  //   }
  //
  // Plus optional overrides:
  //   {
  //     auto_continue: true,              // default true for sessions
  //     node_wait_min_ms / node_wait_max_ms,
  //     download_delay_ms,
  //     ...any other cfg knob accepted by __scrapeMultiStreet
  //   }
  //
  // Builds the right cfg for __scrapeMultiStreet:
  //   - zip_per_card: true (Phase 1)
  //   - skip_flop_walk: true + cached_flop_terminals (Phase 1, no flop re-walk)
  //   - flop_terminal_filter: walks only the target terminal
  //   - target_cards_per_terminal: only the listed cards, in given order (Phase 2)
  //   - turn_card_limit: cards.length (safety belt)
  //
  // Returns the __scrapeMultiStreet result, with session_summary appended.
  // ---------------------------------------------------------------------
  if (typeof window.__scrapeSession !== 'function') {
    window.__scrapeSession = async function(spec) {
      spec = spec || {};
      if (!spec.tree || !spec.flop || !spec.terminal) {
        throw new Error('__scrapeSession: spec.tree, spec.flop, spec.terminal are required');
      }
      if (!Array.isArray(spec.cards) || spec.cards.length === 0) {
        throw new Error('__scrapeSession: spec.cards must be a non-empty array');
      }
      if (!spec.cached_flop_terminals || !spec.cached_flop_terminals.length) {
        throw new Error('__scrapeSession: spec.cached_flop_terminals is required (read from ledger)');
      }
      const cfg = Object.assign({
        scope: 'flop+turn',
        zip_per_card: true,
        auto_continue: true,
      }, spec.cfg_overrides || {});
      cfg.device_name = spec.device || cfg.device_name;
      cfg.session_id  = spec.session_id || cfg.session_id;
      cfg.skip_flop_walk = true;
      cfg.cached_flop_terminals = spec.cached_flop_terminals;
      cfg.flop_terminal_filter = (function(targetTerm) {
        return function(t) { return t === targetTerm; };
      })(spec.terminal);
      cfg.target_cards_per_terminal = Object.assign(
        {},
        cfg.target_cards_per_terminal || {},
        { [spec.terminal]: spec.cards.slice() }
      );
      cfg.turn_card_limit = spec.cards.length;
      const sessionStartedAt = new Date().toISOString();
      try { console.log('[hand-scraper phase3] __scrapeSession launching', {
        tree: spec.tree, flop: spec.flop, terminal: spec.terminal,
        cards: spec.cards, device: cfg.device_name, session_id: cfg.session_id
      }); } catch (_) {}
      const result = await window.__scrapeMultiStreet(cfg);
      result.session_summary = {
        session_id: cfg.session_id || null,
        device: cfg.device_name || null,
        tree: spec.tree,
        flop: spec.flop,
        terminal: spec.terminal,
        cards_planned: spec.cards.slice(),
        cards_walked: (result.zips || [])
          .filter(z => z.kind === 'turn_card_chunk' && Array.isArray(z.turn_cards))
          .reduce((acc, z) => acc.concat(z.turn_cards), []),
        zips_emitted: (result.zips || []).map(z => z.name),
        captures: result.summary && result.summary.captures,
        started_at: sessionStartedAt,
        finished_at: result.finished_at,
        elapsed_s: result.elapsed_s,
        aborted_by_user: !!result.aborted_by_user,
        aborted_due_to_quota: !!result.aborted_due_to_quota,
      };
      window.__msSessionResult = result;
      return result;
    };
  }

  return 'multi-street scraper installed (window.__scrapeMultiStreet, window.__scrapeSession) [tier 2/3 orch: categories-activate + partial-browse + shuffle_cards; tier-1 fixes: all-terminals-cached + per-card-manifest + modal-cleanup; phase 7 emergency-stop hook; phase 4 human-like noise wired (cfg.human_like -> window.__msHumanCfg + turn hover hook); phase 3 session wrapper; phase 2 card maps + target_cards_per_terminal; phase 1 session mode (zip_per_card + device_name + session_id); post-v18 checkpoint-hygiene fix: fresh-launch state clear + flop emit order swap; v17 skip_flop_walk + cached_flop_terminals + emit_resume_file + chunk_max_raw_bytes + terminalFullyDone bug fix; v15 random 3-5s inter-node wait; 5-card chunk threshold; pause+checkpoint after every zip; v13 plomm envelope support; v11 dynamic bet sizings; v10 post-reload-resume options: skip_flop_zip + chunk_index_start_per_terminal]';
})();


/* ==================== 4) RESUME ==================== */
/* scrape_resume.js - resume orchestrator for partially completed flop+turn runs.
 *
 * Installs window.__scrapeResume on top of window.__W + window.__msHelpers.
 *
 * v15 (changes from v1):
 *   - Mirrors the orchestrator's v15 changes: 5-card turn-chunk threshold
 *     (configurable via cfg.turn_cards_per_chunk, default 5), and
 *     pause-after-each-zip with localStorage checkpointing.
 *   - The walker's v15 3-5s inter-node wait applies automatically since
 *     this resume orchestrator calls into __W.dfsStreet.
 *
 * Use this whenever a `__scrapeMultiStreet({ scope: 'flop+turn' })` run was
 * interrupted (quota, network, manual abort) and the tab was NOT reloaded.
 */
(function installResume() {
  if (typeof window.__W === 'undefined' || typeof window.__msHelpers === 'undefined') {
    throw new Error('scrape_resume: window.__W and window.__msHelpers must be loaded first (run combined bootstrap)');
  }
  const W = window.__W;
  const H = window.__msHelpers;
  const sleep = W.sleep;

  const CHECKPOINT_KEY = '__msCheckpoint_v15';

  function saveCheckpoint(snapshot) {
    const ckpt = Object.assign({
      version: 'v15',
      timestamp: new Date().toISOString(),
      from: 'resume',
    }, snapshot || {});
    window.__msCheckpoint = ckpt;
    try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(ckpt)); }
    catch (e) { console.warn('[hand-scraper] localStorage save failed:', e && e.message); }
    return ckpt;
  }

  if (typeof window.__msContinue !== 'function') {
    window.__msContinue = function() {
      window.__msPaused = false;
      console.log('[hand-scraper] resume signal sent (window.__msContinue)');
    };
  }
  if (typeof window.__msAbort !== 'function') {
    window.__msAbort = function() {
      window.__msAborted = true;
      window.__msPaused = false;
      console.log('[hand-scraper] abort signal sent (window.__msAbort)');
    };
  }
  if (typeof window.__msShowProgress !== 'function') {
    window.__msShowProgress = function() {
      const c = window.__msCheckpoint || (function() {
        try { return JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || 'null'); }
        catch (e) { return null; }
      })();
      console.log('[hand-scraper] progress:', c);
      console.log('[hand-scraper] paused?', !!window.__msPaused, 'aborted?', !!window.__msAborted);
      return c;
    };
  }

  async function pauseUntilContinue(reason) {
    if (window.__msAborted) return;
    window.__msPaused = true;
    window.__msPausedReason = reason;
    window.__msPausedAt = new Date().toISOString();
    console.log(`[hand-scraper] PAUSED after ${reason}.`);
    console.log('[hand-scraper] Resume: window.__msContinue()  |  Progress: window.__msShowProgress()  |  Abort: window.__msAbort()');
    while (window.__msPaused === true && !window.__msAborted) {
      await sleep(500);
    }
    window.__msPausedReason = null;
    window.__msPausedAt = null;
    if (!window.__msAborted) console.log('[hand-scraper] Resumed.');
  }

  async function ensureFlopRoot() {
    let safety = 0;
    while (safety++ < 30) {
      if (W.urlNode() === '' && !W.urlTurn() && !W.urlRiver()) return true;
      if (W.modalKind()) await W.closeModalX();
      const blocks = W.readBlocks();
      let target = null;
      for (const b of blocks) { if (b.actions.some(a => a.chosen)) target = b; }
      if (!target) break;
      const before = `${W.urlNode()}|${W.urlTurn()}|${W.urlRiver()}`;
      target.headerEl.click();
      await sleep(700);
      if (`${W.urlNode()}|${W.urlTurn()}|${W.urlRiver()}` === before) break;
    }
    if (W.modalKind()) await W.closeModalX();
    return W.urlNode() === '' && !W.urlTurn() && !W.urlRiver();
  }

  async function replayFromFlopRoot(targetNode, walkResult) {
    if (!await ensureFlopRoot()) return false;
    if (!targetNode) return true;
    const segs = targetNode.split('-');
    try { await W.replaySegments(segs, walkResult); }
    catch (e) { walkResult.warnings.push(`replay to ${targetNode}: ${e.message}`); return false; }
    return W.urlNode() === targetNode;
  }

  async function openModalByCloser(closerLabel) {
    const ab = W.activeBlock();
    if (!ab) return false;
    const ce = ab.actions.find(a => a.label === closerLabel && !a.disabled)?.el;
    if (!ce) return false;
    const before = W.urlNode();
    ce.click();
    let t0 = Date.now();
    while (Date.now() - t0 < 4000 && W.urlNode() === before) await sleep(100);
    while (Date.now() - t0 < 6000 && !W.modalKind()) await sleep(100);
    return !!W.modalKind();
  }

  async function stabilizeBackToTerminal(ftTerminalNode) {
    if (W.modalKind()) await W.closeModalX();
    if (W.urlNode() === ftTerminalNode) return true;
    let safety = 0;
    while (safety++ < 30) {
      const blocks = W.readBlocks();
      let target = null;
      for (const b of blocks) { if (b.actions.some(a => a.chosen)) target = b; }
      if (!target) return false;
      const before = W.urlNode();
      target.headerEl.click();
      await sleep(700);
      if (W.urlNode() === before) return false;
      if (W.urlNode() === ftTerminalNode) {
        if (W.modalKind()) await W.closeModalX();
        return true;
      }
    }
    return false;
  }

  async function reopenTurnModalCheapOrFull(ft, walkResult) {
    if (await stabilizeBackToTerminal(ft.terminal_node)) {
      try {
        await W.reopenChipModal('turn');
        if (W.modalKind() === 'turn') return { ok: true, path: 'cheap' };
      } catch (e) { /* fall through */ }
    }
    if (!await replayFromFlopRoot(ft.parent, walkResult)) return { ok: false, path: 'replay-failed' };
    if (!await openModalByCloser(ft.via)) return { ok: false, path: 'closer-failed' };
    return { ok: true, path: 'replay' };
  }

  function deriveFlopTerminals(walkedNodes) {
    return walkedNodes
      .filter(n => n.street === 'flop')
      .map(n => {
        const closer = n.children?.find(c => c.closes_street && !c.disabled);
        if (!closer) return null;
        const terminalNode = n.node ? `${n.node}-${closer.code}` : closer.code;
        return { parent: n.node, terminal_node: terminalNode, via: closer.label, code: closer.code };
      })
      .filter(x => x);
  }

  async function processTurnSegment(turnNodes, captures, walk, chipsPerBb, layoutCtx) {
    const filesToZip = [];
    const perNodeStats = [];
    const matchErrors = [];
    let aborted = false;
    for (const node of turnNodes) {
      if (window.__msQuotaExceeded || window.__msAborted) { aborted = true; break; }
      const key = H.captureKey(node.node, node.turn, node.river);
      const capture = captures.get(key);
      if (!capture) { matchErrors.push(`no capture for ${key}`); continue; }
      try {
        const t0 = performance.now();
        const { csvText, meta } = await H.processNode(node, capture, walk, chipsPerBb);
        const dt = (performance.now() - t0) / 1000;
        perNodeStats.push({
          street: node.street, node: node.node || '(root)',
          turn: node.turn, river: node.river,
          union: meta.union_combo_count, csv_kb: (csvText.length / 1024) | 0, sec: dt.toFixed(1),
        });
        const nodeFs = node.node ? node.node.replace(/-/g, '_') : '(root)';
        const folderPath = layoutCtx.dropFlopTerminalWrapper
          ? `${layoutCtx.turn_card}/${nodeFs}`
          : `${layoutCtx.flop_terminal}/${layoutCtx.turn_card}/${nodeFs}`;
        filesToZip.push({ name: `${folderPath}_combos.csv`, content: csvText });
        filesToZip.push({ name: `${folderPath}_meta.json`,  content: JSON.stringify(meta, null, 2) });
      } catch (e) {
        matchErrors.push(`process ${key}: ${e.message}`);
        if (/^QUOTA_EXCEEDED/.test(e.message) || window.__msQuotaExceeded) { aborted = true; break; }
      }
    }
    return { filesToZip, perNodeStats, matchErrors, aborted };
  }

  async function emitZip(zipName, filesToZip, allZipsRegistry, downloadDelayMs = 500) {
    if (!filesToZip.length) return null;
    const zipBytes = await H.buildZip(filesToZip);
    const entry = {
      name: zipName, bytes: zipBytes, size: zipBytes.byteLength,
      files: filesToZip.length, t: Date.now(),
      method: zipBytes.__zipMethod === 8 ? 'DEFLATE' : 'STORE',
    };
    allZipsRegistry.push(entry);
    window.__lastZipBytes = zipBytes;
    window.__lastZipName  = zipName;
    try {
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl; a.download = zipName;
      document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(dlUrl); }, 1000);
      entry.download_triggered = true;
    } catch (e) {
      entry.download_triggered = false; entry.download_error = e.message;
    }
    await sleep(downloadDelayMs);
    return entry;
  }

  window.__scrapeResume = async function(cfg) {
    cfg = cfg || {};
    const chipsPerBb = cfg.chipsPerBb || 2000;
    const downloadDelayMs = cfg.download_delay_ms || 500;
    const prior = cfg.prior_result || window.__msResult;
    if (!prior || !prior.nodes || prior.nodes.length === 0) {
      throw new Error('scrape_resume: no prior_result.nodes — cannot derive flop terminals (did the prior run wipe state? a tab reload kills resume)');
    }
    // v15: forward walker wait config + chunk-cards threshold + auto_continue
    if (typeof cfg.node_wait_min_ms === 'number') window.__msNodeWaitMin = cfg.node_wait_min_ms;
    if (typeof cfg.node_wait_max_ms === 'number') window.__msNodeWaitMax = cfg.node_wait_max_ms;
    const turnCardsPerChunk = (typeof cfg.turn_cards_per_chunk === 'number' && cfg.turn_cards_per_chunk > 0) ? cfg.turn_cards_per_chunk : 5;
    const autoContinue = cfg.auto_continue === true;

    window.__msQuotaExceeded = null;
    window.__msPaused = false;
    window.__msAborted = false;

    if (!window._capturedRequests) {
      H.installInterceptors();
    }

    window.__msProgress = {
      phase: 'starting', t_start: Date.now(),
      nodes_walked: 0, zips_emitted: 0,
      last_zip: null, last_node: null,
      reopen_stats: { cheap: 0, replay: 0, failed: 0 },
      resume_mode: true,
      auto_continue: autoContinue,
      turn_cards_per_chunk: turnCardsPerChunk,
      node_wait_ms_range: [
        (typeof window.__msNodeWaitMin === 'number') ? window.__msNodeWaitMin : 3000,
        (typeof window.__msNodeWaitMax === 'number') ? window.__msNodeWaitMax : 5000,
      ],
    };
    window.__msAllZips = window.__msAllZips || [];
    window.__msResumeError = null;

    const result = {
      scope: 'flop+turn',
      dryRun: false,
      chipsPerBb,
      tree: W.urlTree(),
      flop: W.urlFlop(),
      started_at: new Date().toISOString(),
      nodes: prior.nodes.slice(),
      warnings: [],
      events: [],
      aliases: [],
      summary: {},
      zips: [],
      resume: {
        prior_started_at: prior.started_at || null,
        prior_finished_at: prior.finished_at || null,
        prior_zips_count: (prior.zips || []).length,
        skip_cards_per_terminal: cfg.skip_cards_per_terminal || {},
        redo_cards_per_terminal: cfg.redo_cards_per_terminal || {},
        chunk_index_start_per_terminal: cfg.chunk_index_start_per_terminal || {},
        turn_cards_per_chunk: turnCardsPerChunk,
      },
    };
    const log = (kind, data) => result.events.push({ ts: Date.now(), kind, ...(data || {}) });
    const flop = result.flop;
    log('resume_start', { tree: result.tree, flop, prior_zips: (prior.zips || []).length });

    result.nodesByKeyShortcut = new Map();
    for (const n of result.nodes) result.nodesByKeyShortcut.set(n.key, n);

    const completedTerminals = [];
    const nextChunkIndexPerTerminal = Object.assign({}, cfg.chunk_index_start_per_terminal || {});
    const completedCardsPerTerminal = {};

    function buildCheckpoint(extra) {
      return {
        scope: 'flop+turn', chipsPerBb, turn_cards_per_chunk: turnCardsPerChunk,
        tree: result.tree, flop: result.flop,
        started_at: result.started_at,
        flop_emitted: 'skipped (resume)',
        completed_terminals: completedTerminals.slice(),
        next_chunk_index_per_terminal: Object.assign({}, nextChunkIndexPerTerminal),
        completed_cards_per_terminal: Object.fromEntries(
          Object.entries(completedCardsPerTerminal).map(([k, v]) => [k, v.slice()])
        ),
        aliases: result.aliases.slice(),
        zips_emitted: result.zips.map(z => ({
          kind: z.kind, name: z.name,
          flop_terminal: z.flop_terminal || null,
          chunk_index: z.chunk_index || null,
          turn_cards: z.turn_cards || null,
        })),
        progress: window.__msProgress,
        extra: extra || null,
      };
    }

    try {
      window._capturedRequests = window._capturedRequests || [];

      if (!window.__msCanonCache) window.__msCanonCache = { turn: new Map(), river: new Map() };
      if (!window.__msCanonCache.turnAliasMap) window.__msCanonCache.turnAliasMap = new Map();
      if (!window.__msCanonCache.turnAliasMap.has(flop)) window.__msCanonCache.turnAliasMap.set(flop, new Map());
      if (!window.__msCanonCache.turnDimSet) window.__msCanonCache.turnDimSet = new Map();
      if (!window.__msCanonCache.turnDimSet.has(flop)) window.__msCanonCache.turnDimSet.set(flop, new Set());
      const xtAliases = window.__msCanonCache.turnAliasMap.get(flop);
      const xtDim = window.__msCanonCache.turnDimSet.get(flop);

      const seedAliases = (cfg.pre_seed_aliases || []).concat(prior.aliases || []);
      for (const a of seedAliases) {
        if (a && a.requested && a.canonical) xtAliases.set(a.requested, a.canonical);
      }
      log('alias_cache_seeded', { n: xtAliases.size, entries: [...xtAliases.entries()] });

      let flopTerminals = deriveFlopTerminals(prior.nodes);
      if (cfg.flop_terminal_filter) flopTerminals = flopTerminals.filter(t => cfg.flop_terminal_filter(t.terminal_node));
      result.summary.flop_terminals = flopTerminals.length;
      log('flop_terminals_identified', { n: flopTerminals.length, list: flopTerminals.map(t => t.terminal_node) });

      window.__msProgress.phase = 'walking';

      if (!await ensureFlopRoot()) {
        result.warnings.push('could not return to flop root at resume start');
      }

      for (const ft of flopTerminals) {
        if (window.__msQuotaExceeded || window.__msAborted) {
          log('quota_or_user_abort', { phase: 'flop_terminal_loop', terminal: ft.terminal_node });
          break;
        }
        log('flop_terminal_start', { terminal: ft.terminal_node });

        const skipList = new Set(cfg.skip_cards_per_terminal?.[ft.terminal_node] || []);
        const redoList = new Set(cfg.redo_cards_per_terminal?.[ft.terminal_node] || []);
        for (const c of redoList) skipList.delete(c);
        log('terminal_skip_redo', {
          terminal: ft.terminal_node,
          skip: [...skipList], redo: [...redoList],
        });

        const fullReopen = async () => {
          if (!await replayFromFlopRoot(ft.parent, result)) return false;
          return openModalByCloser(ft.via);
        };
        if (!await fullReopen()) {
          result.warnings.push(`open turn modal at ${ft.terminal_node}`);
          continue;
        }

        const knownAliases = xtAliases;
        const knownDim = xtDim;
        for (const c of (cfg.pre_seed_dim_per_terminal?.[ft.terminal_node] || [])) knownDim.add(c);
        const turnCardAliases = [];

        await W.dismissNoSimPopupIfAny();

        const turnCardLimit = cfg.turn_card_limit || 999;

        const chunkIndexStart = cfg.chunk_index_start_per_terminal?.[ft.terminal_node] || 1;
        const chunkState = {
          files: [],
          rawBytes: 0,
          chunkIndex: chunkIndexStart,
          contents: [],
          n_emitted: 0,
        };
        completedCardsPerTerminal[ft.terminal_node] = completedCardsPerTerminal[ft.terminal_node] || [];
        nextChunkIndexPerTerminal[ft.terminal_node] = chunkIndexStart;

        async function flushChunk(reason) {
          if (chunkState.files.length === 0) return null;
          const idxStr = String(chunkState.chunkIndex).padStart(3, '0');
          const chunkZipName = `${result.tree}_${result.flop}_${ft.terminal_node}_turn_chunk${idxStr}.zip`;
          const chunkManifest = {
            tree: result.tree, flop: result.flop, scope: 'flop+turn', chipsPerBb,
            segment_kind: 'turn_card_chunk',
            flop_terminal: ft.terminal_node,
            chunk_index: chunkState.chunkIndex,
            flush_reason: reason,
            resume: true,
            turn_cards: chunkState.contents.map(c => c.turn_card),
            n_turn_cards: chunkState.contents.length,
            n_files: chunkState.files.length,
            chunk_raw_bytes: chunkState.rawBytes,
            turn_cards_per_chunk_cfg: turnCardsPerChunk,
            per_card: chunkState.contents,
            started_at: result.started_at,
            finished_at: new Date().toISOString(),
          };
          const filesWithManifest = chunkState.files.concat([{
            name: `_chunk${idxStr}_manifest.json`,
            content: JSON.stringify(chunkManifest, null, 2),
          }]);
          log('chunk_flush_start', {
            name: chunkZipName, reason, raw_bytes: chunkState.rawBytes,
            n_turn_cards: chunkState.contents.length, n_files: chunkState.files.length,
          });
          const zipEntry = await emitZip(chunkZipName, filesWithManifest, window.__msAllZips, downloadDelayMs);
          if (zipEntry) {
            result.zips.push({
              kind: 'turn_card_chunk', name: chunkZipName,
              flop_terminal: ft.terminal_node,
              chunk_index: chunkState.chunkIndex,
              turn_cards: chunkState.contents.map(c => c.turn_card),
              raw_bytes: chunkState.rawBytes,
              files: zipEntry.files, size: zipEntry.size,
              method: zipEntry.method,
              flush_reason: reason,
              resume: true,
            });
            window.__msProgress.zips_emitted++;
            window.__msProgress.last_zip = chunkZipName;
          }
          log('chunk_flush_done', { name: chunkZipName, files: zipEntry?.files, size: zipEntry?.size, method: zipEntry?.method });
          for (const c of chunkState.contents) {
            completedCardsPerTerminal[ft.terminal_node].push(c.turn_card);
          }
          nextChunkIndexPerTerminal[ft.terminal_node] = chunkState.chunkIndex + 1;
          chunkState.n_emitted++;
          chunkState.chunkIndex++;
          chunkState.files = [];
          chunkState.rawBytes = 0;
          chunkState.contents = [];
          saveCheckpoint(buildCheckpoint({ last_event: 'turn_chunk_emitted_resume', last_zip: chunkZipName, last_terminal: ft.terminal_node }));
          if (!autoContinue) await pauseUntilContinue(`turn chunk emitted (${chunkZipName})`);
          return zipEntry;
        }

        let canonicalsWalkedThisTerminal = 0;
        let cellSafety = 0;
        const CELL_SAFETY_MAX = 80;
        let zeroWalkCount = 0;
        let zeroWalkRunStreak = 0;

        async function ensureTurnModalAtTerminal() {
          if (W.modalKind() === 'turn' && W.urlNode() === ft.terminal_node && !W.urlSuitMap()) {
            return { ok: true, path: 'already_ready' };
          }
          const r = await reopenTurnModalCheapOrFull(ft, result);
          if (!r.ok) return { ok: false, path: r.path };
          if (W.urlSuitMap()) {
            log('suitmap_persisted_forcing_full_replay', { terminal: ft.terminal_node, suitMap: W.urlSuitMap() });
            if (!await replayFromFlopRoot(ft.parent, result)) return { ok: false, path: 'replay-failed' };
            if (!await openModalByCloser(ft.via)) return { ok: false, path: 'closer-failed' };
            window.__msProgress.reopen_stats.replay++;
            return { ok: true, path: 'replay-suitmap-forced' };
          }
          window.__msProgress.reopen_stats[r.path]++;
          return r;
        }

        async function handleOneCell(targetCard, cellStatus) {
          if (window.__msQuotaExceeded || window.__msAborted) return 'break';

          if (skipList.has(targetCard)) {
            log('turn_cell_skipped_resume_skiplist', { terminal: ft.terminal_node, card: targetCard });
            return 'continue';
          }

          if (cfg.turn_card_filter && !cfg.turn_card_filter(ft.terminal_node, targetCard)) return 'continue';
          if (canonicalsWalkedThisTerminal >= turnCardLimit) return 'break';

          if (cellStatus === 'dim') { knownDim.add(targetCard); return 'continue'; }
          if (cellStatus === 'used') return 'continue';
          if (knownDim.has(targetCard)) return 'continue';
          if (knownAliases.has(targetCard)) {
            const canonical = knownAliases.get(targetCard);
            const aliasRec = {
              street: 'turn', flop_terminal: ft.terminal_node,
              requested: targetCard, canonical,
              suitMap: '(cross-terminal cache hit)',
              cross_terminal_cached: true,
            };
            result.aliases.push(aliasRec);
            turnCardAliases.push(aliasRec);
            return 'continue';
          }

          window.__msProgress.last_node = `${ft.terminal_node}/${targetCard}/turn-click`;
          log('turn_cell_click', { terminal: ft.terminal_node, card: targetCard });
          await W.dismissNoSimPopupIfAny();

          let commit;
          try {
            commit = await W.pickCardCommit(targetCard, 'turn');
          } catch (e) {
            if (/no-sim|Generate/i.test(e.message)) {
              knownDim.add(targetCard);
              await W.dismissNoSimPopupIfAny();
              log('turn_cell_dim_recovered', { card: targetCard });
              const er = await ensureTurnModalAtTerminal();
              if (!er.ok) return 'break';
              return 'continue';
            }
            result.warnings.push(`[${ft.terminal_node}/${targetCard}] commit: ${e.message}`);
            log('turn_cell_skip', { card: targetCard, reason: e.message });
            await W.dismissNoSimPopupIfAny();
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) return 'break';
            return 'continue';
          }

          if (commit.was_alias) {
            const aliasRec = {
              street: 'turn', flop_terminal: ft.terminal_node,
              requested: commit.alias_requested, canonical: commit.committed,
              suitMap: commit.suitMap_was,
            };
            result.aliases.push(aliasRec);
            turnCardAliases.push(aliasRec);
            knownAliases.set(commit.alias_requested, commit.committed);
            log('turn_alias_recorded', {
              requested: commit.alias_requested, canonical: commit.committed,
              suitMap: commit.suitMap_was,
            });
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) return 'break';
            return 'continue';
          }

          if (skipList.has(commit.committed)) {
            log('turn_cell_skipped_canonical_in_skiplist', {
              terminal: ft.terminal_node, requested: targetCard, canonical: commit.committed,
            });
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) return 'break';
            return 'continue';
          }

          const turnCardStats = { turn: [] };
          const turnCardErrors = [];
          const turnCardWarnings = [];
          const turnCardNodes = [];
          const aliasesScopedToThisCard = turnCardAliases.filter(a => a.canonical === commit.committed);
          const turnCardFiles = [];

          window.__msProgress.last_node = `${ft.terminal_node}/${commit.committed}/turn-walking`;
          const turnNodeStartIdx = result.nodes.length;
          log('walk_turn_start', { turn: commit.committed, terminal: ft.terminal_node });
          await W.dfsStreet({
            node: W.urlNode(), turn: commit.committed, river: null, suitMap: null, street: 'turn',
          }, result, {
            onNodeRecorded: async (state, node) => {
              node._segment = { kind: 'turn_card', flop_terminal: ft.terminal_node, turn_card: commit.committed };
            },
          });
          log('walk_turn_done', { turn: commit.committed });
          const turnNodes = result.nodes.slice(turnNodeStartIdx);
          turnCardNodes.push(...turnNodes);
          window.__msProgress.nodes_walked = result.nodes.length;
          canonicalsWalkedThisTerminal++;

          const turnStreetNodesThisCard = turnNodes.filter(n => n.street === 'turn').length;
          if (turnStreetNodesThisCard === 0) {
            zeroWalkCount++;
            zeroWalkRunStreak++;
            log('zero_walk_detected', {
              terminal: ft.terminal_node, card: commit.committed,
              streak: zeroWalkRunStreak, total: zeroWalkCount,
            });
            result.warnings.push(`[${ft.terminal_node}/${commit.committed}] turn DFS recorded ZERO nodes`);
            if (zeroWalkRunStreak >= 3) {
              log('zero_walk_circuit_breaker_hard_reset', { terminal: ft.terminal_node, streak: zeroWalkRunStreak });
              result.warnings.push(`[${ft.terminal_node}] hard reset triggered after ${zeroWalkRunStreak} consecutive zero walks`);
              if (!await replayFromFlopRoot(ft.parent, result) || !await openModalByCloser(ft.via)) {
                result.warnings.push(`[${ft.terminal_node}] hard reset failed — aborting terminal`);
                window.__msProgress.reopen_stats.failed++;
                return 'break';
              }
              window.__msProgress.reopen_stats.replay++;
              zeroWalkRunStreak = 0;
            }
            if (zeroWalkCount >= 6) {
              result.warnings.push(`[${ft.terminal_node}] ABORT: ${zeroWalkCount} total zero walks at this terminal`);
              log('zero_walk_terminal_abort', { terminal: ft.terminal_node, total: zeroWalkCount });
              return 'break';
            }
          } else {
            zeroWalkRunStreak = 0;
          }

          window.__msProgress.phase = 'scraping_turn_card';
          await sleep(400);
          const captures = H.enumerateCaptures(result);
          const turnCardInsidePath = `${commit.committed}`;

          const turnNodesOnly = turnCardNodes.filter(n => n.street === 'turn');
          const tSeg = await processTurnSegment(turnNodesOnly, captures, result, chipsPerBb,
            { flop_terminal: ft.terminal_node, turn_card: commit.committed, dropFlopTerminalWrapper: true });
          turnCardFiles.push(...tSeg.filesToZip);
          turnCardStats.turn = tSeg.perNodeStats;
          turnCardErrors.push(...tSeg.matchErrors);

          if (aliasesScopedToThisCard.length) {
            turnCardFiles.push({
              name: `${turnCardInsidePath}/aliases.json`,
              content: JSON.stringify(aliasesScopedToThisCard, null, 2),
            });
          }

          const tcManifest = {
            tree: result.tree, flop: result.flop, scope: 'flop+turn', chipsPerBb,
            segment_kind: 'turn_card',
            flop_terminal: ft.terminal_node,
            turn_card_canonical: commit.committed,
            turn_card_requested: targetCard,
            was_alias: commit.was_alias,
            n_turn_nodes: turnCardStats.turn.length,
            n_match_errors: turnCardErrors.length,
            match_errors: turnCardErrors,
            n_warnings: turnCardWarnings.length,
            warnings: turnCardWarnings,
            n_aliases: aliasesScopedToThisCard.length,
            per_turn_node_stats: turnCardStats.turn,
            resume: true,
            started_at: result.started_at,
            finished_at: new Date().toISOString(),
          };
          turnCardFiles.push({
            name: `${turnCardInsidePath}/turn_card_manifest.json`,
            content: JSON.stringify(tcManifest, null, 2),
          });

          const hasRealContent = turnCardStats.turn.length > 0;
          if (!hasRealContent) {
            log('turn_card_skipped_empty', {
              terminal: ft.terminal_node, card: commit.committed,
              reason: window.__msQuotaExceeded ? 'quota_exceeded' : 'no_nodes_processed',
              n_match_errors: turnCardErrors.length,
            });
            result.warnings.push(`[${ft.terminal_node}/${commit.committed}] turn card skipped (no real content; ${turnCardErrors.length} match errors)`);
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) return 'break';
            return 'walked';
          }

          let cardRawBytes = 0;
          for (const f of turnCardFiles) cardRawBytes += new Blob([f.content]).size;
          chunkState.files.push(...turnCardFiles);
          chunkState.rawBytes += cardRawBytes;
          chunkState.contents.push({
            turn_card: commit.committed,
            turn_card_requested: targetCard,
            n_turn_nodes: turnCardStats.turn.length,
            raw_bytes: cardRawBytes,
            n_files: turnCardFiles.length,
          });
          log('turn_card_buffered', {
            terminal: ft.terminal_node, card: commit.committed,
            card_raw_bytes: cardRawBytes,
            chunk_raw_bytes: chunkState.rawBytes,
            chunk_idx: chunkState.chunkIndex,
            chunk_n_cards: chunkState.contents.length,
          });

          // v15: flush on turn-card-count threshold (default 5).
          if (chunkState.contents.length >= turnCardsPerChunk) {
            await flushChunk('turn_card_count_threshold');
          }

          const er = await ensureTurnModalAtTerminal();
          if (!er.ok) {
            result.warnings.push(`[${ft.terminal_node}] reopen modal after walking ${commit.committed} failed: ${er.path}`);
            window.__msProgress.reopen_stats.failed++;
            return 'break';
          }
          return 'walked';
        }

        const visitedThisTerminal = new Set();
        outer:
        while (cellSafety++ < CELL_SAFETY_MAX) {
          if (window.__msQuotaExceeded || window.__msAborted) {
            log('quota_or_user_abort', { phase: 'cell_loop', terminal: ft.terminal_node });
            break;
          }
          if (canonicalsWalkedThisTerminal >= turnCardLimit) break;
          if (W.modalKind() !== 'turn') {
            const er = await ensureTurnModalAtTerminal();
            if (!er.ok) {
              result.warnings.push(`[${ft.terminal_node}] modal not openable: ${er.path}`);
              break outer;
            }
          }
          await W.dismissNoSimPopupIfAny();
          const cells = W.readModalCells('turn');
          let target = null;
          for (const c of cells) {
            if (visitedThisTerminal.has(c.card)) continue;
            if (c.status === 'used') continue;
            if (knownAliases.has(c.card) || knownDim.has(c.card)) {
              visitedThisTerminal.add(c.card);
              if (knownAliases.has(c.card)) {
                const canonical = knownAliases.get(c.card);
                const aliasRec = {
                  street: 'turn', flop_terminal: ft.terminal_node,
                  requested: c.card, canonical,
                  suitMap: '(cross-terminal cache hit)',
                  cross_terminal_cached: true,
                };
                result.aliases.push(aliasRec);
                turnCardAliases.push(aliasRec);
              }
              continue;
            }
            if (skipList.has(c.card)) {
              visitedThisTerminal.add(c.card);
              log('turn_cell_skipped_resume_pre', { terminal: ft.terminal_node, card: c.card });
              continue;
            }
            target = c;
            break;
          }
          if (!target) break outer;
          visitedThisTerminal.add(target.card);
          const verdict = await handleOneCell(target.card, target.status);
          if (verdict === 'break') break outer;
        }
        log('cell_loop_done', {
          terminal: ft.terminal_node,
          canonicals_walked: canonicalsWalkedThisTerminal,
          aliases_recorded: turnCardAliases.length,
          dim_known: knownDim.size,
        });

        if (chunkState.files.length > 0) {
          await flushChunk('terminal_boundary');
        }
        completedTerminals.push(ft.terminal_node);
        log('flop_terminal_done', {
          terminal: ft.terminal_node,
          chunks_emitted: chunkState.n_emitted,
        });
        saveCheckpoint(buildCheckpoint({ last_event: 'terminal_done_resume', last_terminal: ft.terminal_node }));
      }

      delete result.nodesByKeyShortcut;
      if (window.__msQuotaExceeded) {
        result.aborted_due_to_quota = true;
        result.quota_detail = window.__msQuotaExceeded;
      }
      if (window.__msAborted) {
        result.aborted_by_user = true;
      }
      result.summary.reopen_stats = window.__msProgress.reopen_stats;
      result.finished_at = new Date().toISOString();
      result.elapsed_s = Math.round((Date.now() - window.__msProgress.t_start) / 1000);
      window.__msProgress.phase = window.__msQuotaExceeded ? 'aborted_quota' : (window.__msAborted ? 'aborted_user' : 'done');
      window.__msResumeResult = result;
      saveCheckpoint(buildCheckpoint({ last_event: 'resume_finished' }));
      return result;
    } catch (e) {
      delete result.nodesByKeyShortcut;
      window.__msResumeError = { message: e.message, stack: (e.stack || '').slice(0, 1500) };
      window.__msProgress.phase = 'error';
      result.error = e.message;
      window.__msResumeResult = result;
      try { saveCheckpoint(buildCheckpoint({ last_event: 'error', error: e.message })); } catch (_) {}
      throw e;
    }
  };

  window.__scrapeResumeProbeQuota = async function() {
    const reqs = window._capturedRequests || [];
    let target = null;
    for (let i = reqs.length - 1; i >= 0; i--) {
      const r = reqs[i];
      if (r && r.url && r.url.includes('/range/url')) { target = r; break; }
    }
    if (!target) return { error: 'no /range/url captures available to probe — has a prior run executed in this tab?' };
    const auth = (target.headers && (target.headers.Authorization || target.headers.authorization)) || '';
    try {
      const r = await fetch(target.url, { headers: auth ? { Authorization: auth } : {} });
      const bodySnip = await r.text().then(s => s.slice(0, 200));
      return {
        status: r.status,
        ok: r.ok,
        body_snippet: bodySnip,
        probed_at_utc: new Date().toISOString(),
        verdict: r.ok ? 'QUOTA RESET — safe to launch __scrapeResume()'
                      : (r.status === 429 ? 'QUOTA STILL EXHAUSTED — do NOT launch __scrapeResume()'
                                          : `unexpected status ${r.status} — investigate before launching`),
      };
    } catch (e) {
      return { error: e.message };
    }
  };

  return 'resume orchestrator installed (window.__scrapeResume + window.__scrapeResumeProbeQuota) [v15 5-card chunk threshold + pause/checkpoint; 3-5s inter-node wait via walker]';
})();

/* ==================== 5) POST-RELOAD WIZARD ==================== */
/* post_reload_wizard.js - helpers for building a fresh-run cfg that mimics
 * resume semantics after a tab reload wiped __scrapeResume's prerequisites.
 *
 * Installs:
 *   window.__buildPostReloadResumeCfg(spec)
 *     Translates a high-level resumption spec into a __scrapeMultiStreet cfg.
 *     Pure function — does not touch the DOM, does not start any run.
 *   window.__describeFlopTurnCardOrder(flop)
 *     Returns the canonical DOM order of turn cards on a given flop, with
 *     board cards excluded.
 *
 * v15: behaviour identical to v10/v14; banner string bumped only.
 *      The cfg this wizard produces is compatible with v15's new
 *      `turn_cards_per_chunk` knob — pass it as `cfg.turn_cards_per_chunk`
 *      directly to __scrapeMultiStreet alongside the wizard cfg.
 */
(function installPostReloadWizard() {
  const SUITS = ['s', 'h', 'd', 'c'];
  const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

  function parseFlop(flop) {
    if (typeof flop !== 'string' || flop.length !== 6) {
      throw new Error(`parseFlop: expected 6-char flop string like 'AsAd8d', got: ${JSON.stringify(flop)}`);
    }
    return [flop.slice(0, 2), flop.slice(2, 4), flop.slice(4, 6)];
  }

  window.__describeFlopTurnCardOrder = function(flop) {
    const board = new Set(parseFlop(flop));
    const out = [];
    for (const s of SUITS) {
      for (const r of RANKS) {
        const card = r + s;
        if (!board.has(card)) out.push(card);
      }
    }
    return out;
  };

  function expandStartCardToSkipSet(flop, startCard) {
    const order = window.__describeFlopTurnCardOrder(flop);
    const idx = order.indexOf(startCard);
    if (idx === -1) {
      throw new Error(
        `start_card '${startCard}' is not a valid turn card on flop '${flop}'. ` +
        `Valid turn cards (in DOM order): ${order.join(', ')}`
      );
    }
    return order.slice(0, idx);
  }

  function expandStartTerminalToSkipSet(orderedTerminals, startTerminal) {
    const idx = orderedTerminals.indexOf(startTerminal);
    if (idx === -1) {
      throw new Error(
        `start_terminal '${startTerminal}' is not in the ordered terminal list. ` +
        `Provided terminals: ${orderedTerminals.join(', ')}`
      );
    }
    return orderedTerminals.slice(0, idx);
  }

  window.__buildPostReloadResumeCfg = function(spec) {
    if (!spec || !spec.flop) throw new Error('buildPostReloadResumeCfg: spec.flop is required');
    const trace = [];
    const warnings = [];

    const cfg = {
      scope: 'flop+turn',
      _wizard_trace: trace,
    };

    if (spec.flop_zip_already_on_disk === true) {
      cfg.skip_flop_zip = true;
      trace.push(`flop_zip_already_on_disk=true → cfg.skip_flop_zip=true (flop tree will still be walked + scraped to derive terminals)`);
    } else {
      trace.push(`flop_zip_already_on_disk!=true → flop zip will be re-emitted as '${spec.flop || ''}_flop.zip'`);
    }

    let startTerminalSkip = new Set();
    if (spec.start_terminal) {
      if (!Array.isArray(spec.ordered_terminals) || spec.ordered_terminals.length === 0) {
        throw new Error('buildPostReloadResumeCfg: start_terminal requires ordered_terminals to be supplied');
      }
      const before = expandStartTerminalToSkipSet(spec.ordered_terminals, spec.start_terminal);
      startTerminalSkip = new Set(before);
      trace.push(`start_terminal='${spec.start_terminal}' → skipping ${before.length} earlier terminals: ${before.join(', ') || '(none)'}`);
    }

    const fullyDoneSet = new Set(startTerminalSkip);
    if (spec.per_terminal) {
      for (const [term, entry] of Object.entries(spec.per_terminal)) {
        if (entry && entry.kind === 'fully_done') {
          fullyDoneSet.add(term);
          trace.push(`per_terminal['${term}'].kind='fully_done' → terminal skipped`);
        }
      }
    }

    if (fullyDoneSet.size > 0) {
      cfg.flop_terminal_filter = (function(skipSet) {
        return function(t) { return !skipSet.has(t); };
      })(fullyDoneSet);
      cfg._wizard_terminals_skipped = Array.from(fullyDoneSet);
    }

    const turnCardSkipMap = {};
    const turnCardRedoMap = {};
    const chunkIndexStartMap = {};

    if (spec.per_terminal) {
      for (const [term, entry] of Object.entries(spec.per_terminal)) {
        if (!entry || entry.kind === 'fully_done' || entry.kind === 'not_started') continue;
        if (entry.kind !== 'partial') {
          warnings.push(`per_terminal['${term}'].kind='${entry.kind}' is unrecognized — treating as not_started`);
          continue;
        }
        if (fullyDoneSet.has(term)) {
          warnings.push(`per_terminal['${term}'] marked partial but the terminal is also in the skip set (start_terminal or fully_done) — partial config ignored`);
          continue;
        }

        let skipCards = new Set();
        let redoCards = new Set();

        if (entry.start_card) {
          const before = expandStartCardToSkipSet(spec.flop, entry.start_card);
          for (const c of before) skipCards.add(c);
          trace.push(`per_terminal['${term}'].start_card='${entry.start_card}' → skipping ${before.length} cards in DOM order before it`);
        }
        if (Array.isArray(entry.skip_cards)) {
          for (const c of entry.skip_cards) skipCards.add(c);
          trace.push(`per_terminal['${term}'].skip_cards (explicit) added ${entry.skip_cards.length} cards to skip set`);
        }
        if (Array.isArray(entry.redo_cards)) {
          for (const c of entry.redo_cards) redoCards.add(c);
          trace.push(`per_terminal['${term}'].redo_cards (explicit) added ${entry.redo_cards.length} cards to redo set`);
        }
        if (entry.redo_last === true && entry.start_card) {
          const lastDone = expandStartCardToSkipSet(spec.flop, entry.start_card).slice(-1)[0];
          if (lastDone) {
            redoCards.add(lastDone);
            trace.push(`per_terminal['${term}'].redo_last=true → redoing last completed card '${lastDone}' (its prior chunk may be truncated)`);
          }
        }

        for (const c of redoCards) {
          if (skipCards.has(c)) skipCards.delete(c);
        }

        if (skipCards.size > 0) {
          turnCardSkipMap[term] = skipCards;
        }
        if (redoCards.size > 0) {
          turnCardRedoMap[term] = redoCards;
        }
        if (typeof entry.prior_chunks_emitted === 'number' && entry.prior_chunks_emitted > 0) {
          chunkIndexStartMap[term] = entry.prior_chunks_emitted + 1;
          trace.push(`per_terminal['${term}'].prior_chunks_emitted=${entry.prior_chunks_emitted} → chunk_index_start=${entry.prior_chunks_emitted + 1}`);
        } else {
          warnings.push(`per_terminal['${term}'] is partial but prior_chunks_emitted is unspecified — chunkIndex will start at 1, expect filename collisions on disk`);
        }
      }
    }

    const skipMapForClosure = {};
    for (const [t, set] of Object.entries(turnCardSkipMap)) {
      skipMapForClosure[t] = Array.from(set);
    }
    if (Object.keys(skipMapForClosure).length > 0) {
      cfg.turn_card_filter = (function(skipMap) {
        const sets = {};
        for (const [t, arr] of Object.entries(skipMap)) sets[t] = new Set(arr);
        return function(terminal, card) {
          const s = sets[terminal];
          if (!s) return true;
          return !s.has(card);
        };
      })(skipMapForClosure);
      cfg._wizard_turn_card_skip_map = skipMapForClosure;
    }
    if (Object.keys(turnCardRedoMap).length > 0) {
      cfg._wizard_turn_card_redo_map = {};
      for (const [t, set] of Object.entries(turnCardRedoMap)) {
        cfg._wizard_turn_card_redo_map[t] = Array.from(set);
      }
    }

    if (Object.keys(chunkIndexStartMap).length > 0) {
      cfg.chunk_index_start_per_terminal = chunkIndexStartMap;
    }

    return { cfg, trace, warnings };
  };

  console.log('post-reload wizard installed (window.__buildPostReloadResumeCfg, window.__describeFlopTurnCardOrder) [v15 banner-only republish]');
})();

/* ==================== 6) V17 CAPSULE EXTENSION ==================== */
/* combined_v17_extension.js -- hand-scraper-postflop-flop-turn
 *
 * ADDITIVE extension on top of the orchestrator. Installs:
 *
 *   window.__msDumpResumeCapsule(opts?)
 *     Returns a JSON string capsule containing EVERYTHING needed for a
 *     fresh tab / fresh chat / fresh Cowork session to resume this scrape
 *     exactly where it left off. v17 additions vs v16:
 *       - cached_flop_terminals  (so resume can set skip_flop_walk=true)
 *       - chunk_max_raw_bytes from checkpoint
 *
 *   window.__msApplyResumeCapsule(capsuleJsonOrObj)
 *     Restores localStorage checkpoint, pre-seeds the cross-terminal
 *     alias / dim caches, AND populates cfg.skip_flop_walk +
 *     cfg.cached_flop_terminals so the next __scrapeMultiStreet call
 *     genuinely skips the flop DFS.
 *
 *   window.__msEmitResumeFile(eventLabel, downloadDelayMs)
 *     Builds a capsule and triggers a browser download of
 *     `<tree>_<flop>_resume_<eventLabel>.json`. Called automatically
 *     by the orchestrator after every zip emit. Can also be called
 *     manually from DevTools at any time.
 *
 *     POST-v18 BUG FIX (2026-05-20): refuses to emit if the checkpoint's
 *     flop does not match the URL's flop param. This catches the case
 *     where stale state from a prior run leaks into a fresh launch's
 *     first resume.json. Throws an Error with code
 *     MS_RESUME_FILE_FLOP_MISMATCH; the orchestrator catches it and
 *     pushes a warning into result.warnings.
 *
 * Also wraps __scrapeMultiStreet (and __scrapeResume if present) to
 * capture launch cfg + URL on window.__msLaunchCfg / window.__msLaunchUrl.
 *
 * The capsule format is intentionally a single JSON object that
 * round-trips through JSON.parse without loss, so it can be relayed
 * verbatim through chat.
 */
(function installV17CapsuleExtension() {
  if (typeof window.__scrapeMultiStreet !== 'function') {
    throw new Error(
      'v17 extension requires the v17 orchestrator first. Bootstrap the ' +
      'v17 combined bundle before applying this patch (window.__scrapeMultiStreet missing).'
    );
  }
  if (window.__msV17ExtensionInstalled) {
    console.warn('[hand-scraper v17] capsule extension already installed; skipping re-install.');
    return { v17_extension_loaded: true, already: true };
  }

  const CAPSULE_VERSION = 'v1';
  const RUNTIME_MIN = 'v17';
  const CHECKPOINT_KEY = '__msCheckpoint_v15';   // key name preserved for back-compat

  // ---------------------------------------------------------------------
  // 1) Wrap __scrapeMultiStreet so cfg + URL are captured on launch.
  // ---------------------------------------------------------------------
  function serializableCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === 'function') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = {};
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === 'function') continue;
          nested[k2] = v2;
        }
        out[k] = nested;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  const __origScrape = window.__scrapeMultiStreet;
  window.__scrapeMultiStreet = function(cfg) {
    cfg = cfg || {};
    try {
      window.__msLaunchCfg = serializableCfg(cfg);
      window.__msLaunchUrl = location.href;
      window.__msLaunchAt = new Date().toISOString();
      window.__msLaunchKind = 'fresh';
    } catch (e) {}
    return __origScrape.call(this, cfg);
  };
  if (typeof window.__scrapeResume === 'function') {
    const __origResume = window.__scrapeResume;
    window.__scrapeResume = function(cfg) {
      cfg = cfg || {};
      try {
        window.__msLaunchCfg = serializableCfg(cfg);
        window.__msLaunchUrl = location.href;
        window.__msLaunchAt = new Date().toISOString();
        window.__msLaunchKind = 'resume';
      } catch (e) {}
      return __origResume.call(this, cfg);
    };
  }

  // ---------------------------------------------------------------------
  // 2) __msDumpResumeCapsule()
  // ---------------------------------------------------------------------
  window.__msDumpResumeCapsule = function(opts) {
    opts = opts || {};
    const ckpt = window.__msCheckpoint || (function() {
      try { return JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || 'null'); }
      catch (e) { return null; }
    })();
    if (!ckpt) {
      throw new Error('__msDumpResumeCapsule: no checkpoint found in window.__msCheckpoint or localStorage.');
    }
    const flop = ckpt.flop;
    const knownAliases = window.__msCanonCache &&
      window.__msCanonCache.turnAliasMap &&
      typeof window.__msCanonCache.turnAliasMap.get === 'function'
        ? window.__msCanonCache.turnAliasMap.get(flop)
        : null;
    const knownDim = window.__msCanonCache &&
      window.__msCanonCache.turnDimSet &&
      typeof window.__msCanonCache.turnDimSet.get === 'function'
        ? window.__msCanonCache.turnDimSet.get(flop)
        : null;

    // v17: cached_flop_terminals lives on window AND in checkpoint.
    // Prefer the live window value; fall back to checkpoint.
    const cachedFlopTerminals = Array.isArray(window.__msCachedFlopTerminals) && window.__msCachedFlopTerminals.length
      ? window.__msCachedFlopTerminals.slice()
      : (Array.isArray(ckpt.cached_flop_terminals) ? ckpt.cached_flop_terminals.slice() : null);

    const capsule = {
      capsule_version: CAPSULE_VERSION,
      skill_runtime_min_version: RUNTIME_MIN,
      created_at: new Date().toISOString(),
      url: window.__msLaunchUrl || location.href,
      launch_at: window.__msLaunchAt || null,
      launch_cfg: window.__msLaunchCfg || null,
      checkpoint: ckpt,
      cross_terminal_alias_map: knownAliases ? Object.fromEntries(knownAliases) : {},
      turn_dim_cards: knownDim ? Array.from(knownDim) : [],
      // v17 new field — enables skip_flop_walk on apply
      cached_flop_terminals: cachedFlopTerminals,
      summary: {
        tree: ckpt.tree,
        flop: ckpt.flop,
        chipsPerBb: ckpt.chipsPerBb,
        turn_cards_per_chunk: ckpt.turn_cards_per_chunk,
        chunk_max_raw_bytes: ckpt.chunk_max_raw_bytes,
        flop_emitted: !!ckpt.flop_emitted,
        flop_walk_skipped_on_this_run: !!ckpt.flop_walk_skipped_on_this_run,
        flop_terminals_cached: cachedFlopTerminals ? cachedFlopTerminals.map(t => t.terminal_node) : [],
        completed_terminals: (ckpt.completed_terminals || []).slice(),
        completed_cards_per_terminal: Object.fromEntries(
          Object.entries(ckpt.completed_cards_per_terminal || {}).map(([k, v]) => [k, v.slice()])
        ),
        next_chunk_index_per_terminal: Object.assign({}, ckpt.next_chunk_index_per_terminal || {}),
        // PHASE 2: surface terminal card maps (full data already in checkpoint.terminal_card_maps).
        terminal_card_maps_terminals: ckpt.terminal_card_maps ? Object.keys(ckpt.terminal_card_maps) : [],
        zips_emitted: (ckpt.zips_emitted || []).map(z => z.name),
        last_event: ckpt.extra && ckpt.extra.last_event,
        terminal_exit_reason: ckpt.extra && ckpt.extra.terminal_exit_reason,
      },
    };
    const pretty = opts.compact === true
      ? JSON.stringify(capsule)
      : JSON.stringify(capsule, null, 2);
    if (opts.silent !== true) {
      try {
        console.log('=== HAND-SCRAPER RESUME CAPSULE v1 BEGIN ===');
        console.log(pretty);
        console.log('=== HAND-SCRAPER RESUME CAPSULE v1 END ===');
      } catch (_) {}
    }
    return pretty;
  };

  // ---------------------------------------------------------------------
  // 3) __msEmitResumeFile(eventLabel, downloadDelayMs)
  //    Triggers a browser download of a JSON file named
  //    <tree>_<flop>_resume_<eventLabel>.json containing the current capsule.
  //    Called automatically by the v17 orchestrator after every zip emit.
  // ---------------------------------------------------------------------
  window.__msEmitResumeFile = async function(eventLabel, downloadDelayMs, opts) {
    eventLabel = eventLabel || 'manual';
    opts = opts || {};
    const safeLabel = String(eventLabel).replace(/[^A-Za-z0-9_-]/g, '_');
    downloadDelayMs = (typeof downloadDelayMs === 'number') ? downloadDelayMs : 250;

    const capsuleObj = JSON.parse(window.__msDumpResumeCapsule({ silent: true }));
    const tree = (capsuleObj.checkpoint && capsuleObj.checkpoint.tree) || 'UNKNOWN_TREE';
    const flop = (capsuleObj.checkpoint && capsuleObj.checkpoint.flop) || 'UNKNOWN_FLOP';

    // POST-v18 BUG FIX (flop-mismatch guard): if the in-memory checkpoint's
    //   flop disagrees with the URL's flop, the capsule is carrying stale
    //   state from a prior run and must NOT be written to disk. This is a
    //   belt-and-suspenders check on top of the orchestrator's fresh-launch
    //   state clear; refuse to emit and surface a loud warning instead.
    let urlFlop = null;
    try { urlFlop = new URL(location.href).searchParams.get('flop'); } catch (_) {}
    if (urlFlop && flop && urlFlop !== flop) {
      const msg = `[hand-scraper] __msEmitResumeFile REFUSED: checkpoint.flop=${flop} but URL flop=${urlFlop} (stale checkpoint from a prior run). No resume.json emitted for event '${eventLabel}'.`;
      try { console.warn(msg); } catch (_) {}
      const err = new Error(msg);
      err.code = 'MS_RESUME_FILE_FLOP_MISMATCH';
      throw err;
    }

    // PHASE 1: per-card naming when opts identifies a single (terminal, card)
    //   in zip_per_card mode. JSON payload also gets device + session_id +
    //   session_meta so downstream tooling can attribute the capsule without
    //   re-parsing the filename.
    let fileName;
    if (opts.zip_per_card && opts.terminal && opts.card) {
      const safeTerm = String(opts.terminal).replace(/[^A-Za-z0-9_-]/g, '_');
      const safeCard = String(opts.card).replace(/[^A-Za-z0-9_-]/g, '_');
      const safeDev  = String(opts.device || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
      fileName = `${tree}_${flop}_${safeTerm}_${safeCard}_${safeDev}_resume.json`;
      capsuleObj.device = opts.device || null;
      capsuleObj.session_id = opts.session_id || null;
      capsuleObj.session_emitted_at = new Date().toISOString();
      capsuleObj.session_meta = {
        terminal: opts.terminal,
        card: opts.card,
        device: opts.device || null,
        session_id: opts.session_id || null,
      };
    } else {
      fileName = `${tree}_${flop}_resume_${safeLabel}.json`;
    }
    const capsuleStr = JSON.stringify(capsuleObj, null, 2);

    try {
      const blob = new Blob([capsuleStr], { type: 'application/json' });
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(dlUrl); }, 1000);
    } catch (e) {
      console.warn('[hand-scraper v17] __msEmitResumeFile: download failed:', e && e.message);
      throw e;
    }

    // Track the emitted resume files on a registry, like __msAllZips.
    if (!Array.isArray(window.__msAllResumeFiles)) window.__msAllResumeFiles = [];
    window.__msAllResumeFiles.push({
      name: fileName,
      bytes: capsuleStr.length,
      event: eventLabel,
      t: Date.now(),
    });

    if (downloadDelayMs > 0) {
      await new Promise(r => setTimeout(r, downloadDelayMs));
    }
    return { name: fileName, bytes: capsuleStr.length };
  };

  // ---------------------------------------------------------------------
  // 4) __msApplyResumeCapsule(capsuleJsonOrObj)
  // ---------------------------------------------------------------------
  window.__msApplyResumeCapsule = function(capsule) {
    if (typeof window.__buildPostReloadResumeCfg !== 'function') {
      throw new Error('__msApplyResumeCapsule: requires post-reload wizard. Bootstrap the v17 bundle first.');
    }
    if (typeof capsule === 'string') {
      let s = capsule;
      const beginMark = '=== HAND-SCRAPER RESUME CAPSULE v1 BEGIN ===';
      const endMark   = '=== HAND-SCRAPER RESUME CAPSULE v1 END ===';
      const b = s.indexOf(beginMark);
      if (b !== -1) s = s.slice(b + beginMark.length);
      const e = s.indexOf(endMark);
      if (e !== -1) s = s.slice(0, e);
      s = s.trim();
      if (!s.startsWith('{')) {
        const braceIdx = s.indexOf('{');
        if (braceIdx !== -1) s = s.slice(braceIdx);
      }
      try { capsule = JSON.parse(s); }
      catch (err) {
        throw new Error('Capsule JSON parse failed: ' + err.message);
      }
    }
    if (!capsule || typeof capsule !== 'object' || !capsule.capsule_version) {
      throw new Error('__msApplyResumeCapsule: input does not look like a v1 capsule (missing capsule_version).');
    }
    const ckpt = capsule.checkpoint;
    if (!ckpt || !ckpt.flop || !ckpt.tree) {
      throw new Error('__msApplyResumeCapsule: capsule.checkpoint missing required tree/flop fields.');
    }

    // 1) Restore localStorage checkpoint
    try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(ckpt)); }
    catch (e) { console.warn('[hand-scraper v17] could not write checkpoint to localStorage:', e && e.message); }
    window.__msCheckpoint = ckpt;

    // 2) Seed cross-terminal alias + dim caches for this flop
    if (!window.__msCanonCache) window.__msCanonCache = { turn: new Map(), river: new Map() };
    if (!window.__msCanonCache.turnAliasMap) window.__msCanonCache.turnAliasMap = new Map();
    if (!window.__msCanonCache.turnDimSet)   window.__msCanonCache.turnDimSet   = new Map();
    window.__msCanonCache.turnAliasMap.set(
      ckpt.flop,
      new Map(Object.entries(capsule.cross_terminal_alias_map || {}))
    );
    window.__msCanonCache.turnDimSet.set(
      ckpt.flop,
      new Set(capsule.turn_dim_cards || [])
    );

    // 3) Pre-seed window.__msCachedFlopTerminals so the orchestrator can use it
    //    even if the caller doesn't pass it through cfg explicitly.
    const cachedFlopTerminals = Array.isArray(capsule.cached_flop_terminals) && capsule.cached_flop_terminals.length
      ? capsule.cached_flop_terminals.slice()
      : (Array.isArray(ckpt.cached_flop_terminals) ? ckpt.cached_flop_terminals.slice() : null);
    if (cachedFlopTerminals) window.__msCachedFlopTerminals = cachedFlopTerminals;

    // 4) Build the wizard spec from checkpoint state
    const spec = {
      flop: ckpt.flop,
      flop_zip_already_on_disk: !!ckpt.flop_emitted,
      per_terminal: {},
    };
    for (const term of (ckpt.completed_terminals || [])) {
      spec.per_terminal[term] = { kind: 'fully_done' };
    }
    for (const [term, doneCards] of Object.entries(ckpt.completed_cards_per_terminal || {})) {
      if (spec.per_terminal[term]) continue;
      if (!Array.isArray(doneCards) || doneCards.length === 0) continue;
      const nextChunk = (ckpt.next_chunk_index_per_terminal || {})[term] || 1;
      spec.per_terminal[term] = {
        kind: 'partial',
        skip_cards: doneCards.slice(),
        prior_chunks_emitted: Math.max(0, nextChunk - 1),
      };
    }

    // 5) Call the wizard
    const wiz = window.__buildPostReloadResumeCfg(spec);

    // 6) v17: enable skip_flop_walk if we have cached terminals
    if (cachedFlopTerminals) {
      wiz.cfg.skip_flop_walk = true;
      wiz.cfg.cached_flop_terminals = cachedFlopTerminals;
      wiz.trace.push(`v17: cfg.skip_flop_walk=true with ${cachedFlopTerminals.length} cached terminals — flop DFS will be bypassed entirely`);
    } else {
      wiz.trace.push('v17: no cached_flop_terminals in capsule → flop walk will run again (~30s + ~8 quota calls)');
    }

    // 7) Merge runtime knobs from the launch cfg
    const lcfg = capsule.launch_cfg || {};
    if (typeof lcfg.chipsPerBb === 'number')           wiz.cfg.chipsPerBb           = lcfg.chipsPerBb;
    if (typeof lcfg.turn_cards_per_chunk === 'number') wiz.cfg.turn_cards_per_chunk = lcfg.turn_cards_per_chunk;
    if (typeof lcfg.chunk_max_raw_bytes === 'number')  wiz.cfg.chunk_max_raw_bytes  = lcfg.chunk_max_raw_bytes;
    if (typeof lcfg.node_wait_min_ms === 'number')     wiz.cfg.node_wait_min_ms     = lcfg.node_wait_min_ms;
    if (typeof lcfg.node_wait_max_ms === 'number')     wiz.cfg.node_wait_max_ms     = lcfg.node_wait_max_ms;
    if (typeof lcfg.auto_continue === 'boolean')       wiz.cfg.auto_continue        = lcfg.auto_continue;
    if (typeof lcfg.download_delay_ms === 'number')    wiz.cfg.download_delay_ms    = lcfg.download_delay_ms;
    if (typeof lcfg.emit_resume_file === 'boolean')    wiz.cfg.emit_resume_file     = lcfg.emit_resume_file;

    return {
      cfg: wiz.cfg,
      trace: wiz.trace,
      warnings: wiz.warnings,
      expected_url: capsule.url,
      current_url: location.href,
      url_matches: (location.href.indexOf(ckpt.flop) !== -1 && location.href.indexOf(ckpt.tree) !== -1),
      flop_walk_will_skip: !!wiz.cfg.skip_flop_walk,
      spec_used: spec,
      summary_from_capsule: capsule.summary || null,
    };
  };

  window.__msV17ExtensionInstalled = true;
  window.__msResumeFileFlopGuardInstalled = true;
  window.__msPhase1ResumeFileOptsInstalled = true;
  window.__msPhase2CapsuleSummaryInstalled = true;
  try {
    console.log('[hand-scraper v17] capsule extension installed (__msDumpResumeCapsule, __msApplyResumeCapsule, __msEmitResumeFile + post-v18 flop-mismatch guard). Pauses still come from v15; Claude must NEVER auto-continue them.');
  } catch (_) {}
  return { v17_extension_loaded: true };
})();

