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

    // When the SW takes control (after SKIP_WAITING), reload the page
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  });
}
