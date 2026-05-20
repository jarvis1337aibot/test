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
