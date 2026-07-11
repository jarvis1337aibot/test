(function () {
  function __TW_INSTALL() {
    const W = window; const P = (W.__TW = W.__TW || {});
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    P.LEDGER_KEY = 'plo_turnreport_ledger';
    P._profile = function () { try { return JSON.parse(localStorage['__tw_profile']); } catch (e) {} return { node_wait_ms_range: [5000, 10000], long_pause_chance: 0.10, long_pause_range_ms: [15000, 25000] }; };
    P.setProfile = function (p) { localStorage['__tw_profile'] = JSON.stringify(p); return 'profile set'; };
    P._humanWait = function () { const pr = P._profile(); const r = a => Math.round(a[0] + Math.random() * (a[1] - a[0])); let w = r(pr.node_wait_ms_range || [5000, 10000]); if (Math.random() < (pr.long_pause_chance || 0)) w = r(pr.long_pause_range_ms || [15000, 25000]); return Math.min(w, 25000); };
    P._ensureFzstd = async function () { if (typeof fzstd !== 'undefined') return; await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); };
    P._ensureJSZip = async function () { if (typeof JSZip !== 'undefined') return; await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); };
    P._ctx = function () { let auth = null, host = null; try { const j = JSON.parse(atob(localStorage.getItem('plo-auth-5c'))); let t = j.accessToken || j.idToken || j.token; if (t && t.indexOf('Bearer') !== 0) t = 'Bearer ' + t; auth = t; } catch (e) {} const perf = performance.getEntriesByType('resource').map(e => e.name); for (const u of perf) { if (u.indexOf('execute-api') < 0) continue; const m = u.match(/^(https:\/\/[^\/]+\/prod)/); if (m) { host = m[1]; break; } } const p = new URLSearchParams(location.search); return { auth, host, tree: p.get('tree'), flop: p.get('flop'), node: p.get('node'), turn: p.get('turn') }; };
    const b64 = s => { const b = atob(s), n = b.length, a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = b.charCodeAt(i); return a; };
    const menu = raw => { const k = raw[0], a = []; for (let i = 0; i < k; i++) { const b = 1 + 10 * i; a.push({ type: raw[b + 1], amt: raw[b + 5] }); } return a; };
    const fk = el => Object.keys(el).find(x => x.indexOf('__reactFiber$') === 0);
    P._boards = function () { for (const el of document.querySelectorAll('*')) { const k = fk(el); if (!k) continue; let fib = el[k]; for (let i = 0; i < 12 && fib; i++) { const mp = fib.memoizedProps; if (mp && typeof mp === 'object') for (const kk of Object.keys(mp)) { const v = mp[kk]; if (Array.isArray(v) && v.length && v[0] && v[0].board !== undefined && v[0].buckets !== undefined && v[0].values !== undefined) return v; } fib = fib.return; } } return null; };
    const sizeLbl = amt => ({ 20: '1/5 pot', 25: '1/4 pot', 30: '0.3 pot', 33: '1/3 pot', 40: '0.4 pot', 50: '1/2 pot', 60: '0.6 pot', 66: '2/3 pot', 67: '2/3 pot', 70: '0.7 pot', 75: '3/4 pot', 80: '0.8 pot', 90: '0.9 pot', 100: 'Pot', 110: '1.1x pot', 125: '5/4 pot', 133: '4/3 pot', 150: '3/2 pot', 175: '7/4 pot', 200: '2x pot', 250: '2.5x pot', 300: '3x pot' }[amt] || (amt + '% pot'));
    const actLbl = a => a.type === 0 ? 'Fold' : a.type === 1 ? 'Check' : a.type === 2 ? 'Call' : a.type === 5 ? sizeLbl(a.amt) : a.type === 7 ? 'All-in' : ('t' + a.type);
    const rank = t => t.type === 0 ? 0 : ((t.type === 1 || t.type === 2) ? 1 : (t.type === 5 ? 2 : 3));
    P._aggUrl = (c, node) => c.host + '/tree/' + c.tree + '/' + node + '/agg-report?flop=' + c.flop;
    // RETRY: this fetch supplies ONLY the action-menu labels (the numbers come from
    // React). A single transient empty/failed response used to silently degrade the
    // header to Act1..ActN and blank AnyRaise. Retry with backoff before giving up.
    P._frames = async function (c, node, tries) {
      tries = tries || 5;
      for (let i = 0; i < tries; i++) {
        try {
          const r = await fetch(P._aggUrl(c, node), { headers: { Authorization: c.auth } });
          if (r.ok) { const j = await r.json(); if (j && j.frames && Object.keys(j.frames).length) return j.frames; }
        } catch (e) {}
        await sleep(500 * (i + 1) + Math.random() * 400);
      }
      return null;
    };
    P._columns = function (frames) { const uni = {}; for (const card of Object.keys(frames)) { const m = menu(fzstd.decompress(b64(frames[card]))); for (const a of m) { const key = a.type + ':' + (a.type === 5 ? a.amt : 0); uni[key] = a; } } const acts = Object.values(uni).sort((a, b) => rank(a) - rank(b) || ((a.amt || 0) - (b.amt || 0))); return acts.map(a => ({ label: actLbl(a), type: a.type })); };
    function turnStart(segs) { let bet = false; for (let i = 0; i < segs.length; i++) { const s = segs[i]; if (s === 'C') { if (bet) return i + 1; if (i > 0 && segs[i - 1] === 'C' && !bet) return i + 1; } else if (s.charAt(0) === 'R' || s === 'A') bet = true; } return segs.length; }
    P.config = async function (tree) { const c = P._ctx(); const T = tree || c.tree; const cfg = await fetch(c.host + '/postflop/tree/' + T, { headers: { Authorization: c.auth } }).then(r => r.json()); const boards = cfg.boards || {}; const flops = Object.keys(boards); const terminalsByFlop = {}; for (const f of flops) terminalsByFlop[f] = Object.keys(boards[f]); return { tree: T, flops, terminalsByFlop }; };
    P.plan = async function (tree) { const cf = await P.config(tree); const units = []; for (const f of cf.flops) for (const t of cf.terminalsByFlop[f]) units.push({ flop: f, terminal: t }); return { tree: cf.tree, flop_count: cf.flops.length, terminal_count: units.length, units }; };
    P.ledgerLoad = function () { try { return JSON.parse(localStorage[P.LEDGER_KEY]); } catch (e) {} return { schema: 'turnreport-ledger-1', trees: {} }; };
    P.ledgerSave = function (L) { L.updated = new Date().toISOString(); localStorage[P.LEDGER_KEY] = JSON.stringify(L); return L; };
    P.ledgerInit = async function (tree) { const cf = await P.config(tree); const L = P.ledgerLoad(); const T = (L.trees[cf.tree] = L.trees[cf.tree] || { flops: {} }); for (const f of cf.flops) { const F = (T.flops[f] = T.flops[f] || { terminals: {} }); for (const t of cf.terminalsByFlop[f]) if (!F.terminals[t]) F.terminals[t] = { status: 'pending' }; } P.ledgerSave(L); return P.ledgerStatus(cf.tree); };
    P.ledgerStatus = function (tree) { tree = tree || P._ctx().tree; const L = P.ledgerLoad(); const T = L.trees[tree]; if (!T) return { tree, total: 0, done: 0, pending: 0, flops: 0 }; let total = 0, done = 0; for (const f in T.flops) for (const t in T.flops[f].terminals) { total++; if (T.flops[f].terminals[t].status === 'done') done++; } return { tree, flops: Object.keys(T.flops).length, total, done, pending: total - done }; };
    P.ledgerNextBatch = function (n, tree) { tree = tree || P._ctx().tree; const L = P.ledgerLoad(); const T = L.trees[tree]; const out = []; if (!T) return out; for (const f in T.flops) for (const t in T.flops[f].terminals) { if (T.flops[f].terminals[t].status !== 'done') { out.push({ tree, flop: f, terminal: t }); if (out.length >= (n || 1)) return out; } } return out; };
    P.ledgerMark = function (flop, terminal, meta) { const c = P._ctx(); const L = P.ledgerLoad(); const T = (L.trees[c.tree] = L.trees[c.tree] || { flops: {} }); const F = (T.flops[flop] = T.flops[flop] || { terminals: {} }); F.terminals[terminal] = Object.assign({ status: 'done', at: new Date().toISOString() }, meta || {}); P.ledgerSave(L); return P.ledgerStatus(c.tree); };
    P.ledgerExport = function () { const L = P.ledgerLoad(); const blob = new Blob([JSON.stringify(L, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'turnreport_ledger.json'; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 3000); return P.ledgerStatus(); };
    P.enumerate = async function (start) { await P._ensureFzstd(); const c = P._ctx(); const nodes = [], seen = {};
      async function walk(node, depth) { if (seen[node] || depth > 16) return; const frames = await P._frames(c, node); if (!frames) return; seen[node] = 1; nodes.push(node);
        const segs = node.split('-'), tSegs = segs.slice(turnStart(segs)), kids = {};
        for (const card of Object.keys(frames)) { const m = menu(fzstd.decompress(b64(frames[card]))); for (const a of m) { if (a.type === 5) kids['R' + a.amt] = 1; else if (a.type === 7) kids['A'] = 1; else if (a.type === 1) { const closer = tSegs.length > 0 && tSegs.every(s => s === 'C'); if (!closer) kids['C'] = 1; } } }
        for (const k in kids) await walk(node + '-' + k, depth + 1);
      }
      await walk(start, 0); return nodes;
    };
    const esc = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    P._csv = function (bds, cols, flop) {
      let nReact = 0; (function scan(arr) { for (const b of arr) { nReact = Math.max(nReact, (b.values || []).length); const ch = b.next || b.buckets; if (ch && ch.length) scan(ch); } })(bds); for (const bd of bds) nReact = Math.max(nReact, (bd.values || []).length);
      const n = Math.max(cols.length, nReact); P._lastColInfo = { menu_cols: cols.length, react_cols: nReact, mismatch: cols.length !== nReact };
      const labels = []; for (let i = 0; i < n; i++) labels.push(cols[i] ? cols[i].label : ('Act' + (i + 1)));
      const raiseIdx = []; for (let i = 0; i < n; i++) if (cols[i] && (cols[i].type === 5 || cols[i].type === 7)) raiseIdx.push(i);
      const head = ['Board', 'Turn', 'Depth', 'Category', 'Parent_Path', 'NumberOfHands'].concat(labels).concat(['AnyRaise']); const rows = [head];
      const addRow = (board, turn, depth, cat, path, nh, vals) => { const cells = []; let anyR = 0, haveR = false; for (let i = 0; i < n; i++) { const v = vals[i]; if (v == null || v < 0) cells.push(''); else { cells.push(Math.round(v * 1000) / 10); if (raiseIdx.indexOf(i) >= 0) { anyR += v; haveR = true; } } } rows.push([board, turn, depth, cat, path, nh].concat(cells).concat([haveR ? Math.round(anyR * 1000) / 10 : ''])); };
      for (const bd of bds) { const board = bd.board, turn = board.slice(flop.length); const bv = bd.values || []; let tot = 0; for (let i = 0; i < n; i++) if (bv[i] >= 0) tot += bv[i]; tot = tot || 1;
        addRow(board, turn, 'ALL', '(all hands)', '', bd.numberOfHands, bv.map((x, i) => i < n && bv[i] >= 0 ? bv[i] / tot : -1));
        (function walk(arr, depth, path) { for (const b of arr) { addRow(board, turn, depth, b.category || ('#' + b.id), path, b.numberOfHands, b.values || []); const ch = b.next || b.buckets; if (ch && ch.length) walk(ch, depth + 1, path ? (path + ' > ' + (b.category || b.id)) : (b.category || ('' + b.id))); } })(bd.buckets || [], 0, '');
      }
      return rows.map(r => r.map(esc).join(',')).join('\n');
    };
    P._nextUrl = (c, node) => location.pathname + '?tab=Reports&type=postflop&tree=' + c.tree + '&node=' + node + '&flop=' + c.flop + (c.turn ? ('&turn=' + c.turn) : '');
    P._capObj = async function () { await P._ensureFzstd(); const list = JSON.parse(localStorage['__tw_list'] || '[]'); const c = P._ctx(); const node = c.node;
      let bds = null; for (let t = 0; t < 40; t++) { bds = P._boards(); if (bds && bds.length && bds[0].buckets) break; await sleep(500); }
      const status = { node }; if (!bds) { status.error = 'no report tree after wait'; }
      else { const frames = await P._frames(c, node); const cols = frames ? P._columns(frames) : []; const csv = P._csv(bds, cols, c.flop || ''); localStorage['__tw_csv_' + node] = csv; status.rows = csv.split('\n').length - 1; status.turn_cards = bds.length; status.cols = cols.map(x => x.label); status.col_mismatch = P._lastColInfo && P._lastColInfo.mismatch || false; }
      const next = list.find(x => localStorage['__tw_csv_' + x] === undefined); status.done = list.filter(x => localStorage['__tw_csv_' + x] !== undefined).length; status.total = list.length; status.next = next || null; localStorage['__tw_last'] = JSON.stringify(status);
      if (next) { const u = P._nextUrl(c, next); const w = P._humanWait(); status.wait_ms = w; await sleep(w); setTimeout(() => { location.href = u; }, 50); } else localStorage['__tw_done'] = '1';
      return status;
    };
    P.last = function () { return localStorage['__tw_last'] || '{}'; };
    P.cap = async function () { return JSON.stringify(await P._capObj()); };
    P.begin = async function () { const c = P._ctx(); const list = await P.enumerate(c.node); localStorage['__tw_list'] = JSON.stringify(list); list.forEach(n => localStorage.removeItem('__tw_csv_' + n)); localStorage.removeItem('__tw_done'); const s = await P._capObj(); s.enumerated = list.length; s.node_list = list; localStorage['__tw_last'] = JSON.stringify(s); return JSON.stringify(s); };
    P.zip = async function () { await P._ensureJSZip(); const list = JSON.parse(localStorage['__tw_list'] || '[]'); const c = P._ctx(); const zip = new JSZip(); const report = []; let anyMismatch = false;
      for (const node of list) { const csv = localStorage['__tw_csv_' + node]; if (!csv) { report.push({ node, missing: true }); continue; } const fn = 'turnreport_' + node.replace(/[^A-Za-z0-9_.-]+/g, '_') + '.csv'; zip.file(fn, csv); report.push({ node, file: fn, rows: csv.split('\n').length - 1 }); }
      const blob = await zip.generateAsync({ type: 'blob' }); const name = ('turnreport_' + (c.tree || '') + '_' + (c.flop || '') + '_' + (list[0] || '') + '.zip').replace(/[^A-Za-z0-9_.-]+/g, '_'); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 8000);
      list.forEach(n => localStorage.removeItem('__tw_csv_' + n)); localStorage.removeItem('__tw_src'); localStorage.removeItem('__tw_list'); localStorage.removeItem('__tw_done');
      return JSON.stringify({ zip: name, terminal: list[0] || null, files: report.filter(r => !r.missing).length, total_rows: report.reduce((s, r) => s + (r.rows || 0), 0), report });
    };
    return 'installed';
  }
  localStorage['__tw_src'] = '(' + __TW_INSTALL.toString() + ')()';
  __TW_INSTALL();
  return 'TW ready. terminal: __TW.begin()/cap()/zip(); auto: __TW.config()/plan()/ledgerInit()/ledgerNextBatch()/ledgerMark()/ledgerStatus()/ledgerExport().';
})();
