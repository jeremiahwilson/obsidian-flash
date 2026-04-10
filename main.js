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
      import_view.Decoration.replace({
        widget: new LabelWidget(m.label)
      }).range(m.from, m.from + 1)
    );
    if (m.to > m.from + 1) {
      ranges.push(
        import_view.Decoration.mark({ class: "flash-match" }).range(m.from + 1, m.to)
      );
    }
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
function assignLabels(cm, matches, cursorPos, _pattern, previous) {
  const sorted = [...matches].sort(
    (a, b) => Math.abs(a.from - cursorPos) - Math.abs(b.from - cursorPos)
  );
  const extensionChars = /* @__PURE__ */ new Set();
  const docLen = cm.state.doc.length;
  for (const m of sorted) {
    if (m.to < docLen) {
      const ch = cm.state.doc.sliceString(m.to, m.to + 1).toLowerCase();
      extensionChars.add(ch);
    }
  }
  const safeLabels = new Set(
    LABELS.split("").filter((c) => !extensionChars.has(c))
  );
  const prevByFrom = /* @__PURE__ */ new Map();
  for (const p of previous)
    prevByFrom.set(p.from, p.label);
  const used = /* @__PURE__ */ new Set();
  const result = sorted.map(() => null);
  sorted.forEach((m, i) => {
    const prevLabel = prevByFrom.get(m.from);
    if (prevLabel && safeLabels.has(prevLabel) && !used.has(prevLabel)) {
      result[i] = { ...m, label: prevLabel };
      used.add(prevLabel);
    }
  });
  const freshPool = LABELS.split("").filter(
    (c) => safeLabels.has(c) && !used.has(c)
  );
  let freshIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (result[i] !== null)
      continue;
    if (freshIdx >= freshPool.length)
      break;
    result[i] = { ...sorted[i], label: freshPool[freshIdx++] };
  }
  return result.filter((m) => m !== null);
}
var FlashSession = class {
  constructor(plugin, cm) {
    this.plugin = plugin;
    this.pattern = "";
    this.active = false;
    this.matches = [];
    this.onCleanup = [];
    this.lastEvent = null;
    this.cm = cm;
  }
  start() {
    console.log("[flash] session start");
    this.active = true;
    this.pattern = "";
    this.matches = [];
    this.cm.dom.classList.add("flash-backdrop");
    this.onCleanup.push(
      () => this.cm.dom.classList.remove("flash-backdrop")
    );
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
    if (!this.pattern) {
      this.matches = [];
      this.cm.dispatch({ effects: clearFlash.of(null) });
      return;
    }
    const cursorPos = this.cm.state.selection.main.head;
    const rawMatches = findMatches(this.cm, this.pattern);
    const previous = this.matches;
    this.matches = assignLabels(
      this.cm,
      rawMatches,
      cursorPos,
      this.pattern,
      previous
    );
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
var DEFAULT_SETTINGS = {
  triggerKey: "s"
};
var FlashPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.currentSession = null;
    // The key currently bound in vim — tracked so we know what to unmap
    // when the user changes the trigger in settings.
    this.activeMappedKey = null;
  }
  async onload() {
    await this.loadSettings();
    this.registerEditorExtension([flashField]);
    this.addCommand({
      id: "flash-jump",
      name: "Flash jump",
      editorCallback: () => {
        this.startFlash();
      }
    });
    this.addSettingTab(new FlashSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.registerVimMapping();
    });
  }
  onunload() {
    var _a;
    (_a = this.currentSession) == null ? void 0 : _a.stop();
    this.unregisterVimMapping();
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
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
    const key = this.settings.triggerKey;
    if (!key)
      return;
    vimApi.map(key, ":flash<CR>", "normal");
    vimApi.map(key, ":flash<CR>", "visual");
    this.activeMappedKey = key;
  }
  unregisterVimMapping() {
    const vimApi = this.getVimApi();
    if (!vimApi || !this.activeMappedKey)
      return;
    try {
      vimApi.unmap(this.activeMappedKey, "normal");
      vimApi.unmap(this.activeMappedKey, "visual");
    } catch (e) {
    }
    this.activeMappedKey = null;
  }
  /**
   * Called by the settings tab when the user changes the trigger key.
   * Unmaps the previous key (restoring its default vim behavior) and
   * maps the new one.
   */
  async updateTriggerKey(newKey) {
    this.unregisterVimMapping();
    this.settings.triggerKey = newKey;
    await this.saveSettings();
    this.registerVimMapping();
  }
  getVimApi() {
    var _a;
    const w = window;
    if ((_a = w.CodeMirrorAdapter) == null ? void 0 : _a.Vim)
      return w.CodeMirrorAdapter.Vim;
    if (w.vim)
      return w.vim;
    return null;
  }
};
var FlashSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Trigger key").setDesc(
      "The key in vim normal/visual mode that activates Flash. If you use the vimrc plugin, make sure this mapping doesn't conflict with a mapping set in your vimrc. You can also leave this setting blank and map :flash<CR> in your vimrc"
    ).addText(
      (text) => text.setPlaceholder("s").setValue(this.plugin.settings.triggerKey).onChange(async (value) => {
        const trimmed = value.trim();
        if (trimmed.length > 1) {
          new import_obsidian.Notice("Trigger key must be a single character");
          return;
        }
        await this.plugin.updateTriggerKey(trimmed);
      })
    );
  }
};
