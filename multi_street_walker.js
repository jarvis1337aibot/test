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
  async function interNodeWait() {
    const ms = _nodeWaitMs();
    if (ms > 0) {
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
  };
  window.__msV18WalkerInstalled = true;
  return 'multi-street walker installed (window.__W) [v18 all-in no-descend + back-out chain collapse; v15 random 3-5s inter-node wait; v13 plomm envelope support; v11 dynamic bet sizings + 1/5 pot static]';
})();
