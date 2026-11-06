import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type PortEntry } from "../lib/ipc";
import { SoftTile, SourceIcon } from "./ClipboardView";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

/** What usually runs on a port, to make the list easier to read. */
export const WELL_KNOWN: Record<number, string> = {
  80: "HTTP",
  443: "HTTPS",
  1420: "Tauri",
  1433: "SQL Server",
  3000: "Dev server",
  3001: "Dev server",
  3306: "MySQL",
  4200: "Angular",
  5000: "Flask",
  5173: "Vite",
  5174: "Vite",
  5432: "PostgreSQL",
  6006: "Storybook",
  6379: "Redis",
  8000: "Dev server",
  8080: "HTTP alt",
  8081: "Metro",
  8443: "HTTPS alt",
  9000: "Dev server",
  9229: "Node debugger",
  11434: "Ollama",
  19000: "Expo",
  27017: "MongoDB",
};

const key = (p: PortEntry) => `${p.port}:${p.pid}`;
const REFRESH_MS = 3000;

/** Matches "3000", ":30", "node", "vite". */
export function matchesPort(p: PortEntry, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^:/, "");
  if (!q) return true;
  return (
    String(p.port).startsWith(q) ||
    p.name.toLowerCase().includes(q) ||
    String(p.pid) === q ||
    (WELL_KNOWN[p.port]?.toLowerCase().includes(q) ?? false)
  );
}

export function PortsView({ onBack }: { onBack: () => void }) {
  const [ports, setPorts] = useState<PortEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const busy = useRef(false);

  const load = useCallback(async (manual = false) => {
    if (busy.current) return;
    busy.current = true;
    if (manual) setLoading(true);
    try {
      setPorts(await api.portsList());
    } catch (e) {
      setToast({ text: errorMessage(e), error: true });
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  // Live list: servers come and go while you work.
  useEffect(() => {
    void load(true);
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  const visible = useMemo(() => (ports ?? []).filter((p) => matchesPort(p, query)), [ports, query]);
  const yours = visible.filter((p) => !p.protected);
  const system = visible.filter((p) => p.protected);
  const current = visible.find((p) => key(p) === selected) ?? null;

  // Keep a sensible selection as the list changes underneath.
  useEffect(() => {
    if (!visible.length) return;
    if (!visible.some((p) => key(p) === selected)) setSelected(key(yours[0] ?? visible[0]));
  }, [visible, yours, selected]);

  const stop = useCallback(
    async (p: PortEntry | null) => {
      if (!p || stopping) return;
      if (p.protected) {
        setToast({ text: `${p.name} is part of Windows, so Fyn leaves it alone`, error: true });
        return;
      }
      if (confirm !== key(p)) {
        setConfirm(key(p));
        return;
      }
      setConfirm(null);
      setStopping(key(p));
      try {
        const message = await api.portsKill(p.port, p.pid);
        setToast({ text: message });
        // Let the row fade out, then refresh.
        setTimeout(() => {
          setPorts((list) => list?.filter((x) => x.pid !== p.pid) ?? null);
          setStopping(null);
          void load();
        }, 260);
      } catch (e) {
        setStopping(null);
        setToast({ text: errorMessage(e), error: true });
      }
    },
    [confirm, load, stopping],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (confirm) setConfirm(null);
      else if (query) setQuery("");
      else onBack();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      void load(true);
    }
  };

  const total = ports?.length ?? 0;

  return (
    <div className="subview">
      <Command
        className="cmdk"
        label="Port Killer"
        loop
        shouldFilter={false}
        value={selected}
        onValueChange={(v) => {
          setSelected(v);
          setConfirm(null);
        }}
        onKeyDown={onKeyDown}
      >
        <ViewHeader onBack={onBack}>
          <Command.Input
            className="search__input"
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Filter by port or app…"
            spellCheck={false}
          />
          {ports && (
            <span className="ports__count">
              <span className="ports__live" aria-hidden />
              {total} listening
            </span>
          )}
          <button className={`icon-btn ${loading ? "spin" : ""}`} aria-label="Refresh" title="Refresh (Ctrl+R)" onClick={() => void load(true)}>
            <Glyph name="refresh" size={16} />
          </button>
        </ViewHeader>

        <Command.List className="list ports">
          {ports === null ? (
            <div className="empty">Looking for listening ports…</div>
          ) : visible.length === 0 ? (
            <div className="ports__empty">
              <SoftTile glyph="plug" tint="#0f766e" />
              <strong>{query ? `Nothing on “${query}”` : "Nothing is listening"}</strong>
              <span>{query ? "That port is free to use." : "Start a dev server and it shows up here."}</span>
            </div>
          ) : (
            <>
              {yours.length > 0 && (
                <Command.Group heading="Your apps" className="group">
                  {yours.map((p) => (
                    <PortRow key={key(p)} port={p} confirming={confirm === key(p)} stopping={stopping === key(p)} onSelect={() => void stop(p)} />
                  ))}
                </Command.Group>
              )}
              {system.length > 0 && (
                <Command.Group heading="Windows & services" className="group">
                  {system.map((p) => (
                    <PortRow key={key(p)} port={p} confirming={false} stopping={false} onSelect={() => void stop(p)} />
                  ))}
                </Command.Group>
              )}
            </>
          )}
        </Command.List>
      </Command>

      <footer className="footer">
        <div className="footer__left">
          {toast ? (
            <span className={`toast ${toast.error ? "toast--error" : ""}`}>{toast.text}</span>
          ) : (
            <span className="footer__hint footer__hint--sentence">
              {confirm && current ? (
                <>Press ↵ again to stop {current.name}</>
              ) : (
                <>
                  <Kbd keys={["Ctrl", "R"]} /> Refresh
                </>
              )}
            </span>
          )}
        </div>
        <div className="footer__right">
          <button
            className={`btn btn--primary btn--danger ports__stop ${confirm ? "btn--armed" : ""}`}
            disabled={!current || current.protected || stopping !== null}
            onClick={() => void stop(current)}
          >
            {confirm ? "Confirm Stop" : current && !current.protected ? `Stop ${current.name}` : "Stop"}
            <Kbd keys={["↵"]} />
          </button>
        </div>
      </footer>
    </div>
  );
}

function PortRow({ port: p, confirming, stopping, onSelect }: { port: PortEntry; confirming: boolean; stopping: boolean; onSelect: () => void }) {
  const known = WELL_KNOWN[p.port];
  return (
    <Command.Item
      value={key(p)}
      onSelect={onSelect}
      className={`row port ${p.protected ? "port--system" : ""} ${confirming ? "port--confirm" : ""} ${stopping ? "port--stopping" : ""}`}
    >
      <span className="port__num">
        <span className="port__colon">:</span>
        {p.port}
      </span>
      <SourceIcon path={p.icon} fallback={<SoftTile glyph={p.protected ? "gear" : "code"} tint={p.protected ? "#8b8b94" : "#0f766e"} />} />
      <span className="port__text">
        <span className="port__name">
          <span className="port__app">{p.name}</span>
          {known && <span className="port__tag">{known}</span>}
        </span>
        <span className="port__meta">
          PID {p.pid} · {p.addresses.join(", ")}
        </span>
      </span>
      {p.protected ? (
        <span className="port__lock" title="Part of Windows: can't be stopped here">
          <Glyph name="lock" size={12} /> System
        </span>
      ) : (
        <span className="port__action">{confirming ? "Press ↵ to stop" : "Stop"}</span>
      )}
    </Command.Item>
  );
}
