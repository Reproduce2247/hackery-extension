import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExt,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  indentOnInput,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { simpleMode } from "@codemirror/legacy-modes/mode/simple-mode";

const editors = new WeakMap();

const regexHighlightMode = simpleMode({
  start: [
    { regex: /\\./, token: "escape" },
    { regex: /\(\?:|\(\?[=!<:]/, token: "meta" },
    { regex: /[[\](){}|]/, token: "bracket" },
    { regex: /[*+?]|\{\d+(?:,\d*)?\}/, token: "operator" },
    { regex: /[$^]/, token: "atom" },
    { regex: /./, token: "variable" },
  ],
  languageData: { name: "regexp" },
});

const regexLanguage = StreamLanguage.define(regexHighlightMode);

const languageCompartment = new Compartment();
const placeholderCompartment = new Compartment();

function languageExtension(language) {
  if (language === "json") {
    return json();
  }
  if (language === "regex") {
    return regexLanguage;
  }
  if (language === "plain" || language === "wildcard") {
    return [];
  }
  return javascript();
}

function editorTheme(compact) {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--bg)",
        color: "var(--text)",
      },
      ".cm-content": {
        caretColor: "var(--text)",
        padding: compact ? "4px 8px" : "6px 8px",
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: "12px",
        lineHeight: "1.4",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--text)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
        },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--border) 35%, transparent)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--panel)",
        color: "var(--muted)",
        border: "none",
      },
      ".cm-placeholder": {
        color: "var(--muted)",
      },
    },
    { dark: false }
  );
}

function compactExtensions() {
  return [
    keymap.of([
      {
        key: "Enter",
        run: () => true,
      },
    ]),
    EditorView.theme({
      ".cm-scroller": {
        overflow: "auto",
      },
      ".cm-content, .cm-line": {
        minHeight: "1.4em",
      },
    }),
  ];
}

function createExtensions({ language, compact, minHeight, placeholder }) {
  const extensions = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    editorTheme(compact),
    languageCompartment.of(languageExtension(language)),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      const element = update.view.dom.closest(".cm-field")?.previousElementSibling;
      if (!update.docChanged || !element) {
        return;
      }
      element.value = update.state.doc.toString();
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  ];

  if (!compact) {
    extensions.push(lineNumbers(), highlightActiveLine(), foldGutter());
  } else {
    extensions.push(...compactExtensions());
  }

  if (minHeight) {
    extensions.push(
      EditorView.theme({
        ".cm-scroller": {
          minHeight: `${minHeight}px`,
        },
      })
    );
  }

  if (placeholder) {
    extensions.push(placeholderCompartment.of(placeholderExt(placeholder)));
  } else {
    extensions.push(placeholderCompartment.of([]));
  }

  return extensions;
}

export function attachCodeMirror(element, options = {}) {
  if (!element) {
    return null;
  }

  const existing = editors.get(element);
  if (existing) {
    return existing;
  }

  const { language = "javascript", compact = false, minHeight, placeholder } = options;

  element.style.display = "none";
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;

  const wrapper = document.createElement("div");
  wrapper.className = `cm-field${compact ? " cm-field-compact" : ""}`;
  element.insertAdjacentElement("afterend", wrapper);

  const view = new EditorView({
    state: EditorState.create({
      doc: element.value,
      extensions: createExtensions({ language, compact, minHeight, placeholder }),
    }),
    parent: wrapper,
  });

  const api = {
    view,
    getValue() {
      return view.state.doc.toString();
    },
    setValue(value) {
      const next = value ?? "";
      const current = view.state.doc.toString();
      if (current === next) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
      element.value = next;
    },
    setLanguage(nextLanguage) {
      view.dispatch({
        effects: languageCompartment.reconfigure(
          languageExtension(nextLanguage)
        ),
      });
    },
    setPlaceholder(nextPlaceholder) {
      view.dispatch({
        effects: placeholderCompartment.reconfigure(
          nextPlaceholder ? placeholderExt(nextPlaceholder) : []
        ),
      });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
      wrapper.remove();
      element.style.display = "";
      element.removeAttribute("aria-hidden");
      element.tabIndex = 0;
      editors.delete(element);
    },
  };

  editors.set(element, api);
  return api;
}

export function getFieldValue(element) {
  if (!element) {
    return "";
  }
  return editors.get(element)?.getValue() ?? element.value ?? "";
}

export function setFieldValue(element, value) {
  if (!element) {
    return;
  }
  const editor = editors.get(element);
  const next = value ?? "";
  if (editor) {
    editor.setValue(next);
    return;
  }
  element.value = next;
}

export function setFieldLanguage(element, language) {
  if (!element) {
    return;
  }
  editors.get(element)?.setLanguage(language);
}

export function setFieldPlaceholder(element, placeholder) {
  if (!element) {
    return;
  }
  element.placeholder = placeholder || "";
  editors.get(element)?.setPlaceholder(placeholder || "");
}

export function focusField(element) {
  if (!element) {
    return;
  }
  const editor = editors.get(element);
  if (editor) {
    editor.focus();
    return;
  }
  element.focus();
}

export function attachCodeMirrorAll(entries) {
  const attached = {};
  for (const [key, config] of Object.entries(entries)) {
    const { element, ...options } = config;
    if (!element) {
      continue;
    }
    attached[key] = attachCodeMirror(element, options);
  }
  return attached;
}
