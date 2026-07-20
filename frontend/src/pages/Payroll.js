import React, { useEffect, useState, useMemo } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Play, Download, Eye, X, FileText, Save, CheckCircle2, Trash2, Send, Lock, Unlock, AlertTriangle } from "lucide-react";

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function daysInPeriod(period) {
  if (!period) return 26;
  const [yr, mo] = period.split("-").map(Number);
  if (!yr || !mo) return 26;
  return new Date(yr, mo, 0).getDate(); // last day of month = total days
}

export default function Payroll() {
  const { user } = useAuth();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [filterPeriod, setFilterPeriod] = useState("");
  const [showSlip, setShowSlip] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [editTds, setEditTds] = useState("");
  const [editOtherDed, setEditOtherDed] = useState("");
  const [editOtherAdd, setEditOtherAdd] = useState("");
  const [editLopDays, setEditLopDays] = useState("");
  const [editRemarks, setEditRemarks] = useState("");
  const [savingEdits, setSavingEdits] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [releaseNote, setReleaseNote] = useState("");
  const [releasing, setReleasing] = useState(false);
  const isManager = ["hr_admin", "management"].includes(user?.role);

  // Build dynamic period list: 2025-01 up to current month
  const periodOptions = useMemo(() => {
    const opts = [];
    const now = new Date();
    const endYear = now.getFullYear();
    const endMonth = now.getMonth() + 1;
    for (let y = 2025; y <= endYear; y++) {
      const maxM = y === endYear ? endMonth : 12;
      for (let m = 1; m <= maxM; m++) {
        opts.push(`${y}-${String(m).padStart(2, "0")}`);
      }
    }
    return opts.reverse(); // most recent first
  }, []);

  // When opening the payslip modal, prime edit fields with stored values
  const openSlip = (r) => {
    setShowSlip(r);
    setEditTds(r.tds || 0);
    setEditOtherDed(r.other_deductions || 0);
    setEditOtherAdd(r.other_additions || 0);
    const wd = r.working_days || daysInPeriod(r.period);
    const lopDays = r.lop_days != null ? r.lop_days : 0;
    setEditLopDays(lopDays);
    setEditRemarks(r.remarks || "");
    setReleaseNote("");
  };

  const releaseHold = async () => {
    if (!showSlip) return;
    const early = !showSlip.hold_eligible;
    if (early && !releaseNote.trim()) {
      alert("The exit isn't complete yet. Give a reason to release this salary early.");
      return;
    }
    const warn = early
      ? `\n\nThe exit process is NOT complete for this employee. This is an early release and will be recorded as an override.`
      : "";
    if (!window.confirm(
      `Release ${showSlip.employee_name}'s salary for ${showSlip.period}?\n\n` +
      `₹${Number(showSlip.net_salary || 0).toLocaleString("en-IN")} will be included in the next NEFT sheet you download.${warn}`
    )) return;
    setReleasing(true);
    try {
      const res = await API.post(`/payroll/${showSlip.id}/release-hold`, { note: releaseNote.trim() || null });
      setShowSlip(res.data);
      setRecords(prev => prev.map(r => r.id === res.data.id ? res.data : r));
      setReleaseNote("");
    } catch (e) {
      alert(e.response?.data?.detail || "Failed to release the hold");
    } finally {
      setReleasing(false);
    }
  };

  const saveEdits = async () => {
    if (!showSlip) return;
    setSavingEdits(true);
    try {
      const res = await API.put(`/payroll/${showSlip.id}`, {
        tds: parseFloat(editTds) || 0,
        other_deductions: parseFloat(editOtherDed) || 0,
        other_additions: parseFloat(editOtherAdd) || 0,
        lop_days: editLopDays === "" ? null : parseFloat(editLopDays) || 0,
        remarks: editRemarks || null,
      });
      setShowSlip(res.data);
      setRecords(prev => prev.map(r => r.id === res.data.id ? res.data : r));
    } catch (e) {
      alert(e.response?.data?.detail || "Failed to save changes");
    } finally {
      setSavingEdits(false);
    }
  };

  const markPaid = async () => {
    if (!showSlip) return;
    if (!window.confirm(`Mark payroll for ${showSlip.employee_name} (${showSlip.period}) as PAID?\n\nThis is final — the record will be locked.`)) return;
    setFinalizing(true);
    try {
      await API.post(`/payroll/${showSlip.id}/finalize`);
      const updated = { ...showSlip, status: "paid" };
      setShowSlip(updated);
      setRecords(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (e) {
      alert(e.response?.data?.detail || "Failed to mark as paid");
    } finally {
      setFinalizing(false);
    }
  };

  const publishPayslips = async () => {
    const p = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    if (!window.confirm(`Mark all unpaid payslips as Paid for ${months[selectedMonth-1]} ${selectedYear}?\n\nEmployees will be able to view their payslips immediately.`)) return;
    setPublishing(true);
    try {
      const res = await API.post(`/payroll/publish?period=${p}`);
      const skipped = res.data.held_skipped
        ? `\n\n${res.data.held_skipped} salary(s) on hold were SKIPPED — they stay unpaid and hidden from the employee until released.`
        : "";
      if (res.data.published === 0) {
        alert(`No payslips to publish for ${months[selectedMonth-1]} ${selectedYear}.${skipped || " They are already marked as Paid."}`);
      } else {
        alert(`${res.data.published} payslip(s) for ${months[selectedMonth-1]} ${selectedYear} marked as Paid. Employees can now view them.${skipped}`);
      }
      fetchRecords();
    } catch (e) {
      alert(e.response?.data?.detail || "Publish failed");
    } finally {
      setPublishing(false);
    }
  };

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filterPeriod) params.period = filterPeriod;
      const res = await API.get("/payroll", { params });
      setRecords(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchRecords(); }, [filterPeriod]);

  const handleProcess = async () => {
    setProcessing(true);
    try {
      const res = await API.post("/payroll/process", { month: selectedMonth, year: selectedYear });
      const heldNote = res.data.held
        ? `\n\n${res.data.held} of them are ON HOLD (resignation accepted) and will be left out of the NEFT sheet until released.`
        : "";
      alert(`Processed ${res.data.processed} payroll records for ${months[selectedMonth-1]} ${selectedYear}${heldNote}`);
      fetchRecords();
    } catch (e) {
      alert(e.response?.data?.detail || "Processing failed");
    } finally {
      setProcessing(false);
    }
  };

  const downloadNEFT = async () => {
    const period = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    try {
      const res = await API.get("/payroll/export/neft", { params: { period }, responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a"); a.href = url; a.download = `NEFT_${period}.xlsx`; a.click();
      // Three things keep someone out of this sheet, and none of them may be silent —
      // it's the file that actually moves money. Report every exclusion, with names.
      const h = res.headers || {};
      const n = (k) => Number(h[k] || 0);
      const ids = (k) => (h[k] || "").split(",").filter(Boolean).join(", ");
      const held = n("x-payroll-held-count");
      const drafts = n("x-payroll-draft-count");
      const unver = n("x-payroll-unverified-count");
      const parts = [];
      if (held > 0) {
        parts.push(
          `• ${held} ON HOLD — ₹${n("x-payroll-held-amount").toLocaleString("en-IN")} withheld ` +
          `pending exit clearance.\n  ${ids("x-payroll-held-ids")}`
        );
      }
      if (drafts > 0) {
        parts.push(
          `• ${drafts} NOT REVIEWED YET (still Draft). Open each payslip and click ` +
          `"Save Adjustments" to approve it for payment.\n  ${ids("x-payroll-draft-ids")}`
        );
      }
      if (unver > 0) {
        parts.push(
          `• ${unver} BANK NOT VERIFIED — cannot be paid until the account is verified ` +
          `on their employee record.\n  ${ids("x-payroll-unverified-ids")}\n  ` +
          `(someone can appear here AND above — both need fixing)`
        );
      }
      if (parts.length) {
        alert(
          `NEFT sheet for ${months[selectedMonth-1]} ${selectedYear}: ` +
          `${n("x-payroll-included-count")} employee(s) included.\n\n` +
          `The following were LEFT OUT:\n\n${parts.join("\n\n")}\n\n` +
          `All of them still appear in the Salary Register for your records.`
        );
      }
    } catch (e) {
      alert("NEFT export failed");
    }
  };

  const downloadSalaryRegister = async () => {
    const period = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    try {
      const res = await API.get("/payroll/export/salary-register", { params: { period }, responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a"); a.href = url; a.download = `Salary_Register_${period}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert(e.response?.status === 404 ? `No payroll records for ${period}. Process payroll first.` : "Salary Register export failed");
    }
  };

  // Whether the deletion window is still open (until 15th of month after `period`).
  const canDeletePeriod = (() => {
    const cutYear = selectedMonth === 12 ? selectedYear + 1 : selectedYear;
    const cutMonth = selectedMonth === 12 ? 1 : selectedMonth + 1;
    const cutoff = new Date(cutYear, cutMonth - 1, 15, 23, 59, 59);
    return Date.now() <= cutoff.getTime();
  })();

  const handleDeletePeriod = async () => {
    const period = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    const periodLabel = `${months[selectedMonth - 1]} ${selectedYear}`;
    const periodCount = records.filter(r => r.period === period).length;
    if (periodCount === 0) {
      alert(`No payroll records to delete for ${periodLabel}.`);
      return;
    }
    if (!window.confirm(`Delete ALL ${periodCount} payroll record(s) for ${periodLabel}?\n\nThis cannot be undone. You'll need to re-run "Process Payroll" to regenerate them.`)) return;
    try {
      const res = await API.delete(`/payroll/period/${period}`);
      alert(`Deleted ${res.data.deleted} payroll record(s) for ${periodLabel}.`);
      fetchRecords();
    } catch (e) {
      alert(e.response?.data?.detail || "Delete failed");
    }
  };

  const downloadPayslipPdf = async (record) => {
    setDownloadingId(record.id);
    try {
      const res = await API.get(`/payroll/${record.id}/payslip/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Payslip_${record.employee_name}_${record.period}.pdf`.replace(/\s+/g, "_");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert("Payslip PDF generation failed. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  const period = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
            {isManager ? "Payroll" : "My Payslips"}
          </h1>
          {isManager && <p className="text-slate-500 text-sm">{records.length} records</p>}
        </div>
        {isManager && (
          <div className="flex flex-wrap gap-2">
            <select value={selectedMonth} onChange={e => setSelectedMonth(+e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
              {months.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
            </select>
            <select value={selectedYear} onChange={e => setSelectedYear(+e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
              {[2023, 2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={handleProcess} disabled={processing} data-testid="process-payroll-btn"
              className="flex items-center gap-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-60 transition-colors">
              <Play size={14} /> {processing ? "Processing..." : "Process Payroll"}
            </button>
            <button onClick={publishPayslips} disabled={publishing} data-testid="publish-payslips-btn"
              title="Mark all unpaid payslips as Paid for this month — makes them visible to employees"
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors">
              <Send size={14} /> {publishing ? "Publishing..." : "Mark All Paid"}
            </button>
            <button onClick={downloadNEFT} data-testid="download-neft-btn"
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 transition-colors">
              <Download size={14} /> NEFT Sheet
            </button>
            <button onClick={downloadSalaryRegister} data-testid="download-register-btn"
              className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
              <Download size={14} /> Salary Register
            </button>
            <button onClick={handleDeletePeriod}
              disabled={!canDeletePeriod}
              data-testid="delete-period-btn"
              title={canDeletePeriod ? `Delete all payroll records for ${months[selectedMonth-1]} ${selectedYear}` : `Deletion window closed (allowed until 15th of the next month)`}
              className="flex items-center gap-2 px-4 py-2 border-2 border-red-300 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <Trash2 size={14} /> Delete Period
            </button>
          </div>
        )}
      </div>

      {/* Filter — manager only */}
      {isManager && (
      <div className="flex gap-3 mb-4">
        <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="payroll-period-filter">
          <option value="">All Periods</option>
          {periodOptions.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      )}

      {/* Unpublished payslips banner — shown to HR admin/management only */}
      {isManager && (() => {
        // Find all past periods (ended months) that have any non-paid records
        const now = new Date();
        const unpaidByPeriod = {};
        records.forEach(r => {
          if (r.status === "paid") return;
          const [y, m] = (r.period || "").split("-").map(Number);
          if (!y || !m) return;
          // Only flag periods whose month has already ended
          const periodEnd = new Date(y, m, 1); // 1st of next month
          if (now >= periodEnd) {
            unpaidByPeriod[r.period] = (unpaidByPeriod[r.period] || 0) + 1;
          }
        });
        const unpaidPeriods = Object.entries(unpaidByPeriod).sort((a, b) => b[0].localeCompare(a[0]));
        if (unpaidPeriods.length === 0) return null;
        return (
          <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3" data-testid="unpublished-payslips-banner">
            <div className="flex items-start gap-2 flex-1">
              <span className="mt-0.5 text-amber-500"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></span>
              <div>
                <p className="text-sm font-semibold text-amber-800">Payslips not yet released to employees</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  {unpaidPeriods.map(([p, cnt]) => `${p}: ${cnt} unpaid`).join(" · ")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {unpaidPeriods.map(([p]) => {
                const [y, m] = p.split("-").map(Number);
                return (
                  <button key={p} onClick={async () => {
                    if (!window.confirm(`Mark all payslips for ${months[m-1]} ${y} as Paid?\nEmployees will be able to view their payslips immediately.`)) return;
                    setPublishing(true);
                    try {
                      const res = await API.post(`/payroll/publish?period=${p}`);
                      alert(`${res.data.published} payslip(s) for ${months[m-1]} ${y} are now visible to employees.`);
                      fetchRecords();
                    } catch (e) { alert(e.response?.data?.detail || "Publish failed"); }
                    finally { setPublishing(false); }
                  }} disabled={publishing}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg disabled:opacity-60 transition-colors whitespace-nowrap">
                    <Send size={11} /> Release {months[m-1]}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Summary card — visible whenever the user has filtered to a single period */}
      {isManager && filterPeriod && records.length > 0 && (() => {
        const periodRecords = records.filter(r => r.period === filterPeriod);
        if (periodRecords.length === 0) return null;
        const sum = periodRecords.reduce((acc, r) => {
          const totalDed = r.total_deductions != null
            ? r.total_deductions
            : (Number(r.epf_employee || 0) + Number(r.esic_employee || 0) + Number(r.tds || 0) + Number(r.other_deductions || 0));
          const lop = r.lop_days != null ? Number(r.lop_days) : 0;
          return {
            net: acc.net + Number(r.net_salary || 0),
            ded: acc.ded + totalDed,
            lop: acc.lop + lop,
            employer: acc.employer + Number(r.epf_employer || 0) + Number(r.esic_employer || 0),
            ctc: acc.ctc + Number(r.ctc_monthly || 0),
            count: acc.count + 1,
          };
        }, { net: 0, ded: 0, lop: 0, employer: 0, ctc: 0, count: 0 });
        const fmt = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
        const fmtLop = (n) => Number.isInteger(n) ? n : n.toFixed(1);
        const cards = [
          { label: "Total Net Payable", val: fmt(sum.net),     hint: `${sum.count} employees`, accent: "bg-green-50 border-green-200 text-green-700", bigCls: "text-green-800" },
          { label: "Total Deductions", val: fmt(sum.ded),      hint: "EPF + ESIC + TDS + Other", accent: "bg-red-50 border-red-200 text-red-700",       bigCls: "text-red-800" },
          { label: "Total LOP Days",   val: fmtLop(sum.lop),   hint: "Across all employees",   accent: "bg-amber-50 border-amber-200 text-amber-700",   bigCls: "text-amber-800" },
          { label: "Employer Cost",    val: fmt(sum.employer), hint: "EPF + ESIC contributions", accent: "bg-blue-50 border-blue-200 text-blue-700",     bigCls: "text-blue-800" },
          { label: "Total Monthly CTC",val: fmt(sum.ctc),      hint: "Gross + Employer cost",  accent: "bg-slate-50 border-slate-200 text-slate-600",   bigCls: "text-[#1E2A47]" },
        ];
        return (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4" data-testid="payroll-summary-card">
            {cards.map(c => (
              <div key={c.label} className={`border rounded-xl p-3 ${c.accent}`}>
                <p className="text-[11px] font-semibold uppercase tracking-wider">{c.label}</p>
                <p className={`text-xl font-bold mt-0.5 ${c.bigCls}`} style={{ fontFamily: "'Outfit', sans-serif" }}>{c.val}</p>
                <p className="text-[10px] mt-0.5 opacity-70">{c.hint}</p>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Salaries on hold — shown to HR admin/management only */}
      {isManager && (() => {
        const held = records.filter(r => r.on_hold);
        if (held.length === 0) return null;
        const total = held.reduce((s, r) => s + Number(r.net_salary || 0), 0);
        const ready = held.filter(r => r.hold_eligible).length;
        return (
          <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 flex items-start gap-3" data-testid="held-salaries-banner">
            <Lock size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-900">
              <p className="font-bold">
                {held.length} salary{held.length === 1 ? "" : " records"} on hold — ₹{Math.round(total).toLocaleString("en-IN")} withheld
              </p>
              <p className="text-red-800 mt-0.5">
                Resignation accepted. These are left out of the NEFT sheet until released, but still appear in the Salary Register.
                {ready > 0 && (
                  <> <span className="font-semibold">{ready} {ready === 1 ? "has" : "have"} completed exit clearance and {ready === 1 ? "is" : "are"} ready to release</span> — open the payslip to release.</>
                )}
              </p>
            </div>
          </div>
        );
      })()}

      {/* Not payable yet — bank unverified or never reviewed. Both silently keep
          someone out of the NEFT sheet, so surface them before the bank run. */}
      {isManager && (() => {
        const rows = records.filter(r => r.period === period);
        const unver = rows.filter(r => r.bank_verified === false);
        const drafts = rows.filter(r => r.status === "draft" && !r.on_hold);
        if (!unver.length && !drafts.length) return null;
        const list = (rs) => rs.map(r => r.employee_id).join(", ");
        return (
          <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3" data-testid="not-payable-banner">
            <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900 space-y-1">
              <p className="font-bold">Not payable in {months[selectedMonth - 1]} {selectedYear}'s NEFT sheet</p>
              {unver.length > 0 && (
                <p><strong>{unver.length} bank account{unver.length === 1 ? "" : "s"} not verified</strong> — verify on the employee record: <span className="font-mono text-[12px]">{list(unver)}</span></p>
              )}
              {drafts.length > 0 && (
                <p><strong>{drafts.length} still Draft</strong> — nobody has reviewed the figure. Open the payslip and click Save Adjustments: <span className="font-mono text-[12px]">{list(drafts)}</span></p>
              )}
            </div>
          </div>
        );
      })()}

      {/* Manager: full payroll table */}
      {isManager && (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="payroll-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Period", "Gross", "EPF (Emp)", "ESIC (Emp)", "Deductions", "Net Salary", "Status", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : records.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-400">No payroll records. Process payroll to see records.</td></tr>
                : records.map(r => {
                  const totalDed = r.total_deductions != null
                    ? r.total_deductions
                    : (Number(r.epf_employee || 0) + Number(r.esic_employee || 0) + Number(r.tds || 0) + Number(r.other_deductions || 0));
                  return (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{r.employee_name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.period}</td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-700">₹{r.gross_salary?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-sm text-red-600">-₹{r.epf_employee?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-sm text-red-600">-₹{r.esic_employee?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-red-600" data-testid={`deductions-${r.id}`}>-₹{Math.round(totalDed).toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-sm font-bold text-green-700">₹{r.net_salary?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${r.status === "paid" ? "bg-green-100 text-green-700" : r.status === "processed" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>{r.status}</span>
                        {r.on_hold && (
                          <span data-testid={`hold-badge-${r.id}`}
                            title={r.hold_reason || "Salary on hold — excluded from the NEFT sheet"}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${r.hold_eligible ? "bg-orange-100 text-orange-700" : "bg-red-100 text-red-700"}`}>
                            <Lock size={9} /> {r.hold_eligible ? "Held — ready" : "Held"}
                          </span>
                        )}
                        {r.bank_verified === false && (
                          <span data-testid={`bank-badge-${r.id}`}
                            title="This employee's bank account is not verified, so they are left out of the NEFT sheet. Verify the account on their employee record."
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-red-100 text-red-700">
                            <AlertTriangle size={9} /> Bank not verified
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5">
                        <button onClick={() => openSlip(r)} data-testid={`view-slip-${r.id}`}
                          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" title="View payslip">
                          <Eye size={16} />
                        </button>
                        <button
                          onClick={() => downloadPayslipPdf(r)}
                          disabled={downloadingId === r.id}
                          data-testid={`download-payslip-${r.id}`}
                          className="p-1.5 rounded-lg hover:bg-[#E85B1E]/10 text-[#E85B1E] disabled:opacity-50"
                          title="Download payslip PDF"
                        >
                          {downloadingId === r.id
                            ? <div className="w-4 h-4 border-2 border-[#E85B1E] border-t-transparent rounded-full animate-spin" />
                            : <FileText size={16} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );})}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Employee / non-manager: salary slip cards only */}
      {!isManager && (
        <div className="space-y-3" data-testid="my-payslips">
          {loading && <p className="text-slate-400 text-sm py-8 text-center">Loading your payslips...</p>}
          {!loading && records.length === 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-400 shadow-sm">
              <FileText size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No payslips yet. HR processes payroll each month.</p>
            </div>
          )}
          {records.map(r => (
            <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-sm hover:shadow-md transition-shadow" data-testid={`payslip-card-${r.id}`}>
              <div>
                <p className="font-bold text-[#1E2A47]">{r.period}</p>
                <p className="text-xs text-slate-500 mt-0.5">{r.designation} • {r.department}</p>
                <p className="text-green-700 font-bold text-lg mt-1">₹{r.net_salary?.toLocaleString("en-IN")}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${r.status === "paid" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>{r.status}</span>
                <button onClick={() => openSlip(r)} data-testid={`view-slip-${r.id}`}
                  className="p-2 rounded-lg hover:bg-slate-100 text-slate-500" title="View payslip">
                  <Eye size={18} />
                </button>
                <button onClick={() => downloadPayslipPdf(r)} disabled={downloadingId === r.id}
                  data-testid={`download-payslip-${r.id}`}
                  className="p-2 rounded-lg hover:bg-[#E85B1E]/10 text-[#E85B1E] disabled:opacity-50" title="Download PDF">
                  {downloadingId === r.id
                    ? <div className="w-4 h-4 border-2 border-[#E85B1E] border-t-transparent rounded-full animate-spin" />
                    : <FileText size={18} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showSlip && (
        <Modal title={`Payslip — ${showSlip.employee_name}`} onClose={() => setShowSlip(null)}>
          <div className="space-y-4" data-testid="payslip-modal">
            {/* Header card */}
            <div className="bg-[#1E2A47] text-white p-4 rounded-lg flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-bold">{showSlip.employee_name}</p>
                <p className="text-slate-300 text-sm">{showSlip.designation} • {showSlip.department}</p>
                <p className="text-slate-400 text-xs mt-1">{showSlip.employee_id} | {showSlip.period}</p>
              </div>
              <button
                onClick={() => downloadPayslipPdf(showSlip)}
                disabled={downloadingId === showSlip.id}
                data-testid="modal-download-payslip-btn"
                className="flex items-center gap-2 px-3 py-2 bg-[#E85B1E] text-white rounded-lg text-xs font-semibold hover:bg-[#D04A15] disabled:opacity-60 whitespace-nowrap"
              >
                {downloadingId === showSlip.id
                  ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Generating...</>
                  : <><FileText size={14} /> Download PDF</>}
              </button>
            </div>

            {/* Attendance info */}
            <div className="grid grid-cols-3 gap-3">
              {[
                ["Days in Month", daysInPeriod(showSlip.period)],
                ["LOP Days",      showSlip.lop_days != null ? showSlip.lop_days : 0],
                ["Payable Days",  daysInPeriod(showSlip.period) - (showSlip.lop_days != null ? Number(showSlip.lop_days) : 0)],
              ].map(([label, val]) => (
                <div key={label} className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className={`text-lg font-bold ${label === "LOP Days" && Number(val) > 0 ? "text-red-600" : "text-[#1E2A47]"}`}>{val}</p>
                </div>
              ))}
            </div>

            {/* Earnings */}
            <div className="space-y-1.5">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Earnings</p>
              {[
                ["Basic Salary", showSlip.basic],
                ["HRA", showSlip.hra],
                ["Special Allowance", showSlip.special_allowance],
                ["Canteen Allowance", showSlip.canteen_allowance],
                ["Conveyance", showSlip.conveyance_allowance],
                ["Other Income", showSlip.other_additions],
              ].filter(([, v]) => v > 0).map(([label, val]) => (
                <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-1">
                  <span className="text-slate-600">{label}</span>
                  <span className="text-green-700 font-medium">₹{val?.toLocaleString("en-IN")}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm font-bold pt-1 border-t-2 border-slate-200">
                <span>Gross Salary</span>
                <span>₹{showSlip.gross_salary?.toLocaleString("en-IN")}</span>
              </div>
            </div>

            {/* Deductions */}
            <div className="space-y-1.5">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Deductions</p>
              {[
                ["EPF (Employee 12%)", showSlip.epf_employee],
                ["ESIC (Employee 0.75%)", showSlip.esic_employee],
              ].filter(([, v]) => v > 0).map(([label, val]) => (
                <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-1">
                  <span className="text-slate-600">{label}</span>
                  <span className="text-red-600 font-medium">-₹{val?.toLocaleString("en-IN")}</span>
                </div>
              ))}

              {isManager && showSlip.status !== "paid" ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">LOP Days</label>
                      <input type="number" min="0" step="0.5" value={editLopDays} onChange={e => setEditLopDays(e.target.value)} data-testid="edit-lop-days"
                        title="Loss of pay days. Supports 0.5 (half day). Pro-rates Basic/HRA/EPF/ESIC."
                        className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">TDS (₹)</label>
                      <input type="number" min="0" step="1" value={editTds} onChange={e => setEditTds(e.target.value)} data-testid="edit-tds"
                        className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">Other Deductions (₹)</label>
                      <input type="number" min="0" step="1" value={editOtherDed} onChange={e => setEditOtherDed(e.target.value)} data-testid="edit-other-deductions"
                        className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">Other Additions (₹)</label>
                      <input type="number" min="0" step="1" value={editOtherAdd} onChange={e => setEditOtherAdd(e.target.value)} data-testid="edit-other-additions"
                        className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                    </div>
                  </div>
                  <div className="pt-1">
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Remarks</label>
                    <input value={editRemarks} onChange={e => setEditRemarks(e.target.value)} placeholder="e.g. Bonus paid in March" data-testid="edit-remarks"
                      className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                  </div>
                  <p className="text-[11px] text-slate-500 italic">LOP days pro-rate Basic/HRA/Allowances/EPF/ESIC. Saving recalculates Net Salary and moves status to <span className="font-semibold">Processed</span>.</p>
                </>
              ) : (
                [
                  ["TDS", showSlip.tds],
                  ["Other Deductions", showSlip.other_deductions],
                ].filter(([, v]) => v > 0).map(([label, val]) => (
                  <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-1">
                    <span className="text-slate-600">{label}</span>
                    <span className="text-red-600 font-medium">-₹{val?.toLocaleString("en-IN")}</span>
                  </div>
                ))
              )}
            </div>

            {/* Salary on hold — HR releases it here */}
            {isManager && showSlip.on_hold && (
              <div className="border border-red-300 bg-red-50 rounded-lg p-3 space-y-2.5" data-testid="hold-panel">
                <div className="flex items-start gap-2">
                  <Lock size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
                  <div className="text-sm text-red-900">
                    <p className="font-bold">Salary on hold — not in the NEFT sheet</p>
                    {showSlip.hold_reason && <p className="text-red-800 text-[12px] mt-0.5">{showSlip.hold_reason}</p>}
                  </div>
                </div>
                {showSlip.hold_eligible ? (
                  <p className="text-[12px] text-green-800 bg-green-50 border border-green-200 rounded p-2 flex items-start gap-1.5">
                    <CheckCircle2 size={13} className="flex-shrink-0 mt-0.5" />
                    <span>Exit clearance is complete. This salary is ready to release.</span>
                  </p>
                ) : (
                  <p className="text-[12px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 flex items-start gap-1.5">
                    <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                    <span>The exit isn't complete yet (NOCs and final documents pending). Releasing now is an override and will be recorded as one.</span>
                  </p>
                )}
                <input
                  value={releaseNote}
                  onChange={e => setReleaseNote(e.target.value)}
                  data-testid="release-note-input"
                  placeholder={showSlip.hold_eligible ? "Note (optional)" : "Reason for releasing early (required)"}
                  className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                />
                <button onClick={releaseHold} disabled={releasing} data-testid="release-hold-btn"
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                  {releasing ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Releasing...</> : <><Unlock size={14} /> Release Salary</>}
                </button>
              </div>
            )}

            {/* HR action buttons */}
            {isManager && showSlip.status !== "paid" && (
              <div className="flex flex-col sm:flex-row gap-2">
                <button onClick={saveEdits} disabled={savingEdits} data-testid="save-payroll-edits-btn"
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50">
                  {savingEdits ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</> : <><Save size={14} /> Save Adjustments</>}
                </button>
                <button onClick={markPaid} disabled={finalizing || showSlip.status === "draft" || showSlip.on_hold} data-testid="mark-paid-btn"
                  title={showSlip.on_hold
                    ? "This salary is on hold. Release it before marking as paid."
                    : showSlip.status === "draft" ? "Save adjustments first to move record to Processed before marking as paid" : ""}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">
                  {finalizing ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Marking...</> : <><CheckCircle2 size={14} /> Mark as Paid</>}
                </button>
              </div>
            )}
            {showSlip.status === "paid" && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm flex items-center gap-2 text-green-800">
                <CheckCircle2 size={16} className="text-green-600" />
                <span><strong>Paid.</strong> This payroll record is finalized and locked.</span>
              </div>
            )}

            {/* Net salary */}
            <div className="bg-[#E85B1E] text-white p-4 rounded-lg flex justify-between items-center">
              <span className="font-bold text-lg">Net Take Home Salary</span>
              <span className="font-bold text-2xl">₹{showSlip.net_salary?.toLocaleString("en-IN")}</span>
            </div>

            {/* Employer contributions */}
            <div className="text-xs text-slate-500 space-y-1 bg-slate-50 p-3 rounded-lg">
              <p className="font-semibold text-slate-600 mb-1">Employer contributions (for reference)</p>
              <p>EPF Employer: ₹{showSlip.epf_employer?.toLocaleString("en-IN")} | ESIC Employer: ₹{showSlip.esic_employer?.toLocaleString("en-IN")}</p>
              <p>Monthly Gratuity Provision: ₹{showSlip.gratuity_monthly?.toLocaleString("en-IN")}</p>
              <p>Monthly CTC: ₹{showSlip.ctc_monthly?.toLocaleString("en-IN")}</p>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
