/*
 * Just enough of a browser to let the button exist and be pressed.
 *
 * Adapted from the Treeview stub. The lesson carried over is that listeners
 * must be kept and events must travel: a stub that swallows them can show
 * that a control was drawn but never that pressing it does anything, and
 * "drawn but dead" is the failure that actually happens.
 */

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.className = '';
    this.children = [];
    this.attrs = {};
    this.text = '';
    this.props = {};
    const props = this.props;
    this.style = {
      setProperty(k, v) { props[k] = v; },
      getPropertyValue(k) { return props[k]; },
    };
    /* A box, so a test can show where a thing actually ended up. A stub where
     * everything is zero-sized cannot show that the button was put beside the
     * column rather than on top of it. */
    this.box = { left: 0, top: 0, width: 44, height: 44 };
    this.isConnected = true;
    this.on = {};
    this.parent = null;
  }

  make(tag, o) {
    const e = new El(tag);
    if (o && o.cls) e.className = o.cls;
    if (o && o.text) e.text = String(o.text);
    e.parent = this;
    this.children.push(e);
    return e;
  }
  createDiv(o) { return this.make('div', o); }
  createSpan(o) { return this.make('span', o); }
  createEl(tag, o) { return this.make(tag, o); }

  addClass(c) { this.className = (this.className + ' ' + c).trim(); }
  removeClass(c) { this.className = this.className.split(/\s+/).filter((x) => x !== c).join(' '); }
  toggleClass(c, on) { if (on) this.addClass(c); else this.removeClass(c); }
  hasClass(c) { return this.className.split(/\s+/).indexOf(c) !== -1; }

  setText(t) { this.text = String(t); }
  setAttr(k, v) { this.attrs[k] = v; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }

  detach() {
    this.isConnected = false;
    for (const c of this.children) c.detach();
  }
  remove() {
    this.detach();
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }

  getBoundingClientRect() {
    const b = this.box;
    return {
      left: b.left,
      top: b.top,
      width: b.width,
      height: b.height,
      right: b.left + b.width,
      bottom: b.top + b.height,
    };
  }
  setBox(left, top, width, height) {
    this.box = { left: left, top: top, width: width, height: height };
    return this;
  }
  appendChild(e) { e.parent = this; this.children.push(e); return e; }
  contains(el) {
    let node = el;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
  get parentNode() { return this.parent; }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelectorAll(sel) {
    const parts = String(sel).split(',').map((x) => x.trim().replace(/^\./, '')).filter(Boolean);
    return this.find((e) => parts.some((c) => e.hasClass(c)));
  }
  get textContent() {
    return [this.text].concat(this.children.map((c) => c.textContent)).join('');
  }
  querySelector(sel) {
    const parts = String(sel).split(',').map((x) => x.trim().replace(/^\./, '')).filter(Boolean);
    return this.find((e) => parts.some((c) => e.hasClass(c)))[0] || null;
  }

  /* Send one event straight at this element, with whatever the handler will
   * read off it. */
  fire(type, props) {
    const ev = Object.assign(
      { target: this, preventDefault: () => {}, stopPropagation: () => {}, pointerId: 1 },
      props || {}
    );
    for (const fn of (this.on[type] || []).slice()) fn(ev);
    return ev;
  }

  addEventListener(type, fn) {
    if (!this.on[type]) this.on[type] = [];
    this.on[type].push(fn);
  }
  removeEventListener() {}

  /* Press it, and let the event travel up as a real one would. */
  press(type) {
    let stopped = false;
    const ev = {
      target: this,
      stopPropagation: () => { stopped = true; },
      preventDefault: () => {},
      button: 0,
    };
    let el = this;
    while (el) {
      for (const fn of (el.on[type || 'click'] || []).slice()) fn(ev);
      if (stopped) return ev;
      el = el.parent;
    }
    return ev;
  }

  /*
   * Enough of closest() for the selectors main.js uses: a comma-separated
   * list of class names and tag names, walked up the tree. Without a real one
   * the stub could not show which of two nested spans a click was aimed at,
   * which is the only question the click handler exists to answer.
   */
  closest(sel) {
    const parts = String(sel).split(',').map((x) => x.trim()).filter(Boolean);
    let el = this;
    while (el) {
      for (const part of parts) {
        if (part.charAt(0) === '.' ? el.hasClass(part.slice(1)) : el.tagName === part.toUpperCase()) {
          return el;
        }
      }
      el = el.parent;
    }
    return null;
  }

  find(fn, out) {
    out = out || [];
    if (fn(this)) out.push(this);
    for (const c of this.children) c.find(fn, out);
    return out;
  }
}

function install() {
  const body = new El('body');
  global.El = El;
  global.document = {
    body: body,
    createElement: (t) => new El(t),
    createElementNS: () => new El('svg'),
  };
  const store = {};
  global.window = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      getItem(k) { return store[k] === undefined ? null : store[k]; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
      clear() { for (const k of Object.keys(store)) delete store[k]; },
    },
  };
  return { El: El, body: body };
}

module.exports = { El: El, install: install };
