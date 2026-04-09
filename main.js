var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => FlashPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_view = require("@codemirror/view");
var import_state = require("@codemirror/state");
var LABELS = "asdfghjklqwertyuiopzxcvbnm";
var setFlashState = import_state.StateEffect.define();
var clearFlash = import_state.StateEffect.define();
var flashField = import_state.StateField.define({
  create() {
    return {
      active: false,
      pattern: "",
      matches: [],
      decorations: import_view.Decoration.none
    };
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlashState)) {
        const { active, pattern, matches } = e.value;
        return {
          active,
          pattern,
          matches,
          decorations: buildDecorations(tr.state.doc, matches)
        };
      }
      if (e.is(clearFlash)) {
        return {
          active: false,
          pattern: "",
          matches: [],
          decorations: import_view.Decoration.none
        };
      }
    }
    return value;
  },
  provide(f) {
    return import_view.EditorView.decorations.from(f, (val) => val.decorations);
  }
});
function buildDecorations(_doc, matches) {
  if (matches.length === 0)
    return import_view.Decoration.none;
  const ranges = [];
  for (const m of matches) {
    ranges.push(
      import_view.Decoration.widget({
        widget: new LabelWidget(m.label),
        side: -1
      }).range(m.from)
    );
    ranges.push(
      import_view.Decoration.mark({ class: "flash-match" }).range(m.from, m.to)
    );
  }
  return import_view.Decoration.set(ranges, true);
}
var LabelWidget = class extends import_view.WidgetType {
  constructor(label) {
    super();
    this.label = label;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "flash-label";
    span.textContent = this.label;
    return span;
  }
  eq(other) {
    return this.label === other.label;
  }
};
function getEditorView(plugin) {
  const view = plugin.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
  if (!view)
    return null;
  return view.editor.cm;
}
function getVisibleRange(cm) {
  const { from, to } = cm.viewport;
  return { from, to };
}
function findMatches(cm, pattern) {
  if (!pattern)
    return [];
  const { from, to } = getVisibleRange(cm);
  const text = cm.state.doc.sliceString(from, to);
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "gi");
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push({ from: from + m.index, to: from + m.index + m[0].length });
  }
  return results;
}
function assignLabels(cm, matches, cursorPos, pattern) {
  const sorted = [...matches].sort(
    (a, b) => Math.abs(a.from - cursorPos) - Math.abs(b.from - cursorPos)
  );
  const nextChars = /* @__PURE__ */ new Set();
  for (const m of sorted) {
    if (m.to < cm.state.doc.length) {
      const ch = cm.state.doc.sliceString(m.to, m.to + 1).toLowerCase();
      nextChars.add(ch);
    }
  }
  const available = LABELS.split("").filter((c) => !nextChars.has(c));
  const pool = available.length >= sorted.length ? available : LABELS.split("");
  return sorted.slice(0, pool.length).map((m, i) => ({
    ...m,
    label: pool[i]
  }));
}
var FlashSession = class {
  constructor(plugin, cm) {
    this.plugin = plugin;
    this.pattern = "";
    this.active = false;
    this.matches = [];
    this.statusEl = null;
    this.onCleanup = [];
    this.lastEvent = null;
    this.cm = cm;
  }
  start() {
    var _a;
    console.log("[flash] session start");
    this.active = true;
    this.pattern = "";
    this.matches = [];
    this.cm.dom.classList.add("flash-backdrop");
    this.onCleanup.push(
      () => this.cm.dom.classList.remove("flash-backdrop")
    );
    this.statusEl = document.createElement("div");
    this.statusEl.className = "flash-status";
    this.statusEl.innerHTML = `<span>Flash:</span><span class="flash-status-pattern"></span>`;
    (_a = this.plugin.app.workspace.containerEl.querySelector(".status-bar")) == null ? void 0 : _a.prepend(this.statusEl);
    this.onCleanup.push(() => {
      var _a2;
      return (_a2 = this.statusEl) == null ? void 0 : _a2.remove();
    });
    const handler = (e) => this.handleKey(e);
    const attach = () => {
      this.cm.contentDOM.addEventListener("keydown", handler, true);
      document.addEventListener("keydown", handler, true);
      window.addEventListener("keydown", handler, true);
      this.onCleanup.push(() => {
        this.cm.contentDOM.removeEventListener("keydown", handler, true);
        document.removeEventListener("keydown", handler, true);
        window.removeEventListener("keydown", handler, true);
      });
      console.log("[flash] listeners attached");
    };
    setTimeout(attach, 0);
    this.updateDecorations();
  }
  stop() {
    this.active = false;
    this.cm.dispatch({ effects: clearFlash.of(null) });
    for (const fn of this.onCleanup)
      fn();
    this.onCleanup = [];
  }
  handleKey(e) {
    if (!this.active)
      return;
    if (this.lastEvent === e)
      return;
    this.lastEvent = e;
    console.log("[flash] key:", e.key, "pattern:", this.pattern);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.stop();
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      this.pattern = this.pattern.slice(0, -1);
      this.updateDecorations();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (this.matches.length > 0) {
        this.jumpTo(this.matches[0]);
      }
      this.stop();
      return;
    }
    if (e.key.length !== 1)
      return;
    if (e.ctrlKey || e.metaKey || e.altKey)
      return;
    e.preventDefault();
    e.stopPropagation();
    const key = e.key.toLowerCase();
    if (this.matches.length > 0 && this.pattern.length > 0) {
      const extendedMatches = findMatches(this.cm, this.pattern + e.key);
      if (extendedMatches.length > 0) {
        this.pattern += e.key;
        this.updateDecorations();
        return;
      }
      const target = this.matches.find((m) => m.label === key);
      if (target) {
        this.jumpTo(target);
        this.stop();
        return;
      }
    }
    this.pattern += e.key;
    this.updateDecorations();
  }
  updateDecorations() {
    var _a;
    const patternEl = (_a = this.statusEl) == null ? void 0 : _a.querySelector(".flash-status-pattern");
    if (patternEl)
      patternEl.textContent = this.pattern || " ";
    if (!this.pattern) {
      this.matches = [];
      this.cm.dispatch({ effects: clearFlash.of(null) });
      return;
    }
    const cursorPos = this.cm.state.selection.main.head;
    const rawMatches = findMatches(this.cm, this.pattern);
    this.matches = assignLabels(this.cm, rawMatches, cursorPos, this.pattern);
    if (this.matches.length === 1) {
      this.jumpTo(this.matches[0]);
      this.stop();
      return;
    }
    this.cm.dispatch({
      effects: setFlashState.of({
        active: true,
        pattern: this.pattern,
        matches: this.matches
      })
    });
  }
  jumpTo(match) {
    this.cm.dispatch({
      selection: { anchor: match.from },
      scrollIntoView: true
    });
    this.cm.focus();
  }
};
var FlashPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.currentSession = null;
  }
  async onload() {
    this.registerEditorExtension([flashField]);
    this.addCommand({
      id: "flash-jump",
      name: "Flash jump",
      editorCallback: () => {
        this.startFlash();
      }
    });
    this.app.workspace.onLayoutReady(() => {
      this.registerVimMapping();
    });
  }
  onunload() {
    var _a;
    (_a = this.currentSession) == null ? void 0 : _a.stop();
    this.unregisterVimMapping();
  }
  startFlash() {
    var _a;
    (_a = this.currentSession) == null ? void 0 : _a.stop();
    const cm = getEditorView(this);
    if (!cm) {
      new import_obsidian.Notice("No active editor");
      return;
    }
    this.currentSession = new FlashSession(this, cm);
    this.currentSession.start();
  }
  registerVimMapping() {
    const vimApi = this.getVimApi();
    if (!vimApi)
      return;
    vimApi.defineEx("flash", "fl", () => {
      this.startFlash();
    });
    vimApi.map("s", ":flash<CR>", "normal");
    vimApi.map("s", ":flash<CR>", "visual");
  }
  unregisterVimMapping() {
    const vimApi = this.getVimApi();
    if (!vimApi)
      return;
    try {
      vimApi.unmap("s", "normal");
    } catch (e) {
    }
  }
  getVimApi() {
    var _a;
    const w = window;
    if ((_a = w.CodeMirrorAdapter) == null ? void 0 : _a.Vim) {
      return w.CodeMirrorAdapter.Vim;
    }
    if (w.vim) {
      return w.vim;
    }
    return null;
  }
};
