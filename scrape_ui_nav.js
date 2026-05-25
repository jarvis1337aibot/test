/* scrape_ui_nav.js -- UI-driven scenario picker navigation (v9.13, 2026-05-25 (null-op path when URL already at target) (verifyDialogClosed + lenient flop matcher + URL fallback) (flop-only fast path) (Heads Up skip pos + rank-only flop match))
 *
 * Installs window.__navigateToFlopViaUI(spec) which clicks through the
 * trainer's "Select scenario" modal instead of relying on direct URL
 * navigation. Each click is paced 1-2s; flop name is typed letter-by-letter
 * at 0.5-1s per character to mimic human interaction.
 *
 * Usage:
 *   await window.__navigateToFlopViaUI({
 *     tree: 'PLO5C_100_2_SB_BB_3BP',  // full tree id; parsed into filters
 *     flop: '8s6s2s',                  // 6-char board
 *     opts: {                          // optional pacing overrides
 *       slow_ms_range: [1000, 2000],
 *       type_ms_range: [500, 1000],
 *     },
 *   });
 *
 * Three startup scenarios are handled:
 *   A) Tab not on plomastermind.com -> navigate to '/', then full flow
 *   B) Tab on plomastermind.com but different tree -> open Select Scenario,
 *      apply filters, pick scenario row, type flop
 *   C) Tab on the correct tree but different flop -> click the FLOP action
 *      block (top of the action timeline) and type the new flop
 *
 * Parses tree id like 'PLO5C_100_2_SB_BB_3BP':
 *   PLO5C    -> 5-Card Cash
 *   100      -> stack 100bb
 *   2        -> 2 players -> Heads Up
 *   SB       -> First Position SB
 *   BB       -> Second Position BB
 *   3BP      -> scenario 3BP (also SRP / 4BP / SQ)
 *
 * Returns a result object: { ok, steps_completed, final_url, warnings }.
 */
(function installUiNav() {
  if (window.__msUiNavInstalled) return;

  const SLOW_MS_MIN_DEFAULT = 1000;
  const SLOW_MS_MAX_DEFAULT = 2000;
  const TYPE_MS_MIN_DEFAULT = 500;
  const TYPE_MS_MAX_DEFAULT = 1000;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

  function parseTreeId(tree) {
    // 'PLO5C_100_2_SB_BB_3BP' -> {variant, stack, n_players, pos1, pos2, scenario}
    if (!tree) throw new Error('tree id required');
    const parts = tree.split('_');
    if (parts.length < 6) throw new Error('tree id must have 6 underscore parts: ' + tree);
    return {
      variant:   parts[0],                          // 'PLO5C' or 'PLO4C'
      stack:     parseInt(parts[1], 10),            // 100 / 200 / etc.
      n_players: parseInt(parts[2], 10),            // 2 = Heads Up
      pos1:      parts[3],                          // SB / BB / BTN / CO / EP
      pos2:      parts[4],                          // SB / BB / BTN / CO / EP
      scenario:  parts[5],                          // SRP / 3BP / 4BP / SQ
    };
  }

  function findLeafByText(text, root) {
    root = root || document.body;
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      if ((el.textContent || '').trim() === text) return el;
    }
    return null;
  }
  function clickableAncestor(el, max_steps) {
    max_steps = max_steps || 8;
    let c = el;
    for (let k = 0; k < max_steps && c; k++) {
      const tag = (c.tagName || '').toLowerCase();
      const cls = (c.className || '').toString();
      const role = c.getAttribute && c.getAttribute('role');
      if (tag === 'button' || tag === 'a' || role === 'button' || /cursor-pointer/.test(cls)) {
        return c;
      }
      c = c.parentElement;
    }
    return el;
  }
  function waitFor(predicate, timeout_ms) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function loop() {
        const v = predicate();
        if (v) return resolve(v);
        if (Date.now() - start > timeout_ms) return resolve(null);
        setTimeout(loop, 150);
      })();
    });
  }
  function getDialog() { return document.querySelector('dialog.modal-root'); }
  function getModalCard(dialog) {
    if (!dialog) return null;
    for (const d of dialog.querySelectorAll('div')) {
      const cls = (d.className || '').toString();
      if (cls.includes('bg-neutral-1050') && cls.includes('animate-fade-in-fast')) return d;
    }
    return null;
  }

  /**
   * v9.10.3 (2026-05-25): after any picker interaction (scenario row click,
   * flop pick, etc.), the modal SHOULD close. Sometimes it lingers (race
   * with React state update / animation), which causes the next click to
   * miss the underlying page or hit the stale dialog instead.
   *
   * verifyDialogClosed: wait up to timeout_ms for the dialog to disappear
   * (no visible <h4> heading inside .modal-root). If still present, force
   * close via:
   *   1. Escape key dispatched to document
   *   2. Click on the outer overlay (the .fixed.inset-0 div behind the card)
   *   3. Click on a close-button if one is present
   * Returns true if the dialog ended up closed, false if all attempts failed.
   */
  async function verifyDialogClosed(opts, timeout_ms) {
    timeout_ms = (typeof timeout_ms === 'number') ? timeout_ms : 5000;
    function isClosed() {
      const d = getDialog();
      if (!d) return true;
      // Dialog element may exist but be empty when "closed". Look for any
      // visible <h4> heading inside as a proxy for "picker still open".
      const h4 = d.querySelector('h4');
      if (!h4) return true;
      const r = h4.getBoundingClientRect();
      return r.width === 0 || r.height === 0;
    }
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
      if (isClosed()) return true;
      await sleep(200);
    }
    // Still open. Try Escape first (cheapest).
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
      }));
      await sleep(500);
      if (isClosed()) return true;
    } catch (_) {}
    // Try clicking the modal overlay (the .fixed.inset-0 backdrop).
    try {
      const dialog = getDialog();
      if (dialog) {
        let overlay = null;
        dialog.querySelectorAll('div').forEach(d => {
          const cls = (d.className || '').toString();
          if (/fixed/.test(cls) && /inset-0/.test(cls)) overlay = overlay || d;
        });
        if (overlay) {
          overlay.click();
          await sleep(500);
          if (isClosed()) return true;
        }
      }
    } catch (_) {}
    // Try clicking a close (X) button if the modal exposes one.
    try {
      const dialog = getDialog();
      if (dialog) {
        const closeBtn = dialog.querySelector(
          'button[aria-label*="close" i], button[aria-label*="lose" i], ' +
          '[class*="close-button" i], [class*="closeBtn" i], button[class*="x-close" i]'
        );
        if (closeBtn) {
          closeBtn.click();
          await sleep(500);
          if (isClosed()) return true;
        }
      }
    } catch (_) {}
    return isClosed();
  }
  window.__msVerifyDialogClosed = verifyDialogClosed;

  /**
   * Inside the open dialog, find the option button with the given text
   * within the column anchored by `labelText`. Avoids collisions when the
   * same option text appears in multiple filter rows or in the scenario
   * list table.
   */
  function findOptionUnderLabel(labelText, optionText) {
    const dialog = getDialog();
    if (!dialog) return null;
    const card = getModalCard(dialog);
    if (!card) return null;
    // Locate the label leaf
    let label = null;
    for (const el of card.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      if ((el.textContent || '').trim() === labelText) { label = el; break; }
    }
    if (!label) return null;
    const lr = label.getBoundingClientRect();
    // Search for option buttons whose Y is just below the label AND X is
    // in the same logical column (label_x to label_x + ~370 for left column,
    // or label_x to label_x + ~470 for right column).
    const candidates = [];
    card.querySelectorAll('div, button, span').forEach(el => {
      if (el === label) return;
      const cls = (el.className || '').toString();
      if (!/cursor-pointer/.test(cls) && el.tagName !== 'BUTTON') return;
      const txt = (el.innerText || '').trim();
      if (txt !== optionText) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      // Same column: option starts within 380px to the right of label
      const dx = r.left - lr.left;
      if (dx < -10 || dx > 470) return;
      // Below label: option Y should be label.bottom .. label.bottom + 80
      const dy = r.top - lr.bottom;
      if (dy < -5 || dy > 80) return;
      candidates.push({ el, dx: Math.abs(dx), dy: Math.abs(dy) });
    });
    if (!candidates.length) return null;
    // Prefer the candidate with smallest |dy| (closest row), then |dx|
    candidates.sort((a, b) => a.dy - b.dy || a.dx - b.dx);
    return candidates[0].el;
  }

  async function clickAndPace(el, opts) {
    if (!el) throw new Error('clickAndPace: null element');
    el.click();
    await sleep(randInt(opts.slow_ms_min, opts.slow_ms_max));
  }

  async function typeLetterByLetter(input, text, opts) {
    if (!input) throw new Error('typeLetterByLetter: input element required');
    input.focus();
    // React-friendly: use the native value setter then dispatch 'input'
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    for (let i = 0; i < text.length; i++) {
      const val = input.value + text[i];
      nativeSetter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(randInt(opts.type_ms_min, opts.type_ms_max));
    }
  }

  /**
   * Flop-only-change path: when the URL already has the desired tree on
   * the postflop trainer, just click the FLOP action block (top of the
   * action timeline) to open the "Select a flop" dialog directly,
   * skipping the scenario picker.
   */
  async function openFlopPickerViaFlopBlock(opts) {
    // Find the FLOP action block — div whose visible text starts with "FLOP"
    // and is the wider card (~60-120px wide, ~80+ px tall).
    let flopBlock = null;
    document.querySelectorAll('.cursor-pointer, [role="button"], button').forEach(el => {
      const txt = (el.innerText || '').trim();
      if (!txt.startsWith('FLOP') || txt.length > 30) return;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.width > 120 || r.height < 80) return;
      flopBlock = el;
    });
    if (!flopBlock) throw new Error('FLOP action block not found on page');
    await clickAndPace(flopBlock, opts);
    const dialog = await waitFor(() => getDialog(), 5000);
    if (!dialog) throw new Error('"Select a flop" dialog did not open after FLOP block click');
    // Verify it's the flop popup (h4 "Select a flop") and not the scenario popup
    const h4 = dialog.querySelector('h4');
    if (h4 && (h4.textContent || '').trim() !== 'Select a flop') {
      throw new Error('Expected "Select a flop" dialog but got: ' + (h4.textContent || '').trim());
    }
    return dialog;
  }

  async function openScenarioPicker(opts) {
    let dialog = getDialog();
    if (dialog) return dialog;   // already open
    const trigger = findLeafByText('Select scenario', document.body);
    if (!trigger) throw new Error('"Select scenario" trigger not found on page');
    const click = clickableAncestor(trigger);
    await clickAndPace(click, opts);
    dialog = await waitFor(() => getDialog(), 5000);
    if (!dialog) throw new Error('scenario-picker dialog did not open');
    return dialog;
  }

  async function applyFiltersForTree(filters, opts, warnings) {
    // (a) Reset first to clear any prior selection state
    const dialog = getDialog();
    const card = getModalCard(dialog);
    if (!card) throw new Error('dialog open but card not found');
    const resetLeaf = findLeafByText('Reset', card);
    if (resetLeaf) await clickAndPace(clickableAncestor(resetLeaf), opts);

    // (b) Street: Postflop (changes UI to show Scenario/Turns/etc.)
    const postflop = findOptionUnderLabel('Street', 'Postflop');
    if (!postflop) throw new Error('Postflop option not found under Street');
    await clickAndPace(postflop, opts);

    // (c) Type: 1 vs 1 (vs Multiway)
    const type1v1 = findOptionUnderLabel('Type', '1 vs 1');
    if (!type1v1) warnings.push('Type "1 vs 1" not found — leaving default');
    else await clickAndPace(type1v1, opts);

    // (d) Players: Heads Up (vs 6-Max)
    const playersHU = findOptionUnderLabel('Players', 'Heads Up');
    if (!playersHU) throw new Error('Players "Heads Up" not found');
    await clickAndPace(playersHU, opts);

    // (e) Stack Size: 100 (or whatever the tree says)
    const stackBtn = findOptionUnderLabel('Stack Size', String(filters.stack));
    if (!stackBtn) throw new Error(`Stack Size "${filters.stack}" not found`);
    await clickAndPace(stackBtn, opts);

    // (f) Scenario: SRP / 3BP / 4BP / SQ
    const scenarioBtn = findOptionUnderLabel('Scenario', filters.scenario);
    if (!scenarioBtn) throw new Error(`Scenario "${filters.scenario}" not found`);
    await clickAndPace(scenarioBtn, opts);

    // (g) Turns Available: Yes (only for SRP/3BP; 4BP doesn't have this)
    if (filters.scenario === 'SRP' || filters.scenario === '3BP') {
      const turnsYes = findOptionUnderLabel('Turns Available', 'Yes');
      if (!turnsYes) warnings.push('"Turns Available -> Yes" not found');
      else await clickAndPace(turnsYes, opts);
    }

    // (h, i) First Position + Second Position.
    //   IMPORTANT: For Heads Up (n_players === 2) the picker AUTO-HIDES these
    //   filter rows since positions are implicit (SB vs BB). The scenario list
    //   already narrows to one row from the other filters. Skipping these is
    //   required — attempting to click them when they don't exist throws.
    if (filters.n_players !== 2) {
      const pos1Btn = findOptionUnderLabel('First Position', filters.pos1);
      if (!pos1Btn) throw new Error(`First Position "${filters.pos1}" not found`);
      await clickAndPace(pos1Btn, opts);
      const pos2Btn = findOptionUnderLabel('Second Position', filters.pos2);
      if (!pos2Btn) throw new Error(`Second Position "${filters.pos2}" not found`);
      await clickAndPace(pos2Btn, opts);
    } else {
      warnings.push('Skipped First/Second Position clicks (Heads Up — picker auto-hides them)');
    }
  }

  async function clickFirstScenarioRow(opts) {
    // After filters narrow the list, the scenario-list table has 1 row.
    // Find the first <tr>-like clickable row under the "Scenario list" header.
    const dialog = getDialog();
    const card = getModalCard(dialog);
    if (!card) throw new Error('card not found at scenario-row click');
    const header = findLeafByText('Scenario list', card);
    if (!header) throw new Error('"Scenario list" header not found');
    const hr = header.getBoundingClientRect();
    // Find rows below header that are clickable
    const rowCandidates = [];
    card.querySelectorAll('div, tr, button').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.top < hr.bottom + 20) return;        // must be below header
      if (r.top > hr.bottom + 200) return;       // first few rows only
      const cls = (el.className || '').toString();
      if (!/cursor-pointer/.test(cls)) return;
      if (r.width < 400) return;                  // full-width row
      rowCandidates.push({ el, y: r.top });
    });
    rowCandidates.sort((a, b) => a.y - b.y);
    if (!rowCandidates.length) {
      throw new Error('no scenario list rows visible — filters may not match any scenario');
    }
    await clickAndPace(rowCandidates[0].el, opts);
  }

  async function typeFlopAndPick(flop, opts, warnings) {
    // After scenario-row click, a SECOND dialog appears with title "Select a
    // flop". The flop list is on the right side, with a "Search" input above
    // suit-icon rows. Suits render as VISUAL ICONS (not text), so the row's
    // textContent contains just the 3 ranks (e.g. "862") plus question marks
    // for the icon glyphs. We match by checking that all 3 ranks of the
    // desired flop appear in the row's textContent, AND the row is below the
    // search input AND aligned to its column.
    const flopInput = await waitFor(() => {
      const dialog = document.querySelector('dialog.modal-root');
      if (!dialog) return null;
      // The flop popup has multiple Search inputs (suit filters + flop list);
      // pick the one nearest the "Flop list" h6 header.
      const flopHeader = Array.from(dialog.querySelectorAll('h6'))
        .find(h => (h.textContent || '').trim() === 'Flop list');
      if (!flopHeader) return null;
      const fhr = flopHeader.getBoundingClientRect();
      const inputs = Array.from(dialog.querySelectorAll('input'))
        .filter(i => i.offsetParent !== null && i.placeholder === 'Search');
      if (!inputs.length) return null;
      // The flop-list search input is just below the "Flop list" header
      let best = null, bestDy = Infinity;
      for (const i of inputs) {
        const r = i.getBoundingClientRect();
        const dy = Math.abs(r.top - fhr.bottom);
        if (dy < bestDy) { bestDy = dy; best = i; }
      }
      return best;
    }, 8000);
    if (!flopInput) throw new Error('flop-search input did not appear');
    await sleep(randInt(opts.slow_ms_min, opts.slow_ms_max));
    await typeLetterByLetter(flopInput, flop, opts);
    // Wait for list to filter
    await sleep(800);
    // v9.10.4 (2026-05-25): more lenient row match. The old logic required
    //   (a) startsWith(ranks[0]), (b) cursor-pointer class on the row itself,
    //   (c) row positioned just below the input.
    // Failure case observed on AhJd7h: matcher returned no row even though
    // the flop was selectable. New approach:
    //   - Don't require startsWith — just include() ALL 3 ranks AND no other
    //     non-ranking text bleed.
    //   - If the leaf element with ranks isn't clickable, walk up to find a
    //     clickable ancestor (cursor-pointer / <button> / role=button).
    //   - Search the whole dialog, not just below the input.
    //   - Score candidates by Y-proximity to input and tightness of rank-only
    //     text (no extra digit/letter noise beyond ranks + question-marks).
    const ranks = [flop[0], flop[2], flop[4]];
    const ranksSet = new Set(ranks);
    function isClickable(el) {
      if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      const cls = (el.className || '').toString();
      const role = el.getAttribute && el.getAttribute('role');
      return tag === 'button' || tag === 'a' || role === 'button' || /cursor-pointer/.test(cls);
    }
    function walkUpClickable(el, max) {
      max = max || 6;
      let c = el;
      for (let k = 0; k < max && c; k++) {
        if (isClickable(c)) return c;
        c = c.parentElement;
      }
      return null;
    }
    const dialog = document.querySelector('dialog.modal-root');
    const ir = flopInput.getBoundingClientRect();
    let candidates = [];
    // Pass 1: scan ALL elements whose textContent contains all 3 ranks and is
    // short (<= 20 chars, the typical flop row).
    dialog.querySelectorAll('div, button, li, tr, span').forEach(el => {
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 30) return;
      // Strip whitespace and the suit-icon glyphs (which appear as '?' in
      // textContent when rendered as SVG/img). What's left should be just
      // the three ranks.
      const stripped = txt.replace(/\s+|\?/g, '');
      if (stripped.length !== 3) return;
      const present = stripped.split('').every(ch => ranksSet.has(ch));
      if (!present) return;
      const all3 = ranks.every(rk => stripped.includes(rk));
      if (!all3) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      // Resolve to clickable ancestor if leaf isn't clickable itself.
      const click = isClickable(el) ? el : walkUpClickable(el);
      if (!click) return;
      const cr = click.getBoundingClientRect();
      // Score by Y-proximity to input (below preferred)
      const dy = cr.top - ir.bottom;
      const score = dy >= 0 ? dy : (Math.abs(dy) + 1000);  // penalize above-input
      candidates.push({ click, leaf: el, score, leafText: txt });
    });
    candidates.sort((a, b) => a.score - b.score);
    let matchEl = candidates.length ? candidates[0].click : null;

    // Pass 2 (fallback): if no candidate, try the legacy strict match in case
    // the row has noise after the ranks (e.g. score icons).
    if (!matchEl) {
      dialog.querySelectorAll('div, button, li, tr').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.top < ir.bottom + 4) return;
        if (r.width === 0) return;
        const txt = (el.innerText || '').trim();
        if (!txt) return;
        if (!ranks.every(rk => txt.includes(rk))) return;
        const click = isClickable(el) ? el : walkUpClickable(el);
        if (!click) return;
        if (!matchEl || click.getBoundingClientRect().top < matchEl.getBoundingClientRect().top) {
          matchEl = click;
        }
      });
    }

    if (!matchEl) {
      // v9.10.4 fallback: direct URL navigation when UI matcher fails.
      //   The cron debrief on 2026-05-25 observed this failure on AhJd7h —
      //   the user (Claude in the spawned chat) had to fall back to direct
      //   URL nav manually. Bake that fallback in so it auto-recovers.
      warnings.push(`flop matcher found no row for "${flop}" (typed value "${flopInput.value}"); ` +
                    `falling back to direct URL navigation`);
      // Try to close the picker dialog cleanly before navigating
      try { await verifyDialogClosed(opts, 3000); } catch (_) {}
      const u = new URL(location.href);
      u.searchParams.set('flop', flop);
      u.searchParams.set('type', 'postflop');
      // Tree/host already correct (we navigated via the picker successfully
      // for the scenario; only the flop pick failed).
      location.href = u.toString();
      // Wait for the page to land on the new URL
      const start = Date.now();
      while (Date.now() - start < 8000) {
        await sleep(300);
        if (new URL(location.href).searchParams.get('flop') === flop) break;
      }
      return;
    }
    await clickAndPace(matchEl, opts);
    // v9.10.3: confirm the popup closed after the flop pick. If it lingers,
    // force-close via Escape/overlay/close-button. Surfacing a warning so
    // the caller knows the dialog needed a nudge.
    const closed = await verifyDialogClosed(opts, 5000);
    if (!closed) {
      warnings.push('flop-pick dialog did not close cleanly after match click ' +
                    'and could not be force-closed -- next click may misfire');
    }
  }

  /**
   * Main entry point. Walks the picker UI to reach (tree, flop).
   * Three start states are handled:
   *   A) Not on plomastermind.com -> navigate to '/' first
   *   B) On plomastermind.com but wrong tree -> open picker, set filters
   *   C) On correct tree but wrong flop -> click FLOP action block, retype
   *      (NOT IMPLEMENTED in v9.10 — falls through to full-picker flow)
   */
  window.__navigateToFlopViaUI = async function(spec) {
    const opts = {
      slow_ms_min: (spec.opts && spec.opts.slow_ms_range && spec.opts.slow_ms_range[0]) || SLOW_MS_MIN_DEFAULT,
      slow_ms_max: (spec.opts && spec.opts.slow_ms_range && spec.opts.slow_ms_range[1]) || SLOW_MS_MAX_DEFAULT,
      type_ms_min: (spec.opts && spec.opts.type_ms_range && spec.opts.type_ms_range[0]) || TYPE_MS_MIN_DEFAULT,
      type_ms_max: (spec.opts && spec.opts.type_ms_range && spec.opts.type_ms_range[1]) || TYPE_MS_MAX_DEFAULT,
    };
    if (!spec.tree || !spec.flop) throw new Error('spec.tree and spec.flop are required');
    const filters = parseTreeId(spec.tree);
    const warnings = [];
    const stepsCompleted = [];

    // (A) Make sure we're on the trainer at all
    if (location.host !== 'plo5.plomastermind.com' &&
        location.host !== 'plo4.plomastermind.com') {
      const host = (filters.variant && filters.variant.startsWith('PLO4'))
        ? 'plo4.plomastermind.com' : 'plo5.plomastermind.com';
      location.href = 'https://' + host + '/';
      throw new Error('Navigated to ' + host + '; re-invoke after page loads');
    }
    stepsCompleted.push('host_ok');

    // (A2) PATH DETECTION:
    //   - If URL ALREADY at target (tree+flop+postflop): NULL-OP (v9.13).
    //     Saves ~10s per chunk when chunk N+1 is on the same flop as chunk N.
    //   - Else if URL has correct tree+postflop but wrong flop: flop-only
    //     fast path (v9.10.2). Click FLOP action block to open Select-a-flop
    //     dialog directly, skip scenario picker. Saves ~15s.
    //   - Else: full scenario picker.
    const u = new URL(location.href);
    const curTree = u.searchParams.get('tree');
    const curFlop = u.searchParams.get('flop');
    const curType = u.searchParams.get('type');
    const nullOpPath = (curTree === spec.tree && curFlop === spec.flop && curType === 'postflop');
    const fastPath = (curTree === spec.tree && curType === 'postflop');

    if (nullOpPath) {
      stepsCompleted.push('path_already_at_target');
      // Verify no picker is currently open (could be a leftover from a prior
      // interaction in the same chat). If one is open, force-close it before
      // the walker tries to interact with the page.
      const wasClosed = await verifyDialogClosed(opts, 2000);
      if (!wasClosed) {
        warnings.push('null-op path: a picker dialog was still open and could not be force-closed');
      }
      // Give the page a brief moment to settle (mostly cosmetic since URL
      // already matches; the walker's own state is what matters next).
      await sleep(500);
      const final_url = new URL(location.href);
      return {
        ok: true,
        steps_completed: stepsCompleted,
        final_url: {
          tree: final_url.searchParams.get('tree'),
          flop: final_url.searchParams.get('flop'),
          type: final_url.searchParams.get('type'),
          match: true,
        },
        warnings: warnings.concat(['already at target URL; navigation skipped (null-op path)']),
      };
    }

    if (fastPath) {
      stepsCompleted.push('path_flop_only');
      await openFlopPickerViaFlopBlock(opts);
      stepsCompleted.push('flop_picker_opened');
    } else {
      stepsCompleted.push('path_full_picker');
      await openScenarioPicker(opts);
      stepsCompleted.push('picker_opened');
      await applyFiltersForTree(filters, opts, warnings);
      stepsCompleted.push('filters_applied');
      await clickFirstScenarioRow(opts);
      stepsCompleted.push('scenario_row_clicked');
    }

    // Type flop and pick (same for both paths)
    await typeFlopAndPick(spec.flop, opts, warnings);
    stepsCompleted.push('flop_picked');

    // v9.10.3: belt-and-suspenders — ensure no picker dialog is still open
    // after the full navigation completes (would block any subsequent walker
    // calls that try to interact with the page).
    const finalClosed = await verifyDialogClosed(opts, 3000);
    if (!finalClosed) {
      warnings.push('a picker dialog is still open after navigation completed; ' +
                    'this may block subsequent walker interactions');
    }
    // Wait for navigation to settle
    await sleep(1500);
    const final_url = new URL(location.href);
    const url_tree = final_url.searchParams.get('tree');
    const url_flop = final_url.searchParams.get('flop');
    const url_type = final_url.searchParams.get('type');
    const ok = (url_tree === spec.tree && url_flop === spec.flop && url_type === 'postflop');

    return {
      ok,
      steps_completed: stepsCompleted,
      final_url: {
        tree: url_tree, flop: url_flop, type: url_type,
        match: ok,
      },
      warnings,
    };
  };

  window.__msUiNavInstalled = true;
  try {
    console.log('[ui-nav v9.13] installed __navigateToFlopViaUI(spec)');
  } catch (_) {}
})();
