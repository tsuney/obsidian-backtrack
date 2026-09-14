/* Minimal stub of the Obsidian API so main.js can be required in plain Node. */

/*
 * Only what the tests reach. The lifecycle helpers are real methods on
 * Obsidian's own Plugin, so they are given bodies here rather than being
 * guarded for in main.js. registerDomEvent keeps what it was given: a stub
 * that swallows listeners can only show that a handler was installed, never
 * that it was installed on the capture phase, which is the half that matters.
 */
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest || { dir: 'plugins/backtrack' };
    this.domEvents = [];
    this.commands = [];
    this.disposers = [];
  }
  registerEvent(ref) { return ref; }
  registerDomEvent(el, type, fn, options) {
    this.domEvents.push({ el: el, type: type, fn: fn, options: options });
  }
  registerInterval(id) { return id; }
  addCommand(cmd) { this.commands.push(cmd); }
  addRibbonIcon() { return {}; }
  addSettingTab() {}
  register(fn) { this.disposers.push(fn); }
}

class MarkdownView {}

/* A notice nobody can read proves nothing about what the user was told. */
class Notice {
  constructor(message) {
    this.message = String(message);
    Notice.all.push(this.message);
    Notice.last = this.message;
  }
}
Notice.all = [];
Notice.last = null;

const Platform = { isMobile: false, isMacOS: true };

/* The real one puts an <svg class="svg-icon"> inside. Enough of that here for
 * a test to show the button is not empty. */
function setIcon(el, name) {
  if (el && typeof el.createDiv === 'function') {
    const svg = el.createEl('svg', { cls: 'svg-icon' });
    svg.setAttr('data-icon', name);
  }
}

function debounce(fn) { return fn; }

module.exports = {
  Plugin,
  MarkdownView,
  Notice,
  Platform,
  setIcon,
  debounce,
};
