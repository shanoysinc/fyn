import { useCallback, useEffect, useState } from "react";
import { ENGINES } from "../lib/entries";
import {
  api,
  applyTheme,
  errorMessage,
  events,
  on,
  type SearchEngine,
  type Settings,
  type HomeLayout,
  type Theme,
  type UpdateInfo,
} from "../lib/ipc";
import { fromEvent, toKeys } from "../lib/hotkey";
import { Kbd } from "./Kbd";
import { BackButton } from "./ViewHeader";

interface Props {
  onBack: () => void;
  onShowWelcome: () => void;
  update: UpdateInfo | null;
  onUpdate: (update: UpdateInfo | null) => void;
}

type UpdateStatus = "idle" | "checking" | "latest" | "installing";

export function SettingsView({ onBack, onShowWelcome, update, onUpdate }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");

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

  const changeTheme = async (theme: Theme) => {
    if (!settings || settings.theme === theme) return;
    applyTheme(theme); // instant feedback; reverted below if saving fails
    try {
      await api.setTheme(theme);
      setSettings({ ...settings, theme });
    } catch (e) {
      applyTheme(settings.theme);
      setError(errorMessage(e));
    }
  };

  const setLayout = async (homeLayout: HomeLayout) => {
    if (!settings || settings.homeLayout === homeLayout) return;
    try {
      await api.setHomeLayout(homeLayout);
      setSettings({ ...settings, homeLayout });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const setEngine = async (engine: SearchEngine) => {
    if (!settings) return;
    try {
      await api.setSearchEngine(engine);
      setSettings({ ...settings, searchEngine: engine });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const rescan = () => {
    setNotice("Rescanning applications…");
    api.rescan().catch((e) => setError(errorMessage(e)));
  };

  const checkForUpdate = async () => {
    setError(null);
    setUpdateStatus("checking");
    try {
      const found = await api.checkForUpdate();
      onUpdate(found);
      setUpdateStatus(found ? "idle" : "latest");
    } catch (e) {
      setError(errorMessage(e));
      setUpdateStatus("idle");
    }
  };

  const installUpdate = async () => {
    setError(null);
    setUpdateStatus("installing");
    try {
      await api.installUpdate(); // restarts the app on success
    } catch (e) {
      setError(errorMessage(e));
      setUpdateStatus("idle");
    }
  };

  const updateDesc =
    updateStatus === "checking"
      ? "Checking…"
      : updateStatus === "installing"
        ? "Downloading and installing. Fyn will restart."
        : update
          ? `Fyn ${update.version} is available (you have ${update.currentVersion}).`
          : updateStatus === "latest"
            ? "You're on the latest version."
            : "Fyn checks for updates automatically.";

  return (
    <div className="settings">
      <header className="settings__header">
        <BackButton onBack={onBack} />
        <h1>Settings</h1>
        <span className="settings__hint">
          <Kbd keys={["Esc"]} /> to go back
        </span>
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
            <div className="setting__title">Appearance</div>
            <div className="setting__desc">Fyn’s theme. System follows Windows; your PC’s theme isn’t changed.</div>
          </div>
          <Segmented
            value={settings?.theme ?? null}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(v) => void changeTheme(v as Theme)}
          />
        </section>

        <section className="setting">
          <div>
            <div className="setting__title">Favorites &amp; suggestions</div>
            <div className="setting__desc">Show them as a row of icons or as a list on the home screen.</div>
          </div>
          <Segmented
            value={settings?.homeLayout ?? null}
            options={[
              { value: "grid", label: "Icons" },
              { value: "list", label: "List" },
            ]}
            onChange={(v) => void setLayout(v as HomeLayout)}
          />
        </section>

        <section className="setting">
          <div>
            <div className="setting__title">Search engine</div>
            <div className="setting__desc">Used for “Search the web” results at the bottom of the list.</div>
          </div>
          <Segmented
            value={settings?.searchEngine ?? null}
            options={(Object.keys(ENGINES) as SearchEngine[]).map((id) => ({ value: id, label: ENGINES[id].name }))}
            onChange={(v) => void setEngine(v as SearchEngine)}
          />
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

        <section className="setting">
          <div>
            <div className="setting__title">Updates</div>
            <div className="setting__desc">{updateDesc}</div>
          </div>
          {update ? (
            <button className="btn btn--primary" onClick={installUpdate} disabled={updateStatus === "installing"}>
              Install &amp; Restart
            </button>
          ) : (
            <button className="btn" onClick={checkForUpdate} disabled={updateStatus === "checking"}>
              Check for Updates
            </button>
          )}
        </section>

        <section className="setting">
          <div>
            <div className="setting__title">Getting started</div>
            <div className="setting__desc">See the welcome tour and tips again.</div>
          </div>
          <button className="btn" onClick={onShowWelcome}>
            Show Welcome
          </button>
        </section>

        <footer className="settings__footer">Fyn {settings?.version}</footer>
      </div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={`segmented__item ${value === o.value ? "segmented__item--on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
