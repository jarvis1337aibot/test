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
    if (W.modalKind()) { await sleep(2000 + Math.floor(Math.random() * 2000)); }
    return !!W.modalKind();
  }

  async function stabilizeBackToTerminal(ftTerminalNode) {
    // POST-TIER-9 FIX v9.4 (2026-05-24): per-click wait 700ms -> 2000ms,
    //   and if the URL doesn't change after a click, retry ONCE before
    //   bailing. Tolerates slow VPN + React render lag during navigation.
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
      await sleep(2000);
      // If URL didn't change, give it ONE more chance (re-read blocks +
      //   click again — the headerEl might be stale after a partial re-render).
      if (W.urlNode() === before) {
        const blocks2 = W.readBlocks();
        let target2 = null;
        for (const b of blocks2) { if (b.actions.some(a => a.chosen)) target2 = b; }
        if (target2 && target2.headerEl) {
          target2.headerEl.click();
          await sleep(2000);
        }
        if (W.urlNode() === before) return false; // truly stuck
      }
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
          // POST-TIER-5 (2026-05-23): skip resume_after_flop_zip.json when in
          //   producer mode -- the workload JSONs carry the resume info.
          const _producerMode = (cfg.skip_workload_emission !== true) && (cfg.scope === 'flop+turn');
          if (!_producerMode && emitResumeFile && typeof window.__msEmitResumeFile === 'function') {
            try {
              await window.__msEmitResumeFile('after_flop_zip', downloadDelayMs);
            } catch (e) {
              result.warnings.push(`emit_resume_file (after_flop_zip) failed: ${e.message}`);
            }
          }

          // POST-TIER-5 (2026-05-23): EMIT N WORKLOAD JSONS WITH 100% COVERAGE.
          //   For each terminal, shuffle the walkable cards and distribute
          //   round-robin across N workloads so every card lands in exactly
          //   one workload (no gaps, no overlap). With N=4 each workload
          //   gets ~25% of cards (inside the 5-40% target window).
          //   Schema is SLIM: only fields needed for resume/identification.
          const wantsWorkloads = (cfg.skip_workload_emission !== true) && (cfg.scope === 'flop+turn');
          if (wantsWorkloads) {
            const N = Math.max(1, Math.min(20, cfg.workload_partitions || 4));
            const terms = (window.__msCachedFlopTerminals || []).slice();
            const tcm = result.terminal_card_maps || {};
            function shuffle(arr) {
              const a = arr.slice();
              for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
              }
              return a;
            }
            // Producer's trainer URL (workers navigate here before bootstrapping the workload)
            const producerUrl = location.origin + location.pathname + '?type=postflop&tree=' + encodeURIComponent(result.tree) + '&flop=' + encodeURIComponent(result.flop);
            // POST-TIER-6 (2026-05-23): CONSTRAINED RANDOM PARTITION.
            //   For each terminal, generate N random percentages each in
            //   [5%, 40%] summing to 100%, convert to integer card counts
            //   that sum to walkable.length exactly, shuffle walkable, then
            //   split into chunks of those sizes. Guarantees:
            //     - 100% coverage (every card in exactly 1 workload)
            //     - each workload's share for THAT terminal is in [5%, 40%]
            //   Edge case: walkable.length < N -> round-robin (some
            //   workloads end up empty for that terminal, unavoidable).
            const MIN_PCT = 0.05, MAX_PCT = 0.40;
            function genPercentagesInRange(n, minP, maxP, maxAttempts = 2000) {
              // Generate n random values, normalize, check bounds, reject + retry.
              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const raw = Array.from({length: n}, () => Math.random());
                const sumRaw = raw.reduce((a, b) => a + b, 0);
                const norm = raw.map(r => r / sumRaw);
                if (norm.every(p => p >= minP && p <= maxP)) return norm;
              }
              // Fallback: equal split (unlikely to be needed for n=4, [5,40])
              return Array.from({length: n}, () => 1 / n);
            }
            function distributeCards(walkable, n) {
              if (walkable.length === 0) return Array.from({length: n}, () => []);
              if (walkable.length < n) {
                // Not enough cards for everyone -- round-robin assigns to first M workloads.
                const parts = Array.from({length: n}, () => []);
                const sh = shuffle(walkable);
                for (let i = 0; i < sh.length; i++) parts[i].push(sh[i]);
                return parts;
              }
              const pcts = genPercentagesInRange(n, MIN_PCT, MAX_PCT);
              // Convert to integer counts, each at least 1
              let counts = pcts.map(p => Math.max(1, Math.round(p * walkable.length)));
              let sum = counts.reduce((a, b) => a + b, 0);
              // Adjust to sum exactly walkable.length
              while (sum > walkable.length) {
                // Decrement the largest (but never below 1)
                let maxIdx = 0;
                for (let i = 1; i < counts.length; i++) if (counts[i] > counts[maxIdx]) maxIdx = i;
                if (counts[maxIdx] > 1) { counts[maxIdx]--; sum--; } else break;
              }
              while (sum < walkable.length) {
                // Increment the smallest
                let minIdx = 0;
                for (let i = 1; i < counts.length; i++) if (counts[i] < counts[minIdx]) minIdx = i;
                counts[minIdx]++; sum++;
              }
              const sh = shuffle(walkable);
              const parts = []; let off = 0;
              for (const c of counts) { parts.push(sh.slice(off, off + c)); off += c; }
              return parts;
            }
            const partitionsByTerm = {};
            for (const t of terms) {
              const m = tcm[t.terminal_node] || {};
              const avail = (m.available || []).slice();
              const used  = new Set(m.used || []);
              const dim   = new Set(m.dim_dom || []);
              const walkable = avail.filter(c => !used.has(c) && !dim.has(c));
              partitionsByTerm[t.terminal_node] = distributeCards(walkable, N);
            }
            // Build N workload payloads
            const workloads = [];
            for (let i = 1; i <= N; i++) {
              const wl = {
                schema_version: '2',
                workload_id: 'wl-' + Math.random().toString(36).slice(2, 10) + '-p' + i,
                url: producerUrl,
                tree: result.tree,
                flop: result.flop,
                chipsPerBb: chipsPerBb,
                partition_index: i,
                partition_count: N,
                flop_terminals: terms.map(t => ({
                  parent: t.parent, terminal_node: t.terminal_node, via: t.via, code: t.code,
                })),
                terminals: terms.map(t => {
                  const m = tcm[t.terminal_node] || {};
                  return {
                    terminal_node: t.terminal_node,
                    parent: t.parent,
                    via: t.via,
                    code: t.code,
                    card_map: {
                      available: (m.available || []).slice(),
                      used: (m.used || []).slice(),
                      dim_dom: (m.dim_dom || []).slice(),
                    },
                    assigned_cards: (partitionsByTerm[t.terminal_node] || [])[i - 1] || [],
                  };
                }),
              };
              workloads.push(wl);
            }
            // Trigger downloads
            for (const wl of workloads) {
              try {
                const name = `${wl.tree}_${wl.flop}_workload_${String(wl.partition_index).padStart(2,'0')}_of_${String(wl.partition_count).padStart(2,'0')}.json`;
                const blob = new Blob([JSON.stringify(wl, null, 2)], { type: 'application/json' });
                const u = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = u; a.download = name;
                document.body.appendChild(a); a.click();
                setTimeout(() => { a.remove(); URL.revokeObjectURL(u); }, 1500);
                await sleep(400 + downloadDelayMs);
                log('workload_emitted', { name, partition: wl.partition_index, of: wl.partition_count });
              } catch (e) {
                result.warnings.push(`workload emit ${wl.workload_id}: ${e.message}`);
              }
            }
            result.workloads_emitted = workloads.map(w => ({
              workload_id: w.workload_id,
              partition_index: w.partition_index,
              partition_count: w.partition_count,
              terminals: w.terminals.map(t => ({
                terminal_node: t.terminal_node,
                assigned_count: t.assigned_cards.length,
              })),
            }));
            log('all_workloads_emitted', { count: workloads.length });
            saveCheckpoint(buildCheckpoint({ last_event: 'workloads_emitted', n_workloads: workloads.length }));
          }

          // POST-TIER-4 (2026-05-23): STOP GATE — producer device emits
          //   flop+workloads and stops. Workers re-launch with cfg.skip_flop_walk
          //   + cfg.cached_flop_terminals + cfg.target_cards_per_terminal to do
          //   the turn-walk portion. If neither target_cards_per_terminal nor
          //   turn_cards_per_terminal is supplied, this is a producer run -- exit.
          if (!cfg.target_cards_per_terminal && !cfg.turn_cards_per_terminal && !cfg.flop_terminal_filter) {
            log('producer_run_complete', { workloads_emitted: (result.workloads_emitted || []).length });
            window.__msProgress.phase = 'producer_complete';
            result.finished_at = new Date().toISOString();
            result.elapsed_s = Math.round((Date.now() - window.__msProgress.t_start) / 1000);
            window.__msResult = result;
            return result;
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
          // POST-TIER-9 v9.3 (2026-05-24): partial walk now fires BEFORE
          //   each target card walk (in the cell loop), not after. The
          //   old post-card partial-walk block was removed; this comment
          //   marks the location for archaeology.
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
          // POST-TIER-9 FIX B (2026-05-24): if explicitCards/targetList is set
          //   AND every assigned card has been visited, exit immediately --
          //   no point reopening the modal just to discover "no target left".
          //   This eliminates one wasted reopen at the end of each terminal.
          if (explicitCards && explicitCards.every(c => visitedThisTerminal.has(c))) {
            terminalFullyDone = true;
            terminalExitReason = 'all_targets_visited';
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
          //   With targetCardsPerTerminal[terminal] OR explicitCards
          //   (cfg.turn_cards_per_terminal[terminal]) provided: iterate
          //   the given list in order, pick the first card that maps to
          //   an available cell. Aliased/dim cards are recorded as
          //   alias-hits and skipped (consistent with legacy behavior).
          //   Without either: fall back to legacy top-to-bottom DOM order.
          //
          //   POST-TIER-9 FIX v9.5 (2026-05-24): coalesce cfg.target_cards_per_terminal
          //   (targetCardsPerTerminal) and cfg.turn_cards_per_terminal
          //   (explicitCards). Either is sufficient to drive the picker.
          //   Bug fixed: without this, when only cfg.turn_cards_per_terminal
          //   was set, iterCards fell back to ALL modal cells, picker picked
          //   random non-target cards, and the new pre-target partial walks
          //   fired for each one -- burning quota with no real walks.
          let target = null;
          const targetList = (targetCardsPerTerminal && Array.isArray(targetCardsPerTerminal[ft.terminal_node]))
            ? targetCardsPerTerminal[ft.terminal_node]
            : (Array.isArray(explicitCards) ? explicitCards : null);
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
          // POST-TIER-9 v9.3 (2026-05-24): PRE-TARGET PARTIAL WALK.
          //   Before each target card walk (including the first on a new
          //   terminal), do a partial walk into a random non-target card's
          //   subtree (1-2 actions + categories + 10-20s wait), then cheap-
          //   reopen the modal so the real target walk proceeds normally.
          //   excludeCards is the ENTIRE explicitCards list so the partial
          //   walk can never pick a card we'll later try to walk for real.
          try {
            const pbChance = (humanCfg && typeof humanCfg.partial_browse_chance === 'number')
              ? humanCfg.partial_browse_chance : 0;
            if (pbChance > 0 && Math.random() < pbChance && typeof W.partialWalkOnTerminal === 'function') {
              await W.partialWalkOnTerminal(ft.terminal_node, { excludeCards: explicitCards || [] });
              // POST-TIER-9 v9.4 (2026-05-24): cleanup uses ensureTurnModalAtTerminal
              //   which tries cheap (stabilize + reopenChipModal) FIRST and
              //   only falls back to replay if cheap fails. Guarantees modal
              //   is open afterwards so the real target walk doesn't fail
              //   with "modal not open". Watch reopen_stats.replay -- if it
              //   climbs, the cheap path needs more investigation.
              try {
                const _er = await ensureTurnModalAtTerminal();
                if (!_er.ok) {
                  result.warnings.push(`post-partial-walk cleanup at ${ft.terminal_node}: ${_er.path}`);
                }
              } catch (e) {
                result.warnings.push(`post-partial-walk cleanup at ${ft.terminal_node}: ${e.message}`);
              }
            }
          } catch (_) {}
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
  window.__msPostTier5Installed = true;
  window.__msPostTier6Installed = true; // 2026-05-23 v6: constrained random partition          // 2026-05-23 v5: round-robin coverage + slim schema + URL
  window.__msPostTier4Installed = true;        // 2026-05-23 v4
  window.__msTerminalModalCaptureInstalled = true;
  window.__msWorkloadEmissionInstalled = true;
  window.__msReplayPacingV4Installed = true;
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

