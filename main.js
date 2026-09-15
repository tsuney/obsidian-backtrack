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
const { Plugin, Notice, MarkdownView, Platform, setIcon, setTooltip } = obsidian;

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

/* Looking for the link to light: how often, and for how long at most.
 * Going back to another note means opening and drawing it, and how long that
 * takes is not ours to know, so it is watched for rather than waited out. */
const LOOK_EVERY_MS = 100;
const LOOK_ATTEMPTS = 40;

/* When to check that the mark is still there, measured from the moment it was
 * put on. In Live Preview the link is CodeMirror's element, and CodeMirror
 * rebuilds its decorations after a note is drawn again, discarding any class
 * that is not its own. A handful of checks over the first couple of seconds
 * covers the drawing and then stops: a mark defended for ever would flicker,
 * and would fight the reader the moment they edited the line. */
const KEEP_AT_MS = [200, 500, 1000, 2000];

/* How long the link you came from stays lit after you land back on it.
 *
 * Ten seconds, which is long for a mark on a page - but the reader arrives
 * with their eye still travelling, and a mark that has gone by the time they
 * look was never there for them. It does not sit still for ten seconds: it
 * arrives filled, settles to a thin ring within the first second, and fades
 * from there, so what remains is a marker rather than a highlight. */
const FLASH_MS = 10000;

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
 * inner spans in both, so these are matched with closest().
 *
 * Footnotes are here too, and they are not internal links: they carry their
 * own classes. They are the case this plugin exists for in miniature - the
 * reference sits mid-sentence and the note sits at the very bottom of the
 * page - so leaving them out would be leaving out the obvious one. Obsidian
 * does put a small arrow at the end of each footnote to get back, but only
 * from the footnote, and only when the reader notices it is there. */
const LINK_SELECTOR =
  '.internal-link,.cm-hmd-internal-link,.footnote-link,.footnote-ref,.footnote-backref,.cm-footref';

/* Obsidian's own back command. This id is not part of the public API, so it
 * is recorded as a dependency in the project note, and success is judged by
 * whether the open file actually changed rather than by what the call
 * returns. */
const GO_BACK_COMMAND = 'app:go-back';

/* The events a press on a link can reach us as. One gesture usually produces
 * more than one of these, and the first to arrive is the one we trust. */
const CATCH_EVENTS = ['pointerup', 'touchend', 'click'];

/* How much of a link's text a label will carry. Long enough to recognise the
 * link, short enough that the label stays a label. */
const LABEL_WORDS = 42;

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
function usableHere(entry, here) {
  if (!entry || !here) return false;
  /* A move to another pane is undone by going back to the pane it came from,
   * so it is offered everywhere except there, and only while that pane is
   * still open. This is the pinned-note case: the reader clicked an ordinary
   * link, and Obsidian, refusing to navigate a pinned tab, put them in a
   * different pane. Nothing scrolled, but their attention moved, and moving
   * it back is exactly what they will want. */
  if (entry.kind === 'pane') {
    if (entry.leaf === here.leaf) return false;
    return !!(here.leaves && here.leaves.indexOf(entry.leaf) !== -1);
  }
  /* The move belongs to the pane it was made in. Close that pane, or step
   * into another one, and the move has nothing left to act on: Obsidian's
   * own history went with the pane, and a note restored into a different
   * pane is not where the reader was. */
  if (entry.leaf !== here.leaf) return false;
  /* A move we handed to Obsidian is only ours to offer while Obsidian still
   * has somewhere to go. Our note of the move and its history are two
   * records of one thing and they drift apart: press its own back button,
   * close a tab, and ours is left pointing at nothing. Asking first is the
   * difference between not offering a move and apologising for one. */
  if (entry.kind === 'across') return !!here.canGoBack;
  return entry.path === here.path;
}

function nextUsable(stack, here) {
  const rest = stack.slice();
  while (rest.length) {
    const entry = rest.pop();
    if (usableHere(entry, here)) return { entry: entry, rest: rest };
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

/* The same, for the fall-back store.
 *
 * Obsidian's desktop runs every vault on one origin, so window.localStorage
 * is shared between them: a key without the vault's name in it is one answer
 * for a question each vault asks separately. The app's own store scopes by
 * vault already, so this shape is only needed where that store is missing. */
function fallbackKey(vaultName, isMobile) {
  return 'backtrack/' + String(vaultName || 'vault') + '/spot/' + (isMobile ? 'mobile' : 'desktop');
}

/* The app's store hands back whatever was put in; an older one, or the
 * fall-back, hands back a string. Accept either, and refuse anything that is
 * not a pair of numbers. */
function readSpotValue(raw) {
  let spot = raw;
  if (typeof raw === 'string') {
    try {
      spot = JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  if (!spot || typeof spot.left !== 'number' || typeof spot.top !== 'number') return null;
  return { left: spot.left, top: spot.top };
}

/* The topmost usable entry, without disturbing anything.
 *
 * render() needs this and must not consume: a reader who wanders off by hand
 * and comes back should find the button where they left it, not find that
 * looking at the screen threw their place away. */
function peekUsable(stack, here) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (usableHere(stack[i], here)) return stack[i];
  }
  return null;
}

/* Two pieces of link text are the same if they read the same. Rendering can
 * add or lose whitespace around and inside a link between one drawing of a
 * note and the next, and a comparison that fails on a doubled space would
 * quietly find nothing. */
function sameWords(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/* The half of the view the reader is actually looking at.
 *
 * A markdown view holds both halves at once: the reading view and the editor.
 * The one not in use is hidden, not thrown away, so searching the whole view
 * finds two of every link - and the first of the two is in the half nobody
 * can see. Lighting that one does exactly what going back between notes
 * looked like from the reader's chair: nothing at all. Worse, it looks like
 * success from in here, because the class really was added.
 *
 * Measured rather than reasoned about: the log showed a mark landing on a
 * cm-hmd-internal-link inside markdown-source-view while the note was on
 * screen in reading mode, and CodeMirror stripping the unknown class again
 * within 300ms. */
function visibleHalf(view) {
  const host = view && view.contentEl;
  if (!host || typeof host.querySelector !== 'function') return host || null;
  const mode = typeof view.getMode === 'function' ? view.getMode() : null;
  const want =
    mode === 'source' ? '.markdown-source-view' : mode === 'preview' ? '.markdown-reading-view' : null;
  /* An older layout that has no such half, or a mode we do not know, is
   * better served by the whole view than by nothing. */
  if (!want) return host;
  return host.querySelector(want) || host;
}

/* Which document an element belongs to.
 *
 * A pop-out window is a separate document with its own body, and a button in
 * the main window's body is not in it - it is not merely misplaced, it is not
 * there at all. Obsidian hangs a `doc` on elements for exactly this; the
 * standard `ownerDocument` is the fallback. */
function docOf(el) {
  if (!el) return null;
  return el.doc || el.ownerDocument || null;
}

/* "10s", "0.5s", "250ms", "10" -> milliseconds. Anything unusable -> 0, so a
 * caller can fall back rather than light something for no time at all. */
function readSeconds(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return 0;
  const n = parseFloat(text);
  if (!isFinite(n) || n <= 0) return 0;
  return /ms\s*$/.test(text) ? n : n * 1000;
}

/* A note's name, without its folder or its extension. */
function noteName(path) {
  return String(path || '').split('/').pop().replace(/\.md$/, '');
}

/* Link text, short enough to sit in a label. */
function shorten(text, most) {
  const words = sameWords(text);
  const limit = most || LABEL_WORDS;
  if (words.length <= limit) return words;
  return words.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
}

/* What to call the place a button press would take you.
 *
 * Named, not described. "The note you came from" is a true sentence that
 * withholds what the reader wants: which note. We hold the name, so we say it.
 *
 * With one honest caveat, for the note-to-note case. That move is handed to
 * Obsidian, and where it lands is decided by the pane's own history, which is
 * a second record of the same thing and can disagree with ours. Naming the
 * note is therefore a promise that can be broken. It is worth making: being
 * told the wrong name costs a glance, and being told nothing costs the reader
 * the decision of whether to press at all. */
function describeEntry(entry) {
  if (!entry) return '';
  const name = noteName(entry.path);
  if (entry.kind === 'across') return name || 'the note you came from';
  if (entry.kind === 'pane') {
    return name ? 'the pane you clicked in (' + name + ')' : 'the pane you clicked in';
  }
  /* Inside one note, the note's name says nothing - the reader is in it. What
   * they left from is the link, so that is what is named. */
  const words = shorten(entry.linkText);
  if (words) return 'your place before "' + words + '"';
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
    this.flashTimer = 0;
    this.keepTimer = 0;
    this.suppressClick = false;
    this.at = null;

    /* Capture phase on purpose. Obsidian's own handler runs on the way back
     * up and moves the view; by then the position we want is gone.
     *
     * Three kinds of event, not one. A tap is not obliged to reach us as a
     * click: a platform may take the touch for itself and never let the click
     * through, and which one it lets through is not ours to choose. Listening
     * only for the click means the capture works or fails per platform, for
     * reasons we cannot see from here. Listening for all three makes it not
     * depend on the answer.
     *
     * Over-catching costs nothing. What is caught is only a candidate: 140ms
     * later we look at where we actually are, and if nothing moved, nothing
     * is remembered. The decision was never the event's to make. */
    this.catchLinkEvent = this.onLinkClick.bind(this);
    this.wired = [];
    this.wire(document);

    this.addCommand({
      id: 'go-back',
      name: 'Undo the last move',
      callback: () => {
        this.goBack();
      },
    });

    /* The same answer a long press on the button gives, without the button.
     *
     * Holding the button says where it would take you. That is fine until the
     * button is not in front of you - it is off the bottom of a phone, or the
     * reader is in a mode where there is nothing to undo and so nothing is
     * drawn. Asking should not require first finding the thing you are asking
     * about. */
    this.addCommand({
      id: 'say-where',
      name: 'Where would it take me?',
      callback: () => {
        this.sayWhere();
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


    /* The button's answer depends on which note is on screen, so it has to be
     * asked again whenever that changes. A judgement nobody re-runs keeps
     * showing yesterday's conclusion. */
    const again = () => {
      this.ensureButton();
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
    if (this.flashTimer) window.clearTimeout(this.flashTimer);
    if (this.keepTimer) window.clearTimeout(this.keepTimer);
    this.settleTimer = 0;
    this.pressTimer = 0;
    this.flashTimer = 0;
    this.keepTimer = 0;
    if (this.button) {
      this.button.remove();
      this.button = null;
    }
  }

  activeView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  /* --- more than one window ---------------------------------------- *
   *
   * "Open in new window" puts a note in a separate document, with its own
   * body and its own events. A plugin that only ever looked at `document`
   * has, from that window's point of view, not been installed: no button in
   * the body, and no listener to catch a press. Nothing was misplaced - there
   * was nothing there.
   *
   * So both the button and the listeners follow the note. The button is built
   * in whichever document holds the view the reader is in, and rebuilt when
   * that changes; a window is wired for presses the first time it is used. */

  /* The document the reader is looking at: the one holding the active view,
   * and the main one when there is no view to ask. */
  activeDoc() {
    const view = this.activeView();
    return docOf(view && view.contentEl) || document;
  }

  /* Catch presses in this window. Once per window: registerDomEvent is the
   * plugin's own, so all of them are taken down when it unloads. */
  wire(doc) {
    if (!doc || this.wired.indexOf(doc) !== -1) return false;
    this.wired.push(doc);
    CATCH_EVENTS.forEach((type) => {
      this.registerDomEvent(doc, type, this.catchLinkEvent, { capture: true });
    });
    const win = doc.defaultView;
    if (win && win !== window) {
      this.registerDomEvent(win, 'resize', () => {
        this.ensureButton();
        this.render();
        this.place();
      });
    }
    return true;
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
    /* The first event of a gesture wins, and the rest are dropped.
     *
     * Not merely to avoid doing the work twice. By the time the later ones
     * arrive the move may already have happened, so the position they would
     * record is the one we are trying to get back from - the entry would look
     * perfectly well formed and point at the wrong place. A pending capture
     * is therefore a closed door until it settles, 140ms later. */
    if (this.pending) return;

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
      leaf: view.leaf,
      /* A modifier means the reader asked for another pane and means to keep
       * both open, so landing in one is not a move to undo. Without one,
       * landing in another pane was Obsidian's doing, not theirs. */
      deliberate: !!(evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey || evt.button === 1),
      state: this.readState(view),
      href: href,
      /* The link itself, and enough about it to find it again.
       *
       * Reading view does not keep the whole note in the document: scroll far
       * enough away and the paragraph is taken out and built afresh when you
       * return. The element we held is then an orphan - which is exactly the
       * case this feature exists for, a jump far down a long note. So what it
       * said is kept too, and used to find the new element. */
      el: anchor,
      linkText: (anchor.textContent || '').trim().slice(0, 200),
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

    const entry = this.entryFor(pending, view, kind);
    if (!entry) return;

    this.stack = pushEntry(this.stack, entry, MAX_ENTRIES);
    this.render();
  }

  /* What to remember, if anything, given where the click started and where
   * it ended up. */
  entryFor(pending, view, kind) {
    if (view.leaf !== pending.leaf) {
      /* Asked for: they opened it elsewhere on purpose and both stay open. */
      if (pending.deliberate) return null;
      /* Not asked for: a pinned tab will not be navigated, so Obsidian put
       * them in another pane. */
      return {
        kind: 'pane',
        path: pending.path,
        leaf: pending.leaf,
        state: pending.state,
        el: pending.el,
        linkText: pending.linkText,
      };
    }
    if (!kind) return null;
    if (kind === 'across' && !this.canHandBack()) return null;
    return kind === 'across'
      ? {
          kind: 'across',
          path: pending.path,
          leaf: pending.leaf,
          el: pending.el,
          linkText: pending.linkText,
        }
      : {
          kind: 'within',
          path: pending.path,
          leaf: pending.leaf,
          state: pending.state,
          el: pending.el,
          linkText: pending.linkText,
        };
  }

  /* --- going back -------------------------------------------------- */

  goBack() {
    const view = this.activeView();
    const picked = nextUsable(this.stack, this.here());
    this.stack = picked.rest;

    if (!picked.entry) {
      this.render();
      return false;
    }

    if (picked.entry.kind === 'pane') {
      this.goToPane(picked.entry);
      this.render();
      return true;
    }

    if (picked.entry.kind === 'across') {
      this.handBack();
      /* The note has to be drawn again before its links exist to be lit. */
      this.flashLater(picked.entry);
      this.render();
      return true;
    }

    try {
      view.setEphemeralState(picked.entry.state);
    } catch (e) {
      new Notice('Backtrack could not restore that position.');
    }
    this.flashLater(picked.entry);
    this.render();
    return true;
  }

  /* Put the reader back in the pane they clicked in.
   *
   * Only the pane changes: it was never scrolled, so there is no position to
   * restore. Both calls are public API, and revealLeaf comes first in case
   * the pane is in a sidebar that has since been collapsed. */
  goToPane(entry) {
    const workspace = this.app.workspace;
    try {
      if (typeof workspace.revealLeaf === 'function') workspace.revealLeaf(entry.leaf);
      if (typeof workspace.setActiveLeaf === 'function') {
        workspace.setActiveLeaf(entry.leaf, { focus: true });
      }
    } catch (e) {
      new Notice('Backtrack could not get back to that pane.');
      return false;
    }
    this.flashLater(entry);
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
      if (app.workspace.getActiveFile() !== before) return;
      /* Nothing happened. The entry has already been taken off the stack, so
       * the button has stopped offering a move it cannot make; say so once
       * rather than leaving the reader to press again. */
      this.render();
      new Notice('Backtrack: Obsidian had nothing left to go back to in this pane.');
    }, VERIFY_MS);
  }

  /* Light the link you left from.
   *
   * Landing back at a position answers where, not why. The link is what the
   * reader was looking at when they jumped, and pointing at it saves them
   * finding their own place again.
   *
   * Only if it is still there: a note redrawn since the jump has new elements
   * and the one we kept is an orphan. Lighting an orphan changes nothing the
   * reader can see, so it is skipped rather than guessed at. */
  /* Find the link again, now that the note has been drawn.
   *
   * The element we kept if it is still in the document, and otherwise the
   * first link on screen that says the same thing and points the same way.
   * Matching on what it said rather than on where it was: a rebuilt note has
   * new elements everywhere, but the words are the words. */
  findLink(entry) {
    if (!entry) return null;
    const view = this.activeView();
    /* Only in the note the link is in. A note still being opened is the wrong
     * note, and two notes can easily hold links that read the same. */
    if (!view || !view.file || view.file.path !== entry.path) return null;
    /* Only the half on screen. The other half holds a second copy of every
     * link in the note, and a mark put there is invisible. */
    const host = visibleHalf(view);
    if (!host) return null;

    /* The element we kept, but only if it is in the half now on screen.
     *
     * "Still in the document" is not the same question as "still in front of
     * the reader". Obsidian keeps both halves of the view, and more than one
     * note's rendering, about; an element can answer yes to the first and no
     * to the second, and lighting it then changes nothing anyone can see. Ask
     * the question that matters. */
    if (entry.el && entry.el.isConnected !== false && this.inside(host, entry.el)) {
      return entry.el;
    }

    if (typeof host.querySelectorAll !== 'function') return null;
    const want = sameWords(entry.linkText);
    if (!want) return null;
    const all = host.querySelectorAll(LINK_SELECTOR);
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (sameWords(el.textContent) === want) return el;
    }
    return null;
  }

  /* Is this element part of that one? contains() where it exists, and a walk
   * up the parents where it does not. */
  inside(host, el) {
    if (host === el) return true;
    if (typeof host.contains === 'function') return host.contains(el);
    let node = el && el.parentNode;
    while (node) {
      if (node === host) return true;
      node = node.parentNode;
    }
    return false;
  }

  /* Light it once the note has had time to be drawn. Lighting it in the same
   * breath as restoring the position lights whatever was on screen before the
   * move, which is not what the reader is looking for. */
  flashLater(entry, attemptsLeft) {
    if (this.flashTimer) window.clearTimeout(this.flashTimer);
    const left = attemptsLeft === undefined ? LOOK_ATTEMPTS : attemptsLeft;
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = 0;
      if (this.flash(this.findLink(entry), entry)) return;
      /* Not there yet. Going back between notes has to open and draw the note
       * first, and how long that takes is not a number we get to pick. Give
       * up eventually rather than watch for ever: a link that never appears
       * was in a part of the note the reader has since changed. */
      if (left > 1) this.flashLater(entry, left - 1);
    }, LOOK_EVERY_MS);
    return this.flashTimer;
  }

  flash(el, entry) {
    if (!el || el.isConnected === false || typeof el.addClass !== 'function') return false;
    this.light(el);
    if (entry) this.keepLit(entry, el, 0);
    return true;
  }

  /* How long the mark stays, as the stylesheet says.
   *
   * The length of the animation lives in CSS, where a theme or a snippet can
   * change it - and where the Style Settings plugin offers it as a slider.
   * Keeping a second copy of the number here would let the two disagree: the
   * class taken off at ten seconds while the animation was set to thirty
   * leaves the mark stopping half way for no reason the reader can see. So
   * the stylesheet is asked, and the constant is only what to do when it will
   * not answer. */
  flashMs(el) {
    const win = (docOf(el) || document).defaultView || window;
    try {
      if (typeof win.getComputedStyle !== 'function') return FLASH_MS;
      const said = readSeconds(win.getComputedStyle(el).getPropertyValue('--backtrack-flash-seconds'));
      if (said) return said;
    } catch (e) {
      /* asked and not answered */
    }
    return FLASH_MS;
  }

  /* Put the mark on, and take it off again when its time is up. */
  light(el) {
    el.addClass('backtrack-flash');
    const ms = this.flashMs(el);
    this.litFor = ms;
    window.setTimeout(() => {
      if (typeof el.removeClass === 'function') el.removeClass('backtrack-flash');
    }, ms);
  }

  /* Put the mark back if something took it off.
   *
   * Measured in a live vault rather than reasoned about: going back to a note
   * in Live Preview left the mark on the right element and gone 300ms later,
   * with the element still in the document. The same move inside one note
   * kept it for the full ten seconds. The difference is whether the note was
   * drawn again, and what draws it is CodeMirror, which owns those elements
   * and rebuilds them from its own decorations.
   *
   * So the mark is checked a few times while the drawing settles and put back
   * on whatever the link is by then - which may be a new element. It is not
   * defended beyond that. */
  keepLit(entry, el, step) {
    const i = step || 0;
    if (i >= KEEP_AT_MS.length) return 0;
    /* Never defend a mark past its own lifetime. With a short setting the
     * mark is gone by the second check, and putting it back then would light
     * the link again after the reader had watched it go out. */
    if (KEEP_AT_MS[i] >= (this.litFor || FLASH_MS)) return 0;
    if (this.keepTimer) window.clearTimeout(this.keepTimer);
    const wait = KEEP_AT_MS[i] - (i ? KEEP_AT_MS[i - 1] : 0);
    this.keepTimer = window.setTimeout(() => {
      this.keepTimer = 0;
      let on = el;
      const gone =
        !on ||
        on.isConnected === false ||
        (typeof on.hasClass === 'function' && !on.hasClass('backtrack-flash'));
      if (gone) {
        const again = this.findLink(entry);
        if (again && typeof again.addClass === 'function') {
          this.light(again);
          on = again;
        }
      }
      this.keepLit(entry, on || el, i + 1);
    }, wait);
    return this.keepTimer;
  }

  /* --- the button -------------------------------------------------- */

  ensureButton() {
    const doc = this.activeDoc();
    this.wire(doc);
    /* A button in another window is no use here, and cannot be moved: it is a
     * node of a document this one knows nothing about. Take it down and build
     * one where the reader is. */
    if (this.button && docOf(this.button) !== doc) {
      this.button.remove();
      this.button = null;
      this.at = null;
    }
    if (this.button) return this.button;
    const host = doc && doc.body;
    if (!host || typeof host.createDiv !== 'function') return null;

    const el = host.createDiv({ cls: 'backtrack-fab' });
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'Undo the last move');
    /* Calling a thing a button and leaving it out of the tab order says one
     * thing to the eye and another to the keyboard. Either it can be reached
     * or it should not claim to be a button. */
    el.setAttribute('tabindex', '0');
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
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      /* Space scrolls the page unless we take it. */
      if (typeof e.preventDefault === 'function') e.preventDefault();
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
    /* The column of the half on screen. Asking the whole view would find the
     * hidden half's column first, and a hidden box measures as nothing. */
    const half = visibleHalf(view) || host;
    const inner =
      (typeof half.querySelector === 'function' &&
        half.querySelector('.markdown-preview-sizer, .cm-sizer, .cm-content')) ||
      half;
    let col =
      inner && typeof inner.getBoundingClientRect === 'function'
        ? inner.getBoundingClientRect()
        : pane;
    /* A column that has not been laid out yet reports a box of nothing at the
     * origin, and standing beside that puts the button against the left edge
     * of the window, far from anything. When the box makes no sense, fall
     * back to the pane, which does. */
    if (!col.width || col.right <= pane.left || col.left >= pane.right) col = pane;
    return { pane: pane, col: col };
  }

  size() {
    const el = this.button;
    const box = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    return box && box.width ? box.width : 44;
  }

  onMobile() {
    return !!(Platform && Platform.isMobile);
  }

  /* Where a remembered position is kept.
   *
   * The app's own store is preferred because it is already scoped to the
   * vault. Falling back to window.localStorage means scoping it ourselves:
   * on the desktop every vault shares one origin, so an unqualified key
   * would let one vault answer another vault's question. */
  vaultName() {
    const vault = this.app && this.app.vault;
    return vault && typeof vault.getName === 'function' ? vault.getName() : '';
  }

  readSpot() {
    const app = this.app;
    try {
      if (app && typeof app.loadLocalStorage === 'function') {
        return readSpotValue(app.loadLocalStorage(spotKey(this.onMobile())));
      }
      return readSpotValue(window.localStorage.getItem(fallbackKey(this.vaultName(), this.onMobile())));
    } catch (e) {
      return null;
    }
  }

  saveSpot(spot) {
    const app = this.app;
    try {
      if (app && typeof app.saveLocalStorage === 'function') {
        app.saveLocalStorage(spotKey(this.onMobile()), spot);
        return;
      }
      window.localStorage.setItem(
        fallbackKey(this.vaultName(), this.onMobile()),
        JSON.stringify(spot)
      );
    } catch (e) {
      /* A position we cannot remember is not worth a message. */
    }
  }

  forgetSpot() {
    const app = this.app;
    try {
      if (app && typeof app.saveLocalStorage === 'function') {
        app.saveLocalStorage(spotKey(this.onMobile()), null);
        return;
      }
      window.localStorage.removeItem(fallbackKey(this.vaultName(), this.onMobile()));
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
    /* Values, not styling. Where the button stands has to be worked out at
     * run time, but how it stands is the stylesheet's business - and a theme
     * can reach a custom property, while it cannot reach an inline rule. */
    this.button.style.setProperty('--backtrack-left', at.left + 'px');
    this.button.style.setProperty('--backtrack-top', at.top + 'px');
    this.button.addClass('is-placed');
    this.at = at;
    return at;
  }

  /* --- the gesture -------------------------------------------------- */

  onPress(e) {
    /* On a phone a one-finger drag is the gesture that closes a sidebar, and
     * it is not ours to take. Treeview measured this: the swipe is not
     * grabbed at the top but travels up from the element, so stopping it here
     * genuinely works alongside touch-action: none. The escape hatch is that
     * a tap and the command both still go back, so nothing is lost if a
     * platform ever behaves differently. */
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
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
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
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
    const usable = peekUsable(this.stack, this.here());
    const wasShowing = this.button.hasClass('is-visible');
    this.button.toggleClass('is-visible', !!usable);
    /* Measure when it is about to be seen. Measuring at load asks a pane that
     * has not been laid out yet, and a jump inside one note raises no event
     * that would have prompted a second look. */
    if (usable && !wasShowing) this.place();
    /* The same words to the eye, to a screen reader, and to a long press.
     *
     * A tooltip is the desktop half of what a long press already answers on a
     * phone: where would this take me. Obsidian's own is used rather than the
     * browser's title attribute, so it is themed and appears when the app's
     * other tooltips do. */
    const label = usable ? 'Back to ' + describeEntry(usable) : 'Undo the last move';
    this.button.setAttribute('aria-label', label);
    if (typeof setTooltip === 'function') {
      setTooltip(this.button, label, { placement: 'left' });
    }
  }

  /* Where we are, as an entry has to match it: which note, which pane, and
   * whether Obsidian itself still has anywhere to go back to. */
  here() {
    const view = this.activeView();
    if (!view || !view.file) {
      return { path: null, leaf: null, canGoBack: false, leaves: this.openLeaves() };
    }
    return {
      path: view.file.path,
      leaf: view.leaf,
      canGoBack: this.canGoBackIn(view.leaf),
      leaves: this.openLeaves(),
    };
  }

  /* Every pane currently open. A remembered pane that is no longer among
   * them was closed, and there is nowhere to go back to. */
  openLeaves() {
    const out = [];
    const workspace = this.app.workspace;
    if (workspace && typeof workspace.iterateAllLeaves === 'function') {
      workspace.iterateAllLeaves((leaf) => out.push(leaf));
    }
    return out;
  }

  /* Has Obsidian got a step left in this pane?
   *
   * The pane's own history is the thing being asked about, so it is asked
   * directly. None of these ways in are public API, so each is checked for
   * before it is used and the last word, when nothing can be asked, is to
   * assume yes: staying silent about a move that would have worked is worse
   * than the notice we still print if it turns out not to. */
  canGoBackIn(leaf) {
    if (!leaf) return false;
    const history = leaf.history;
    if (history && Array.isArray(history.backHistory)) return history.backHistory.length > 0;
    const commands = this.app && this.app.commands;
    const known = commands && commands.commands && commands.commands[GO_BACK_COMMAND];
    if (known && typeof known.checkCallback === 'function') {
      try {
        return known.checkCallback(true) !== false;
      } catch (e) {
        return true;
      }
    }
    return this.canHandBack();
  }

  sayWhere() {
    const usable = peekUsable(this.stack, this.here());
    new Notice(usable ? 'Back to ' + describeEntry(usable) : 'Nothing to undo');
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
module.exports.usableHere = usableHere;
module.exports.defaultSpot = defaultSpot;
module.exports.clampSpot = clampSpot;
module.exports.isDrag = isDrag;
module.exports.spotKey = spotKey;
module.exports.fallbackKey = fallbackKey;
module.exports.readSpotValue = readSpotValue;
module.exports.GAP = GAP;
module.exports.DRAG_SLOP = DRAG_SLOP;
module.exports.describeEntry = describeEntry;
module.exports.sameWords = sameWords;
module.exports.visibleHalf = visibleHalf;
module.exports.KEEP_AT_MS = KEEP_AT_MS;
module.exports.MAX_ENTRIES = MAX_ENTRIES;
module.exports.LINK_SELECTOR = LINK_SELECTOR;
module.exports.CATCH_EVENTS = CATCH_EVENTS;
module.exports.docOf = docOf;
module.exports.noteName = noteName;
module.exports.readSeconds = readSeconds;
module.exports.shorten = shorten;
module.exports.LABEL_WORDS = LABEL_WORDS;
module.exports.GO_BACK_COMMAND = GO_BACK_COMMAND;
