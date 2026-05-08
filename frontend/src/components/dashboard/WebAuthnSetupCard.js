import React, { useEffect, useState } from "react";
import API from "../../utils/api";
import { Fingerprint, CheckCircle, AlertCircle, Trash2, Loader2 } from "lucide-react";
import { registerWebAuthnDevice, isWebAuthnSupported } from "../../utils/webauthn";

export function WebAuthnSetupCard() {
  const [status, setStatus] = useState(null); // null | { allowed, registered, credentials }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { type: success|error, text }

  const supported = isWebAuthnSupported();

  const load = async () => {
    try {
      const res = await API.get("/auth/webauthn/status");
      setStatus(res.data);
    } catch (_) {
      setStatus({ allowed: false, registered: false, credentials: [] });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleRegister = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const deviceName = prompt("Name this device (e.g. 'My Phone' or 'Office Laptop'):", "My Device") || "My Device";
      const out = await registerWebAuthnDevice(deviceName);
      setMsg({ type: "success", text: out.message || "Biometric login set up!" });
      await load();
    } catch (e) {
      setMsg({ type: "error", text: e.message || "Setup failed" });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (credential_id) => {
    if (!window.confirm("Remove this device? You'll need to re-register it next time.")) return;
    setBusy(true);
    try {
      await API.delete(`/auth/webauthn/credentials/${credential_id}`);
      setMsg({ type: "success", text: "Device removed" });
      await load();
    } catch (e) {
      setMsg({ type: "error", text: e.response?.data?.detail || "Failed to remove" });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="bg-white border border-slate-200 rounded-lg p-4 mb-6 animate-pulse h-20" />;
  }
  if (!status?.allowed) return null;  // Hide for HR Admin / users without username

  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-sm p-5 mb-6" data-testid="webauthn-setup-card">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-lg bg-violet-100 flex items-center justify-center flex-shrink-0">
          <Fingerprint className="text-violet-600" size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-[#1E2A47] text-base flex items-center gap-2" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Biometric Login
            {status.registered && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 bg-green-100 text-green-700 rounded-full">
                <CheckCircle size={10} /> Active
              </span>
            )}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {status.registered
              ? "Use your fingerprint, Face ID or Windows Hello — skip the password every morning."
              : "Set up once on this device — then log in with a single tap."}
          </p>

          {!supported && (
            <p className="text-xs text-amber-700 mt-2 flex items-center gap-1.5">
              <AlertCircle size={12} /> This browser doesn't support biometric login. Try Chrome / Safari on your phone or laptop.
            </p>
          )}

          {msg && (
            <div className={`mt-3 px-3 py-2 rounded-lg text-xs ${msg.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}
              data-testid="webauthn-msg">
              {msg.text}
            </div>
          )}

          {/* Existing devices */}
          {status.credentials?.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {status.credentials.map(c => (
                <div key={c.credential_id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 text-xs"
                  data-testid={`webauthn-cred-${c.credential_id.slice(0, 8)}`}>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-700 truncate">{c.friendly_name || "Device"}</p>
                    <p className="text-slate-400 text-[10px]">
                      Added {c.created_at ? new Date(c.created_at).toLocaleDateString("en-IN") : "—"}
                      {c.last_used_at && ` · Last used ${new Date(c.last_used_at).toLocaleDateString("en-IN")}`}
                    </p>
                  </div>
                  <button onClick={() => handleRemove(c.credential_id)} disabled={busy}
                    data-testid={`remove-cred-${c.credential_id.slice(0, 8)}`}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add device button */}
          {supported && (
            <button onClick={handleRegister} disabled={busy}
              data-testid="setup-webauthn-btn"
              className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold rounded-lg disabled:opacity-60">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />}
              {status.registered ? "Add another device" : "Set up biometric login"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
