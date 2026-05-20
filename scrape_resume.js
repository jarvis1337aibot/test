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
