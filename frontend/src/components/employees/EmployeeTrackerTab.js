import React, { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { RefreshCw, Copy, Check, MapPin, Battery, Clock, AlertCircle, MessageCircle } from "lucide-react";
import API from "../../utils/api";

const TRACCAR_ANDROID = "https://play.google.com/store/apps/details?id=org.traccar.client";
const TRACCAR_IOS     = "https://apps.apple.com/app/traccar-client/id843156974";

export function EmployeeTrackerTab({ employeeId }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);

  const serverUrl = `${window.location.origin}/api/tracker/osmand`;

  const fetchConfig = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await API.get(`/tracker/config/${employeeId}`);
      setConfig(res.data);
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to load tracker config");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfig(); }, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(""), 1500);
  };

  const regenerate = async () => {
    if (!window.confirm("Rotating the secret will stop the currently-installed tracker from working. Employee will need to re-scan the QR / re-enter the identifier. Continue?")) return;
    setRegenBusy(true);
    try {
      await API.post(`/tracker/regenerate/${employeeId}`);
      await fetchConfig();
    } catch (e) {
      alert(e.response?.data?.detail || "Regenerate failed");
    } finally {
      setRegenBusy(false);
    }
  };

  const whatsappMessage = config
    ? `Hi ${config.employee_name.split(" ")[0] || ""},\n\nInstall *Traccar Client* from Play Store/App Store (free):\n${TRACCAR_ANDROID}\n${TRACCAR_IOS}\n\nThen open the app and configure:\n\n*Server URL:*\n${serverUrl}\n\n*Device Identifier:*\n${config.identifier}\n\n*Frequency:* ${config.interval_seconds} seconds\n*Location Accuracy:* High\n\nFinally, tap *Start Service*. Your location will be tracked automatically.\n\n— Radhya HR`
    : "";

  const waLink = config
    ? `https://wa.me/${(config.employee_phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(whatsappMessage)}`
    : "#";

  if (loading) return <div className="text-sm text-slate-400 py-8 text-center">Loading tracker config...</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg">{error}</div>;
  if (!config) return null;

  const qrPayload = JSON.stringify({
    server: serverUrl,
    id: config.identifier,
    interval: config.interval_seconds,
  });

  const lastPingAgo = config.last_ping_at
    ? (() => {
        const mins = Math.round((Date.now() - new Date(config.last_ping_at).getTime()) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins} min ago`;
        if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
        return `${Math.floor(mins / 1440)} d ago`;
      })()
    : null;

  return (
    <div className="space-y-5" data-testid="tracker-tab">
      {/* Info banner */}
      <div className="bg-gradient-to-r from-[#1E2A47] to-[#2a3a5c] rounded-xl p-4 text-white">
        <div className="flex items-start gap-3">
          <MapPin size={20} className="mt-0.5 flex-shrink-0 text-[#E85B1E]" />
          <div>
            <p className="text-sm font-bold" style={{ fontFamily: "'Outfit', sans-serif" }}>Background GPS Tracker</p>
            <p className="text-xs opacity-80 mt-0.5">
              The field staff install <strong>Traccar Client</strong> — a free battery-efficient Android/iOS app — and
              configure it with the identifier below. Unlike a PWA, it can push location 24/7 even when the phone is locked.
            </p>
          </div>
        </div>
      </div>

      {/* Status card */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">Last Ping</p>
          <div className="flex items-center gap-2">
            <Clock size={14} className={config.last_ping_at ? "text-green-600" : "text-slate-400"} />
            <p className="text-sm font-semibold text-slate-700">{lastPingAgo || "Never"}</p>
          </div>
          {config.last_ping_at && (
            <p className="text-[11px] text-slate-400 mt-1">
              {new Date(config.last_ping_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
            </p>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">Battery</p>
          <div className="flex items-center gap-2">
            <Battery size={14} className={
              config.last_battery == null ? "text-slate-400" :
              config.last_battery > 30 ? "text-green-600" :
              config.last_battery > 15 ? "text-amber-500" : "text-red-600"
            } />
            <p className="text-sm font-semibold text-slate-700">
              {config.last_battery != null ? `${Math.round(config.last_battery)}%` : "—"}
            </p>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">Ping Interval</p>
          <p className="text-sm font-semibold text-slate-700">{config.interval_seconds}s</p>
          <p className="text-[11px] text-slate-400 mt-1">Configured in Traccar Client app</p>
        </div>
      </div>

      {/* QR code + copy fields */}
      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-5 bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-col items-center gap-2">
          <div className="bg-white p-2 border-2 border-slate-200 rounded-xl">
            <QRCodeCanvas value={qrPayload} size={180} level="M" includeMargin={false} data-testid="tracker-qr" />
          </div>
          <p className="text-[11px] text-slate-400 text-center max-w-[180px]">
            Scan from Traccar Client's "Import Settings" screen for one-tap setup
          </p>
        </div>

        <div className="space-y-3">
          {/* Server URL */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">Server URL</label>
            <div className="flex gap-2">
              <input readOnly value={serverUrl} data-testid="tracker-server-url"
                className="flex-1 border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-xs font-mono text-slate-700" />
              <button onClick={() => copy(serverUrl, "url")}
                className="px-3 py-2 rounded-lg bg-[#1E2A47] text-white text-xs hover:bg-[#2a3a5c]"
                data-testid="copy-url-btn">
                {copied === "url" ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          {/* Identifier */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">Device Identifier</label>
            <div className="flex gap-2">
              <input readOnly value={config.identifier} data-testid="tracker-identifier"
                className="flex-1 border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-xs font-mono text-slate-700" />
              <button onClick={() => copy(config.identifier, "id")}
                className="px-3 py-2 rounded-lg bg-[#1E2A47] text-white text-xs hover:bg-[#2a3a5c]"
                data-testid="copy-id-btn">
                {copied === "id" ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Format: <span className="font-mono">EmployeeID:Secret</span> — do not share publicly. Anyone with this ID can spoof this employee's location.
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            {config.employee_phone && (
              <a href={waLink} target="_blank" rel="noopener noreferrer"
                data-testid="whatsapp-setup-btn"
                className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-xs font-semibold hover:bg-green-700">
                <MessageCircle size={13} /> Send setup via WhatsApp
              </a>
            )}
            <button onClick={regenerate} disabled={regenBusy}
              data-testid="regenerate-secret-btn"
              className="flex items-center gap-1.5 px-3 py-2 border-2 border-red-200 text-red-600 rounded-lg text-xs font-semibold hover:bg-red-50 disabled:opacity-60">
              <RefreshCw size={13} className={regenBusy ? "animate-spin" : ""} />
              {regenBusy ? "Rotating..." : "Rotate Secret"}
            </button>
          </div>
        </div>
      </div>

      {/* Instructions */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div className="flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-amber-600" />
          <div className="text-xs text-amber-800 space-y-2">
            <p className="font-bold text-sm">Install on employee's phone (2 minutes):</p>
            <ol className="list-decimal pl-4 space-y-1">
              <li>Install <strong>Traccar Client</strong>:{" "}
                <a href={TRACCAR_ANDROID} target="_blank" rel="noopener noreferrer" className="underline font-semibold">Android</a>
                {" · "}
                <a href={TRACCAR_IOS} target="_blank" rel="noopener noreferrer" className="underline font-semibold">iOS</a>
              </li>
              <li>Open the app → tap <strong>Settings</strong> (gear icon top-right)</li>
              <li>Paste the <strong>Server URL</strong> above into the "URL" field</li>
              <li>Enter the <strong>Device Identifier</strong> above into the "Device identifier" field</li>
              <li>Set <strong>Frequency</strong> = {config.interval_seconds} seconds, <strong>Accuracy</strong> = High</li>
              <li>Go back → toggle <strong>Service status</strong> to ON</li>
              <li>Grant location permission → <strong>"Allow all the time"</strong> (critical for background)</li>
            </ol>
            <p className="text-[11px] italic mt-2">
              On Android, also disable battery optimisation for the app: <em>Settings → Apps → Traccar Client → Battery → Unrestricted</em>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
