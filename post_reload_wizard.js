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
