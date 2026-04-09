import {
  Plugin,
  MarkdownView,
  Notice,
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
  pattern: string
): FlashMatch[] {
  // Sort by distance from cursor (closest first)
  const sorted = [...matches].sort(
    (a, b) => Math.abs(a.from - cursorPos) - Math.abs(b.from - cursorPos)
  );

  // Collect the set of characters that appear right after any match,
  // so we can avoid using those as labels (prevents ambiguity between
  // "extending the search" and "picking a label").
  const nextChars = new Set<string>();
  for (const m of sorted) {
    if (m.to < cm.state.doc.length) {
      const ch = cm.state.doc.sliceString(m.to, m.to + 1).toLowerCase();
      nextChars.add(ch);
    }
  }

  // Build available labels, preferring ones that won't conflict
  const available = LABELS.split("").filter((c) => !nextChars.has(c));
  // Fall back to the full alphabet if we filtered too aggressively
  const pool = available.length >= sorted.length ? available : LABELS.split("");

  return sorted.slice(0, pool.length).map((m, i) => ({
    ...m,
    label: pool[i],
  }));
}

// ── The Flash controller ──────────────────────────────────────────────
class FlashSession {
  private pattern = "";
  private active = false;
  private matches: FlashMatch[] = [];
  private cm: EditorView;
  private statusEl: HTMLElement | null = null;
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

    // Show status indicator
    this.statusEl = document.createElement("div");
    this.statusEl.className = "flash-status";
    this.statusEl.innerHTML = `<span>Flash:</span><span class="flash-status-pattern"></span>`;
    this.plugin.app.workspace.containerEl
      .querySelector(".status-bar")
      ?.prepend(this.statusEl);
    this.onCleanup.push(() => this.statusEl?.remove());

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

    // If labels are showing, check if this key is a label pick vs search extension.
    // Like flash.nvim: if extending the pattern still produces matches, extend;
    // otherwise, treat it as a label pick.
    if (this.matches.length > 0 && this.pattern.length > 0) {
      const extendedMatches = findMatches(this.cm, this.pattern + e.key);
      if (extendedMatches.length > 0) {
        // Extending the search still has results — treat as search extension
        this.pattern += e.key;
        this.updateDecorations();
        return;
      }

      // No results from extending — try as label pick
      const target = this.matches.find((m) => m.label === key);
      if (target) {
        this.jumpTo(target);
        this.stop();
        return;
      }
    }

    // No labels yet, or key doesn't match a label — extend search
    this.pattern += e.key;
    this.updateDecorations();
  }

  private updateDecorations() {
    // Update status
    const patternEl = this.statusEl?.querySelector(".flash-status-pattern");
    if (patternEl) patternEl.textContent = this.pattern || " ";

    if (!this.pattern) {
      this.matches = [];
      this.cm.dispatch({ effects: clearFlash.of(null) });
      return;
    }

    const cursorPos = this.cm.state.selection.main.head;
    const rawMatches = findMatches(this.cm, this.pattern);
    this.matches = assignLabels(this.cm, rawMatches, cursorPos, this.pattern);

    // Auto-jump if exactly one match
    if (this.matches.length === 1) {
      this.jumpTo(this.matches[0]);
      this.stop();
      return;
    }

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

// ── Plugin ────────────────────────────────────────────────────────────
export default class FlashPlugin extends Plugin {
  private currentSession: FlashSession | null = null;

  async onload() {
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

    // Hook into vim mode: map 's' in normal mode to trigger flash
    this.app.workspace.onLayoutReady(() => {
      this.registerVimMapping();
    });
  }

  onunload() {
    this.currentSession?.stop();
    this.unregisterVimMapping();
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
    // Access the vim API exposed by Obsidian's built-in vim mode
    const vimApi = this.getVimApi();
    if (!vimApi) return;

    // Define an ex command that triggers flash
    vimApi.defineEx("flash", "fl", () => {
      this.startFlash();
    });

    // Map 's' in normal mode to :flash<CR> (the <CR> actually executes it)
    vimApi.map("s", ":flash<CR>", "normal");
    vimApi.map("s", ":flash<CR>", "visual");
  }

  private unregisterVimMapping() {
    const vimApi = this.getVimApi();
    if (!vimApi) return;

    try {
      vimApi.unmap("s", "normal");
    } catch {
      // Mapping may not exist
    }
  }

  private getVimApi(): any {
    // Obsidian exposes the vim API on the window object when vim mode is enabled
    // Try multiple known locations
    const w = window as any;

    if (w.CodeMirrorAdapter?.Vim) {
      return w.CodeMirrorAdapter.Vim;
    }

    // Some versions expose it differently
    if (w.vim) {
      return w.vim;
    }

    return null;
  }
}
