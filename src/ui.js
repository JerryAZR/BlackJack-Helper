/**
 * UI layer: owns all DOM and app state, delegates every decision to the
 * engine. State transitions are snapshot-undoable; settings and the running
 * shoe survive reloads via localStorage.
 *
 * Import-safe outside the browser (no top-level DOM or storage access), so
 * the module can be syntax-checked with plain node.
 */

import { RANKS, fullShoe, handInfo, countsOf, evaluate, EngineError } from './engine.js';

const LS_KEY = 'bjh:v1';
const MAX_HISTORY = 100;

// State is JSON-safe by construction (it round-trips through localStorage),
// so a JSON clone is exact — and works in every browser unlike structuredClone.
const clone = s => JSON.parse(JSON.stringify(s));

const defaultState = () => ({
  decks: 1,
  mode: 'fresh',      // 'fresh' = new shoe every round | 'running' = cards carry over
  s17: true,          // dealer stands on soft 17
  peek: true,         // dealer peeks for blackjack (US rules)
  upcard: [],         // 0 or 1 rank indices
  hand: [],           // rank indices
  extra: [],          // other cards seen (other players, dealer reveals)
  shoeOut: [],        // running mode: every card known out since the last new shoe
  doubling: false,
  doublePending: false,
  stood: false,
});

let state = null;
let history = [];
let hint = '';
let settingsOpen = false;

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

function load() {
  const fresh = defaultState();
  if (typeof localStorage === 'undefined') return fresh;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY));
    if (!saved) return fresh;
    // validate everything: corrupted storage must degrade to defaults, never
    // poison the app (a bad decks value would throw inside every render)
    if (Number.isInteger(saved.decks) && saved.decks >= 1 && saved.decks <= 16) {
      fresh.decks = saved.decks;
    }
    if (saved.mode === 'fresh' || saved.mode === 'running') fresh.mode = saved.mode;
    if (typeof saved.s17 === 'boolean') fresh.s17 = saved.s17;
    if (typeof saved.peek === 'boolean') fresh.peek = saved.peek;
    if (fresh.mode === 'running' && Array.isArray(saved.shoeOut)) {
      fresh.shoeOut = saved.shoeOut.filter(r => Number.isInteger(r) && r >= 0 && r <= 9);
    }
  } catch (err) {
    // corrupted storage is an external error: start clean, don't crash
    console.warn('Blackjack Helper: ignoring saved state:', err);
  }
  return fresh;
}

function persist() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      decks: state.decks,
      mode: state.mode,
      s17: state.s17,
      peek: state.peek,
      shoeOut: state.mode === 'running' ? state.shoeOut : [],
    }));
  } catch (err) {
    console.warn('Blackjack Helper: could not save settings:', err);
  }
}

/* ------------------------------------------------------------------ */
/* state helpers                                                       */
/* ------------------------------------------------------------------ */

function snapshot(fn) {
  history.push(clone(state));
  if (history.length > MAX_HISTORY) history.shift();
  fn(state);
  render();
}

/** Every card known to be out right now (rank indices). */
function outCards() {
  return state.mode === 'fresh'
    ? [...state.hand, ...state.upcard, ...state.extra]
    : state.shoeOut;
}

function playerInfo() {
  return handInfo(countsOf(state.hand));
}

function roundOver() {
  // bust, an explicit stand, or the one double card has been drawn
  return playerInfo().bust || state.stood || (state.doubling && !state.doublePending);
}

/** Remaining composition; negative entries mean the state is inconsistent. */
function remaining() {
  const out = countsOf(outCards());
  return fullShoe(state.decks).map((f, r) => f - out[r]);
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

function addCard(target, rank) {
  if (target === 'hand' && roundOver()) return;
  if (target === 'upcard' && state.upcard.length > 0) return;
  hint = '';
  snapshot(s => {
    s[target].push(rank);
    if (s.mode === 'running') s.shoeOut.push(rank);
    if (target === 'hand' && s.doublePending) s.doublePending = false;
  });
}

function removeCard(target, idx) {
  snapshot(s => {
    const rank = s[target][idx];
    s[target].splice(idx, 1);
    if (s.mode === 'running') {
      const i = s.shoeOut.lastIndexOf(rank);
      if (i >= 0) s.shoeOut.splice(i, 1);
    }
    if (target === 'hand') {
      // editing your hand invalidates a committed double; a stand stays
      s.doubling = false;
      s.doublePending = false;
    }
  });
}

function commitAction(act) {
  if (roundOver()) return;
  if (act === 'hit') {
    hint = 'Tap the rank you drew to add it to your hand.';
    render();
    return;
  }
  if (act === 'stand') {
    snapshot(s => { s.stood = true; });
    return;
  }
  if (act === 'double') {
    if (state.hand.length !== 2) return;
    hint = 'Tap your one double card.';
    snapshot(s => {
      s.doubling = true;
      s.doublePending = true;
    });
  }
}

function newRound() {
  hint = '';
  snapshot(s => {
    s.upcard = [];
    s.hand = [];
    s.extra = [];
    s.doubling = false;
    s.doublePending = false;
    s.stood = false;
    if (s.mode === 'fresh') s.shoeOut = [];
  });
}

function newShoe() {
  snapshot(s => { s.shoeOut = []; });
}

function undo() {
  if (!history.length) return;
  state = history.pop();
  hint = '';
  render();
}

function setDecks(n) {
  const d = Math.min(16, Math.max(1, Math.round(n)));
  if (d === state.decks) return;
  snapshot(s => { s.decks = d; });
}

function setMode(mode) {
  if (mode === state.mode) return;
  snapshot(s => {
    if (mode === 'running') {
      // carry this round's known-out cards over as the start of the shoe
      s.shoeOut = [...s.hand, ...s.upcard, ...s.extra];
    }
    s.mode = mode;
  });
}

function setS17(v) { if (state.s17 !== v) snapshot(s => { s.s17 = v; }); }
function setPeek(v) { if (state.peek !== v) snapshot(s => { s.peek = v; }); }

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const $ = sel => document.querySelector(sel);

const fmtEV = v => (v >= 0 ? '+' : '') + v.toFixed(3);
const pct = v => (v * 100).toFixed(1) + '%';

function rankRow(target, disabled) {
  return `<div class="ranks" role="group">${RANKS.map((r, i) =>
    `<button data-add="${target}" data-rank="${i}"${disabled ? ' disabled' : ''}` +
    ` title="${i === 9 ? '10 / J / Q / K' : r}">${r}</button>`).join('')}</div>`;
}

function chip(target, idx, rank) {
  return `<button class="chip" data-remove="${target}" data-idx="${idx}" title="Remove">` +
    `${RANKS[rank]}<span class="x">×</span></button>`;
}

function renderSettings() {
  $('#settings').hidden = !settingsOpen;
  $('#settings-toggle').setAttribute('aria-expanded', String(settingsOpen));
  const input = $('#decks');
  if (document.activeElement !== input) input.value = String(state.decks);
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
  document.querySelectorAll('[data-s17]').forEach(b => b.classList.toggle('on', (b.dataset.s17 === 's17') === state.s17));
  document.querySelectorAll('[data-peek]').forEach(b => b.classList.toggle('on', (b.dataset.peek === 'peek') === state.peek));
  $('#mode-note').textContent = state.mode === 'fresh'
    ? 'Each round starts from a full, freshly shuffled shoe.'
    : 'Cards stay out across rounds — log everything you see, reset with “New shoe”.';
}

function renderShoe() {
  const rem = remaining();
  const bad = rem.some(x => x < 0);
  const left = rem.reduce((a, b) => a + Math.max(0, b), 0);
  const total = fullShoe(state.decks).reduce((a, b) => a + b, 0);
  const modeLine = state.mode === 'fresh'
    ? `fresh ${state.decks}-deck shoe each round`
    : `running shoe · ${left} of ${total} cards left`;

  $('#shoe').innerHTML = `
    <div class="shoe-head">
      <h2>Shoe</h2>
      <span class="muted small">${modeLine}</span>
    </div>
    ${bad ? '<p class="small error">More cards logged than the shoe contains — undo or reset.</p>' : ''}
    <p class="small muted" style="margin:0 0 6px">Cards remaining (readout — enter cards below)</p>
    <div class="shoe-grid">${RANKS.map((r, i) =>
      `<div class="slot${rem[i] < 0 ? ' bad' : rem[i] === 0 ? ' empty' : ''}">` +
      `<span class="rank">${r}</span><span class="count">${rem[i]}</span></div>`).join('')}
    </div>
    <div class="shoe-tools">
      <div>
        <span class="small muted">Seen elsewhere — other players' cards, dealer's hole card &amp; draws</span>
        ${rankRow('extra', false)}
        <div class="chips" style="margin-top:8px">${
          state.extra.map((r, i) => chip('extra', i, r)).join('') ||
          '<span class="small muted">none yet</span>'
        }</div>
      </div>
      ${state.mode === 'running' ? '<button class="ghost" data-new-shoe>↺ New shoe</button>' : ''}
    </div>
  `;
}

function renderInputs() {
  const over = roundOver();
  $('#upcard-chips').innerHTML = state.upcard.map((r, i) => chip('upcard', i, r)).join('');
  $('#upcard-ranks').innerHTML = rankRow('upcard', over || state.upcard.length > 0);
  $('#hand-chips').innerHTML = state.hand.map((r, i) => chip('hand', i, r)).join('');
  $('#hand-ranks').innerHTML = rankRow('hand', over);
  $('#hint').textContent = over ? '' : hint;
  $('#flow').innerHTML = `
    <button class="ghost" data-undo${history.length ? '' : ' disabled'}>↶ Undo</button>
    <span class="spacer"></span>
    <button class="ghost" data-new-round>→ New round</button>
  `;
}

function actionCard(name, label, act, best, enabled) {
  if (!act) {
    const why = name === 'double' ? 'first two cards only' : 'not available';
    return `<div class="action off"><span class="name">${label}</span>` +
      `<span class="ev">—</span><span class="wpl">${why}</span></div>`;
  }
  const isBest = enabled && best === name;
  return `
    <button class="action${isBest ? ' best' : ''}" data-act="${name}"${enabled ? '' : ' disabled'}>
      <span class="name">${label}</span>
      <span class="ev">${fmtEV(act.ev)}</span>
      <span class="wpl">win ${pct(act.win)} · push ${pct(act.push)} · lose ${pct(act.lose)}</span>
      ${isBest ? '<span class="badge">best</span>' : ''}
    </button>`;
}

function dealerBars(res) {
  const d = res.dealer;
  const rows = [];
  if (d.bj > 0) rows.push(['BJ', d.bj]);
  for (let t = 17; t <= 21; t++) rows.push([String(t), d.dist[t - 16]]);
  rows.push(['bust', d.dist[0]]);
  return `
    <div class="dealer">
      <span class="small muted">Dealer finishes with${d.bj > 0 ? ' (unless blackjack)' : ''}</span>
      <div class="bars">${rows.map(([label, p]) => `
        <div class="bar-row">
          <span class="bar-label">${label}</span>
          <span class="track"><span class="fill" style="width:${(p * 100).toFixed(1)}%"></span></span>
          <span class="bar-val">${pct(p)}</span>
        </div>`).join('')}
      </div>
    </div>`;
}

function roundOverStrip(res) {
  if (!roundOver()) return '';
  const info = playerInfo();
  const act = res && res.actions && res.actions.stand;
  const outcome = act && !info.bust
    ? `Settled hand: win ${pct(act.win)} · push ${pct(act.push)} · lose ${pct(act.lose)}` +
      (state.doubling ? ' — at doubled stakes' : '')
    : '';
  const logNote = state.mode === 'running'
    ? 'Before the next round, log the dealer\u2019s revealed cards (hole card + draws) under “Seen elsewhere”.'
    : '';
  return `
    <div class="panel over">
      <h3>Round over</h3>
      ${outcome ? `<p class="small">${outcome}</p>` : ''}
      ${logNote ? `<p class="small muted">${logNote}</p>` : ''}
      <button class="primary" data-new-round>Start next round</button>
    </div>`;
}

function renderAdvice() {
  const box = $('#advice');
  if (!state.upcard.length || state.hand.length < 2) {
    box.innerHTML = `<div class="panel placeholder">
      <p>Enter the dealer's upcard and your two cards.</p>
      <p class="small">The advice updates with every card you add.</p>
    </div>`;
    return;
  }

  const info = playerInfo();
  const handLabel = state.hand.map(r => RANKS[r]).join(' ');
  const totalLabel = `${info.total}${info.soft ? ' soft' : ''}`;

  if (info.blackjack) {
    box.innerHTML = `
      <div class="panel result">
        <h2>Your hand</h2>
        <p class="big win">${handLabel} — Blackjack!</p>
        <p class="small muted">No decision to make. Normally paid 3 to 2; pushes if the dealer also has one.</p>
      </div>
      ${roundOverStrip(null)}`;
    return;
  }

  let res;
  try {
    res = evaluate({
      decks: state.decks,
      out: countsOf(outCards()),
      upcard: state.upcard[0],
      hand: countsOf(state.hand),
      peek: state.peek,
      h17: !state.s17,
    });
  } catch (err) {
    if (err instanceof EngineError) {
      box.innerHTML = `<div class="panel error"><p>${err.message}</p></div>${roundOverStrip(null)}`;
      return;
    }
    throw err; // internal error: fail loudly
  }

  const canDouble = state.hand.length === 2 && !roundOver();
  const over = roundOver();
  const actions = `
    <div class="actions">
      ${actionCard('hit', 'Hit', res.actions.hit, res.best, !over)}
      ${actionCard('stand', 'Stand', res.actions.stand, res.best, !over)}
      ${actionCard('double', 'Double', res.actions.double, res.best, canDouble)}
    </div>`;

  if (info.bust) {
    box.innerHTML = `
      <div class="panel result">
        <h2>Your hand</h2>
        <p class="big lose">${handLabel} = ${info.total} — Bust</p>
        <p class="small muted">You drew past 21; the hand is over.</p>
      </div>
      ${roundOverStrip(res)}`;
    return;
  }

  const bestLabel = { hit: 'Hit', stand: 'Stand', double: 'Double' }[res.best];
  const verdict = res.best
    ? `<p class="verdict">${bestLabel} — <b>${fmtEV(res.actions[res.best].ev)}</b> per unit bet` +
      `${res.best === 'hit' ? ' (assuming optimal play on later draws)' : ''}</p>`
    : '';
  const bjUp = state.upcard[0] === 0 || state.upcard[0] === 9;
  const peekNote = !bjUp
    ? 'blackjack not possible on this upcard'
    : state.peek
      ? 'dealer checked for blackjack — it is excluded'
      : 'dealer blackjack still possible';

  box.innerHTML = `
    <div class="panel">
      <div class="advice-head">
        <span class="you">${handLabel} = ${totalLabel}</span>
        <span class="muted small">dealer shows ${RANKS[state.upcard[0]]}</span>
      </div>
      ${actions}
      ${verdict}
      ${dealerBars(res)}
      <p class="note small muted">${res.meta.unseen} unseen cards · ${peekNote} · dealer ${state.s17 ? 'stands on' : 'hits'} soft 17</p>
    </div>
    ${roundOverStrip(res)}`;
}

function render() {
  renderSettings();
  renderShoe();
  renderInputs();
  renderAdvice();
  persist();
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function onDecksChange(e) {
  const n = Number(e.target.value);
  if (Number.isFinite(n)) setDecks(n);
  e.target.value = String(state.decks);
}

/**
 * Click dispatch. One table drives both the delegation selector and the
 * handlers, so a new data-* control cannot be wired on one side and
 * forgotten on the other — a mismatch would silently dead-click.
 */
const CLICK_HANDLERS = [
  ['data-add', el => addCard(el.dataset.add, Number(el.dataset.rank))],
  ['data-remove', el => removeCard(el.dataset.remove, Number(el.dataset.idx))],
  ['data-act', el => commitAction(el.dataset.act)],
  ['data-new-round', () => newRound()],
  ['data-new-shoe', () => newShoe()],
  ['data-undo', () => undo()],
  ['data-decks', el => setDecks(Number(el.dataset.decks))],
  ['data-mode', el => setMode(el.dataset.mode)],
  ['data-s17', el => setS17(el.dataset.s17 === 's17')],
  ['data-peek', el => setPeek(el.dataset.peek === 'peek')],
];

const CLICK_SELECTOR =
  `#settings-toggle,${CLICK_HANDLERS.map(([attr]) => `[${attr}]`).join(',')}`;

function onClick(e) {
  const el = e.target.closest(CLICK_SELECTOR);
  if (!el || el.disabled) return;

  if (el.id === 'settings-toggle') {
    settingsOpen = !settingsOpen;
    renderSettings();
    return;
  }
  for (const [attr, handle] of CLICK_HANDLERS) {
    if (el.hasAttribute(attr)) {
      handle(el);
      return;
    }
  }
}

// The browser swallows exceptions thrown inside event listeners into the
// console — to a user that reads as "clicking does nothing", which is
// exactly how the first deployed version failed. Surface them instead.
function showCrash(message) {
  const el = $('#crash');
  el.hidden = false;
  el.textContent =
    `Something broke: ${message}. Details are in the browser console — reloading usually helps.`;
}

export function init() {
  if (state) return;
  state = load();
  window.addEventListener('error', e => showCrash(e.message));
  window.addEventListener('unhandledrejection', e =>
    showCrash(String(e.reason?.message ?? e.reason)));
  document.addEventListener('click', onClick);
  $('#decks').addEventListener('change', onDecksChange);
  render();
}
