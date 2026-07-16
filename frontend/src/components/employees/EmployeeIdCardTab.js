import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CreditCard, Download, RefreshCw } from "lucide-react";
import API from "../../utils/api";

/**
 * ID Card tab — generate the printable employee ID card.
 *
 * The emergency number is the next-of-kin contact printed on the card, NOT the
 * employee's own mobile, so it is confirmed here before a card can be made.
 */
export function EmployeeIdCardTab({ employee }) {
  const employeeId = employee.employee_id;
  const [meta, setMeta] = useState(null);
  const [emergency, setEmergency] = useState("");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await API.get(`/id-cards/${employeeId}`);
      setMeta(res.data);
      setEmergency(res.data.emergency || "");
    } catch (e) {
      setErr(e.response?.data?.detail || "Could not load ID card details");
    }
  }, [employeeId]);

  useEffect(() => { load(); }, [load]);

  const dirty = meta ? emergency.trim() !== (meta.emergency || "") : false;
  const hasEmergency = !!(meta?.emergency || "").trim();

  const saveEmergency = async () => {
    setErr(""); setNote(""); setSaving(true);
    try {
      await API.put(`/id-cards/${employeeId}/emergency`, { mobile: emergency.trim() });
      await load();
      setNote("Emergency number saved.");
    } catch (e) {
      setErr(e.response?.data?.detail || "Could not save the emergency number");
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    setErr(""); setNote(""); setDownloading(true);
    try {
      const res = await API.get(`/id-cards/${employeeId}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `IDCard_${employeeId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch (e) {
      // the error body is a blob when responseType is blob
      try {
        const text = await e.response.data.text();
        setErr(JSON.parse(text).detail || "Failed to generate the ID card");
      } catch (_) {
        setErr("Failed to generate the ID card");
      }
    } finally {
      setDownloading(false);
    }
  };

  const reissue = async () => {
    if (!window.confirm(
      "Re-issue this card?\n\nA new QR code is generated. The QR on the employee's " +
      "current printed card will stop verifying immediately. Use this if the card " +
      "was lost or stolen."
    )) return;
    setErr(""); setNote(""); setReissuing(true);
    try {
      await API.post(`/id-cards/${employeeId}/reissue`);
      await load();
      setNote("Card re-issued — the old QR no longer verifies. Print the new card.");
    } catch (e) {
      setErr(e.response?.data?.detail || "Could not re-issue the card");
    } finally {
      setReissuing(false);
    }
  };

  if (!meta) {
    return <div className="text-sm text-slate-500 py-6 text-center">Loading ID card…</div>;
  }

  const blockers = meta.missing || [];

  return (
    <div className="space-y-4" data-testid="id-card-tab">
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600 flex items-start gap-2">
        <CreditCard size={14} className="flex-shrink-0 mt-0.5 text-slate-400" />
        <span>
          Prints at <strong>5 × 8.2 cm</strong>, front and back, with a cut line. The back is the
          same on every card. The QR lets anyone verify this employee is genuine and still working here.
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Name</label>
          <div className="border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-700">{meta.name || "—"}</div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Designation</label>
          <div className={`border rounded-lg px-3 py-2 text-sm ${meta.designation ? "border-slate-200 bg-slate-50 text-slate-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            {meta.designation || "Not set — edit the employee"}
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Blood Group</label>
          <div className={`border rounded-lg px-3 py-2 text-sm ${meta.blood_group ? "border-slate-200 bg-slate-50 text-slate-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            {meta.blood_group || "Not set — edit the employee"}
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Emergency Contact Number <span className="text-red-500">*</span>
          </label>
          <div className="flex gap-2">
            <input
              value={emergency}
              onChange={(e) => setEmergency(e.target.value)}
              placeholder="e.g. 98765 43210"
              data-testid="id-card-emergency-input"
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none"
            />
            <button
              type="button" onClick={saveEmergency} disabled={saving || !dirty || !emergency.trim()}
              data-testid="id-card-save-emergency-btn"
              className="px-3 py-2 text-xs bg-[#1E2A47] text-white rounded-lg hover:bg-[#2A3A5E] disabled:opacity-50 whitespace-nowrap"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Next of kin — not the employee's own number.
          </p>
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">Photo</label>
        <div className={`text-xs rounded-lg px-3 py-2 border ${meta.has_photo ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {meta.has_photo
            ? "Passport photo on file — it will be printed on the card."
            : "No passport photo on file. The card will print a placeholder. Upload one under the Documents tab."}
        </div>
      </div>

      {blockers.length > 0 && (
        <div className="text-xs text-amber-800 bg-amber-100 border border-amber-300 rounded-lg p-2 flex items-start gap-2" data-testid="id-card-blocked">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span>Fill these before the card can be generated: <strong>{blockers.join(", ")}</strong>.</span>
        </div>
      )}
      {dirty && hasEmergency && (
        <p className="text-[11px] text-amber-700">Unsaved emergency number — click Save before downloading.</p>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button" onClick={download} disabled={downloading || blockers.length > 0 || dirty}
          data-testid="download-id-card-btn"
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-50"
        >
          {downloading
            ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Generating…</>
            : <><Download size={14} /> Download ID Card (PDF)</>}
        </button>
        <button
          type="button" onClick={reissue} disabled={reissuing}
          data-testid="reissue-id-card-btn"
          title="Generate a new QR and kill the old one — use if the card was lost"
          className="flex items-center justify-center gap-2 px-4 py-2.5 border border-slate-300 text-slate-600 rounded-lg text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} /> {reissuing ? "Re-issuing…" : "Re-issue (lost card)"}
        </button>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">Verification link (in the QR)</label>
        <div className="border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-[11px] font-mono text-slate-500 break-all">
          {meta.verify_url}
        </div>
      </div>

      {note && (
        <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg p-2 flex items-start gap-2">
          <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" /><span>{note}</span>
        </div>
      )}
      {err && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
        </div>
      )}
    </div>
  );
}
