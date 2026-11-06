import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Behave like a native launcher, not a web page.
if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", (e) => {
    const reload = e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r");
    const find = e.ctrlKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "p");
    if (reload || find) e.preventDefault();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
