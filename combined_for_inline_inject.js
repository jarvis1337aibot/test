/* combined_for_inline_inject.js — hand-scraper-postflop-flop-turn v15
 *
 * Concatenation of:
 *   1. multi_street_walker.js   (window.__W)
 *   2. scrape_helpers.js        (window.__msHelpers)
 *   3. scrape_multistreet.js    (window.__scrapeMultiStreet)
 *   4. scrape_resume.js         (window.__scrapeResume + probe)
 *   5. post_reload_wizard.js    (window.__buildPostReloadResumeCfg)
 *
 * Bootstrap from a fresh trainer tab:
 *   await fetch('https://cdn.jsdelivr.net/gh/<USER>/<REPO>@v15/combined_for_inline_inject.js')
 *     .then(r => r.text()).then(src => (0, eval)(src));
 *
 * v15 highlights:
 *   - Random 3-5s wait between every walked node (DFS).
 *   - Turn-chunk zip emitted every 5 walked turn cards (configurable).
 *   - After every emitted zip the orchestrator pauses + checkpoints to
 *     localStorage; user calls window.__msContinue() to resume.
 */

/* multi_street_walker.js - DOM-only walker for the PLO Master Mind postflop trainer.
 *
 * Installs window.__W with primitives for DFS, modal handling, alias-aware card
 * picks (with post-click no-sim recovery), and back-navigation.
 *
 * NEVER reloads the page. All state changes via DOM clicks only.
 *
 * Install order: this FIRST, then scrape_helpers.js, then scrape_multistreet.js.
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
  // v11: ACTION_CODE is the *static* forward map. Unknown N/M pot labels
  // are resolved dynamically by codeForLabel() below.
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

  // v15: inter-node random wait. Use window globals so the orchestrator can
  // configure them without re-installing the walker.
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
  async function interNodeWait() {
    const ms = _nodeWaitMs();
    if (ms > 0) {
      // record diagnostic so progress can show wait totals
      window.__msNodeWaitStats = window.__msNodeWaitStats || { count: 0, total_ms: 0, last_ms: 0 };
      window.__msNodeWaitStats.count++;
      window.__msNodeWaitStats.total_ms += ms;
      window.__msNodeWaitStats.last_ms = ms;
      await sleep(ms);
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

  async function dfsStreet(state, walkResult, opts = {}) {
    // v15: random 3-5s inter-node wait at the start of every node visit.
    // This gives the trainer / DOM time to settle between successive
    // walks and reduces the chance of click races. Configurable via
    // window.__msNodeWaitMin / window.__msNodeWaitMax. Set both to 0 to disable.
    await interNodeWait();
    // Auto-init streetEntryNode on first call into a street.
    if (state.streetEntryNode === undefined) state.streetEntryNode = state.node || '';
    await sleep(80);
    let active = await waitForActionPanelStable(4000, 500);
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
      let pick = null;
      for (const a of abIter.actions) {
        if (a.disabled) continue;
        if (a.label === 'Fold') continue;
        if (isStreetCloser(a.label, state)) continue;
        if (walkedLabels.has(a.label)) continue;
        const code = codeForLabel(a.label);
        if (!code) { walkResult.warnings.push(`unknown label "${a.label}" at ${state.node || '(root)'} (not Check/Call/Fold/Allin and not a recognizable N/M pot label)`); walkedLabels.add(a.label); continue; }
        pick = { label: a.label, code, el: a.el };
        break;
      }
      if (!pick) break;

      walkedLabels.add(pick.label);
      const childPath = state.node ? `${state.node}-${pick.code}` : pick.code;

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

      await dfsStreet({ ...state, node: childPath }, walkResult, opts);

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
    interNodeWait,  // v15: exposed for diagnostics / external tests
  };
  return 'multi-street walker installed (window.__W) [v15 random 3-5s inter-node wait; v13 plomm envelope support; v11 dynamic bet sizings + 1/5 pot static]';
})();


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


/* scrape_multistreet.js - flop+turn tree scraper for the PLO Master Mind
 * postflop trainer. Walks (flop -> every canonical turn under every flop
 * terminal), captures /range/url envelopes, decodes binary/plomm blobs,
 * and emits ONE flop zip plus one turn-chunk zip per N turn cards walked
 * (default N=5).
 *
 * Requires window.__W (walker) and window.__msHelpers to be installed first.
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
    const turnCardsPerChunk = (typeof cfg.turn_cards_per_chunk === 'number' && cfg.turn_cards_per_chunk > 0) ? cfg.turn_cards_per_chunk : 5;
    // v15: auto-continue defaults to false → orchestrator pauses after each zip.
    const autoContinue = cfg.auto_continue === true;

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
        tree: result.tree, flop: result.flop,
        started_at: result.started_at,
        flop_emitted: !!result.flop_zip_emitted_at,
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
      window._capturedRequests = [];
      H.installInterceptors();
      window.__msProgress.phase = 'walking';

      log('phase', { name: 'walk_flop' });
      await ensureFlopRoot();
      const flopNodeStartIdx = result.nodes.length;
      await W.dfsStreet({ node: '', turn: null, river: null, street: 'flop' }, result, {
        onNodeRecorded: async (state, node) => { node._segment = { kind: 'flop' }; },
      });
      await ensureFlopRoot();
      const flopNodes = result.nodes.slice(flopNodeStartIdx);
      result.summary.flop_nodes = flopNodes.length;
      window.__msProgress.nodes_walked = result.nodes.length;
      log('walk_flop_done', { n: flopNodes.length });

      await sleep(500);
      let captures = H.enumerateCaptures(result);
      log('captures_enumerated', { phase: 'flop', n_captures: captures.size });

      result.nodesByKeyShortcut = new Map();
      for (const n of result.nodes) result.nodesByKeyShortcut.set(n.key, n);

      if (!dryRun) {
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
          let preTerminals = identifyTerminals(flopNodes, 'flop');
          if (cfg.flop_terminal_filter) preTerminals = preTerminals.filter(t => cfg.flop_terminal_filter(t.terminal_node));
          flopManifest.pre_created_terminal_folders = preTerminals.map(t => t.terminal_node);
          flopSeg.filesToZip[flopSeg.filesToZip.length - 1].content = JSON.stringify(flopManifest, null, 2);
          for (const t of preTerminals) {
            flopSeg.filesToZip.push({ name: `${flop}/${t.terminal_node}/.keep`, content: '' });
          }
          log('pre_created_terminal_folders', { n: preTerminals.length, list: preTerminals.map(t => t.terminal_node) });
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
          // v15: checkpoint + pause after flop zip.
          saveCheckpoint(buildCheckpoint({ last_event: 'flop_zip_emitted', last_zip: flopZipName }));
          if (!autoContinue) await pauseUntilContinue(`flop zip emitted (${flopZipName})`);
        }
      }

      if (scope === 'flop') {
        delete result.nodesByKeyShortcut;
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
        result.finished_at = new Date().toISOString();
        result.elapsed_s = Math.round((Date.now() - window.__msProgress.t_start) / 1000);
        window.__msProgress.phase = window.__msQuotaExceeded ? 'aborted_quota' : 'aborted_user';
        window.__msResult = result;
        return result;
      }

      let flopTerminals = identifyTerminals(flopNodes, 'flop');
      if (cfg.flop_terminal_filter) flopTerminals = flopTerminals.filter(t => cfg.flop_terminal_filter(t.terminal_node));
      result.summary.flop_terminals = flopTerminals.length;
      log('flop_terminals_identified', { n: flopTerminals.length, list: flopTerminals.map(t => t.terminal_node) });

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
          const chunkZipName = `${result.tree}_${result.flop}_${ft.terminal_node}_turn_chunk${idxStr}.zip`;
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
            if (chunkState.contents.length >= turnCardsPerChunk) {
              await flushChunk('turn_card_count_threshold');
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
            target = c;
            break;
          }
          if (!target) {
            break outer;
          }
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
        // v15: refresh checkpoint at terminal boundary (no extra pause —
        // pause already fired when the boundary chunk was emitted, OR there
        // was nothing to emit and we just mark the terminal done.)
        saveCheckpoint(buildCheckpoint({ last_event: 'terminal_done', last_terminal: ft.terminal_node }));
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

  return 'multi-street scraper installed (window.__scrapeMultiStreet) [v15 random 3-5s inter-node wait; 5-card chunk threshold; pause+checkpoint after every zip; v13 plomm envelope support; v11 dynamic bet sizings; v10 post-reload-resume options: skip_flop_zip + chunk_index_start_per_terminal]';
})();


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
