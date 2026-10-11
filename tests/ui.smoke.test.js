/**
 * DOM-level smoke test: loads the real index.html, drives the real ui.js,
 * and simulates the actual click flow a user performs. jsdom is a
 * devDependency; the test skips (with a notice) when it is not installed so
 * the zero-dependency engine tests still run anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('UI wiring: entering cards, acting on advice, and resetting all work', async t => {
  let JSDOM;
  try {
    ({ JSDOM } = await import('jsdom'));
  } catch {
    t.skip('jsdom not installed — run `npm install` for DOM tests');
    return;
  }

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://jerryazr.github.io/BlackJack-Helper/' });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  // jsdom does not execute module scripts; we drive init() ourselves instead
  window.document.querySelector('script[type="module"]').remove();

  const { init } = await import('../src/ui.js');
  init();

  const q = sel => window.document.querySelector(sel);
  const qa = sel => [...window.document.querySelectorAll(sel)];
  const click = el => el.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true })
  );

  // initial state: placeholders, no chips
  assert.equal(qa('#upcard-chips .chip').length, 0);
  assert.ok(q('#advice .placeholder'), 'placeholder advice before input');

  // rank buttons: dealer shows 10, player holds 10 and 6 (hard 16 vs 10)
  click(q('[data-add="upcard"][data-rank="9"]'));
  assert.equal(qa('#upcard-chips .chip').length, 1, 'upcard chip appears after click');

  click(q('[data-add="hand"][data-rank="9"]'));
  assert.ok(qa('#hand-chips .chip').length >= 1, 'hand chip appears after click');
  click(q('[data-add="hand"][data-rank="5"]'));
  assert.equal(qa('#hand-chips .chip').length, 2, 'second hand chip appears after click');

  // advice must render with a highlighted best action and a verdict
  assert.ok(q('#advice .action.best'), 'a best action is highlighted');
  assert.match(q('#advice .verdict').textContent, /Hit|Stand|Double/);
  assert.match(q('#advice .note').textContent, /unseen cards/);

  // shoe readout reflects the three entered cards (1 deck: 49 left)
  assert.match(q('#shoe').textContent, /49/);

  // hit: draw an ace (rank 0) -> 10+6+A = hard 17
  click(q('[data-act="hit"]'));
  click(q('[data-add="hand"][data-rank="0"]'));
  assert.equal(qa('#hand-chips .chip').length, 3, 'drawn card appears');
  assert.equal(q('[data-act="double"]'), null, 'double no longer offered on 3+ cards');
  assert.ok(q('#advice .action.off'), 'double shown as unavailable');

  // stand: round over strip with settlement odds and a next-round button
  click(q('[data-act="stand"]'));
  assert.match(q('#advice').innerHTML, /Round over/);
  assert.ok(q('[data-new-round]'), 'next-round button offered');

  // undo rolls back the stand
  click(q('[data-undo]'));
  assert.equal(q('#advice').innerHTML.includes('Round over'), false, 'undo restores the round');

  // new round resets the table (fresh mode)
  click(q('[data-new-round]'));
  assert.equal(qa('#hand-chips .chip').length, 0);
  assert.equal(qa('#upcard-chips .chip').length, 0);
  assert.ok(q('#advice .placeholder'));

  // settings: deck count buttons update the shoe readout
  click(q('#settings-toggle'));
  assert.equal(q('#settings').hidden, false);
  click(q('[data-decks="6"]'));
  assert.match(q('#shoe').textContent, /fresh 6-deck/);
  click(q('[data-mode="running"]'));
  assert.match(q('#shoe').textContent, /running shoe/);

  // running shoe: logging seen cards removes them from the readout,
  // chip removal restores them, and a new shoe resets the whole thing
  const rankCount = r => Number(qa('#shoe .slot .count')[r].textContent);
  click(q('[data-add="extra"][data-rank="9"]'));
  click(q('[data-add="extra"][data-rank="0"]'));
  assert.equal(rankCount(9), 16 * 6 - 1, 'logged ten leaves the shoe');
  assert.equal(rankCount(0), 4 * 6 - 1, 'logged ace leaves the shoe');
  click(q('[data-remove="extra"][data-idx="0"]'));
  assert.equal(rankCount(9), 16 * 6, 'chip removal restores the ten');
  click(q('[data-new-shoe]'));
  assert.equal(rankCount(0), 4 * 6, 'new shoe resets the running count');

  // blackjack detection: A + 10
  click(q('[data-add="upcard"][data-rank="5"]'));
  click(q('[data-add="hand"][data-rank="0"]'));
  click(q('[data-add="hand"][data-rank="9"]'));
  assert.match(q('#advice').textContent, /Blackjack/);

  // script errors surface visibly instead of dying silently in the console
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'boom' }));
  const crash = q('#crash');
  assert.equal(crash.hidden, false, 'crash banner becomes visible');
  assert.match(crash.textContent, /boom/);
});
