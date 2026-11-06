import { Command } from "cmdk";
import { useState } from "react";
import type { View } from "../lib/entries";
import { MINI_APPS } from "../miniapps/registry";
import { Glyph } from "./EntryIconView";
import { Kbd } from "./Kbd";
import { ViewHeader } from "./ViewHeader";

/** The Mini Apps screen: every built-in tool, with what it does. */
export function MiniAppsView({ onBack, onOpen }: { onBack: () => void; onOpen: (view: View) => void }) {
  const [selected, setSelected] = useState(MINI_APPS[0]?.id ?? "");
  const current = MINI_APPS.find((a) => a.id === selected);

  return (
    <div className="subview">
      <Command
        className="cmdk"
        label="Mini apps"
        loop
        value={selected}
        onValueChange={setSelected}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onBack();
          }
        }}
      >
        <ViewHeader onBack={onBack}>
          <h1 className="clip-intro__title">Mini Apps</h1>
          {/* cmdk needs an input to drive the keyboard; keep it out of sight. */}
          <Command.Input className="visually-hidden" autoFocus aria-label="Mini apps" />
        </ViewHeader>

        <Command.List className="list miniapps">
          {MINI_APPS.map((app) => (
            <Command.Item key={app.id} value={app.id} className="miniapp" onSelect={() => onOpen(app.view)}>
              <span className="miniapp__icon" style={{ background: app.tint }}>
                <Glyph name={app.glyph} size={22} />
              </span>
              <span className="miniapp__text">
                <span className="miniapp__title">{app.title}</span>
                <span className="miniapp__desc">{app.description}</span>
              </span>
            </Command.Item>
          ))}
          <div className="miniapps__more">More mini apps are on the way.</div>
        </Command.List>
      </Command>

      <footer className="footer">
        <div className="footer__left" />
        {current && (
          <div className="footer__right">
            <button className="footer__action" onClick={() => onOpen(current.view)}>
              Open {current.title} <Kbd keys={["↵"]} />
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}
