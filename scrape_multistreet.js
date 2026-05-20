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
