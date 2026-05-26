/* multi_street_walker.js - DOM-only walker for the PLO Master Mind postflop trainer.
 *
 * Installs window.__W with primitives for DFS, modal handling, alias-aware card
 * picks (with post-click no-sim recovery), and back-navigation.
 *
 * NEVER reloads the page. All state changes via DOM clicks only.
 *
 * Install order: this FIRST, then scrape_helpers.js, then scrape_multistreet.js.
 *
 * v9.18 changes (walker): reopenChipModal snapshots __msFirstTurnBlockIndex;
 *   clickActionAndWait tracks __msLastActionClicked. Both used by v9.18 Phase B+C
 *   in scrape_multistreet.js for All-in collapse handling.
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
    const minDef = 2000, maxDef = 4000;
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
    // POST-TIER-8 FIX (2026-05-24): ALWAYS click the Categories tab when
    //   this is called -- don't trust the cached "already activated" flag
    //   or the panel-locator pre-check. Empirically the panel can appear
    //   locatable while still being dim/empty; the click is idempotent
    //   when the tab is genuinely already active, and necessary when it's
    //   not. Wait long enough for the panel to render before returning.
    try {
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
      try {
        clickable.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await sleep(150 + Math.floor(Math.random() * 250));
        clickable.click();
        // Also dispatch a synthetic MouseEvent click for picky frameworks
        clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch (_) {}
      // Wait for the panel to render. Up to ~3s in 200ms steps.
      let panel = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        await sleep(200);
        panel = _msFindCategoriesPanel();
        if (panel) break;
      }
      window.__msCategoriesTabActivated = !!panel;
      return !!panel;
    } catch (e) {
      return false;
    }
  }

  // POST-TIER-8 (2026-05-24): partialWalkOnTerminal -- REAL partial walk
  //   between cards on the same terminal. Picks a random ok-status turn
  //   cell (excluding opts.excludeCards which are still-to-walk assigned
  //   cards), commits it, walks 1-3 real action blocks forward (with a
  //   category burst between each), then waits 10-20s. After this returns
  //   the trainer is in an arbitrary state inside the partial card's
  //   subtree; the orchestrator's ensureTurnModalAtTerminal() handles
  //   navigating back to the terminal modal for the next real card.
  //
  //   Quota cost per partial walk: 1 (card commit) + 1-3 (action clicks)
  //   = 2-4 /range/url calls. Categories clicks are free.
  //
  //   Old `pretendPartialBrowse` (hover-only) is kept as a thin alias for
  //   back-compat with any caller that hasn't migrated.
  async function partialWalkOnTerminal(currentTerminal, opts) {
    // POST-TIER-9 FIX v9.3 (2026-05-24): fires BEFORE every target card walk.
    //   - Walks 1-2 real action blocks forward (was 1-3).
    //   - EDGE CASE: if all remaining non-fold non-allin actions are
    //     street-closers (Call/Check that end the street), stop the action
    //     walk early -- the line is over, no more advances inside this street.
    //   - Always finishes with a category click + 10-20s settle wait.
    //   Quota: 1 card commit + 1-2 actions = 2-3 /range/url calls per partial walk.
    opts = opts || {};
    try {
      if (modalKind() !== 'turn') return 0;
      const cells = readModalCells('turn');
      if (!cells.length) return 0;
      const exclude = new Set(opts.excludeCards || []);
      const pool = cells.filter(c => c.status === 'ok' && !exclude.has(c.card));
      if (!pool.length) return 0;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      try {
        pick.el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        pick.el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      } catch (_) {}
      await sleep(1000 + Math.floor(Math.random() * 1000));
      // POST-TIER-9 FIX v9.6 (2026-05-24): use pickCardCommit instead of
      //   clickCardAndWait so suitmap aliases are auto-recovered. If pick.card
      //   is a suitmap alias, pickCardCommit:
      //     1. Clicks the suitmap cell (URL gets ?suitMap=X, turn=<canonical>)
      //     2. Detects the alias jump
      //     3. Calls reopenChipModal('turn') -- the "get rid of suitmap" protocol
      //     4. Re-clicks the actual canonical from the freshly-opened modal
      //     5. Returns { was_alias: true, alias_requested: pick.card,
      //                  committed: <canonical>, suitMap_was: <sm> }
      //   The partial walk then proceeds from the canonical's subtree --
      //   "partial walks the suit map counterpart per the partial walk protocol".
      let partialCommit;
      try {
        partialCommit = await pickCardCommit(pick.card, 'turn');
      } catch (e) {
        try { await dismissNoSimPopupIfAny(); } catch (_) {}
        return 0;
      }
      const partialAliasRecovered = !!(partialCommit && partialCommit.was_alias);
      const partialCardWalked = partialCommit ? partialCommit.committed : pick.card;
      if (partialAliasRecovered) {
        window.__msPartialWalkAliasRecoveries =
          (window.__msPartialWalkAliasRecoveries || 0) + 1;
      }
      await sleep(2000 + Math.floor(Math.random() * 2000));
      // Walk 1-2 real action blocks forward (with end-of-line edge case)
      const nActions = 1 + Math.floor(Math.random() * 2); // 1-2
      let actionsWalked = 0;
      const fakeTurnState = { street: 'turn' };
      let endOfLine = false;
      for (let i = 0; i < nActions; i++) {
        const ab = await waitForActionPanelStable(4000, 500);
        if (!ab || ab.actions.length === 0) break;
        // Candidates: not disabled, not Fold/All-in, AND NOT street-closers
        //   Excluding closers keeps the partial walk inside the turn street.
        const candidates = ab.actions.filter(a =>
          !a.disabled &&
          a.label !== 'Fold' &&
          a.label !== 'All-in' &&
          !isStreetCloser(a.label, fakeTurnState)
        );
        if (!candidates.length) {
          // End of line -- no more intra-street advances. Stop walking.
          endOfLine = true;
          break;
        }
        const action = candidates[Math.floor(Math.random() * candidates.length)];
        try {
          await clickActionAndWait(action.el, null, 4000);
          actionsWalked++;
          await sleep(2000 + Math.floor(Math.random() * 2000));
        } catch (_) { break; }
        if (i < nActions - 1) {
          try { await humanCategoryExploration(1); } catch (_) {}
        }
      }
      // ALWAYS finish with categories + settle, even after end-of-line break.
      try { await humanCategoryExploration(1); } catch (_) {}
      await sleep(10000 + Math.floor(Math.random() * 10000));
      window.__msHumanStats = window.__msHumanStats || { node_hovers: 0, category_bursts: 0, turn_hovers: 0, partial_browses: 0, partial_walks: 0 };
      window.__msHumanStats.partial_walks = (window.__msHumanStats.partial_walks || 0) + 1;
      // v9.6: record the CANONICAL we actually walked (post-alias recovery).
      // The suitmap card itself is exposed as __msLastPartialWalkRequested for
      // debugging; aliases get a dedicated flag + count.
      window.__msLastPartialWalkCard = partialCardWalked;
      window.__msLastPartialWalkRequested = pick.card;
      window.__msLastPartialWalkWasAlias = partialAliasRecovered;
      window.__msLastPartialWalkTerminal = currentTerminal;
      window.__msLastPartialWalkActions = actionsWalked;
      window.__msLastPartialWalkEndOfLine = endOfLine;
      return 1;
    } catch (e) {
      return 0;
    }
  }

  // Back-compat alias: pretendPartialBrowse now delegates to partialWalkOnTerminal.
  async function pretendPartialBrowse(currentTerminal, opts) {
    return partialWalkOnTerminal(currentTerminal, opts || {});
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
    // POST-TIER-9 FIX A (2026-05-24): retry chip search 4x with 500ms gaps
    //   to tolerate DOM lag after deep walks + back-out collapse. Also
    //   extend modal-open wait from 3s -> 5s for slow VPN renders.
    const re = kind === 'turn' ? /^[Tt]urn[2-9TJQKA]/ : /^[Rr]iver[2-9TJQKA]/;
    let chip = null;
    for (let attempt = 0; attempt < 4 && !chip; attempt++) {
      chip = $$('div').find(d => {
        const cls = d.className?.toString() || '';
        if (!/cursor-pointer/.test(cls) || !/rounded-md/.test(cls)) return false;
        return re.test((d.textContent || '').replace(/\s+/g, ''));
      });
      if (!chip && attempt < 3) await sleep(500);
    }
    if (!chip) throw new Error(`no ${kind} chip`);
    chip.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && modalKind() !== kind) await sleep(100);
    await sleep(200);
    // v9.18 Phase B: snapshot first-turn-block index when the turn modal opens.
    //   Modal is open over the action panel; visible blocks behind it are
    //   flop-level only (any prior turn segment was collapsed by trainer to
    //   show the modal). readBlocks().length is therefore the index where
    //   the first turn-level block will appear once the modal closes after
    //   a card is picked. Used by stabilizeBackToTerminal for index-based
    //   back-nav (replaces "last chosen highlight" heuristic on success path).
    if (kind === 'turn' && modalKind() === 'turn') {
      try {
        window.__msFirstTurnBlockIndex = readBlocks().length;
      } catch (_) { /* defensive */ }
    }
  }

  async function clickActionAndWait(actionEl, expectedNode = null, timeoutMs = 4000) {
    // v9.18 Phase C: track last action clicked so reopenTurnModalCheapOrFull
    // can detect All-in collapses post-walk.
    try {
      const label = (actionEl?.textContent || '').trim();
      const code = codeForLabel(label);
      window.__msLastActionClicked = { label, code, t: Date.now() };
    } catch (_) { /* defensive */ }
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

    // POST-TIER-7 (2026-05-23): INLINE TURN-MODAL CAPTURE during flop DFS.
    //   When this node has any enabled closes_street child (Call after raise,
    //   second Check, etc.), click it -> wait for the turn modal -> read
    //   cells -> save to walkResult.terminal_card_maps[terminal_node] ->
    //   close modal -> back-out to this node. Replaces the orchestrator's
    //   separate post-walk modal-capture pass.
    if (state.street === 'flop') {
      for (const child of childrenSpec) {
        if (!child.closes_street || child.disabled) continue;
        const terminalNode = state.node ? `${state.node}-${child.code}` : child.code;
        // Re-read the active panel to get a fresh element handle for the closer
        const abClose = await waitForActionPanelStable(4000, 500);
        if (!abClose || abClose.actions.length === 0) {
          walkResult.warnings.push(`inline modal capture: no active at ${state.node} for closer ${child.label}`);
          continue;
        }
        const closerEl = abClose.actions.find(a => a.label === child.label && !a.disabled)?.el;
        if (!closerEl) {
          walkResult.warnings.push(`inline modal capture: closer "${child.label}" not found at ${state.node}`);
          continue;
        }
        const r = await clickActionAndWait(closerEl, terminalNode);
        if (!r.success || urlNode() !== terminalNode) {
          walkResult.warnings.push(`inline modal capture: click "${child.label}" failed at ${state.node} (got "${r.after}" expected "${terminalNode}")`);
          // Try to recover URL
          try {
            const blocksRecover = readBlocks();
            const myBlockRecover = blocksRecover[myIndex];
            if (myBlockRecover && myBlockRecover.headerEl && urlNode() !== state.node) {
              await clickHeaderAndWait(myBlockRecover.headerEl, state.node);
            }
          } catch (_) {}
          continue;
        }
        // Wait for the turn modal to render
        let t0 = Date.now();
        while (Date.now() - t0 < 4000 && modalKind() !== 'turn') await sleep(120);
        if (modalKind() === 'turn') {
          const cells = readModalCells('turn');
          const available = cells.filter(c => c.status === 'ok').map(c => c.card);
          const used = cells.filter(c => c.status === 'used').map(c => c.card);
          const dim_dom = cells.filter(c => c.status === 'dim').map(c => c.card);
          walkResult.terminal_card_maps = walkResult.terminal_card_maps || {};
          walkResult.terminal_card_maps[terminalNode] = {
            recorded_at: new Date().toISOString(),
            total_cells: cells.length,
            available, used, dim_dom,
            aliases: [],
            terminal: terminalNode,
            source: 'inline_dfs_capture',
          };
          try { await closeModalX(); } catch (_) {}
          await sleep(150);
        } else {
          walkResult.warnings.push(`inline modal capture: turn modal did not open at ${terminalNode}`);
        }
        // Back-out to state.node by clicking my header
        const blocksAfterClose = readBlocks();
        const myBlockAfterClose = blocksAfterClose[myIndex];
        if (myBlockAfterClose && myBlockAfterClose.headerEl) {
          const hbr = await clickHeaderAndWait(myBlockAfterClose.headerEl, state.node);
          if (!hbr.success || urlNode() !== state.node) {
            walkResult.warnings.push(`inline modal capture: back-out wrong: exp="${state.node}" got="${urlNode()}"`);
            return;
          }
        }
      }
    }

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
      if (r.success) { await sleep(2000 + Math.floor(Math.random() * 2000)); }
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
    await sleep(2000 + Math.floor(Math.random() * 2000));
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
    // TIER 2 + POST-TIER-8
    activateCategoriesTab, pretendPartialBrowse, partialWalkOnTerminal,
  };
  window.__msV18WalkerInstalled = true;
  window.__msPhase4HumanLikeInstalled = true;
  window.__msPhase7SafetyInstalled = true;
  window.__msInlineModalCaptureInstalled = true; // 2026-05-23 v7: inline turn-modal capture in flop DFS
  window.__msPostTier8WalkerInstalled = true; // 2026-05-24 v8: always-click Categories tab + real partial walk
  window.__msTier2NoiseInstalled = true;
  return 'multi-street walker installed (window.__W) [v9.18 All-in collapse: firstTurnBlockIndex snapshot in reopenChipModal + lastActionClicked tracking in clickActionAndWait; tier 2 noise: categories-tab activate + partial-browse; phase 7 safety detect + emergency stop emit; phase 4 human-like noise (long pauses + hover bursts + category exploration); v18 all-in no-descend + back-out chain collapse; v15 random 3-5s inter-node wait; v13 plomm envelope support; v11 dynamic bet sizings + 1/5 pot static]';
})();
