import {
  Plugin,
  MarkdownView,
  Notice,
  PluginSettingTab,
  App,
  Setting,
} from "obsidian";
import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
} from "@codemirror/view";
import { StateField, StateEffect, Range } from "@codemirror/state";

// ── Label alphabet (home-row first, like flash.nvim) ──────────────────
const LABELS = "asdfghjklqwertyuiopzxcvbnm";

// ── State effects to drive the decoration layer ───────────────────────
interface FlashMatch {
  from: number;
  to: number;
  label: string;
}

const setFlashState = StateEffect.define<{
  active: boolean;
  pattern: string;
  matches: FlashMatch[];
}>();

const clearFlash = StateEffect.define<null>();

// ── State field that holds current flash decorations ──────────────────
const flashField = StateField.define<{
  active: boolean;
  pattern: string;
  matches: FlashMatch[];
  decorations: DecorationSet;
}>({
  create() {
    return {
      active: false,
      pattern: "",
      matches: [],
      decorations: Decoration.none,
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
          decorations: buildDecorations(tr.state.doc, matches),
        };
      }
      if (e.is(clearFlash)) {
        return {
          active: false,
          pattern: "",
          matches: [],
          decorations: Decoration.none,
        };
      }
    }
    return value;
  },
  provide(f) {
    return EditorView.decorations.from(f, (val) => val.decorations);
  },
});

// ── Build CM6 decorations from matches ────────────────────────────────
function buildDecorations(
  _doc: unknown,
  matches: FlashMatch[]
): DecorationSet {
  if (matches.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  for (const m of matches) {
    // Replace the first character of the match with the label widget
    ranges.push(
      Decoration.replace({
        widget: new LabelWidget(m.label),
      }).range(m.from, m.from + 1)
    );
    // Highlight the rest of the matched text (if any)
    if (m.to > m.from + 1) {
      ranges.push(
        Decoration.mark({ class: "flash-match" }).range(m.from + 1, m.to)
      );
    }
  }
  // Decoration.set sorts ranges automatically (unlike RangeSetBuilder)
  return Decoration.set(ranges, true);
}

// ── Label widget ──────────────────────────────────────────────────────
class LabelWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "flash-label";
    span.textContent = this.label;
    return span;
  }
  eq(other: LabelWidget) {
    return this.label === other.label;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function getEditorView(plugin: Plugin): EditorView | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) return null;
  return (view.editor as any).cm as EditorView;
}

function getVisibleRange(cm: EditorView): { from: number; to: number } {
  const { from, to } = cm.viewport;
  return { from, to };
}

function findMatches(
  cm: EditorView,
  pattern: string
): { from: number; to: number }[] {
  if (!pattern) return [];
  const { from, to } = getVisibleRange(cm);
  const text = cm.state.doc.sliceString(from, to);
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "gi");
  const results: { from: number; to: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({ from: from + m.index, to: from + m.index + m[0].length });
  }
  return results;
}

function assignLabels(
  cm: EditorView,
  matches: { from: number; to: number }[],
  cursorPos: number,
  _pattern: string,
  previous: FlashMatch[]
): FlashMatch[] {
  // Sort by distance from cursor (closest first)
  const sorted = [...matches].sort(
    (a, b) => Math.abs(a.from - cursorPos) - Math.abs(b.from - cursorPos)
  );

  // Collect the set of characters that, if typed, would extend the current
  // search pattern to match somewhere. These are the characters immediately
  // following each current match. We MUST NOT use these as labels — otherwise
  // the user has no way to disambiguate "extend the search" from "pick this
  // label".
  const extensionChars = new Set<string>();
  const docLen = cm.state.doc.length;
  for (const m of sorted) {
    if (m.to < docLen) {
      const ch = cm.state.doc.sliceString(m.to, m.to + 1).toLowerCase();
      extensionChars.add(ch);
    }
  }

  // Safe label pool: characters that are NOT valid pattern extensions.
  const safeLabels = new Set(
    LABELS.split("").filter((c) => !extensionChars.has(c))
  );

  // Label stability: if a match existed in the previous update and its old
  // label is still in the safe pool, reuse it so labels don't shuffle around
  // as the user narrows their search.
  const prevByFrom = new Map<number, string>();
  for (const p of previous) prevByFrom.set(p.from, p.label);

  const used = new Set<string>();
  const result: (FlashMatch | null)[] = sorted.map(() => null);

  // Pass 1: reuse previous labels where possible
  sorted.forEach((m, i) => {
    const prevLabel = prevByFrom.get(m.from);
    if (prevLabel && safeLabels.has(prevLabel) && !used.has(prevLabel)) {
      result[i] = { ...m, label: prevLabel };
      used.add(prevLabel);
    }
  });

  // Pass 2: assign fresh labels to remaining matches from the safe pool,
  // preserving cursor-distance order
  const freshPool = LABELS.split("").filter(
    (c) => safeLabels.has(c) && !used.has(c)
  );
  let freshIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (result[i] !== null) continue;
    if (freshIdx >= freshPool.length) break; // out of safe labels
    result[i] = { ...sorted[i], label: freshPool[freshIdx++] };
  }

  return result.filter((m): m is FlashMatch => m !== null);
}

// ── The Flash controller ──────────────────────────────────────────────
class FlashSession {
  private pattern = "";
  private active = false;
  private matches: FlashMatch[] = [];
  private cm: EditorView;
  private onCleanup: (() => void)[] = [];

  constructor(
    private plugin: Plugin,
    cm: EditorView
  ) {
    this.cm = cm;
  }

  start() {
    console.log("[flash] session start");
    this.active = true;
    this.pattern = "";
    this.matches = [];

    // Add backdrop class
    this.cm.dom.classList.add("flash-backdrop");
    this.onCleanup.push(() =>
      this.cm.dom.classList.remove("flash-backdrop")
    );

    // Capture keystrokes — attach to BOTH the editor content DOM and document
    // at capture phase, so we intercept before vim mode / CodeMirror keymaps.
    // We defer by one tick so the current `s` keystroke finishes processing
    // before we start listening.
    const handler = (e: KeyboardEvent) => this.handleKey(e);
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
    // Defer so the triggering `s` keystroke is fully processed first
    setTimeout(attach, 0);

    this.updateDecorations();
  }

  stop() {
    this.active = false;
    this.cm.dispatch({ effects: clearFlash.of(null) });
    for (const fn of this.onCleanup) fn();
    this.onCleanup = [];
  }

  private lastEvent: KeyboardEvent | null = null;
  private handleKey(e: KeyboardEvent) {
    if (!this.active) return;
    // Deduplicate: we attach the listener to multiple targets on the capture
    // path, so the same event may fire the handler more than once.
    if (this.lastEvent === e) return;
    this.lastEvent = e;
    console.log("[flash] key:", e.key, "pattern:", this.pattern);

    // Escape cancels
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.stop();
      return;
    }

    // Backspace removes last char
    if (e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      this.pattern = this.pattern.slice(0, -1);
      this.updateDecorations();
      return;
    }

    // Enter jumps to first match
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (this.matches.length > 0) {
        this.jumpTo(this.matches[0]);
      }
      this.stop();
      return;
    }

    // Ignore modifier-only keys and shortcuts
    if (e.key.length !== 1) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    const key = e.key.toLowerCase();

    // Labels are guaranteed by assignLabels to never be a valid extension of
    // the current pattern, so if the typed key matches a visible label it's
    // unambiguously a jump request.
    if (this.matches.length > 0 && this.pattern.length > 0) {
      const target = this.matches.find((m) => m.label === key);
      if (target) {
        this.jumpTo(target);
        this.stop();
        return;
      }
    }

    // Otherwise, extend the search pattern
    this.pattern += e.key;
    this.updateDecorations();
  }

  private updateDecorations() {
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
        matches: this.matches,
      }),
    });
  }

  private jumpTo(match: FlashMatch) {
    this.cm.dispatch({
      selection: { anchor: match.from },
      scrollIntoView: true,
    });
    this.cm.focus();
  }
}

// ── Settings ──────────────────────────────────────────────────────────
interface FlashSettings {
  triggerKey: string;
}

const DEFAULT_SETTINGS: FlashSettings = {
  triggerKey: "s",
};

// ── Plugin ────────────────────────────────────────────────────────────
export default class FlashPlugin extends Plugin {
  settings: FlashSettings = DEFAULT_SETTINGS;
  private currentSession: FlashSession | null = null;
  // The key currently bound in vim — tracked so we know what to unmap
  // when the user changes the trigger in settings.
  private activeMappedKey: string | null = null;

  async onload() {
    await this.loadSettings();

    // Register the CM6 state field for decorations
    this.registerEditorExtension([flashField]);

    // Register command (works from command palette + hotkey)
    this.addCommand({
      id: "flash-jump",
      name: "Flash jump",
      editorCallback: () => {
        this.startFlash();
      },
    });

    // Settings tab
    this.addSettingTab(new FlashSettingTab(this.app, this));

    // Hook into vim mode once the workspace is ready
    this.app.workspace.onLayoutReady(() => {
      this.registerVimMapping();
    });
  }

  onunload() {
    this.currentSession?.stop();
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

  private startFlash() {
    // Stop any existing session
    this.currentSession?.stop();

    const cm = getEditorView(this);
    if (!cm) {
      new Notice("No active editor");
      return;
    }

    this.currentSession = new FlashSession(this, cm);
    this.currentSession.start();
  }

  private registerVimMapping() {
    const vimApi = this.getVimApi();
    if (!vimApi) return;

    // Define the ex command once (safe to call repeatedly)
    vimApi.defineEx("flash", "fl", () => {
      this.startFlash();
    });

    // Bind the configured trigger key to :flash<CR>
    const key = this.settings.triggerKey;
    if (!key) return;

    vimApi.map(key, ":flash<CR>", "normal");
    vimApi.map(key, ":flash<CR>", "visual");
    this.activeMappedKey = key;
  }

  private unregisterVimMapping() {
    const vimApi = this.getVimApi();
    if (!vimApi || !this.activeMappedKey) return;

    try {
      vimApi.unmap(this.activeMappedKey, "normal");
      vimApi.unmap(this.activeMappedKey, "visual");
    } catch {
      // Mapping may not exist
    }
    this.activeMappedKey = null;
  }

  /**
   * Called by the settings tab when the user changes the trigger key.
   * Unmaps the previous key (restoring its default vim behavior) and
   * maps the new one.
   */
  async updateTriggerKey(newKey: string) {
    this.unregisterVimMapping();
    this.settings.triggerKey = newKey;
    await this.saveSettings();
    this.registerVimMapping();
  }

  private getVimApi(): any {
    const w = window as any;
    if (w.CodeMirrorAdapter?.Vim) return w.CodeMirrorAdapter.Vim;
    if (w.vim) return w.vim;
    return null;
  }
}

// ── Settings tab ──────────────────────────────────────────────────────
class FlashSettingTab extends PluginSettingTab {
  plugin: FlashPlugin;

  constructor(app: App, plugin: FlashPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Trigger key")
      .setDesc(
        "The key in vim normal/visual mode that activates Flash. " +
          "If you use the vimrc plugin, make sure this mapping doesn't " +
          "conflict with a mapping set in your vimrc. You can also leave " +
          "this setting blank and map :flash<CR> in your vimrc"
      )
      .addText((text) =>
        text
          .setPlaceholder("s")
          .setValue(this.plugin.settings.triggerKey)
          .onChange(async (value) => {
            // Accept a single character, or empty to disable
            const trimmed = value.trim();
            if (trimmed.length > 1) {
              new Notice("Trigger key must be a single character");
              return;
            }
            await this.plugin.updateTriggerKey(trimmed);
          })
      );
  }
}
