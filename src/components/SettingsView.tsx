import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, events, on, type Settings } from "../lib/ipc";
import { fromEvent, toKeys } from "../lib/hotkey";
import { Kbd } from "./Kbd";

interface Props {
  onBack: () => void;
}

export function SettingsView({ onBack }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getSettings().then(setSettings).catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    load();
    return on(events.appsChanged, load);
  }, [load]);

  const stopRecording = useCallback(() => {
    setRecording(false);
    api.suspendHotkey(false).catch(() => {});
  }, []);

  // Capture the next key combination while recording.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        stopRecording();
        return;
      }
      const accel = fromEvent(e);
      if (!accel) return; // only modifiers so far
      setRecording(false);
      api
        .setHotkey(accel)
        .then((hotkey) => {
          setError(null);
          setNotice(`Fyn now opens with ${toKeys(hotkey).join(" + ")}`);
          setSettings((s) => (s ? { ...s, hotkey, hotkeyError: null } : s));
        })
        .catch((err) => setError(errorMessage(err)))
        .finally(() => api.suspendHotkey(false).catch(() => {}));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, stopRecording]);

  // Never leave the global shortcut suspended if the view goes away mid-recording.
  useEffect(() => () => void api.suspendHotkey(false).catch(() => {}), []);

  // Esc goes back (when not recording).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!recording && e.key === "Escape") {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, onBack]);

  const startRecording = () => {
    setError(null);
    setNotice(null);
    setRecording(true);
    api.suspendHotkey(true).catch(() => {});
  };

  const toggleAutostart = async () => {
    if (!settings) return;
    const enabled = !settings.autostart;
    try {
      await api.setAutostart(enabled);
      setSettings({ ...settings, autostart: enabled });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const rescan = () => {
    setNotice("Rescanning applications…");
    api.rescan().catch((e) => setError(errorMessage(e)));
  };

  return (
    <div className="settings">
      <header className="settings__header">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          ←
        </button>
        <h1>Settings</h1>
      </header>

      <div className="settings__body">
        {(error ?? settings?.hotkeyError) && (
          <div className="banner banner--error">{error ?? settings?.hotkeyError}</div>
        )}
        {notice && !error && <div className="banner">{notice}</div>}

        <section className="setting">
          <div>
            <div className="setting__title">Launcher shortcut</div>
            <div className="setting__desc">Opens or hides Fyn from anywhere.</div>
          </div>
          <button
            className={`hotkey-btn ${recording ? "hotkey-btn--recording" : ""}`}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? "Press a shortcut… (Esc to cancel)" : settings ? <Kbd keys={toKeys(settings.hotkey)} /> : "…"}
          </button>
        </section>

        <section className="setting">
          <div>
            <div className="setting__title">Launch at login</div>
            <div className="setting__desc">Start Fyn in the background when you sign in.</div>
          </div>
          <button
            role="switch"
            aria-checked={settings?.autostart ?? false}
            className={`switch ${settings?.autostart ? "switch--on" : ""}`}
            onClick={toggleAutostart}
          >
            <span className="switch__thumb" />
          </button>
        </section>

        <section className="setting">
          <div>
            <div className="setting__title">Applications</div>
            <div className="setting__desc">
              {settings ? `${settings.appCount} apps indexed. ` : ""}New installs are picked up automatically.
            </div>
          </div>
          <button className="btn" onClick={rescan}>
            Rescan
          </button>
        </section>

        <footer className="settings__footer">Fyn {settings?.version}</footer>
      </div>
    </div>
  );
}
