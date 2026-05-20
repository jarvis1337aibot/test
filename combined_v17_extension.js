/* combined_v17_extension.js — hand-scraper-postflop-flop-turn v17
 *
 * ADDITIVE extension on top of the v17 orchestrator. Installs:
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
 *     by the v17 orchestrator after every zip emit. Can also be called
 *     manually from DevTools at any time.
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
  window.__msEmitResumeFile = async function(eventLabel, downloadDelayMs) {
    eventLabel = eventLabel || 'manual';
    const safeLabel = String(eventLabel).replace(/[^A-Za-z0-9_-]/g, '_');
    downloadDelayMs = (typeof downloadDelayMs === 'number') ? downloadDelayMs : 250;

    const capsuleStr = window.__msDumpResumeCapsule({ silent: true });
    const capsule = JSON.parse(capsuleStr);
    const tree = (capsule.checkpoint && capsule.checkpoint.tree) || 'UNKNOWN_TREE';
    const flop = (capsule.checkpoint && capsule.checkpoint.flop) || 'UNKNOWN_FLOP';
    const fileName = `${tree}_${flop}_resume_${safeLabel}.json`;

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
  try {
    console.log('[hand-scraper v17] capsule extension installed (__msDumpResumeCapsule, __msApplyResumeCapsule, __msEmitResumeFile). Pauses still come from v15; Claude must NEVER auto-continue them.');
  } catch (_) {}
  return { v17_extension_loaded: true };
})();
