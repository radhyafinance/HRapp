import React, { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

/**
 * Listens for the "swUpdateReady" event fired by index.js when a new
 * service worker is waiting. Shows a bottom banner prompting the user
 * to refresh and get the latest version.
 */
export default function UpdatePrompt() {
  const [reg, setReg] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (e) => setReg(e.detail);
    window.addEventListener("swUpdateReady", handler);
    return () => window.removeEventListener("swUpdateReady", handler);
  }, []);

  if (!reg || dismissed) return null;

  function handleUpdate() {
    const sw = reg.waiting;
    if (sw) {
      sw.postMessage({ type: "SKIP_WAITING" });
      // Page reload is triggered by the "controllerchange" listener in index.js
    } else {
      window.location.reload();
    }
  }

  return (
    <div
      data-testid="update-prompt"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] w-[calc(100%-2rem)] max-w-sm"
      style={{ animation: "slideUp 0.3s ease-out" }}
    >
      <style>{`
        @keyframes slideUp {
          from { transform: translateX(-50%) translateY(100%); opacity: 0; }
          to   { transform: translateX(-50%) translateY(0);    opacity: 1; }
        }
      `}</style>
      <div className="flex items-center gap-3 bg-[#1E2A47] text-white rounded-xl shadow-2xl px-4 py-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight">Update available</p>
          <p className="text-xs text-slate-300 mt-0.5 leading-tight">
            A new version of the app is ready.
          </p>
        </div>
        <button
          onClick={handleUpdate}
          data-testid="update-refresh-btn"
          className="flex items-center gap-1.5 bg-[#E85B1E] hover:bg-[#d04e18] text-white text-xs font-bold px-3 py-2 rounded-lg transition-colors flex-shrink-0"
        >
          <RefreshCw size={13} />
          Refresh
        </button>
        <button
          onClick={() => setDismissed(true)}
          data-testid="update-dismiss-btn"
          className="text-slate-400 hover:text-white transition-colors flex-shrink-0 p-1"
          aria-label="Dismiss"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
