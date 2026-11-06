import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../lib/ipc";
import {
  charKind,
  DEFAULT_PASSPHRASE,
  DEFAULT_PASSWORD,
  generatePassphrase,
  generatePassword,
  passphraseBits,
  passwordBits,
  strength,
  type PassphraseOptions,
  type PasswordOptions,
} from "../lib/passwords";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

type Mode = "password" | "passphrase";

interface Prefs {
  mode: Mode;
  password: PasswordOptions;
  passphrase: PassphraseOptions;
  clearAfter: boolean;
}

// Only the options are remembered, never a generated password.
const PREFS_KEY = "fyn.passwords";
const NO_WORDS: string[] = [];
const DEFAULT_PREFS: Prefs = { mode: "password", password: DEFAULT_PASSWORD, passphrase: DEFAULT_PASSPHRASE, clearAfter: true };

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    if (!saved) return DEFAULT_PREFS;
    return {
      mode: saved.mode === "passphrase" ? "passphrase" : "password",
      password: { ...DEFAULT_PASSWORD, ...saved.password },
      passphrase: { ...DEFAULT_PASSPHRASE, ...saved.passphrase },
      clearAfter: saved.clearAfter ?? true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const SEPARATORS: { value: string; label: string }[] = [
  { value: "-", label: "-" },
  { value: ".", label: "." },
  { value: "_", label: "_" },
  { value: " ", label: "Space" },
];

/** The EFF list is ~60 KB, so it's only loaded when this screen opens. */
function useWordlist() {
  const [words, setWords] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void import("diceware-wordlist-en-eff").then((m) => live && setWords(Object.values(m.default)));
    return () => {
      live = false;
    };
  }, []);
  return words;
}

export function PasswordView({ onBack }: { onBack: () => void }) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const words = useWordlist();
  const [value, setValue] = useState("");
  const [generation, setGeneration] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const { mode, password, passphrase } = prefs;
  const noSets = !password.upper && !password.lower && !password.digits && !password.symbols;

  // A stable empty list, so loading the word list doesn't replace a password on screen.
  const wordlist = mode === "passphrase" ? words : NO_WORDS;

  const regenerate = useCallback(() => {
    setCopied(false);
    setValue(mode === "password" ? generatePassword(password) : generatePassphrase(passphrase, wordlist));
    setGeneration((g) => g + 1);
  }, [mode, password, passphrase, wordlist]);

  // A new one whenever the options change.
  useEffect(regenerate, [regenerate]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode: just don't remember */
    }
  }, [prefs]);

  useEffect(() => rootRef.current?.focus(), []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(t);
  }, [copied]);

  const bits = mode === "password" ? passwordBits(password) : passphraseBits(passphrase, words.length || 7776);
  const s = strength(bits);

  const copy = useCallback(async () => {
    if (!value) return;
    try {
      await api.copySecret(value, prefs.clearAfter);
      setError(null);
      setCopied(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [prefs.clearAfter, value]);

  const setPassword = (patch: Partial<PasswordOptions>) => setPrefs((p) => ({ ...p, password: { ...p.password, ...patch } }));
  const setPassphrase = (patch: Partial<PassphraseOptions>) => setPrefs((p) => ({ ...p, passphrase: { ...p.passphrase, ...patch } }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onBack();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      regenerate();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      void copy();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      void copy();
    }
  };

  const chars = useMemo(() => [...value], [value]);

  return (
    <div className="subview pw" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <ViewHeader onBack={onBack}>
        <h1 className="clip-intro__title">Password Generator</h1>
        <span className="dev__spacer" />
        <div className="segmented segmented--compact" role="tablist" aria-label="Kind">
          {(["password", "passphrase"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`segmented__item ${mode === m ? "segmented__item--on" : ""}`}
              onClick={() => setPrefs((p) => ({ ...p, mode: m }))}
            >
              {m === "password" ? "Password" : "Passphrase"}
            </button>
          ))}
        </div>
      </ViewHeader>

      <div className="pw__body">
        <section className={`pw__card ${copied ? "pw__card--copied" : ""}`} aria-live="polite">
          <div className={`pw__value ${mode === "passphrase" ? "pw__value--phrase" : ""}`} data-testid="password" key={generation}>
            {value ? (
              chars.map((c, i) => (
                <span
                  key={i}
                  className={`pw__ch pw__ch--${charKind(c)}${c === " " ? " pw__ch--space" : ""}`}
                  style={{ "--i": Math.min(i, 24) } as React.CSSProperties}
                >
                  {c}
                </span>
              ))
            ) : (
              <span className="pw__placeholder">{noSets ? "Pick at least one kind of character" : "…"}</span>
            )}
          </div>
          <div className="pw__card-actions">
            <button className="icon-btn" aria-label="Generate another" title="Generate another (Ctrl+R)" onClick={regenerate}>
              <Glyph name="refresh" size={16} />
            </button>
            <button className="icon-btn" aria-label="Copy" title="Copy (Enter)" onClick={() => void copy()}>
              <Glyph name={copied ? "check" : "copy"} size={16} />
            </button>
          </div>
          <div className={`pw__strength pw__strength--${s.level}`}>
            <span className="pw__meter" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={i <= s.level ? "on" : ""} />
              ))}
            </span>
            <span className="pw__label">{s.label}</span>
            <span className="pw__detail">
              {Math.round(bits)} bits · {s.crackTime === "Instantly" ? "cracked instantly" : `${s.crackTime} to crack`}
            </span>
          </div>
        </section>

        <section className="pw__options">
          {mode === "password" ? (
            <>
              <Slider label="Length" value={password.length} min={8} max={64} onChange={(length) => setPassword({ length })} />
              <div className="pw__row">
                <span className="pw__row-label">Include</span>
                <div className="toggles">
                  <Toggle on={password.upper} onClick={() => setPassword({ upper: !password.upper })}>
                    A–Z
                  </Toggle>
                  <Toggle on={password.lower} onClick={() => setPassword({ lower: !password.lower })}>
                    a–z
                  </Toggle>
                  <Toggle on={password.digits} onClick={() => setPassword({ digits: !password.digits })}>
                    0–9
                  </Toggle>
                  <Toggle on={password.symbols} onClick={() => setPassword({ symbols: !password.symbols })}>
                    !@#
                  </Toggle>
                  <Toggle
                    on={password.avoidAmbiguous}
                    onClick={() => setPassword({ avoidAmbiguous: !password.avoidAmbiguous })}
                    title="Leave out I, l, 1, O, 0 and o"
                  >
                    No look-alikes
                  </Toggle>
                </div>
              </div>
            </>
          ) : (
            <>
              <Slider label="Words" value={passphrase.words} min={3} max={10} onChange={(n) => setPassphrase({ words: n })} />
              <div className="pw__row">
                <span className="pw__row-label">Separator</span>
                <div className="segmented segmented--compact" role="radiogroup" aria-label="Separator">
                  {SEPARATORS.map((sep) => (
                    <button
                      key={sep.label}
                      role="radio"
                      aria-checked={passphrase.separator === sep.value}
                      className={`segmented__item mono-sep ${passphrase.separator === sep.value ? "segmented__item--on" : ""}`}
                      onClick={() => setPassphrase({ separator: sep.value })}
                    >
                      {sep.label}
                    </button>
                  ))}
                </div>
                <div className="toggles">
                  <Toggle on={passphrase.capitalize} onClick={() => setPassphrase({ capitalize: !passphrase.capitalize })}>
                    Capitalize
                  </Toggle>
                  <Toggle on={passphrase.number} onClick={() => setPassphrase({ number: !passphrase.number })}>
                    Add a number
                  </Toggle>
                </div>
              </div>
            </>
          )}
          <label className="pw__row pw__privacy">
            <Glyph name="lock" size={13} />
            <span className="pw__privacy-text">
              Copied privately: never saved in clipboard history.
              <span>Clear it from the clipboard after a minute</span>
            </span>
            <button
              role="switch"
              aria-checked={prefs.clearAfter}
              aria-label="Clear from the clipboard after a minute"
              className={`switch ${prefs.clearAfter ? "switch--on" : ""}`}
              onClick={() => setPrefs((p) => ({ ...p, clearAfter: !p.clearAfter }))}
            >
              <span className="switch__thumb" />
            </button>
          </label>
        </section>
      </div>

      <footer className="footer">
        <div className="footer__left">
          {error ? (
            <span className="toast toast--error">{error}</span>
          ) : copied ? (
            <span className="toast pw__copied">
              <Glyph name="check" size={14} /> Copied{prefs.clearAfter ? " · clears in a minute" : ""}
            </span>
          ) : (
            <span className="footer__hint footer__hint--sentence">
              <Kbd keys={["Ctrl", "R"]} /> New one
            </span>
          )}
        </div>
        <div className="footer__right">
          <button className="btn btn--primary" disabled={!value} onClick={() => void copy()}>
            Copy {mode === "password" ? "Password" : "Passphrase"} <Kbd keys={["↵"]} />
          </button>
        </div>
      </footer>
    </div>
  );
}

function Toggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button className={`toggle ${on ? "toggle--on" : ""}`} aria-pressed={on} onClick={onClick} title={title}>
      <span className="toggle__dot" aria-hidden>
        {on && <Glyph name="check" size={10} />}
      </span>
      {children}
    </button>
  );
}

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="pw__row">
      <span className="pw__row-label">{label}</span>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="pw__count">{value}</span>
    </div>
  );
}
