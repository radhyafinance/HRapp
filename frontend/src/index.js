import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register service worker for PWA (Add to Home Screen) support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Force an update check on every page load. The browser only checks
        // /sw.js automatically every ~24h, which can leave users stuck on a
        // broken SW for a day after a deploy. This makes the check immediate.
        try { reg.update(); } catch (_) { /* noop */ }
        // A new SW is already waiting (page was loaded after a deploy)
        if (reg.waiting) {
          window.dispatchEvent(new CustomEvent("swUpdateReady", { detail: reg }));
        }
        // A new SW installs while the page is open
        reg.addEventListener("updatefound", () => {
          const newSW = reg.installing;
          if (!newSW) return;
          newSW.addEventListener("statechange", () => {
            if (newSW.state === "installed" && navigator.serviceWorker.controller) {
              // New version is ready and waiting — prompt the user
              window.dispatchEvent(new CustomEvent("swUpdateReady", { detail: reg }));
            }
          });
        });
      })
      .catch((err) => console.warn("SW registration failed:", err));

    // Track whether a controller existed BEFORE any change.
    // We only want to reload when the SW is UPDATING (old → new),
    // NOT on first install (null → first SW), which would cause a blank-page reload.
    const hadControllerOnLoad = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadControllerOnLoad && !refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  });
}
