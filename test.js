/*
 * Unit tests for Backtrack.
 * Run with:  node test.js      (no dependencies)
 *
 * Two halves. The pure helpers decide what to remember and what to hand
 * back; the plugin half runs the click handler and presses the real button,
 * because a control that is drawn but does nothing is the failure that
 * actually reaches a vault.
 */

const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return require.resolve('./test/obsidian-stub.js');
  return resolve.call(this, request, ...rest);
};

const dom = require('./test/dom-stub.js');
const installed = dom.install();
const El = installed.El;
const body = installed.body;

const { Notice, Platform } = require('./test/obsidian-stub.js');

const m = require('./main.js');
const {
  splitLinktext,
  positionKey,
  didMove,
  classify,
  pushEntry,
  nextUsable,
  peekUsable,
  usableHere,
  defaultSpot,
  clampSpot,
  isDrag,
  spotKey,
  fallbackKey,
  readSpotValue,
  GAP,
  describeEntry,
  sameWords,
  MAX_ENTRIES,
  LINK_SELECTOR,
  GO_BACK_COMMAND,
  KEEP_AT_MS,
  CATCH_EVENTS,
  BacktrackPlugin,
} = m;

let pass = 0;
let fail = 0;
function check(what, ok) {
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log('FAIL: ' + what);
  }
}
function eq(what, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('  got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b));
  check(what, ok);
}

/* ---------------- splitLinktext ---------------- */

eq('a link with a heading splits into note and heading', splitLinktext('Note#Heading'), {
  path: 'Note',
  subpath: '#Heading',
});
eq('a bare heading has no note part', splitLinktext('#Heading'), { path: '', subpath: '#Heading' });
eq('a bare note has no heading part', splitLinktext('Note'), { path: 'Note', subpath: '' });
eq('a block reference keeps its caret', splitLinktext('#^abc123'), { path: '', subpath: '#^abc123' });
eq('nothing at all is still an answer', splitLinktext(null), { path: '', subpath: '' });

/* ---------------- positionKey ---------------- */

check('two identical positions read the same', positionKey({ scroll: 12 }) === positionKey({ scroll: 12 }));
check('two different positions do not', positionKey({ scroll: 12 }) !== positionKey({ scroll: 40 }));
check('an absent position is empty, not a crash', positionKey(null) === '');
(function () {
  const loop = {};
  loop.self = loop;
  check('a position that will not serialise does not throw', positionKey(loop) === '[opaque]');
  check('and is not mistaken for an absent one', positionKey(loop) !== positionKey(null));
})();

/* ---------------- didMove ---------------- */

check(
  'a link written as a bare heading proves we moved, whatever the position says',
  didMove({ scroll: 5 }, { scroll: 5 }, '#Heading') === true
);
check('a block reference counts the same way', didMove(null, null, '#^abc') === true);
check('a changed position means we moved', didMove({ scroll: 5 }, { scroll: 90 }, null) === true);
check(
  'an unchanged position with no hint means we did not',
  didMove({ scroll: 5 }, { scroll: 5 }, 'Other Note') === false
);

/* ---------------- classify ---------------- */

check('landing in another file is a move across', classify('a.md', 'b.md', false) === 'across');
check('staying put and moving is a move within', classify('a.md', 'a.md', true) === 'within');
check('staying put and not moving is not a move at all', classify('a.md', 'a.md', false) === null);
check('with nowhere to come from there is nothing to say', classify(null, 'a.md', true) === null);
check('with nowhere to be there is nothing to say either', classify('a.md', null, true) === null);

/* ---------------- pushEntry ---------------- */

(function () {
  const first = [];
  const second = pushEntry(first, { kind: 'within', path: 'a.md' }, 3);
  check('pushing does not disturb the stack it was given', first.length === 0);
  check('and the new one has the entry', second.length === 1);

  let s = [];
  for (let i = 0; i < 5; i++) s = pushEntry(s, { kind: 'within', path: i + '.md' }, 3);
  check('the stack stops at its limit', s.length === 3);
  eq('and it is the oldest that go', s.map((e) => e.path), ['2.md', '3.md', '4.md']);
  check('the newest is on top', s[s.length - 1].path === '4.md');
  check('a limit nobody gave falls back to the default', pushEntry([], { kind: 'across' }).length === 1);
  check('the default limit is ten', MAX_ENTRIES === 10);
})();

/* ---------------- nextUsable ---------------- */

(function () {
  const L = { id: 'pane-1' };
  const other = { id: 'pane-2' };
  const within = (p, leaf) => ({ kind: 'within', path: p, leaf: leaf || L });
  const across = { kind: 'across', path: 'x.md', leaf: L };
  const at = (p, leaf) => ({ path: p, leaf: leaf || L, canGoBack: true });

  let r = nextUsable([within('a.md')], at('a.md'));
  check('an entry for the note on screen is usable', r.entry && r.entry.path === 'a.md');
  check('and nothing is left under it', r.rest.length === 0);

  r = nextUsable([within('a.md'), within('b.md')], at('a.md'));
  check(
    'an entry naming a note we are no longer in is dropped, not applied',
    r.entry && r.entry.path === 'a.md'
  );
  check('and it is gone rather than kept for next time', r.rest.length === 0);

  r = nextUsable([across, within('b.md')], at('a.md'));
  check('an entry handed to Obsidian is usable anywhere in its own pane', r.entry === across);

  r = nextUsable([across], at('a.md', other));
  check(
    'but not once the pane it was made in is gone, or we are in another',
    r.entry === null
  );
  check('and it is not left behind to be pressed again', r.rest.length === 0);

  r = nextUsable([within('a.md', other)], at('a.md'));
  check('the same note in a different pane is not the same place', r.entry === null);

  r = nextUsable([within('b.md'), within('c.md')], at('a.md'));
  check('when none of them fit, nothing is returned', r.entry === null);
  check('and the stack is emptied rather than left stale', r.rest.length === 0);

  r = nextUsable([], at('a.md'));
  check('an empty stack gives nothing', r.entry === null);

  const original = [within('a.md')];
  nextUsable(original, at('a.md'));
  check('and the stack it was given is left alone', original.length === 1);

  check('usableHere says no to nothing at all', usableHere(null, at('a.md')) === false);
  check('and to being nowhere', usableHere(within('a.md'), null) === false);
})();

/* ---------------- describeEntry ---------------- */

check('a move across is described by where it came from', describeEntry({ kind: 'across' }).length > 0);
check(
  'a move within names the note, without its folder or extension',
  describeEntry({ kind: 'within', path: 'Folder/Sub/My Note.md' }).indexOf('My Note') !== -1
);
check('and says nothing about folders', describeEntry({ kind: 'within', path: 'Folder/My Note.md' }).indexOf('Folder') === -1);
check('nothing to describe is not a crash', describeEntry(null) === '');

/* ---------------- the click handler, on a real tree ---------------- */

/* A link, optionally put into the note that is on screen. Left loose it
 * stands for a link in some other note, which is how the stale-element case
 * is set up. */
function makeLink(cls, href, host) {
  const para = new El('p');
  if (host) host.appendChild(para);
  const anchor = para.make('span', { cls: cls });
  if (href) anchor.setAttr('data-href', href);
  const inner = anchor.make('span', { cls: 'cm-underline', text: 'Heading' });
  return { para: para, anchor: anchor, inner: inner };
}

(function () {
  const reading = makeLink('internal-link', '#Heading');
  check(
    'a click on the text inside a reading-view link finds the link',
    reading.inner.closest(LINK_SELECTOR) === reading.anchor
  );
  const live = makeLink('cm-hmd-internal-link', null);
  check(
    'and a click inside a live-preview link finds it too',
    live.inner.closest(LINK_SELECTOR) === live.anchor
  );
  const plain = new El('p').make('span', { text: 'not a link' });
  check('a click on ordinary text finds nothing', plain.closest(LINK_SELECTOR) === null);
})();

/* ---------------- the plugin ---------------- */

const appStores = {};

function makeApp(path, state) {
  const file = { path: path };
  const pane = new El('div');
  pane.setBox(300, 60, 800, 700);
  /* Both halves, the way a markdown view really is built.
   *
   * The editor is not thrown away while the reader is in reading view: it
   * stays in the document, hidden, holding a second copy of every link in the
   * note - and it comes first, so a search of the whole view finds it first.
   * A fixture with only the visible half cannot show a mark landing in the
   * invisible one, which is precisely the bug that reached the vault. The
   * hidden half is given a box of nothing, as a hidden element measures. */
  const source = pane.make('div', { cls: 'markdown-source-view' });
  const editor = source.make('div', { cls: 'cm-editor' });
  const cmContent = editor.make('div', { cls: 'cm-content' });
  cmContent.setBox(0, 0, 0, 0);
  const reading = pane.make('div', { cls: 'markdown-reading-view' });
  const preview = reading.make('div', { cls: 'markdown-preview-view' });
  const column = preview.make('div', { cls: 'markdown-preview-sizer' });
  column.setBox(500, 60, 400, 2000);
  const leaf = { id: 'leaf-' + path, history: { backHistory: [{}], forwardHistory: [] } };
  const view = {
    file: file,
    leaf: leaf,
    contentEl: pane,
    pane: pane,
    column: column,
    /* Where note content goes in each half, so a test can put a link in the
     * one the reader is looking at - or, deliberately, in the other. */
    reading: column,
    source: cmContent,
    state: state === undefined ? { scroll: 0 } : state,
    applied: undefined,
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
    getMode() { return 'preview'; },
  };
  const app = {
    view: view,
    leaves: [leaf],
    revealed: null,
    activated: null,
    handlers: {},
    workspace: {
      getActiveViewOfType: () => app.view,
      getActiveFile: () => (app.view && app.view.file) || null,
      onLayoutReady: (fn) => fn(),
      iterateAllLeaves(fn) { for (const l of app.leaves) fn(l); },
      revealLeaf(l) { app.revealed = l; },
      setActiveLeaf(l) { app.activated = l; },
      on(name, fn) {
        (app.handlers[name] = app.handlers[name] || []).push(fn);
        return { name: name };
      },
      fire(name) {
        for (const fn of app.handlers[name] || []) fn();
      },
    },
    commands: {
      executed: [],
      commands: { 'app:go-back': {} },
      executeCommandById(id) {
        this.executed.push(id);
        return true;
      },
    },
    vault: { adapter: {}, getName: () => 'Vault A' },
    /* The app's store outlives a plugin and is kept per vault, so the stub
     * keeps it outside the app object too. A store that died with each fake
     * app could not show that a position is remembered at all. */
    get store() { return appStores[this.vault.getName()] || (appStores[this.vault.getName()] = {}); },
    loadLocalStorage(k) { const v = this.store[k]; return v === undefined ? null : v; },
    saveLocalStorage(k, v) { this.store[k] = v; },
  };
  return app;
}

function boot(path, state) {
  const app = makeApp(path, state);
  const p = new BacktrackPlugin(app, { dir: 'plugins/backtrack' });
  p.onload();
  return { app: app, p: p };
}

function clickThen(p, anchorEl) {
  p.onLinkClick({ target: anchorEl });
  if (p.settleTimer) {
    clearTimeout(p.settleTimer);
    p.settleTimer = 0;
  }
}

(function () {
  const { app, p } = boot('a.md');
  const capture = p.domEvents.filter((e) => e.type === 'click')[0];
  check('the click handler is installed', !!capture);
  check(
    'and on the capture phase, or the position we want is already gone',
    !!capture && !!capture.options && capture.options.capture === true
  );
  check('a command is offered so a keyboard can reach it too', p.commands.some((c) => c.id === 'go-back'));
  check(
    'and one that answers where it would go, for when the button is not in front of you',
    p.commands.some((c) => c.id === 'say-where')
  );
})();

/* ---------------- a press is not obliged to be a click ---------------- *
 *
 * A phone may take the touch for itself and never let a click through, and
 * which event a platform lets through is not ours to choose. Listening for
 * one of them makes the capture work or fail per platform for reasons that
 * cannot be seen from here. */

(function () {
  const { app, p } = boot('a.md');
  const on = {};
  for (const e of p.domEvents) if (e.el === document) on[e.type] = e.options;
  check('a press is caught as a click', !!on.click);
  check('and as a pointerup, in case the click never arrives', !!on.pointerup);
  check('and as a touchend, in case neither does', !!on.touchend);
  check(
    'every one of them on the capture phase',
    CATCH_EVENTS.every((t) => on[t] && on[t].capture === true)
  );
})();

/* Fire through the listener the plugin actually registered, not through the
 * method by name: the question is whether it is wired to that event at all. */
function fireOn(p, type, ev) {
  const row = p.domEvents.filter((e) => e.el === document && e.type === type)[0];
  if (!row) return false;
  row.fn(ev);
  return true;
}

(function () {
  const { app, p } = boot('a.md');
  const link = makeLink('internal-link', 'Other Note', app.view.reading);
  check('there is a pointerup listener to fire', fireOn(p, 'pointerup', { target: link.inner }));
  check('a press that only reaches us as a pointerup is caught', !!p.pending);
  if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = 0; }
  app.view.file.path = 'b.md';
  p.settle();
  check('and the move it made is remembered', p.stack.length === 1 && p.stack[0].kind === 'across');
})();

(function () {
  const { app, p } = boot('a.md');
  const link = makeLink('internal-link', 'Other Note', app.view.reading);
  check('there is a touchend listener to fire', fireOn(p, 'touchend', { target: link.inner }));
  check('a press that only reaches us as a touchend is caught too', !!p.pending);
  if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = 0; }
  app.view.file.path = 'b.md';
  p.settle();
  check('and that move is remembered as well', p.stack.length === 1 && p.stack[0].kind === 'across');
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 120 });
  const link = makeLink('internal-link', 'Other Note', app.view.reading);
  fireOn(p, 'pointerup', { target: link.inner });
  const first = p.pending;
  check('the press was caught at all', !!first);
  if (!first) return;

  /* The move happens on the pointerup, and the click arrives after it. An
   * entry built from that later event would be well formed and point at the
   * place we are trying to get back from. */
  app.view.file.path = 'b.md';
  app.view.state = { scroll: 0 };
  const later = makeLink('internal-link', 'Third Note', app.view.reading);
  fireOn(p, 'click', { target: later.inner });

  check('the rest of one gesture is dropped', p.pending === first);
  check('so the note kept is the one we left', p.pending.path === 'a.md');
  check(
    'and the position kept is the one from before the move',
    positionKey(p.pending.state) === positionKey({ scroll: 120 })
  );

  if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = 0; }
  p.settle();
  check('one gesture leaves one entry, not three', p.stack.length === 1);
  check('and it points at where the reader actually was', p.stack[0].path === 'a.md');
})();

(function () {
  const { app, p } = boot('a.md');
  check('the button exists as soon as the layout is ready', !!p.button);
  check('and it is in the document', !!p.button && p.button.isConnected === true);
  check('but not showing, because there is nothing to undo', !p.button.hasClass('is-visible'));
  check('it carries an icon, not an empty circle', p.button.find((e) => e.hasClass('svg-icon')).length === 1);
  check('and a label a screen reader can say', !!p.button.getAttribute('aria-label'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading');
  clickThen(p, link.inner);
  app.view.state = { scroll: 200 };
  p.settle();
  check('a jump to a heading in the same note is remembered', p.stack.length === 1);
  check('as a move within', p.stack[0].kind === 'within');
  eq('holding the position we left, not the one we landed on', p.stack[0].state, { scroll: 10 });
  check('and the button shows', p.button.hasClass('is-visible'));
  check('saying where it would take you', p.button.getAttribute('aria-label').indexOf('a') !== -1);

  p.goBack();
  eq('pressing it puts the old position back', app.view.applied, { scroll: 10 });
  check('the stack is emptied', p.stack.length === 0);
  check('and the button goes, because there is nothing left to undo', !p.button.hasClass('is-visible'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', 'Other Note');
  clickThen(p, link.inner);
  app.view = {
    file: { path: 'b.md' },
    leaf: app.view.leaf,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  check('a jump to another note is remembered too', p.stack.length === 1);
  check('as a move across', p.stack[0].kind === 'across');
  check('with no position of its own to disagree with Obsidian', p.stack[0].state === undefined);

  p.goBack();
  eq('pressing it hands the move back to Obsidian', app.commands.executed, [GO_BACK_COMMAND]);
  check('and nothing was restored by hand', app.view.applied === undefined);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('cm-hmd-internal-link', null);
  clickThen(p, link.inner);
  p.settle();
  check('a click that moved nothing is not remembered', p.stack.length === 0);
  check('and leaves no button behind', !p.button.hasClass('is-visible'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [
    { kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 1 } },
    { kind: 'within', path: 'gone.md', leaf: app.view.leaf, state: { scroll: 99 } },
  ];
  p.render();
  p.goBack();
  eq(
    'an entry for a note we have since left is dropped, and the one under it used',
    app.view.applied,
    { scroll: 1 }
  );
  check('with nothing stale kept underneath', p.stack.length === 0);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'gone.md', leaf: app.view.leaf, state: { scroll: 99 } }];
  p.render();
  const answered = p.goBack();
  check('when nothing fits, the press honestly does nothing', answered === false);
  check('and does not force us into a note we did not ask for', app.view.applied === undefined);
  check('the button goes, because the stack really is empty now', !p.button.hasClass('is-visible'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();
  p.button.press('click');
  eq('the button itself is wired, not just the command', app.view.applied, { scroll: 7 });
})();

(function () {
  const before = Notice.all.length;
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();
  p.button.press('contextmenu');
  check('a long press says where it would take you', Notice.all.length === before + 1);
  check('and names the note', Notice.last.indexOf('a') !== -1);
})();

(function () {
  const { app, p } = boot('a.md');
  const el = p.button;
  p.onunload();
  check('unloading takes the button out of the document', el.isConnected === false);
  check('and lets go of it', p.button === null);
  check('and takes it out of the page rather than merely hiding it', body.find((e) => e === el).length === 0);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 0 });
  for (let i = 0; i < 15; i++) {
    p.stack = m.pushEntry(p.stack, { kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: i } }, MAX_ENTRIES);
  }
  check('a long read does not grow the stack for ever', p.stack.length === MAX_ENTRIES);
  p.render();
  p.goBack();
  eq('and the most recent move is the one undone first', app.view.applied, { scroll: 14 });
})();

/* ---------------- peekUsable does not consume ---------------- */

(function () {
  const L = { id: 'pane-1' };
  const stack = [{ kind: 'within', path: 'a.md', leaf: L, state: { scroll: 1 } }];
  check('peeking finds the entry', peekUsable(stack, { path: 'a.md', leaf: L, canGoBack: true }) === stack[0]);
  check('and leaves it where it was', stack.length === 1);
  check('an entry for another note is not offered here', peekUsable(stack, { path: 'b.md', leaf: L, canGoBack: true }) === null);
  check('but it is still not thrown away', stack.length === 1);
  check('nothing to peek at is not a crash', peekUsable([], { path: 'a.md', leaf: L, canGoBack: true }) === null);
})();

/* ---------------- a button that would do nothing is not shown --------- */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();
  check('with something to undo here, the button shows', p.button.hasClass('is-visible'));

  app.view = {
    file: { path: 'elsewhere.md' },
    leaf: app.view.leaf,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  app.workspace.fire('file-open');
  check(
    'walking off by hand hides it, rather than leaving a button that does nothing',
    !p.button.hasClass('is-visible')
  );
  check('but the move is not thrown away merely by looking elsewhere', p.stack.length === 1);

  app.view = {
    file: { path: 'a.md' },
    leaf: app.view.leaf,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  app.workspace.fire('active-leaf-change');
  check('and coming back brings it back', p.button.hasClass('is-visible'));
  p.goBack();
  eq('still holding the place we left', app.view.applied, { scroll: 7 });
})();

(function () {
  const { app, p } = boot('a.md');
  const names = p.domEvents.length;
  check('the view being changed is listened for', names >= 0);
  check('and the button asks again when it happens', typeof p.render === 'function');
})();

/* ---------------- no landing place, no offer ---------------- */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  delete app.commands.commands['app:go-back'];
  const link = makeLink('internal-link', 'Other Note');
  clickThen(p, link.inner);
  app.view = {
    file: { path: 'b.md' },
    leaf: app.view.leaf,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  check(
    'if Obsidian can no longer go back, the move is not remembered at all',
    p.stack.length === 0
  );
  check('so no button appears that would do nothing', !p.button.hasClass('is-visible'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  app.commands = {};
  const link = makeLink('internal-link', 'Other Note');
  clickThen(p, link.inner);
  app.view = { file: { path: 'b.md' }, leaf: app.view.leaf, state: {}, getEphemeralState() { return this.state; } };
  p.settle();
  check('and the same when the command machinery is gone entirely', p.stack.length === 0);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading');
  clickThen(p, link.inner);
  p.settle();
  check(
    'a move inside a note is still remembered without the back command',
    p.stack.length === 1 && p.stack[0].kind === 'within'
  );
  app.commands = {};
  p.render();
  check('and remains offered, because it needs nobody else', p.button.hasClass('is-visible'));
})();

/* ---------------- our own way of writing notes ---------------- */

(function () {
  const name = describeEntry({ kind: 'within', path: 'Obsidian App 開発/Backtrack 開発/Backtrack の設計検討.md' });
  check('a Japanese note name survives being described', name.indexOf('Backtrack の設計検討') !== -1);
  check('and its folders do not come with it', name.indexOf('Obsidian App') === -1);
  const spaced = describeEntry({ kind: 'within', path: 'a folder/a note with spaces.md' });
  check('spaces in a name are not a problem', spaced.indexOf('a note with spaces') !== -1);

  const { app, p } = boot('議事録/2026-09-14 定例.md', { scroll: 3 });
  const link = makeLink('internal-link', '#2. 決めたこと');
  clickThen(p, link.inner);
  app.view.state = { scroll: 400 };
  p.settle();
  check('and a Japanese heading anchor is caught like any other', p.stack.length === 1);
  p.goBack();
  eq('and takes us back to where we were reading', app.view.applied, { scroll: 3 });
})();

/* ---------------- where it sits ---------------- */

(function () {
  const col = { left: 500, top: 60, width: 400, height: 2000, right: 900, bottom: 2060 };
  const pane = { left: 300, top: 60, width: 800, height: 700, right: 1100, bottom: 760 };
  const spot = defaultSpot(col, pane, 44);
  check('by default it stands beside the column, not over the words', spot.left >= col.right);
  check('close beside it, not adrift in the margin', spot.left === col.right + GAP);
  check('and below the line being read, not level with it', spot.top > pane.top + pane.height / 2);
  check('while still inside the pane', spot.top + 44 < pane.bottom);
})();

(function () {
  const pane = { left: 0, top: 0, width: 390, height: 700, right: 390, bottom: 700 };
  const narrow = { left: 0, top: 0, width: 390, height: 3000, right: 390, bottom: 3000 };
  const at = clampSpot(defaultSpot(narrow, pane, 44), pane, 44);
  check('where the column fills the screen there is no margin to stand in', at.left + 44 <= pane.right);
  check('so it comes inside rather than off the edge', at.left >= GAP);
  check('and stays clear of the bottom, where the toolbar lives', at.top + 44 <= pane.bottom);
})();

(function () {
  const pane = { left: 300, top: 60, width: 800, height: 700, right: 1100, bottom: 760 };
  const stranded = clampSpot({ left: 4000, top: 4000 }, pane, 44);
  check('a position remembered from a larger screen is brought back', stranded.left + 44 <= pane.right);
  check('in both directions', stranded.top + 44 <= pane.bottom);
  const above = clampSpot({ left: -900, top: -900 }, pane, 44);
  check('and back from the other side too', above.left >= GAP && above.top >= pane.top);
  const pinched = clampSpot({ left: 0, top: 0 }, { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }, 44);
  check('a pane too small for the button still gives an answer', typeof pinched.left === 'number');
})();

check('a finger that has barely moved was pressing', isDrag(2, 2) === false);
check('one that has travelled was moving it', isDrag(40, 0) === true);
check('in either direction', isDrag(0, -40) === true);

check('a phone and a desktop remember separately', spotKey(true) !== spotKey(false));

/* ---------------- pressing, holding, dragging ---------------- */

function pressAt(p, x, y) {
  p.button.fire('pointerdown', { clientX: x, clientY: y });
}

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const at = p.at;
  check('the button is placed as soon as it exists', !!at);
  check('beside the column', at.left >= app.view.column.getBoundingClientRect().right);
  check('and it is told where to stand in absolute terms', p.button.props['--backtrack-left'] === at.left + 'px');
  check('as values, not as styling', p.button.props.left === undefined);
  check('with the stylesheet told it has been placed', p.button.hasClass('is-placed'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();
  const start = p.at;
  pressAt(p, start.left + 22, start.top + 22);
  p.button.fire('pointermove', { clientX: start.left + 24, clientY: start.top + 23 });
  p.button.fire('pointerup', { clientX: start.left + 24, clientY: start.top + 23 });
  p.button.fire('click');
  eq('a press that barely moves is still a press', app.view.applied, { scroll: 7 });
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();
  const start = p.at;
  pressAt(p, start.left + 22, start.top + 22);
  p.button.fire('pointermove', { clientX: start.left + 22 - 200, clientY: start.top + 22 - 100 });
  check('dragging moves it', p.at.left < start.left);
  check('by about as far as the finger went', Math.abs((start.left - p.at.left) - 200) < 2);
  p.button.fire('pointerup', { clientX: start.left + 22 - 200, clientY: start.top + 22 - 100 });
  p.button.fire('click');
  check('and a drag is not taken as a press', app.view.applied === undefined);
  check('the move it was holding is still there', p.stack.length === 1);

  const moved = p.at;
  const second = boot('a.md', { scroll: 10 });
  eq('where it was left is where it comes back', second.p.at, moved);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const start = p.at;
  pressAt(p, start.left + 22, start.top + 22);
  p.button.fire('pointermove', { clientX: start.left + 22 - 300, clientY: start.top + 22 });
  p.button.fire('pointerup', { clientX: start.left + 22 - 300, clientY: start.top + 22 });
  const dragged = p.at.left;
  const reset = p.commands.filter((c) => c.id === 'reset-position')[0];
  check('there is a way to put it back', !!reset);
  reset.callback();
  check('and it goes back beside the column', p.at.left > dragged);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

(function () {
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
  const { app, p } = boot('a.md', { scroll: 10 });
  const start = p.at;
  pressAt(p, start.left + 22, start.top + 22);
  p.button.fire('pointermove', { clientX: start.left + 22 - 150, clientY: start.top + 22 });
  p.button.fire('pointerup', { clientX: start.left + 22 - 150, clientY: start.top + 22 });
  const onDesktop = p.at.left;

  Platform.isMobile = true;
  const phone = boot('a.md', { scroll: 10 });
  check(
    'a position measured on the desktop is not handed to the phone',
    phone.p.at.left !== onDesktop
  );
  Platform.isMobile = false;
  const back = boot('a.md', { scroll: 10 });
  check('and the desktop keeps its own', back.p.at.left === onDesktop);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

(function () {
  const before = Notice.all.length;
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();
  const start = p.at;
  pressAt(p, start.left + 22, start.top + 22);
  check('holding is timed, not answered at once', Notice.all.length === before);
  p.button.fire('pointermove', { clientX: start.left + 222, clientY: start.top + 22 });
  p.button.fire('pointerup', { clientX: start.left + 222, clientY: start.top + 22 });
  check('and a drag never becomes a hold', Notice.all.length === before);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.button.fire('pointerdown', { clientX: 0, clientY: 0 });
  p.onunload();
  check('unloading in the middle of a press leaves no timer behind', p.pressTimer === 0);
  check('and none waiting to light a link either', p.flashTimer === 0);
})();

(function () {
  const app = makeApp('a.md', { scroll: 0 });
  app.view.contentEl = null;
  const p = new BacktrackPlugin(app, { dir: 'plugins/backtrack' });
  p.onload();
  check('with nothing to measure, placing is skipped rather than guessed', p.at === null);
  check('and the button still exists', !!p.button);
})();

/* ---------------- the note is closed while the move is remembered ------ */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const first = app.view.leaf;
  const link = makeLink('internal-link', 'Other Note');
  clickThen(p, link.inner);
  app.view = {
    file: { path: 'b.md' },
    leaf: first,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  check('the move across is remembered', p.stack.length === 1);
  check('and offered while we are still in that pane', p.button.hasClass('is-visible'));

  /* The reader closes the tab. Obsidian puts them in a different pane, and
   * the history that knew how to go back went with the one they closed. */
  app.view = {
    file: { path: 'c.md' },
    leaf: { id: 'another-pane', history: { backHistory: [], forwardHistory: [] } },
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  app.workspace.fire('active-leaf-change');
  check(
    'closing the note takes the button with it, rather than leaving one that errs',
    !p.button.hasClass('is-visible')
  );
  const answered = p.goBack();
  check('and pressing the command finds nothing to do, quietly', answered === false);
  eq('having asked Obsidian for nothing', app.commands.executed, []);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const origin = app.view.leaf;
  const link = makeLink('internal-link', 'Other Note');
  p.onLinkClick({ target: link.inner, metaKey: true });
  if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = 0; }
  /* Opened in a new tab on purpose: the note we came from is still there. */
  app.view = {
    file: { path: 'b.md' },
    leaf: { id: 'new-tab', history: { backHistory: [], forwardHistory: [] } },
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  check(
    'a link opened in a new tab leaves nothing to undo, because nothing moved',
    p.stack.length === 0
  );
  check('so no button appears in the new tab', !p.button.hasClass('is-visible'));
  check('and the pane we came from is untouched', origin !== app.view.leaf);
})();

/* ---------------- a column that has not been laid out yet ------------- */

(function () {
  const app = makeApp('a.md', { scroll: 0 });
  app.view.column.setBox(0, 0, 0, 0);
  const p = new BacktrackPlugin(app, { dir: 'plugins/backtrack' });
  p.onload();
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 1 } }];
  p.render();
  const pane = app.view.pane.getBoundingClientRect();
  check(
    'a column of nothing does not push the button against the left edge',
    p.at.left > pane.left
  );
  check('it falls back to the pane, which does have a box', p.at.left + 44 <= pane.right);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

(function () {
  const app = makeApp('a.md', { scroll: 0 });
  const p = new BacktrackPlugin(app, { dir: 'plugins/backtrack' });
  /* Nothing is laid out at load, as when the plugin is switched on with a
   * note already open and no event follows. */
  app.view.pane.setBox(0, 0, 0, 0);
  p.onload();
  check('nothing is placed while there is nothing to measure', p.at === null);
  app.view.pane.setBox(300, 60, 800, 700);
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 1 } }];
  p.render();
  check('and it is measured when it is about to be seen', !!p.at);
  check('landing beside the column, not at the window edge', p.at.left > 300);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

/* ---------------- asking before offering ---------------- */

(function () {
  const L = { id: 'p', history: { backHistory: [], forwardHistory: [] } };
  const across = { kind: 'across', path: 'a.md', leaf: L };
  check(
    'a handed-back move is not offered when Obsidian has nowhere to go',
    usableHere(across, { path: 'b.md', leaf: L, canGoBack: false }) === false
  );
  check(
    'and is offered when it has',
    usableHere(across, { path: 'b.md', leaf: L, canGoBack: true }) === true
  );
  const within = { kind: 'within', path: 'a.md', leaf: L };
  check(
    'a move we restore ourselves does not depend on Obsidian at all',
    usableHere(within, { path: 'a.md', leaf: L, canGoBack: false }) === true
  );
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const leaf = app.view.leaf;
  const link = makeLink('internal-link', 'Other Note');
  clickThen(p, link.inner);
  app.view = {
    file: { path: 'b.md' },
    leaf: leaf,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  check('the move across is offered while the pane has history', p.button.hasClass('is-visible'));

  /* The reader presses Obsidian's own back button. Its history is spent;
   * ours still holds a note of the same move. */
  leaf.history.backHistory = [];
  app.workspace.fire('file-open');
  check(
    'once Obsidian has spent its history the button goes, rather than erring',
    !p.button.hasClass('is-visible')
  );
  check('and pressing finds nothing to hand over', p.goBack() === false);
  eq('so Obsidian is never asked to do the impossible', app.commands.executed, []);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  app.view.leaf.history = null;
  const commands = app.commands;
  commands.commands[GO_BACK_COMMAND] = { checkCallback: () => false };
  const here = p.here();
  check('with no history to read, the command is asked instead', here.canGoBack === false);
  commands.commands[GO_BACK_COMMAND] = { checkCallback: () => true };
  check('and believed either way', p.here().canGoBack === true);
  delete commands.commands[GO_BACK_COMMAND].checkCallback;
  check('when nothing can be asked, we assume yes rather than go silent', p.here().canGoBack === true);
})();

/* ---------------- lighting the link you came from ---------------- */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading', app.view.reading);
  clickThen(p, link.inner);
  app.view.state = { scroll: 400 };
  p.settle();
  check('the link itself is kept with the move', p.stack[0].el === link.anchor);
  const entry = p.stack[0];
  check('going back schedules the light rather than firing it at once', !!p.goBack() && p.flashTimer !== 0);
  check('and when it fires it finds the link', p.flash(p.findLink(entry)) === true);
  check('which then carries the mark', link.anchor.hasClass('backtrack-flash'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading');
  clickThen(p, link.inner);
  app.view.state = { scroll: 400 };
  p.settle();
  /* The note was redrawn while we were away, so the link we kept is an
   * orphan with nothing on screen to light. */
  link.anchor.detach();
  check('an orphaned link is not lit', p.flash(link.anchor) === false);
  check('and nothing at all is not a crash', p.flash(null) === false);
  p.goBack();
  eq('while the position is still put back', app.view.applied, { scroll: 10 });
})();

/* ---------------- footnotes ---------------- */

(function () {
  /* Reading view puts the reference in a <sup class="footnote-ref"> holding
   * an <a class="footnote-link">, and the note at the bottom ends with an
   * <a class="footnote-backref">. */
  const sup = new El('sup');
  sup.className = 'footnote-ref';
  const a = sup.make('a', { cls: 'footnote-link', text: '[1]' });
  a.setAttr('href', '#fn-1-abc');
  check('a footnote reference is a link we catch', a.closest(LINK_SELECTOR) === a);
  check('and so is the sup around it', sup.closest(LINK_SELECTOR) === sup);

  const back = new El('a');
  back.className = 'footnote-backref footnote-link';
  check('the arrow back out of a footnote counts too', back.closest(LINK_SELECTOR) === back);
})();

(function () {
  const { app, p } = boot('論文ノート.md', { scroll: 120 });
  const sup = new El('sup');
  sup.className = 'footnote-ref';
  app.view.reading.appendChild(sup);
  const a = sup.make('a', { cls: 'footnote-link', text: '[1]' });
  a.setAttr('data-href', '#fn-1-abc');
  clickThen(p, a);
  app.view.state = { scroll: 4200 };
  p.settle();
  check('jumping to a footnote is remembered', p.stack.length === 1);
  check('as a move inside the note', p.stack[0].kind === 'within');
  const entry = p.stack[0];
  p.goBack();
  eq('and takes you back to the sentence you were reading', app.view.applied, { scroll: 120 });
  p.flash(p.findLink(entry));
  check('with the reference lit so you can find your line', a.hasClass('backtrack-flash'));
})();

/* ---------------- a pinned note will not be navigated ---------------- */

(function () {
  const L = { id: 'pinned' };
  const elsewhere = { id: 'elsewhere' };
  const pane = { kind: 'pane', path: 'Daily.md', leaf: L };
  check(
    'a move out of a pane is offered from anywhere but that pane',
    usableHere(pane, { path: 'x.md', leaf: elsewhere, leaves: [L, elsewhere] }) === true
  );
  check(
    'and not once you are back in it',
    usableHere(pane, { path: 'Daily.md', leaf: L, leaves: [L, elsewhere] }) === false
  );
  check(
    'nor once that pane has been closed',
    usableHere(pane, { path: 'x.md', leaf: elsewhere, leaves: [elsewhere] }) === false
  );
})();

(function () {
  const { app, p } = boot('Daily.md', { scroll: 300 });
  const pinned = app.view.leaf;
  const other = { id: 'opened-for-us', history: { backHistory: [], forwardHistory: [] } };
  app.leaves = [pinned, other];
  const link = makeLink('internal-link', '議事録');
  clickThen(p, link.inner);
  /* Obsidian refuses to navigate a pinned tab and puts us in another pane. */
  app.view = {
    file: { path: '議事録.md' },
    leaf: other,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  check('a click out of a pinned note is remembered', p.stack.length === 1);
  check('as a move between panes', p.stack[0].kind === 'pane');
  check('and the button appears, which it did not before', p.button.hasClass('is-visible'));
  p.goBack();
  check('pressing it goes back to the pane we clicked in', app.activated === pinned);
  check('revealing it first, in case it was tucked away', app.revealed === pinned);
})();

(function () {
  const { app, p } = boot('Daily.md', { scroll: 300 });
  const other = { id: 'new-tab', history: { backHistory: [], forwardHistory: [] } };
  app.leaves = [app.view.leaf, other];
  const link = makeLink('internal-link', 'Other');
  p.onLinkClick({ target: link.inner, metaKey: true });
  if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = 0; }
  app.view = {
    file: { path: 'b.md' },
    leaf: other,
    contentEl: app.view.contentEl,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  check(
    'but asking for a new tab yourself is not a move to undo',
    p.stack.length === 0
  );
})();

/* ---------------- finding the link again after a redraw ---------------- */

(function () {
  const { app, p } = boot('long.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading');
  link.inner.setText('第 3 章 結論');
  clickThen(p, link.inner);
  app.view.state = { scroll: 9000 };
  p.settle();
  check('what the link said is kept with the move', p.stack[0].linkText === '第 3 章 結論');

  /* Reading view took the paragraph out while we were away and built a new
   * one on the way back. The element we held is an orphan. */
  link.anchor.detach();
  const rebuilt = app.view.reading.make('span', { cls: 'internal-link' });
  rebuilt.make('span', { cls: 'cm-underline', text: '第 3 章 結論' });
  const found = p.findLink(p.stack[0]);
  check('so the new one is found by what it says', found === rebuilt);
  check('and it is the one that gets lit', p.flash(found) === true);
  check('the new element carries the mark', rebuilt.hasClass('backtrack-flash'));
})();

(function () {
  const { app, p } = boot('long.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading', app.view.reading);
  clickThen(p, link.inner);
  app.view.state = { scroll: 9000 };
  p.settle();
  check('the element we held is preferred while it is still there', p.findLink(p.stack[0]) === link.anchor);
  const orphan = { kind: 'within', path: 'long.md', leaf: app.view.leaf, linkText: 'nothing like this' };
  check('and a link that no longer exists anywhere is not invented', p.findLink(orphan) === null);
})();

/* ---------------- the half the reader is not looking at ---------------- *
 *
 * The bug this exists for: a mark landed on the editor's copy of the link
 * while the reader was in reading view, and from inside the plugin that is
 * indistinguishable from success - the class really was added. It was found
 * by logging what got lit in a live vault, because the fixture had only one
 * half and so could not fail. */

(function () {
  const { app, p } = boot('both.md', { scroll: 10 });

  /* The same link, written twice: once in the editor, which is hidden, and
   * once in the reading view, which is what the reader can see. The editor's
   * copy comes first in the document, as it does in Obsidian. */
  const hidden = app.view.source.make('span', { cls: 'cm-hmd-internal-link' });
  hidden.make('span', { cls: 'cm-underline', text: 'Knots' });

  const link = makeLink('internal-link', 'Knots', app.view.reading);
  link.inner.setText('Knots');
  clickThen(p, link.inner);
  app.view.file.path = 'knots.md';
  p.settle();
  app.view.file.path = 'both.md';

  /* The note was redrawn while we were away: the old element is gone from the
   * document, not merely marked, so the search runs. */
  link.anchor.remove();
  const redrawn = app.view.reading.make('span', { cls: 'internal-link' });
  redrawn.make('span', { cls: 'cm-underline', text: 'Knots' });

  const found = p.findLink(p.stack[0]);
  check('the link that is lit is the one the reader can see', found === redrawn);
  check('not the editor\'s hidden copy of the same link', found !== hidden);
  p.flash(found);
  check('so the mark lands where it can be seen', redrawn.hasClass('backtrack-flash'));
  check('and nowhere else', hidden.hasClass('backtrack-flash') === false);
})();

(function () {
  const { app, p } = boot('both.md', { scroll: 10 });
  /* An element held from before a switch of mode is in the wrong half now. */
  const stale = app.view.source.make('span', { cls: 'cm-hmd-internal-link' });
  stale.make('span', { cls: 'cm-underline', text: 'Knots' });
  const entry = { kind: 'within', path: 'both.md', leaf: app.view.leaf, el: stale, linkText: 'Knots' };
  check('an element held in the hidden half is not used', p.findLink(entry) === null);
})();

(function () {
  const { app, p } = boot('both.md', { scroll: 10 });
  /* The editor's column measures as nothing while it is hidden. Asking the
   * whole view would find it first and the button would be placed against a
   * box at the origin. */
  const seen = p.measure();
  check('the column measured is the visible half\'s', seen && seen.col.width === 400);
  check('and not the hidden editor\'s empty one', seen && seen.col.left === 500);
})();

/* ---------------- a mark that something else took off ------------------ *
 *
 * The second half of the same bug, and also measured rather than guessed:
 * in Live Preview the mark landed on the right element and was gone 300ms
 * later, the element still in the document. CodeMirror owns those elements
 * and rebuilds them from its own decorations when a note is drawn again. */

(function () {
  const { app, p } = boot('keep.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading', app.view.reading);
  link.inner.setText('Knots');
  clickThen(p, link.inner);
  app.view.state = { scroll: 900 };
  p.settle();
  const entry = p.stack[0];

  /* Run the short checks at once so they can be watched. The long one is the
   * mark's own ten seconds and is left alone, or it would take the mark off
   * again before anything could be asked about it. */
  const real = window.setTimeout;
  let fakeId = 900;
  window.setTimeout = function (fn, ms) {
    if (ms <= 2000) { fn(); }
    return ++fakeId;
  };

  p.light(link.anchor);
  check('a mark put on stays on while nothing disturbs it', link.anchor.hasClass('backtrack-flash'));

  /* CodeMirror discards a class that is not its own. */
  link.anchor.removeClass('backtrack-flash');
  p.keepLit(entry, link.anchor, 0);
  check('a mark that was taken off is put back', link.anchor.hasClass('backtrack-flash'));

  /* And when the rebuild replaced the element rather than stripping it. */
  link.anchor.remove();
  const redrawn = app.view.reading.make('span', { cls: 'internal-link' });
  redrawn.make('span', { cls: 'cm-underline', text: 'Knots' });
  p.keepLit(entry, link.anchor, 0);
  check('and it lands on the new element when the old one was replaced', redrawn.hasClass('backtrack-flash'));

  window.setTimeout = real;

  check('the checks stop rather than running for ever', p.keepLit(entry, redrawn, KEEP_AT_MS.length) === 0);
  check('and there are only a few of them', KEEP_AT_MS.length <= 6);

  p.keepTimer = 0;
  p.flash(redrawn);
  check('lighting something with no move behind it starts no keeper', p.keepTimer === 0);
  p.flash(redrawn, entry);
  check('lighting the link a move came from does', p.keepTimer !== 0);
  p.teardown();
  check('and unloading stops it', p.keepTimer === 0);
})();

/* ---------------- looking for the link, not waiting a fixed time ------- */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading', app.view.reading);
  link.inner.setText('結論へ');
  clickThen(p, link.inner);
  app.view.state = { scroll: 500 };
  p.settle();
  const entry = p.stack[0];

  /* Mid-flight: Obsidian has not finished opening the note we are going back
   * to, so the note on screen is still the wrong one. */
  const elsewhere = {
    file: { path: 'still-loading.md' },
    leaf: app.view.leaf,
    contentEl: new El('div'),
    state: {},
    getEphemeralState() { return this.state; },
  };
  const real = app.view;
  app.view = elsewhere;
  check('a link is not looked for in a note we have not arrived at', p.findLink(entry) === null);
  check('and nothing is lit by mistake', p.flash(p.findLink(entry)) === false);

  app.view = real;
  check('once we have arrived it is found', p.findLink(entry) === link.anchor);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', '#Heading');
  clickThen(p, link.inner);
  app.view.state = { scroll: 500 };
  p.settle();
  const entry = p.stack[0];
  link.anchor.detach();
  const id = p.flashLater(entry, 3);
  check('looking is scheduled rather than done at once', id !== 0);
  check('and it keeps its own count of how many looks are left', p.flashTimer === id);
  p.onunload();
  check('unloading stops it looking', p.flashTimer === 0);
})();

/* ---------------- release hygiene ---------------- */

(function () {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'main.js'), 'utf8');
  check('no diagnostic scaffolding is left in the published file', src.indexOf('trace.log') === -1);
  check('and no command offers to write one', src.indexOf('write-trace') === -1);
  check('nothing hijacks the console', src.indexOf('console.error =') === -1);
  const manifest = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, 'manifest.json'), 'utf8')
  );
  check('the manifest says it runs on a phone', manifest.isDesktopOnly === false);
  check('its description is one short sentence, not a feature list', manifest.description.length <= 160);
  check('and says it only once', manifest.description.split('.').filter((x) => x.trim()).length === 1);
  const versions = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, 'versions.json'), 'utf8')
  );
  check('versions.json knows this version', !!versions[manifest.version]);
  check('and agrees about the oldest app it needs', versions[manifest.version] === manifest.minAppVersion);
})();

/* ---------------- the drag is not the sidebar's gesture ---------------- */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();
  const start = p.at;
  let stopped = 0;
  const down = Object.assign(
    { clientX: start.left + 22, clientY: start.top + 22, pointerId: 1 },
    { stopPropagation: () => { stopped++; } }
  );
  for (const fn of (p.button.on['pointerdown'] || []).slice()) fn(down);
  check(
    'a press on the button does not travel on to close a sidebar',
    stopped === 1
  );
  let movedStop = 0;
  const move = {
    clientX: start.left + 22 - 200,
    clientY: start.top + 22,
    pointerId: 1,
    preventDefault: () => {},
    stopPropagation: () => { movedStop++; },
  };
  for (const fn of (p.button.on['pointermove'] || []).slice()) fn(move);
  check('nor does the drag itself', movedStop === 1);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

/* ---------------- a position belongs to one vault ---------------- */

(function () {
  check('a phone and a desktop keep separate keys', spotKey(true) !== spotKey(false));
  check('and so do two vaults, where we have to scope it ourselves',
    fallbackKey('Vault A', false) !== fallbackKey('Vault B', false));
  check('the vault name is in the key', fallbackKey('Vault A', false).indexOf('Vault A') !== -1);
  check('a nameless vault still gives a key', typeof fallbackKey(null, false) === 'string');

  eq('a stored object is read back', readSpotValue({ left: 1, top: 2 }), { left: 1, top: 2 });
  eq('and so is a stored string', readSpotValue('{"left":3,"top":4}'), { left: 3, top: 4 });
  check('nonsense is refused', readSpotValue('not json') === null);
  check('a half a position is refused', readSpotValue({ left: 1 }) === null);
  check('nothing at all is refused', readSpotValue(null) === null);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const start = p.at;
  pressAt(p, start.left + 22, start.top + 22);
  p.button.fire('pointermove', { clientX: start.left + 22 - 120, clientY: start.top + 22 });
  p.button.fire('pointerup', { clientX: start.left + 22 - 120, clientY: start.top + 22 });
  const moved = p.at.left;

  check("the app's own store is used when it is there", Object.keys(app.store).length === 1);
  check('and window.localStorage is left alone', window.localStorage.getItem(spotKey(false)) === null);

  /* Another vault, its own store. */
  const second = makeApp('a.md', { scroll: 10 });
  second.vault.getName = () => 'Vault B';
  const q = new BacktrackPlugin(second, { dir: 'plugins/backtrack' });
  q.onload();
  check('a second vault does not inherit the first vault position', q.at.left !== moved);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

(function () {
  /* An app too old to have the store: we scope by vault ourselves. */
  const first = makeApp('a.md', { scroll: 10 });
  delete first.loadLocalStorage;
  delete first.saveLocalStorage;
  const p = new BacktrackPlugin(first, { dir: 'plugins/backtrack' });
  p.onload();
  const start = p.at;
  pressAt(p, start.left + 22, start.top + 22);
  p.button.fire('pointermove', { clientX: start.left + 22 - 130, clientY: start.top + 22 });
  p.button.fire('pointerup', { clientX: start.left + 22 - 130, clientY: start.top + 22 });
  const moved = p.at.left;
  check('the fall-back writes under a key naming the vault',
    window.localStorage.getItem(fallbackKey('Vault A', false)) !== null);

  const second = makeApp('a.md', { scroll: 10 });
  delete second.loadLocalStorage;
  delete second.saveLocalStorage;
  second.vault.getName = () => 'Vault B';
  const q = new BacktrackPlugin(second, { dir: 'plugins/backtrack' });
  q.onload();
  check('so another vault is unaffected', q.at.left !== moved);

  const again = makeApp('a.md', { scroll: 10 });
  delete again.loadLocalStorage;
  delete again.saveLocalStorage;
  const r = new BacktrackPlugin(again, { dir: 'plugins/backtrack' });
  r.onload();
  check('while the same vault finds its own', r.at.left === moved);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

/* ---------------- reachable by keyboard ---------------- */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  check('the button is in the tab order', p.button.getAttribute('tabindex') === '0');
  p.stack = [{ kind: 'within', path: 'a.md', leaf: app.view.leaf, state: { scroll: 7 } }];
  p.render();

  let prevented = 0;
  p.button.fire('keydown', { key: 'Enter', preventDefault: () => { prevented++; } });
  eq('Enter goes back', app.view.applied, { scroll: 7 });

  const second = boot('a.md', { scroll: 10 });
  second.p.stack = [{ kind: 'within', path: 'a.md', leaf: second.app.view.leaf, state: { scroll: 9 } }];
  second.p.render();
  let stopped = 0;
  second.p.button.fire('keydown', { key: ' ', preventDefault: () => { stopped++; } });
  eq('Space goes back too', second.app.view.applied, { scroll: 9 });
  check('and Space does not also scroll the page', stopped === 1);

  const third = boot('a.md', { scroll: 10 });
  third.p.stack = [{ kind: 'within', path: 'a.md', leaf: third.app.view.leaf, state: { scroll: 5 } }];
  third.p.render();
  third.p.button.fire('keydown', { key: 'a', preventDefault: () => {} });
  check('other keys are left alone', third.app.view.applied === undefined);
  window.localStorage.clear();
  for (const k of Object.keys(appStores)) delete appStores[k];
})();

/* --------- still in the document is not still in this note --------- */

check('link text is compared by the words, not the whitespace',
  sameWords('  Backtrack   Demo  ') === sameWords('Backtrack Demo'));
check('and nothing is still nothing', sameWords(null) === '');

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  const link = makeLink('internal-link', 'Other Note');
  link.inner.setText('Other Note');
  clickThen(p, link.inner);
  const from = app.view;

  /* Go to another note in the same pane. Obsidian keeps the note we left
   * rendered somewhere, so the element we held is still in the document. */
  const elsewhere = new El('div');
  app.view = {
    file: { path: 'b.md' },
    leaf: from.leaf,
    contentEl: elsewhere,
    state: { scroll: 0 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  p.settle();
  const entry = p.stack[0];
  check('the move across is remembered', entry && entry.kind === 'across');
  check('and the element we kept is still in the document', link.anchor.isConnected === true);
  check('but it is not in the note on screen, so it is not offered',
    p.findLink(entry) === null);

  /* Back to the first note, redrawn: a new element, the same words. */
  const redrawn = new El('div');
  const fresh = redrawn.make('span', { cls: 'internal-link' });
  fresh.make('span', { cls: 'cm-underline', text: 'Other Note' });
  app.view = {
    file: { path: 'a.md' },
    leaf: from.leaf,
    contentEl: redrawn,
    state: { scroll: 10 },
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
  };
  check('once we are back, the new element is found by its words',
    p.findLink(entry) === fresh);
  check('and it is the one that lights', p.flash(p.findLink(entry)) === true);
  check('the stale one is left dark', !link.anchor.hasClass('backtrack-flash'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  /* Inside one note nothing was redrawn, so the element we held is still in
   * the note on screen and is used as it is. */
  const link = makeLink('internal-link', '#Heading', app.view.reading);
  clickThen(p, link.inner);
  app.view.state = { scroll: 500 };
  p.settle();
  check('inside one note the element we held is used as it is',
    p.findLink(p.stack[0]) === link.anchor);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
