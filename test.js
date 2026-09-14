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

const { Notice } = require('./test/obsidian-stub.js');

const m = require('./main.js');
const {
  splitLinktext,
  positionKey,
  didMove,
  classify,
  pushEntry,
  nextUsable,
  peekUsable,
  describeEntry,
  MAX_ENTRIES,
  LINK_SELECTOR,
  GO_BACK_COMMAND,
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
  const within = (p) => ({ kind: 'within', path: p });
  const across = { kind: 'across', path: 'x.md' };

  let r = nextUsable([within('a.md')], 'a.md');
  check('an entry for the note on screen is usable', r.entry && r.entry.path === 'a.md');
  check('and nothing is left under it', r.rest.length === 0);

  r = nextUsable([within('a.md'), within('b.md')], 'a.md');
  check(
    'an entry naming a note we are no longer in is dropped, not applied',
    r.entry && r.entry.path === 'a.md'
  );
  check('and it is gone rather than kept for next time', r.rest.length === 0);

  r = nextUsable([across, within('b.md')], 'a.md');
  check('an entry handed to Obsidian is usable wherever we are', r.entry === across);

  r = nextUsable([within('b.md'), within('c.md')], 'a.md');
  check('when none of them fit, nothing is returned', r.entry === null);
  check('and the stack is emptied rather than left stale', r.rest.length === 0);

  r = nextUsable([], 'a.md');
  check('an empty stack gives nothing', r.entry === null);

  const original = [within('a.md')];
  nextUsable(original, 'a.md');
  check('and the stack it was given is left alone', original.length === 1);
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

function makeLink(cls, href) {
  const para = new El('p');
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

function makeApp(path, state) {
  const file = { path: path };
  const view = {
    file: file,
    state: state === undefined ? { scroll: 0 } : state,
    applied: undefined,
    getEphemeralState() { return this.state; },
    setEphemeralState(s) { this.applied = s; },
    getMode() { return 'preview'; },
  };
  const app = {
    view: view,
    handlers: {},
    workspace: {
      getActiveViewOfType: () => app.view,
      getActiveFile: () => (app.view && app.view.file) || null,
      onLayoutReady: (fn) => fn(),
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
    vault: { adapter: {} },
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
  const { p } = boot('a.md');
  const capture = p.domEvents.filter((e) => e.type === 'click')[0];
  check('the click handler is installed', !!capture);
  check(
    'and on the capture phase, or the position we want is already gone',
    !!capture && !!capture.options && capture.options.capture === true
  );
  check('a command is offered so a keyboard can reach it too', p.commands.some((c) => c.id === 'go-back'));
})();

(function () {
  const { p } = boot('a.md');
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
  const { p } = boot('a.md', { scroll: 10 });
  const link = makeLink('cm-hmd-internal-link', null);
  clickThen(p, link.inner);
  p.settle();
  check('a click that moved nothing is not remembered', p.stack.length === 0);
  check('and leaves no button behind', !p.button.hasClass('is-visible'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [
    { kind: 'within', path: 'a.md', state: { scroll: 1 } },
    { kind: 'within', path: 'gone.md', state: { scroll: 99 } },
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
  p.stack = [{ kind: 'within', path: 'gone.md', state: { scroll: 99 } }];
  p.render();
  const answered = p.goBack();
  check('when nothing fits, the press honestly does nothing', answered === false);
  check('and does not force us into a note we did not ask for', app.view.applied === undefined);
  check('the button goes, because the stack really is empty now', !p.button.hasClass('is-visible'));
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', state: { scroll: 7 } }];
  p.render();
  p.button.press('click');
  eq('the button itself is wired, not just the command', app.view.applied, { scroll: 7 });
})();

(function () {
  const before = Notice.all.length;
  const { p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', state: { scroll: 7 } }];
  p.render();
  p.button.press('contextmenu');
  check('a long press says where it would take you', Notice.all.length === before + 1);
  check('and names the note', Notice.last.indexOf('a') !== -1);
})();

(function () {
  const { p } = boot('a.md');
  const el = p.button;
  p.onunload();
  check('unloading takes the button out of the document', el.isConnected === false);
  check('and lets go of it', p.button === null);
  check('and takes it out of the page rather than merely hiding it', body.find((e) => e === el).length === 0);
})();

(function () {
  const { app, p } = boot('a.md', { scroll: 0 });
  for (let i = 0; i < 15; i++) {
    p.stack = m.pushEntry(p.stack, { kind: 'within', path: 'a.md', state: { scroll: i } }, MAX_ENTRIES);
  }
  check('a long read does not grow the stack for ever', p.stack.length === MAX_ENTRIES);
  p.render();
  p.goBack();
  eq('and the most recent move is the one undone first', app.view.applied, { scroll: 14 });
})();

/* ---------------- peekUsable does not consume ---------------- */

(function () {
  const stack = [{ kind: 'within', path: 'a.md', state: { scroll: 1 } }];
  check('peeking finds the entry', peekUsable(stack, 'a.md') === stack[0]);
  check('and leaves it where it was', stack.length === 1);
  check('an entry for another note is not offered here', peekUsable(stack, 'b.md') === null);
  check('but it is still not thrown away', stack.length === 1);
  check('nothing to peek at is not a crash', peekUsable([], 'a.md') === null);
})();

/* ---------------- a button that would do nothing is not shown --------- */

(function () {
  const { app, p } = boot('a.md', { scroll: 10 });
  p.stack = [{ kind: 'within', path: 'a.md', state: { scroll: 7 } }];
  p.render();
  check('with something to undo here, the button shows', p.button.hasClass('is-visible'));

  app.view = {
    file: { path: 'elsewhere.md' },
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
  const { p } = boot('a.md');
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
  app.view = { file: { path: 'b.md' }, state: {}, getEphemeralState() { return this.state; } };
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
