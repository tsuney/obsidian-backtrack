'use strict';

/*
 * Backtrack
 * ---------------------------------------------------------------------------
 * One button that undoes the last move.
 *
 * Obsidian already goes back well between notes: press it and you land where
 * you were reading, part way down the page. What it cannot do is go back
 * inside a note. A jump to a heading or a block never becomes a history
 * entry, so the back command skips over it and takes you to whatever note you
 * had open before. On a long note read through its own table of contents,
 * that is the move you most want to undo.
 *
 * The obvious fix - a second control that only handles jumps inside a note  - 
 * asks the reader to remember how they arrived. They do not. Reading mixes
 * the two kinds freely: note to note, then a heading inside that note, then
 * out to a third note. Two controls for one intention is two answers to one
 * question, and the reader will pick the wrong one.
 *
 * So there is one control, and it means "undo the last move". Inside a note
 * it restores the position itself. Between notes it hands the job to
 * Obsidian's own back command, because that already works and a position kept
 * in two places is a position that will disagree with itself.
 *
 * It is a button rather than a hotkey because this has to work on a phone,
 * where there are no hotkeys and no hover preview - the place the problem
 * hurts most.
 *
 * No build step: this is plain CommonJS.
 */

const obsidian = require('obsidian');
const { Plugin, Notice, MarkdownView, Platform, setIcon } = obsidian;

/* How many moves we are willing to remember. */
const MAX_ENTRIES = 10;

/* How long to wait after a click before asking where we ended up. Obsidian
 * scrolls to a heading asynchronously, so reading the position in the click
 * handler itself would read the position we just left. */
const SETTLE_MS = 140;

/* After handing a move back to Obsidian, how long before we check that
 * something actually happened. */
const VERIFY_MS = 300;

const LONG_PRESS_MS = 450;

/* How far a finger may wander before it is a drag rather than a press. */
const DRAG_SLOP = 6;

/* The gap kept between the button and whatever it sits beside. */
const GAP = 12;

/* Where down the note the button sits by default: below the eye line, so it
 * is not in the way of the line being read, and within reach of a thumb.
 * A ratio rather than a measurement, so it means the same thing on a phone
 * as on a desktop. */
const DOWN_THE_PAGE = 0.62;

/* Reading view renders an <a class="internal-link">; Live Preview renders a
 * span pair, the outer of which carries cm-hmd-internal-link. Clicks land on
 * inner spans in both, so these are matched with closest(). */
const LINK_SELECTOR = '.internal-link,.cm-hmd-internal-link';

/* Obsidian's own back command. This id is not part of the public API, so it
 * is recorded as a dependency in the project note, and success is judged by
 * whether the open file actually changed rather than by what the call
 * returns. */
const GO_BACK_COMMAND = 'app:go-back';

const TRACE_FILE = 'trace.log';

/* ------------------------------------------------------------------ *
 * Pure helpers. Everything below this line can be tested without an
 * app, a window or a vault, and everything above the plugin class is
 * exported for that purpose.
 * ------------------------------------------------------------------ */

/* "Note#heading" -> { path: "Note", subpath: "#heading" }.
 * "#heading"     -> { path: "",     subpath: "#heading" } */
function splitLinktext(href) {
  const s = String(href == null ? '' : href);
  const i = s.indexOf('#');
  if (i < 0) return { path: s, subpath: '' };
  return { path: s.slice(0, i), subpath: s.slice(i) };
}

/* A comparable stand-in for a position. The shape Obsidian puts in ephemeral
 * state is not documented, so nothing here may depend on which fields it
 * has; two states are the same position when they serialise the same way.
 * A state that cannot be serialised compares equal to itself and to nothing
 * else, which errs towards "we did not move" - the href hint in didMove()
 * covers the case that matters. */
function positionKey(state) {
  if (state === null || state === undefined) return '';
  try {
    return JSON.stringify(state);
  } catch (e) {
    return '[opaque]';
  }
}

/* Did the click move us within the same note?
 *
 * A link written as "#heading" or "#^block" can only point inside the note it
 * is in, so it is proof on its own. Otherwise we compare the position before
 * and after. */
function didMove(before, after, href) {
  if (href && String(href).charAt(0) === '#') return true;
  return positionKey(before) !== positionKey(after);
}

/* What kind of move just happened, given where we were and where we are. */
function classify(fromPath, toPath, moved) {
  if (!fromPath || !toPath) return null;
  if (fromPath !== toPath) return 'across';
  return moved ? 'within' : null;
}

/* Push, oldest dropped first. Returns a new array; the old one is untouched
 * so a caller can compare. */
function pushEntry(stack, entry, max) {
  const limit = typeof max === 'number' && max > 0 ? max : MAX_ENTRIES;
  const next = stack.concat([entry]);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/* The topmost entry we can actually use, and what is left underneath.
 *
 * An entry that names a file other than the one on screen cannot be applied:
 * the reader has gone somewhere else by hand, and forcing them back to a note
 * they did not ask for is worse than doing nothing. Such entries are dropped
 * rather than kept, because a stale entry that survives will be just as wrong
 * the next time. Entries handed to Obsidian carry no file of their own and
 * are always usable. */
function nextUsable(stack, currentPath) {
  const rest = stack.slice();
  while (rest.length) {
    const entry = rest.pop();
    if (entry.kind === 'across') return { entry: entry, rest: rest };
    if (entry.path === currentPath) return { entry: entry, rest: rest };
  }
  return { entry: null, rest: rest };
}

/* Where the button goes when nobody has moved it.
 *
 * Beside the column of text, not in the far corner of the screen: on a wide
 * window the corner is a long way from the line being read. The column's own
 * edge is asked for the number, so it follows the width the reader has
 * chosen instead of a measurement taken once on one screen. Where the margin
 * is too narrow to stand in - a phone, a split pane - clampSpot() brings it
 * back inside.
 */
function defaultSpot(col, pane, size) {
  return {
    left: col.right + GAP,
    top: pane.top + pane.height * DOWN_THE_PAGE - size / 2,
  };
}

/* Keep the button inside the pane it belongs to.
 *
 * The pane, not the window: its edges already exclude the status bar on a
 * desktop and the toolbar on a phone, so nothing here has to know those
 * exist. Applied on every placement, so a position remembered on a larger
 * screen cannot strand the button where it can never be pressed. */
function clampSpot(spot, pane, size) {
  const minLeft = GAP;
  const maxLeft = Math.max(minLeft, pane.right - size - GAP);
  const minTop = pane.top + GAP;
  const maxTop = Math.max(minTop, pane.bottom - size - GAP);
  return {
    left: Math.min(Math.max(spot.left, minLeft), maxLeft),
    top: Math.min(Math.max(spot.top, minTop), maxTop),
  };
}

/* A finger that has travelled this far was moving the button, not pressing
 * it. Without a threshold every press on a touch screen would be a drag. */
function isDrag(dx, dy) {
  return Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP;
}

/* A position measured on one screen means nothing on another, so a phone and
 * a desktop remember separately rather than handing each other a number
 * neither can use. */
function spotKey(isMobile) {
  return 'backtrack/spot/' + (isMobile ? 'mobile' : 'desktop');
}

/* The topmost usable entry, without disturbing anything.
 *
 * render() needs this and must not consume: a reader who wanders off by hand
 * and comes back should find the button where they left it, not find that
 * looking at the screen threw their place away. */
function peekUsable(stack, currentPath) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry.kind === 'across') return entry;
    if (entry.path === currentPath) return entry;
  }
  return null;
}

/* What to call the place a button press would take you. */
function describeEntry(entry) {
  if (!entry) return '';
  if (entry.kind === 'across') return 'the note you came from';
  const name = String(entry.path || '').split('/').pop().replace(/\.md$/, '');
  return name ? 'where you were in ' + name : 'where you were';
}

/* ------------------------------------------------------------------ */

class BacktrackPlugin extends Plugin {
  onload() {
    this.stack = [];
    this.pending = null;
    this.settleTimer = 0;
    this.pressTimer = 0;
    this.button = null;
    this.press = null;
    this.suppressClick = false;
    this.at = null;

    /* Capture phase on purpose. Obsidian's own handler runs on the way back
     * up and moves the view; by then the position we want is gone. */
    this.registerDomEvent(document, 'click', this.onLinkClick.bind(this), { capture: true });

    this.addCommand({
      id: 'go-back',
      name: 'Undo the last move',
      callback: () => {
        this.goBack();
      },
    });

    this.addCommand({
      id: 'reset-position',
      name: 'Put the button back',
      callback: () => {
        this.forgetSpot();
        this.place();
      },
    });

    this.addCommand({
      id: 'write-trace',
      name: 'Write a debug trace',
      callback: () => {
        this.writeTrace();
      },
    });

    /* The button's answer depends on which note is on screen, so it has to be
     * asked again whenever that changes. A judgement nobody re-runs keeps
     * showing yesterday's conclusion. */
    const again = () => {
      this.render();
      this.place();
    };
    if (typeof this.app.workspace.on === 'function') {
      this.registerEvent(this.app.workspace.on('active-leaf-change', again));
      this.registerEvent(this.app.workspace.on('file-open', again));
      this.registerEvent(this.app.workspace.on('resize', again));
    }
    this.registerDomEvent(window, 'resize', again);

    this.app.workspace.onLayoutReady(() => this.ensureButton());
  }

  onunload() {
    this.teardown();
  }

  teardown() {
    if (this.settleTimer) window.clearTimeout(this.settleTimer);
    if (this.pressTimer) window.clearTimeout(this.pressTimer);
    this.settleTimer = 0;
    this.pressTimer = 0;
    if (this.button) {
      this.button.remove();
      this.button = null;
    }
  }

  activeView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  /* Can Obsidian still take a note-to-note move back?
   *
   * The command id is not public API. Leaning on something unpromised means
   * deciding in advance where to land when it is gone, and the landing here is
   * to not offer the move at all: a button that does nothing is worse than no
   * button. So this is asked before an across entry is ever remembered, not
   * after the reader has pressed. */
  canHandBack() {
    const commands = this.app && this.app.commands;
    if (!commands || typeof commands.executeCommandById !== 'function') return false;
    const known = commands.commands;
    if (known && typeof known === 'object') return !!known[GO_BACK_COMMAND];
    return true;
  }

  /* --- remembering ------------------------------------------------ */

  onLinkClick(evt) {
    const target = evt && evt.target;
    if (!target || typeof target.closest !== 'function') return;
    const anchor = target.closest(LINK_SELECTOR);
    if (!anchor) return;

    const view = this.activeView();
    if (!view || !view.file) return;

    const href =
      (typeof anchor.getAttribute === 'function' &&
        (anchor.getAttribute('data-href') || anchor.getAttribute('href'))) ||
      null;

    this.pending = {
      path: view.file.path,
      state: this.readState(view),
      href: href,
    };

    if (this.settleTimer) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = 0;
      this.settle();
    }, SETTLE_MS);
  }

  readState(view) {
    if (!view || typeof view.getEphemeralState !== 'function') return null;
    try {
      return view.getEphemeralState();
    } catch (e) {
      return null;
    }
  }

  /* Called once the click has had time to take effect. */
  settle() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;

    const view = this.activeView();
    if (!view || !view.file) return;

    const now = view.file.path;
    const moved = didMove(pending.state, this.readState(view), pending.href);
    const kind = classify(pending.path, now, moved);
    if (!kind) return;

    if (kind === 'across' && !this.canHandBack()) return;

    const entry =
      kind === 'across'
        ? { kind: 'across', path: pending.path }
        : { kind: 'within', path: pending.path, state: pending.state };

    this.stack = pushEntry(this.stack, entry, MAX_ENTRIES);
    this.render();
  }

  /* --- going back -------------------------------------------------- */

  goBack() {
    const view = this.activeView();
    const picked = nextUsable(this.stack, this.currentPath());
    this.stack = picked.rest;

    if (!picked.entry) {
      this.render();
      return false;
    }

    if (picked.entry.kind === 'across') {
      this.handBack();
      this.render();
      return true;
    }

    try {
      view.setEphemeralState(picked.entry.state);
    } catch (e) {
      new Notice('Backtrack could not restore that position.');
    }
    this.render();
    return true;
  }

  /* Hand a note-to-note move to Obsidian. We do not trust the return value:
   * the command id is not public API, so the only honest test is whether the
   * open file changed. */
  handBack() {
    const app = this.app;
    const before = app.workspace.getActiveFile();
    const commands = app.commands;
    if (commands && typeof commands.executeCommandById === 'function') {
      commands.executeCommandById(GO_BACK_COMMAND);
    }
    window.setTimeout(() => {
      if (app.workspace.getActiveFile() === before) {
        new Notice('Backtrack: Obsidian did not go back. The back command may have changed.');
      }
    }, VERIFY_MS);
  }

  /* --- the button -------------------------------------------------- */

  ensureButton() {
    if (this.button) return this.button;
    const host = document.body;
    if (!host || typeof host.createDiv !== 'function') return null;

    const el = host.createDiv({ cls: 'backtrack-fab' });
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'Undo the last move');
    setIcon(el, 'undo-2');

    /* One gesture, read three ways: a press goes back, a press held says
     * where it would go, a press that travels moves the button. They are
     * told apart by distance and time, not by three separate controls. */
    el.addEventListener('pointerdown', (e) => this.onPress(e));
    el.addEventListener('pointermove', (e) => this.onPressMove(e));
    el.addEventListener('pointerup', (e) => this.onPressEnd(e));
    el.addEventListener('pointercancel', () => this.endPress());
    el.addEventListener('click', () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.goBack();
    });
    el.addEventListener('contextmenu', (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      this.sayWhere();
    });

    this.button = el;
    this.render();
    this.place();
    return el;
  }

  /* Nothing here is on a timer. A control that disappears by itself has to be
   * looked for every time, and a control you have to look for is one you stop
   * trusting. It goes when there is nothing left to undo, and not before. */
  /* --- where it sits ----------------------------------------------- */

  /* The pane we are in, and the column of text inside it. Read fresh every
   * time: the reader can widen the window, split the pane or turn the phone,
   * and a number taken once would outlive all three. */
  measure() {
    const view = this.activeView();
    const host = view && view.contentEl;
    if (!host || typeof host.getBoundingClientRect !== 'function') return null;
    const pane = host.getBoundingClientRect();
    if (!pane || !pane.height) return null;
    const inner =
      (typeof host.querySelector === 'function' &&
        host.querySelector('.markdown-preview-sizer, .cm-sizer, .cm-content')) ||
      host;
    const col =
      inner && typeof inner.getBoundingClientRect === 'function'
        ? inner.getBoundingClientRect()
        : pane;
    return { pane: pane, col: col };
  }

  size() {
    const el = this.button;
    const box = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    return box && box.width ? box.width : 44;
  }

  readSpot() {
    try {
      const raw = window.localStorage.getItem(spotKey(!!(Platform && Platform.isMobile)));
      if (!raw) return null;
      const spot = JSON.parse(raw);
      if (!spot || typeof spot.left !== 'number' || typeof spot.top !== 'number') return null;
      return spot;
    } catch (e) {
      return null;
    }
  }

  saveSpot(spot) {
    try {
      window.localStorage.setItem(spotKey(!!(Platform && Platform.isMobile)), JSON.stringify(spot));
    } catch (e) {
      /* A position we cannot remember is not worth a message. */
    }
  }

  forgetSpot() {
    try {
      window.localStorage.removeItem(spotKey(!!(Platform && Platform.isMobile)));
    } catch (e) {
      /* nothing to undo */
    }
  }

  /* Put the button where it belongs: where it was left, or beside the column
   * if it has never been moved. Either way inside the pane. */
  place(spot) {
    if (!this.button) return null;
    const seen = this.measure();
    if (!seen) return null;
    const size = this.size();
    const wanted = spot || this.readSpot() || defaultSpot(seen.col, seen.pane, size);
    const at = clampSpot(wanted, seen.pane, size);
    const style = this.button.style;
    style.setProperty('left', at.left + 'px');
    style.setProperty('top', at.top + 'px');
    style.setProperty('right', 'auto');
    style.setProperty('bottom', 'auto');
    this.at = at;
    return at;
  }

  /* --- the gesture -------------------------------------------------- */

  onPress(e) {
    const at = this.at || this.place();
    this.press = {
      x: e.clientX,
      y: e.clientY,
      left: at ? at.left : 0,
      top: at ? at.top : 0,
      moved: false,
    };
    if (this.button && typeof this.button.setPointerCapture === 'function' && e.pointerId !== undefined) {
      this.button.setPointerCapture(e.pointerId);
    }
    if (this.pressTimer) window.clearTimeout(this.pressTimer);
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = 0;
      if (this.press && !this.press.moved) this.sayWhere();
    }, LONG_PRESS_MS);
  }

  onPressMove(e) {
    if (!this.press) return;
    const dx = e.clientX - this.press.x;
    const dy = e.clientY - this.press.y;
    if (!this.press.moved && !isDrag(dx, dy)) return;
    this.press.moved = true;
    if (this.pressTimer) {
      window.clearTimeout(this.pressTimer);
      this.pressTimer = 0;
    }
    if (typeof e.preventDefault === 'function') e.preventDefault();
    this.place({ left: this.press.left + dx, top: this.press.top + dy });
  }

  onPressEnd(e) {
    const press = this.press;
    if (!press) return;
    if (press.moved) {
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      const at = this.place({ left: press.left + dx, top: press.top + dy });
      if (at) this.saveSpot(at);
      /* The browser sends a click after the pointer goes up. A drag is not a
       * press, so that one is swallowed rather than taken as "go back". */
      this.suppressClick = true;
    }
    this.endPress();
  }

  endPress() {
    if (this.pressTimer) {
      window.clearTimeout(this.pressTimer);
      this.pressTimer = 0;
    }
    this.press = null;
  }

  render() {
    if (!this.button) return;
    const usable = peekUsable(this.stack, this.currentPath());
    this.button.toggleClass('is-visible', !!usable);
    this.button.setAttribute(
      'aria-label',
      usable ? 'Back to ' + describeEntry(usable) : 'Undo the last move'
    );
  }

  currentPath() {
    const view = this.activeView();
    return view && view.file ? view.file.path : null;
  }

  sayWhere() {
    const usable = peekUsable(this.stack, this.currentPath());
    new Notice(usable ? 'Back to ' + describeEntry(usable) : 'Nothing to undo');
  }

  /* --- trace ------------------------------------------------------- */

  /* The shape of ephemeral state is undocumented. Rather than guess from the
   * console over someone's shoulder, write one sample to a file inside the
   * plugin folder where it can be read directly. Off unless asked for, and to
   * be removed before this goes anywhere public. */
  async writeTrace() {
    const view = this.activeView();
    const state = this.readState(view);
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        file: view && view.file ? view.file.path : null,
        mode: view && typeof view.getMode === 'function' ? view.getMode() : null,
        state: state,
        stack: this.stack.map((e) => ({ kind: e.kind, path: e.path })),
      }) + '\n';
    const path = this.manifest.dir + '/' + TRACE_FILE;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(path)) await adapter.append(path, line);
      else await adapter.write(path, line);
      new Notice('Backtrack: wrote a trace line.');
    } catch (e) {
      new Notice('Backtrack: could not write the trace.');
    }
  }
}

module.exports = BacktrackPlugin;
module.exports.default = BacktrackPlugin;
module.exports.BacktrackPlugin = BacktrackPlugin;
module.exports.splitLinktext = splitLinktext;
module.exports.positionKey = positionKey;
module.exports.didMove = didMove;
module.exports.classify = classify;
module.exports.pushEntry = pushEntry;
module.exports.nextUsable = nextUsable;
module.exports.peekUsable = peekUsable;
module.exports.defaultSpot = defaultSpot;
module.exports.clampSpot = clampSpot;
module.exports.isDrag = isDrag;
module.exports.spotKey = spotKey;
module.exports.GAP = GAP;
module.exports.DRAG_SLOP = DRAG_SLOP;
module.exports.describeEntry = describeEntry;
module.exports.MAX_ENTRIES = MAX_ENTRIES;
module.exports.LINK_SELECTOR = LINK_SELECTOR;
module.exports.GO_BACK_COMMAND = GO_BACK_COMMAND;
