import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { toKeys } from "../lib/hotkey";
import { api, errorMessage, type Settings } from "../lib/ipc";
import { Kbd } from "./Kbd";

interface Props {
  settings: Settings | null;
  onDone: () => void;
  onChangeHotkey: () => void;
}

const TIPS: { sample: string[]; text: string }[] = [
  { sample: ["vsc"], text: "Type a few letters to find any app" },
  { sample: ["24*1.15"], text: "Do quick math. ↵ copies the answer" },
  { sample: ["yt lofi"], text: "Search YouTube, GitHub, Google and more" },
  { sample: ["wifi"], text: "Jump straight to Windows Settings pages" },
  { sample: ["Ctrl", "K"], text: "See every action for the selected item" },
  { sample: ["emoji"], text: "Find emoji, pick colors, lock or restart your PC" },
];

export function WelcomeView({ settings, onDone, onChangeHotkey }: Props) {
  const [autostart, setAutostart] = useState(settings?.autostart ?? false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setAutostart(settings?.autostart ?? false), [settings?.autostart]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A focused button handles its own Enter (e.g. "Change"), so don't also finish.
      const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
      if (e.key === "Escape" || (e.key === "Enter" && !onButton)) {
        e.preventDefault();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const toggleAutostart = async () => {
    const next = !autostart;
    try {
      await api.setAutostart(next);
      setAutostart(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="welcome">
      <div className="welcome__hero">
        <img src={logo} alt="" className="welcome__logo" draggable={false} />
        <div>
          <h1>Welcome to Fyn</h1>
          <p>A fast, keyboard-first launcher for Windows.</p>
        </div>
      </div>

      <div className="welcome__hotkey">
        <span>Open Fyn from anywhere with</span>
        <Kbd keys={toKeys(settings?.hotkey ?? "Ctrl+Space")} />
        <button className="btn btn--small" onClick={onChangeHotkey}>
          Change
        </button>
      </div>

      <ul className="welcome__tips">
        {TIPS.map((t) => (
          <li key={t.text}>
            <Kbd keys={t.sample} />
            <span>{t.text}</span>
          </li>
        ))}
      </ul>

      <div className="welcome__footer">
        <label className="welcome__autostart">
          <button
            role="switch"
            aria-checked={autostart}
            className={`switch ${autostart ? "switch--on" : ""}`}
            onClick={toggleAutostart}
          >
            <span className="switch__thumb" />
          </button>
          Launch Fyn when I sign in
        </label>
        {error && <span className="toast toast--error">{error}</span>}
        <button className="btn btn--primary" onClick={onDone} autoFocus>
          Get Started <Kbd keys={["↵"]} />
        </button>
      </div>
    </div>
  );
}
