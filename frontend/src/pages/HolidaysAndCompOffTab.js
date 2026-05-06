import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { Plus, Edit2, Trash2, Sparkles, RefreshCw, Check, X as XIcon, Clock, Calendar as CalIcon, AlertCircle } from "lucide-react";

const TYPE_BADGES = {
  national: { bg: "bg-orange-100", text: "text-orange-700" },
  festival: { bg: "bg-red-100", text: "text-red-700" },
  company:  { bg: "bg-blue-100", text: "text-blue-700" },
  regional: { bg: "bg-amber-100", text: "text-amber-700" },
};

function MiniModal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><XIcon size={18} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export default function HolidaysAndCompOffTab() {
  const todayY = new Date().getFullYear();
  const [year, setYear] = useState(todayY);
  const [holidays, setHolidays] = useState([]);
  const [holidayLoading, setHolidayLoading] = useState(true);
  const [holidayForm, setHolidayForm] = useState(null); // {date, name, type, description, id?}
  const [savingHoliday, setSavingHoliday] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);
  const [holidayErr, setHolidayErr] = useState("");

  // Comp-off
  const [pending, setPending] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [actBusy, setActBusy] = useState(null); // grant_id being acted on

  const fetchHolidays = async () => {
    setHolidayLoading(true);
    try {
      const res = await API.get("/holidays", { params: { year } });
      setHolidays(res.data || []);
    } catch (e) { console.error(e); }
    finally { setHolidayLoading(false); }
  };
  useEffect(() => { fetchHolidays(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchPending = async () => {
    setPendingLoading(true);
    try {
      const res = await API.get("/comp-offs/pending");
      setPending(res.data || []);
    } catch (e) { console.error(e); }
    finally { setPendingLoading(false); }
  };
  useEffect(() => { fetchPending(); }, []);

  const seedDefaults = async () => {
    if (!window.confirm(`Seed Government of India default holidays for ${year}? Skips dates that already exist.`)) return;
    setSeedBusy(true);
    try {
      const res = await API.post("/holidays/seed-defaults", null, { params: { year } });
      alert(res.data.message);
      await fetchHolidays();
    } catch (e) {
      alert(e.response?.data?.detail || "Seed failed");
    } finally { setSeedBusy(false); }
  };

  const openAdd = () => {
    setHolidayErr("");
    setHolidayForm({ date: `${year}-01-01`, name: "", type: "festival", description: "" });
  };

  const openEdit = (h) => {
    setHolidayErr("");
    setHolidayForm({ ...h, description: h.description || "" });
  };

  const submitHoliday = async () => {
    if (!holidayForm.name.trim()) { setHolidayErr("Name is required"); return; }
    if (!holidayForm.date) { setHolidayErr("Date is required"); return; }
    setSavingHoliday(true);
    setHolidayErr("");
    try {
      const payload = {
        date: holidayForm.date, name: holidayForm.name.trim(),
        type: holidayForm.type, description: holidayForm.description?.trim() || null,
      };
      if (holidayForm.id) {
        await API.put(`/holidays/${holidayForm.id}`, payload);
      } else {
        await API.post("/holidays", payload);
      }
      setHolidayForm(null);
      await fetchHolidays();
    } catch (e) {
      setHolidayErr(e.response?.data?.detail || "Save failed");
    } finally { setSavingHoliday(false); }
  };

  const deleteHoliday = async (id, name) => {
    if (!window.confirm(`Delete holiday "${name}"?`)) return;
    try {
      await API.delete(`/holidays/${id}`);
      await fetchHolidays();
    } catch (e) {
      alert(e.response?.data?.detail || "Delete failed");
    }
  };

  const scanCandidates = async () => {
    setScanBusy(true); setScanResult(null);
    try {
      const res = await API.post("/comp-offs/scan-candidates", null, { params: { days_back: 60 } });
      setScanResult(res.data);
      await fetchPending();
    } catch (e) {
      alert(e.response?.data?.detail || "Scan failed");
    } finally { setScanBusy(false); }
  };

  const approve = async (g) => {
    setActBusy(g.id);
    try {
      await API.put(`/comp-offs/${g.id}/approve`, { remarks: "" });
      await fetchPending();
    } catch (e) {
      alert(e.response?.data?.detail || "Approve failed");
    } finally { setActBusy(null); }
  };

  const reject = async (g) => {
    const reason = window.prompt("Reason for rejection? (required)");
    if (!reason || !reason.trim()) return;
    setActBusy(g.id);
    try {
      await API.put(`/comp-offs/${g.id}/reject`, { remarks: reason.trim() });
      await fetchPending();
    } catch (e) {
      alert(e.response?.data?.detail || "Reject failed");
    } finally { setActBusy(null); }
  };

  return (
    <div className="space-y-5">
      {/* Holiday list */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
        <div className="p-5 border-b border-slate-100 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <h3 className="text-base font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Holiday Calendar — {year}</h3>
            <p className="text-xs text-slate-500">Calendar-year scope · Sundays + 1st/3rd Saturdays for HO staff are automatic</p>
          </div>
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" data-testid="holiday-year-select">
            {[todayY - 1, todayY, todayY + 1, todayY + 2].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={seedDefaults} disabled={seedBusy} data-testid="seed-defaults-btn"
            className="flex items-center gap-1.5 px-3 py-2 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2a3a5c] disabled:opacity-60">
            <Sparkles size={13} /> {seedBusy ? "Seeding..." : "Seed India Defaults"}
          </button>
          <button onClick={openAdd} data-testid="add-holiday-btn"
            className="flex items-center gap-1.5 px-3 py-2 bg-[#E85B1E] text-white rounded-lg text-xs font-semibold hover:bg-[#D04A15]">
            <Plus size={13} /> Add Holiday
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="holidays-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Date", "Day", "Holiday", "Type", "Description", ""].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {holidayLoading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
              ) : holidays.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-slate-400">
                  No holidays configured for {year}. Click <strong>Seed India Defaults</strong> to start, or add manually.
                </td></tr>
              ) : holidays.map(h => {
                const d = new Date(h.date);
                const badge = TYPE_BADGES[h.type] || TYPE_BADGES.festival;
                return (
                  <tr key={h.id} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`holiday-row-${h.id}`}>
                    <td className="px-4 py-3 text-sm font-medium font-mono text-[#1E2A47]">{h.date}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{d.toLocaleDateString("en-IN", { weekday: "long" })}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-slate-700">{h.name}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-[10px] font-medium uppercase ${badge.bg} ${badge.text}`}>{h.type}</span></td>
                    <td className="px-4 py-3 text-xs text-slate-500 max-w-xs">{h.description || "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button onClick={() => openEdit(h)} data-testid={`edit-holiday-${h.id}`}
                          className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-[#E85B1E]"><Edit2 size={12} /></button>
                        <button onClick={() => deleteHoliday(h.id, h.name)} data-testid={`delete-holiday-${h.id}`}
                          className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Comp-off pending approvals */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
        <div className="p-5 border-b border-slate-100 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <h3 className="text-base font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Compensatory Off — Pending Approvals</h3>
            <p className="text-xs text-slate-500">Auto-detected from punch-ins on holidays / Sundays / non-working Saturdays · Approved comp-offs expire in 90 days</p>
          </div>
          <button onClick={scanCandidates} disabled={scanBusy} data-testid="scan-compoff-btn"
            className="flex items-center gap-1.5 px-3 py-2 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2a3a5c] disabled:opacity-60">
            <RefreshCw size={13} className={scanBusy ? "animate-spin" : ""} /> {scanBusy ? "Scanning..." : "Scan Last 60 Days"}
          </button>
        </div>
        {scanResult && (
          <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 text-xs text-blue-700">
            <AlertCircle size={12} className="inline mr-1" />
            Scanned <strong>{scanResult.scanned_records}</strong> punch-in records, created <strong>{scanResult.candidates_created}</strong> new candidate(s).
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="compoff-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Earn Date", "Reason", "Hours Worked", "Action"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {pendingLoading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
              ) : pending.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-sm text-slate-400">
                  No pending comp-off candidates. <button onClick={scanCandidates} className="underline hover:text-[#E85B1E]">Run a scan</button> to detect any.
                </td></tr>
              ) : pending.map(g => {
                const earn = new Date(g.earn_date);
                return (
                  <tr key={g.id} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`compoff-row-${g.id}`}>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-slate-700">{g.employee_name}</p>
                      <p className="text-[11px] text-[#E85B1E] font-mono">{g.employee_id}{g.designation ? ` · ${g.designation}` : ""}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-slate-700">{g.earn_date}</p>
                      <p className="text-[11px] text-slate-400">{earn.toLocaleDateString("en-IN", { weekday: "long" })}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{g.earn_reason}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{g.hours_worked ? `${g.hours_worked.toFixed(1)} h` : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button onClick={() => approve(g)} disabled={actBusy === g.id} data-testid={`approve-compoff-${g.id}`}
                          className="flex items-center gap-1 px-2.5 py-1 bg-green-600 text-white rounded-lg text-xs font-semibold hover:bg-green-700 disabled:opacity-60">
                          <Check size={11} /> Approve
                        </button>
                        <button onClick={() => reject(g)} disabled={actBusy === g.id} data-testid={`reject-compoff-${g.id}`}
                          className="flex items-center gap-1 px-2.5 py-1 border border-red-200 text-red-600 rounded-lg text-xs font-semibold hover:bg-red-50 disabled:opacity-60">
                          <XIcon size={11} /> Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit modal */}
      {holidayForm && (
        <MiniModal title={holidayForm.id ? "Edit Holiday" : "Add Holiday"} onClose={() => setHolidayForm(null)}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Date *</label>
              <input type="date" value={holidayForm.date}
                onChange={e => setHolidayForm(f => ({ ...f, date: e.target.value }))}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                data-testid="holiday-date" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Name *</label>
              <input value={holidayForm.name}
                onChange={e => setHolidayForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Diwali"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                data-testid="holiday-name" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Type</label>
              <select value={holidayForm.type}
                onChange={e => setHolidayForm(f => ({ ...f, type: e.target.value }))}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none"
                data-testid="holiday-type">
                <option value="national">National</option>
                <option value="festival">Festival</option>
                <option value="company">Company</option>
                <option value="regional">Regional</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Description (optional)</label>
              <input value={holidayForm.description}
                onChange={e => setHolidayForm(f => ({ ...f, description: e.target.value }))}
                placeholder="e.g. Festival of Lights"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            {holidayErr && <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-2.5 rounded-lg">{holidayErr}</div>}
            <div className="flex gap-2 pt-2">
              <button onClick={() => setHolidayForm(null)}
                className="flex-1 px-4 py-2 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
              <button onClick={submitHoliday} disabled={savingHoliday}
                data-testid="save-holiday-btn"
                className="flex-1 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
                {savingHoliday ? "Saving..." : (holidayForm.id ? "Save Changes" : "Add Holiday")}
              </button>
            </div>
          </div>
        </MiniModal>
      )}
    </div>
  );
}
