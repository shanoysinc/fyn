import { Command } from "cmdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { run, suggest, TOOLS, type Result, type ToolId } from "../lib/devtools";
import { api, copyText, errorMessage } from "../lib/ipc";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

/** Tiny monospace badges, so each tool is recognisable at a glance. */
const BADGE: Record<ToolId, string> = {
  "json-format": "{ }",
  "json-minify": "{}",
  "base64-encode": "64",
  "base64-decode": "64",
  "url-encode": "%",
  "url-decode": "%",
  sha256: "#",
  "ts-to-date": "ts",
  "date-to-ts": "dt",
  uuid: "id",
};

const GROUPS = ["JSON", "Encode", "Time", "Generate"] as const;
const MAX_CLIPBOARD = 200_000;

/** Time tools print "Label    value" lines: shown as a table with a copy button per row. */
function rows(output: string): [string, string][] | null {
  const lines = output.split("\n");
  const parsed = lines.map((l) => /^(\S+(?: \S+)?)\s{2,}(.+)$/.exec(l));
  return parsed.every(Boolean) ? parsed.map((m) => [m![1], m![2]]) : null;
}

export function DevToolsView({ onBack }: { onBack: () => void }) {
  const [tool, setTool] = useState<ToolId>("json-format");
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result>({ output: "" });
  const [fromClipboard, setFromClipboard] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const listInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const info = TOOLS.find((t) => t.id === tool)!;

  const pasteClipboard = useCallback(async (announce: boolean) => {
    try {
      const text = await api.readClipboardText();
      if (!text?.trim() || text.length > MAX_CLIPBOARD) {
        if (announce) setToast({ text: "The clipboard has no text" });
        return;
      }
      setInput(text);
      setTool(suggest(text));
      setFromClipboard(true);
    } catch (e) {
      if (announce) setToast({ text: errorMessage(e), error: true });
    }
  }, []);

  // Start with whatever is on the clipboard, already in the right tool.
  useEffect(() => void pasteClipboard(false), [pasteClipboard]);

  useEffect(() => {
    let live = true;
    void run(tool, input).then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [tool, input, nonce]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 5000 : 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const copy = useCallback(async (text: string, what = "Output") => {
    if (!text) return;
    try {
      await copyText(text);
      setToast({ text: `${what} copied` });
    } catch (e) {
      setToast({ text: errorMessage(e), error: true });
    }
  }, []);

  const chain = () => {
    if (!result.output || result.error) return;
    setInput(result.output);
    setFromClipboard(false);
    textarea.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inEditor = e.target === textarea.current;
    if (e.key === "Escape") {
      e.preventDefault();
      if (inEditor) listInput.current?.focus();
      else onBack();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void copy(result.output);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      setNonce((n) => n + 1);
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void pasteClipboard(true);
    } else if (e.key === "Enter" && !inEditor && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      textarea.current?.focus();
    }
  };

  const table = !result.error && result.output && (tool === "ts-to-date" || tool === "date-to-ts") ? rows(result.output) : null;
  const lines = result.output ? result.output.split("\n").length : 0;

  return (
    <div className="subview" onKeyDown={onKeyDown}>
      <ViewHeader onBack={onBack}>
        <h1 className="clip-intro__title">Dev Tools</h1>
        <span className="dev__spacer" />
        {fromClipboard && (
          <span className="dev__source" title="Fyn filled this in from your clipboard">
            <Glyph name="clipboard" size={12} /> From clipboard
          </span>
        )}
        <button className="icon-btn" aria-label="Paste from clipboard" title="Paste from clipboard (Ctrl+Shift+V)" onClick={() => void pasteClipboard(true)}>
          <Glyph name="clipboard" size={16} />
        </button>
      </ViewHeader>

      <div className="dev">
        <Command
          className="dev__tools"
          label="Tools"
          loop
          value={tool}
          onValueChange={(v) => setTool(v as ToolId)}
          shouldFilter={false}
        >
          <Command.Input ref={listInput} className="visually-hidden" autoFocus aria-label="Choose a tool" />
          <Command.List className="dev__list">
            {GROUPS.map((g) => (
              <Command.Group key={g} heading={g} className="dev__group">
                {TOOLS.filter((t) => t.group === g).map((t) => (
                  <Command.Item key={t.id} value={t.id} className="dev__tool" onSelect={() => textarea.current?.focus()}>
                    <span className="dev__badge">{BADGE[t.id]}</span>
                    {t.title}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>

        <div className="dev__work">
          <label className="dev__pane dev__pane--in">
            <span className="dev__label">
              {tool === "uuid" ? "How many" : tool === "date-to-ts" ? "Date" : tool === "ts-to-date" ? "Timestamp" : "Input"}
              {input && (
                <button
                  className="dev__mini"
                  onClick={(e) => {
                    e.preventDefault();
                    setInput("");
                    setFromClipboard(false);
                    textarea.current?.focus();
                  }}
                >
                  Clear
                </button>
              )}
            </span>
            <textarea
              ref={textarea}
              className="dev__input mono"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setFromClipboard(false);
              }}
              placeholder={info.placeholder}
              spellCheck={false}
              aria-label="Input"
            />
          </label>

          <div className="dev__divider">
            <button className="dev__chain" onClick={chain} disabled={!result.output || !!result.error} title="Use the output as the input">
              <Glyph name="swap" size={13} /> Use as input
            </button>
          </div>

          <div className={`dev__pane dev__pane--out ${result.error ? "dev__pane--error" : ""}`}>
            <span className="dev__label">
              {info.title}
              {result.output && !result.error && (
                <span className="dev__stat">
                  {lines > 1 ? `${lines} lines · ` : ""}
                  {result.output.length.toLocaleString()} chars
                </span>
              )}
            </span>
            {result.error ? (
              <div className="dev__error" role="alert">
                <span className="dev__error-icon">!</span>
                {result.error}
              </div>
            ) : table ? (
              <dl className="dev__table">
                {table.map(([k, v]) => (
                  <div key={k} className="dev__kv">
                    <dt>{k}</dt>
                    <dd className="mono">{v}</dd>
                    <button className="icon-btn dev__kv-copy" aria-label={`Copy ${k}`} onClick={() => void copy(v, k)}>
                      <Glyph name="copy" size={13} />
                    </button>
                  </div>
                ))}
              </dl>
            ) : result.output ? (
              <pre className="dev__output mono" data-testid="output">
                {result.output}
              </pre>
            ) : (
              <div className="dev__waiting">The result appears here as you type.</div>
            )}
          </div>
        </div>
      </div>

      <footer className="footer">
        <div className="footer__left">
          {toast ? (
            <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>
          ) : (
            <span className="footer__hint dev__hint">
              ↑↓ Tool · <Kbd keys={["Esc"]} /> {tool === "uuid" ? <>· <Kbd keys={["Ctrl", "R"]} /> New</> : null}
            </span>
          )}
        </div>
        <div className="footer__right">
          <button className="btn btn--primary" disabled={!result.output || !!result.error} onClick={() => void copy(result.output)}>
            Copy Result <Kbd keys={["Ctrl", "↵"]} />
          </button>
        </div>
      </footer>
    </div>
  );
}
