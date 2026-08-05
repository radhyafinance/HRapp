import React, { useEffect, useState, useMemo } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Play, Download, Eye, X, FileText, Save, CheckCircle2, Trash2, Send, Lock, Unlock, AlertTriangle, RefreshCw } from "lucide-react";

// The monthly run is a fixed sequence and the order matters: marking paid is
// what freezes a record, so doing it early loses the ability to correct. Rather
// than expecting HR to remember that, the page shows where the selected month
// actually is and what to do next.
const STEPS = [
  { n: 1, label: "Process Payroll",
    doing: "Creates a draft payslip for every active employee this month." },
  { n: 2, label: "Approve for Payment",
    doing: "Moves the drafts to Processed. Nothing is in the bank sheet until this is done." },
  { n: 3, label: "NEFT Sheet",
    doing: "Download the bank file and complete the transfer. Anyone left out is listed for you." },
  { n: 4, label: "Recalculate LOP",
    doing: "Only if attendance or leave changed since the run. Do it BEFORE marking paid." },
  { n: 5, label: "Mark All Paid",
    doing: "Once the money has actually gone. This locks the payslips — do it last. "
         + "Anyone held, or paid by cheque outside the bank file, must be marked on their own payslip." },
];

function WorkflowStrip({ counts, exportCount, monthLabel }) {
  const { total, draft, unpaid, paid } = counts;
  // Which step the selected month is genuinely at, derived from its records.
  let current = 1;
  if (total === 0) current = 1;
  else if (draft > 0) current = 2;
  else if (exportCount === 0) current = 3;
  else if (unpaid > 0) current = 5;
  else current = 6;                                   // nothing left to do

  const state = (n) => n < current ? "done" : n === current ? "now" : "next";
  const cls = { done: "bg-green-50 border-green-300 text-green-800",
                now: "bg-[#E85B1E] border-[#E85B1E] text-white shadow-sm",
                next: "bg-white border-slate-200 text-slate-400" };
  const here =
    current === 1 ? `No payslips exist for ${monthLabel} yet.`
    : current === 2 ? `${draft} payslip(s) are still Draft — they are NOT in the bank sheet.`
    : current === 3 ? `${total} payslip(s) approved. No NEFT file has been downloaded yet.`
    : current === 5 ? `Bank file downloaded. ${unpaid} payslip(s) not yet paid.`
    : `All ${paid} payslip(s) for ${monthLabel} are marked paid. Nothing left to do.`;

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4" data-testid="workflow-strip">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Monthly payroll — {monthLabel}
        </p>
        <p className="text-xs text-slate-500" data-testid="workflow-here">{here}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.n}>
            <div data-testid={`workflow-step-${s.n}`} data-state={state(s.n)}
              title={s.doing}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold ${cls[state(s.n)]}`}>
              <span className={`w-4 h-4 rounded-full grid place-items-center text-[10px] ${
                state(s.n) === "done" ? "bg-green-600 text-white"
                : state(s.n) === "now" ? "bg-white text-[#E85B1E]" : "bg-slate-200 text-slate-500"}`}>
                {state(s.n) === "done" ? "✓" : s.n}
              </span>
              {s.label}
              {s.n === 4 && <span className="font-normal opacity-70">(if needed)</span>}
            </div>
            {i < STEPS.length - 1 && <span className="text-slate-300 text-xs">›</span>}
          </React.Fragment>
        ))}
      </div>
      {current <= 5 && (
        <p className="text-xs text-slate-600 mt-2.5" data-testid="workflow-next">
          <strong className="text-[#E85B1E]">Next:</strong>{" "}
          {STEPS.find(s => s.n === current)?.doing}
        </p>
      )}
    </div>
  );
}

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
  const [recalc, setRecalc] = useState(null);        // preview payload, null = closed
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [recalcApplying, setRecalcApplying] = useState(false);
  const [recalcConfirmed, setRecalcConfirmed] = useState(false);
  const [payPreview, setPayPreview] = useState(null);   // publish preview, null = closed
  const [payApplying, setPayApplying] = useState(false);
  const [payDate, setPayDate] = useState("");
  const [reopening, setReopening] = useState(false);
  const [approving, setApproving] = useState(false);
  // How many NEFT files exist for the selected month — the workflow strip needs
  // it to tell "approved but not sent" from "sent, waiting to be marked paid".
  const [exportCount, setExportCount] = useState(null);
  // Downloading the sheet changes no record, so the effect below would not
  // re-run and the workflow strip would sit on "not downloaded yet".
  const [exportBump, setExportBump] = useState(0);
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
      // LOP entered on a month that already excludes non-employed days deducts
      // them twice. The save still goes through — HR may have meant it — but it
      // must not pass silently.
      if (res.data.warning) alert(res.data.warning);
    } catch (e) {
      alert(e.response?.data?.detail || "Failed to save changes");
    } finally {
      setSavingEdits(false);
    }
  };

  // The exception path. If the employee was in a NEFT file this behaves as
  // before; if not, the server demands a reason, so ask for one and resend.
  const markPaid = async (reason) => {
    if (!showSlip) return;
    if (reason === undefined &&
        !window.confirm(`Mark payroll for ${showSlip.employee_name} (${showSlip.period}) as PAID?\n\nThe record is locked once paid — reopening it later needs a reason.`)) return;
    setFinalizing(true);
    try {
      const res = await API.post(`/payroll/${showSlip.id}/finalize`,
        reason ? { reason } : {});
      const updated = { ...showSlip, status: "paid",
                        paid_outside_neft: res.data?.paid_outside_neft };
      setShowSlip(updated);
      setRecords(prev => prev.map(r => r.id === updated.id ? updated : r));
    } catch (e) {
      const detail = e.response?.data?.detail || "Failed to mark as paid";
      // 400 with "not in any NEFT file" — this is the cheque / manual-transfer
      // case. Collect the reason rather than dead-ending. `reason === undefined`
      // means this is the FIRST attempt: without that guard a server that keeps
      // refusing would prompt in an endless loop.
      if (reason === undefined && e.response?.status === 400 && /not in any NEFT file/.test(detail)) {
        const why = window.prompt(
          `${showSlip.employee_name} was not in any NEFT file for ${showSlip.period}, so the ` +
          `system cannot confirm this payment.\n\nHow were they paid? (e.g. cheque no. 12345, ` +
          `manual transfer on 31 Jul)`);
        if (why === null) return;
        if (!why.trim()) { alert("A reason is required to record this payment."); return; }
        setFinalizing(false);
        return markPaid(why.trim());
      }
      alert(detail);
    } finally {
      setFinalizing(false);
    }
  };

  // Nothing is written until Apply. The preview and the apply run the SAME
  // scoring on the server, so what HR confirms is what gets saved.
  const openRecalc = async () => {
    setRecalcLoading(true);
    setRecalcConfirmed(false);
    try {
      const p = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
      const res = await API.get(`/payroll/recalculate-lop/preview?period=${p}`);
      setRecalc(res.data);
    } catch (e) {
      alert(e.response?.data?.detail || "Could not read the recalculation preview");
    } finally {
      setRecalcLoading(false);
    }
  };

  const applyRecalc = async () => {
    if (!recalc) return;
    setRecalcApplying(true);
    try {
      // From the preview, NOT the dropdown: changing the month behind an open
      // modal would otherwise rewrite a period nobody previewed — and carry this
      // month's after-export consent across to it.
      const p = recalc.period;
      const q = recalc.already_exported ? "&confirm_after_export=true" : "";
      const res = await API.post(`/payroll/recalculate-lop?period=${p}${q}`);
      alert(`${res.data.applied} record(s) updated for ${p}.`);
      setRecalc(null);
      fetchRecords();
    } catch (e) {
      alert(e.response?.data?.detail || "Recalculation failed");
    } finally {
      setRecalcApplying(false);
    }
  };

  // "Mark All Paid" used to double as the approval step by moving drafts
  // straight to paid. Now that paid means "the bank sent this", approval needs
  // its own action or a fresh month can never reach the bank file.
  const approvePeriod = async () => {
    const p = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    const label = `${months[selectedMonth-1]} ${selectedYear}`;
    // Count only THIS period's drafts. The table below is filtered separately
    // (it defaults to All Periods), so counting every loaded record made the
    // button claim drafts existed for a month that had none.
    const known = records.filter(r => r.period === p);
    const draftCount = known.filter(r => r.status === "draft").length;
    // Only trust a zero when we actually loaded that period; if the table is
    // filtered to a different month we have no local view of it, so ask the
    // server rather than refusing on missing data.
    if (known.length > 0 && draftCount === 0) {
      alert(`Nothing to approve for ${label} — none of its payslips are still in Draft.`);
      return;
    }
    if (!window.confirm(
      (draftCount ? `Approve ${draftCount} draft payslip(s) for ${label}?`
                  : `Approve all draft payslips for ${label}?`) + `\n\n` +
      `They move to Processed, which is what puts them in the NEFT sheet. No money moves ` +
      `and nothing is marked paid.`)) return;
    setApproving(true);
    try {
      const res = await API.post(`/payroll/approve?period=${p}`);
      if (!res.data.approved) {
        alert(`Nothing was approved — ${label} has no payslips in Draft.\n\n` +
              `Check the month selector at the top of the page: it is set to ${label}, ` +
              `which is what this button acts on, not the period filter below.`);
      } else {
        alert(`${res.data.approved} payslip(s) approved for payment in ${label}. ` +
              `Download the NEFT sheet next.`);
      }
      fetchRecords();
    } catch (e) {
      alert(e.response?.data?.detail || "Could not approve this month");
    } finally {
      setApproving(false);
    }
  };

  // Preview first — the valuable output is who is NOT going to be marked paid.
  // Period is passed explicitly so the "Release <month>" banner buttons go
  // through this same preview instead of posting straight to /publish.
  const openPublish = async (y = selectedYear, m = selectedMonth) => {
    setPublishing(true);
    try {
      const p = `${y}-${String(m).padStart(2, "0")}`;
      const res = await API.get(`/payroll/publish/preview?period=${p}`);
      setPayPreview(res.data);
      setPayDate(new Date().toISOString().slice(0, 10));
    } catch (e) {
      alert(e.response?.data?.detail || "Could not read the payment preview");
    } finally {
      setPublishing(false);
    }
  };

  const applyPublish = async () => {
    if (!payPreview) return;
    setPayApplying(true);
    try {
      // From the preview itself, so the banner path can't apply to a different
      // month than the one it previewed.
      const p = payPreview.period;
      const d = payDate ? `&payment_date=${payDate}` : "";
      const res = await API.post(`/payroll/publish?period=${p}${d}`);
      alert(`${res.data.published} payslip(s) for ${p} marked as paid.`);
      setPayPreview(null);
      fetchRecords();
    } catch (e) {
      alert(e.response?.data?.detail || "Could not mark as paid");
    } finally {
      setPayApplying(false);
    }
  };

  const reopenSlip = async () => {
    if (!showSlip || reopening) return;
    const reason = window.prompt(
      `Reopen ${showSlip.employee_name}'s payslip for ${showSlip.period}?\n\n` +
      `It goes back to Processed and disappears from their view until it is marked paid again.\n\n` +
      `Reason:`);
    if (reason === null) return;
    if (!reason.trim()) { alert("A reason is required to reopen a paid payslip."); return; }
    setReopening(true);
    try {
      const res = await API.post(`/payroll/${showSlip.id}/reopen`, { reason: reason.trim() });
      setShowSlip(res.data);
      setRecords(prev => prev.map(r => r.id === res.data.id ? res.data : r));
    } catch (e) {
      alert(e.response?.data?.detail || "Could not reopen this payslip");
    } finally {
      setReopening(false);
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

  useEffect(() => {
    if (!isManager) return;
    const p = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    let stale = false;
    API.get(`/payroll/export-history?period=${p}`)
      .then(r => { if (!stale) setExportCount(Array.isArray(r.data) ? r.data.length : 0); })
      .catch(() => { if (!stale) setExportCount(null); });
    return () => { stale = true; };
  }, [isManager, selectedMonth, selectedYear, records, exportBump]);

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

  const downloadNEFT = async (confirmReexport = false) => {
    const period = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    try {
      const params = confirmReexport ? { period, confirm_reexport: true } : { period };
      const res = await API.get("/payroll/export/neft", { params, responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a"); a.href = url; a.download = `NEFT_${period}.xlsx`; a.click();
      // Four things keep someone out of this sheet, and none of them may be silent —
      // it's the file that actually moves money. Report every exclusion, with names.
      setExportBump((b) => b + 1);
      const h = res.headers || {};
      const n = (k) => Number(h[k] || 0);
      const ids = (k) => (h[k] || "").split(",").filter(Boolean).join(", ");
      const held = n("x-payroll-held-count");
      const drafts = n("x-payroll-draft-count");
      const unver = n("x-payroll-unverified-count");
      const nonpos = n("x-payroll-nonpositive-count");
      const parts = [];
      if (nonpos > 0) {
        parts.push(
          `• ${nonpos} NOT PAID — net salary is zero or less, usually deductions larger ` +
          `than the month's pay. A negative amount would tell the bank to take money OUT ` +
          `of the employee's account, so these are withheld. Reduce the deduction and ` +
          `recover the balance over the following months.\n  ${ids("x-payroll-nonpositive-ids")}`
        );
      }
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
      const incomplete = n("x-payroll-incomplete-count");
      if (incomplete > 0) {
        parts.push(
          `• ${incomplete} MISSING ACCOUNT NUMBER OR IFSC — verified, but the bank ` +
          `details on their employee record are incomplete. Previously these were ` +
          `written into the sheet as blank cells.\n  ${ids("x-payroll-incomplete-ids")}`
        );
      }
      // Included, but worth a second look before the money moves — so it is a
      // separate warning, not one of the exclusions above.
      const conflicting = n("x-payroll-conflicting-count");
      if (conflicting > 0) {
        parts.push(
          `• ${conflicting} DUPLICATE RECORDS THAT DISAGREE ON THE AMOUNT — withheld, ` +
          `because only a person can say which figure is right. Resolve them, then ` +
          `re-export.\n  ${ids("x-payroll-conflicting-ids")}`
        );
      }
      const badstatus = n("x-payroll-badstatus-count");
      if (badstatus > 0) {
        parts.push(
          `• ${badstatus} with a status that is not payable (cancelled, reversed, or ` +
          `blank).\n  ${ids("x-payroll-badstatus-ids")}`
        );
      }
      const unnamed = n("x-payroll-unnamed-count");
      const manual = n("x-payroll-manual-count");
      const duplicate = n("x-payroll-duplicate-count");
      const alreadypaid = n("x-payroll-alreadypaid-count");
      const prevExports = n("x-payroll-previous-exports");
      const notes = [];
      if (unnamed > 0) {
        notes.push(
          `• ${unnamed} verified WITHOUT the bank returning an account-holder name. ` +
          `Re-verify these before paying — a verification could previously be recorded ` +
          `from a reply that contained no verification data at all.\n  ${ids("x-payroll-unnamed-ids")}`
        );
      }
      if (manual > 0) {
        notes.push(
          `• ${manual} MANUALLY marked verified by an admin, not confirmed by Perfios.\n  ` +
          ids("x-payroll-manual-ids")
        );
      }
      if (duplicate > 0) {
        notes.push(
          `• ${duplicate} had TWO payroll records for this month with the same amount. ` +
          `Each is in the sheet ONCE, not twice. Clean up the extra records so this ` +
          `stops recurring.\n  ${ids("x-payroll-duplicate-ids")}`
        );
      }
      if (alreadypaid > 0) {
        notes.push(
          `• ${alreadypaid} are already marked PAID but are still in this sheet. If that ` +
          `money has already left, uploading this file pays them again.\n  ${ids("x-payroll-alreadypaid-ids")}`
        );
      }
      if (prevExports > 0) {
        notes.push(`• This period has been exported ${prevExports} time(s) before.`);
      }
      const warning = notes.length
        ? `\n\nINCLUDED BUT WORTH CHECKING:\n\n${notes.join("\n\n")}` : "";
      if (parts.length || warning) {
        alert(
          `NEFT sheet for ${months[selectedMonth-1]} ${selectedYear}: ` +
          `${n("x-payroll-included-count")} employee(s) included.` +
          (parts.length
            ? `\n\nThe following were LEFT OUT:\n\n${parts.join("\n\n")}\n\n` +
              `All of them still appear in the Salary Register for your records.`
            : "") +
          warning
        );
      }
    } catch (e) {
      // responseType "blob" means even the error body arrives as a Blob, so the
      // server's explanation has to be read out of it rather than e.response.data.
      let detail = "";
      try {
        const raw = e.response?.data;
        detail = typeof raw?.text === "function" ? JSON.parse(await raw.text()).detail
               : (raw?.detail || "");
      } catch (_) { /* leave detail empty and fall through to the generic message */ }

      // 409 = this period has been exported before. Uploading a second copy to
      // the bank pays everyone twice, so it asks rather than silently repeating.
      if (e.response?.status === 409 && detail) {
        if (window.confirm(`${detail}\n\nDownload it again anyway?`)) {
          return downloadNEFT(true);
        }
        return;
      }
      alert(detail ? `NEFT export failed.\n\n${detail}` : "NEFT export failed");
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
            <button onClick={approvePeriod} disabled={approving} data-testid="approve-period-btn"
              title="Move this month's draft payslips to Processed so they appear in the NEFT sheet. No money moves."
              className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 text-[#1E2A47] rounded-lg text-sm font-semibold hover:bg-slate-50 disabled:opacity-60 transition-colors">
              <CheckCircle2 size={14} /> {approving ? "Approving..." : "Approve for Payment"}
            </button>
            <button onClick={openRecalc} disabled={recalcLoading} data-testid="recalc-lop-btn"
              title="Re-run the LOP calculation for this month using the latest attendance and leave approvals"
              className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 text-[#1E2A47] rounded-lg text-sm font-semibold hover:bg-slate-50 disabled:opacity-60 transition-colors">
              <RefreshCw size={14} /> {recalcLoading ? "Checking..." : "Recalculate LOP"}
            </button>
            <button onClick={() => openPublish()} disabled={publishing} data-testid="publish-payslips-btn"
              title="Mark all unpaid payslips as Paid for this month — makes them visible to employees"
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors">
              <Send size={14} /> {publishing ? "Publishing..." : "Mark All Paid"}
            </button>
            {/* Arrow-wrapped deliberately: onClick={downloadNEFT} would pass the
                click Event as `confirmReexport`, which is truthy — every download
                would silently override the re-export guard. */}
            <button onClick={() => downloadNEFT()} data-testid="download-neft-btn"
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

      {/* Where this month actually is in the run, and what to do next. */}
      {isManager && (() => {
        const p = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
        const rs = records.filter(r => r.period === p);
        return (
          <WorkflowStrip
            monthLabel={`${months[selectedMonth-1]} ${selectedYear}`}
            exportCount={exportCount}
            counts={{
              total: rs.length,
              draft: rs.filter(r => r.status === "draft").length,
              unpaid: rs.filter(r => r.status !== "paid").length,
              paid: rs.filter(r => r.status === "paid").length,
            }}
          />
        );
      })()}

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
                  <button key={p} onClick={() => openPublish(y, m)} disabled={publishing}
                    data-testid={`release-period-${p}`}
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

      {payPreview && (
        <Modal title={`Mark as Paid — ${payPreview.period}`} onClose={() => setPayPreview(null)}>
          <div className="space-y-4" data-testid="publish-modal">
            {!payPreview.any_export ? (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm" data-testid="publish-no-export">
                <p className="font-bold text-red-900 flex items-center gap-2">
                  <AlertTriangle size={15} /> No NEFT file has been downloaded for this month.
                </p>
                <p className="text-red-800 mt-1">
                  Nothing can be confirmed as paid until the bank sheet has been exported and the
                  transfer completed. If someone was paid another way, open their payslip and mark
                  it paid individually with a reason.
                </p>
              </div>
            ) : (
              <>
                <p className="text-sm text-slate-600">
                  <strong>{payPreview.will_pay}</strong> payslip(s) will be marked paid,
                  totalling <strong>₹{(payPreview.total_amount || 0).toLocaleString("en-IN")}</strong>.
                  Only employees who were actually in a NEFT file for this month are included.
                </p>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Payment date</label>
                  <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
                    data-testid="publish-date"
                    className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                  <p className="text-[11px] text-slate-400 mt-1">
                    The date the money actually left, not today's date.
                  </p>
                </div>

                {(payPreview.mismatched?.length || 0) > 0 && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="publish-mismatch">
                    <p className="font-bold text-amber-900 flex items-center gap-2">
                      <AlertTriangle size={15} /> {payPreview.mismatched.length} record(s) changed
                      since the bank file was sent.
                    </p>
                    <p className="text-amber-800 mt-1">
                      These will still be marked paid, but the payslip no longer matches what the
                      bank was told:
                    </p>
                    <ul className="mt-1 text-amber-900">
                      {(payPreview.mismatched || []).map(r => (
                        <li key={r.record_id}>
                          {r.employee_id} — sent ₹{(r.sent_amount || 0).toLocaleString("en-IN")},
                          record now ₹{(r.net_salary || 0).toLocaleString("en-IN")}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(payPreview.skipped?.not_in_neft?.length || 0) > 0 && (
                  <p className="text-xs text-slate-600" data-testid="publish-skipped-notneft">
                    <strong>{payPreview.skipped['not_in_neft'].length} employee(s) were never in a NEFT
                    file</strong> and will NOT be marked paid: {payPreview.skipped['not_in_neft'].map(r => r.employee_id).join(", ")}.
                    If they were paid another way, mark those payslips individually with a reason.
                  </p>
                )}
                {(payPreview.skipped?.nonpositive?.length || 0) > 0 && (
                  <p className="text-xs text-slate-600" data-testid="publish-skipped-nonpositive">
                    <strong>{payPreview.skipped['nonpositive'].length} payslip(s) have a net of zero
                    or less</strong> and will NOT be marked paid — nothing was sent for
                    them: {payPreview.skipped['nonpositive'].map(r => r.employee_id).join(", ")}.
                    Correct the deductions, then approve and export again.
                  </p>
                )}
                {(payPreview.skipped?.held?.length || 0) > 0 && (
                  <p className="text-xs text-slate-500" data-testid="publish-skipped-held">
                    {payPreview.skipped['held'].length} salary(s) on hold are skipped and stay hidden
                    until released: {payPreview.skipped['held'].map(r => r.employee_id).join(", ")}.
                  </p>
                )}
                {(payPreview.skipped?.draft?.length || 0) > 0 && (
                  <p className="text-xs text-slate-500" data-testid="publish-skipped-draft">
                    {payPreview.skipped['draft'].length} record(s) are still draft and were never
                    exported: {payPreview.skipped['draft'].map(r => r.employee_id).join(", ")}.
                  </p>
                )}
                {(payPreview.skipped?.already_paid?.length || 0) > 0 && (
                  <p className="text-xs text-slate-500" data-testid="publish-skipped-paid">
                    {payPreview.skipped['already_paid'].length} already marked paid.
                  </p>
                )}
                <p className="text-[11px] text-slate-400 italic">
                  Employees can view a payslip once it is paid <em>and</em> the month has ended —
                  not before.
                </p>
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setPayPreview(null)} data-testid="publish-cancel"
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={applyPublish} data-testid="publish-apply"
                disabled={payApplying || !payPreview.any_export || payPreview.will_pay === 0}
                className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
                {payApplying ? "Marking..." : `Mark ${payPreview.will_pay} as paid`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {recalc && (
        <Modal title={`Recalculate LOP — ${months[selectedMonth-1]} ${selectedYear}`} onClose={() => setRecalc(null)}>
          <div className="space-y-4" data-testid="recalc-modal">
            {/* Money already with the bank cannot be recovered by editing a
                record. Say that first, before any numbers. */}
            {recalc.already_exported && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="recalc-exported-warning">
                <p className="font-bold text-amber-900 flex items-center gap-2">
                  <AlertTriangle size={15} /> A NEFT file for this month was already exported
                  {recalc.exported_at ? ` on ${String(recalc.exported_at).slice(0, 10)}` : ""}.
                </p>
                <p className="text-amber-800 mt-1">
                  Recalculating now recovers nothing — the money has gone. It only changes the
                  records so they no longer match what was sent. Treat the figures below as a
                  finding, not a correction.
                </p>
                {((recalc.overpaid_total || 0) > 0 || (recalc.underpaid_total || 0) > 0) && (
                  <p className="text-amber-900 mt-2 font-semibold" data-testid="recalc-recover">
                    Overpaid ₹{(recalc.overpaid_total || 0).toLocaleString("en-IN")}
                    {" · "}Underpaid ₹{(recalc.underpaid_total || 0).toLocaleString("en-IN")}
                  </p>
                )}
              </div>
            )}

            {recalc.changed === 0 ? (
              <p className="text-slate-500 text-sm" data-testid="recalc-nothing">
                Nothing would change — every record already matches the current attendance and
                leave approvals.
              </p>
            ) : (
              <>
                <p className="text-sm text-slate-600">
                  <strong>{recalc.changed}</strong> record(s) would change.
                  Net movement <strong>{(recalc.net_delta || 0) >= 0 ? "+" : "−"}₹
                  {Math.abs(recalc.net_delta || 0).toLocaleString("en-IN")}</strong>.
                </p>
                <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>{["Employee", "LOP", "Not employed", "Net", "Change"].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {(recalc.rows || []).map(r => (
                        <tr key={r.record_id} className="border-t border-slate-100" data-testid={`recalc-row-${r.employee_id}`}>
                          <td className="px-3 py-2">
                            <p className="font-medium text-[#0F172A]">{r.employee_name}</p>
                            <p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p>
                          </td>
                          <td className="px-3 py-2 text-slate-600">{r.lop_before} → <strong>{r.lop_after}</strong></td>
                          <td className="px-3 py-2 text-slate-600">{r.non_employed_before} → <strong>{r.non_employed_after}</strong></td>
                          <td className="px-3 py-2 text-slate-600">
                            ₹{(r.net_before || 0).toLocaleString("en-IN")} → <strong>₹{(r.net_after || 0).toLocaleString("en-IN")}</strong>
                          </td>
                          <td className={`px-3 py-2 font-semibold ${(r.delta || 0) < 0 ? "text-red-600" : "text-green-700"}`}>
                            {(r.delta || 0) >= 0 ? "+" : "−"}₹{Math.abs(r.delta || 0).toLocaleString("en-IN")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* Anything deliberately left alone is named, never silently dropped. */}
            {(recalc.skipped_manual?.length || 0) > 0 && (
              <p className="text-xs text-slate-500" data-testid="recalc-skipped-manual">
                <strong className="text-slate-600">{recalc.skipped_manual.length} record(s) skipped</strong> — LOP
                was set by hand and is left untouched: {recalc.skipped_manual.map(s => s.employee_id).join(", ")}.
                Edit the payslip directly to change those.
              </p>
            )}
            {(recalc.skipped_paid?.length || 0) > 0 && (
              <p className="text-xs text-slate-500" data-testid="recalc-skipped-paid">
                <strong className="text-slate-600">{recalc.skipped_paid.length} record(s) already marked paid</strong> and
                are never rewritten: {recalc.skipped_paid.map(s => s.employee_id).join(", ")}.
              </p>
            )}

            {recalc.changed > 0 && recalc.already_exported && (
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={recalcConfirmed} data-testid="recalc-confirm-box"
                  onChange={e => setRecalcConfirmed(e.target.checked)} className="mt-0.5" />
                <span>I understand the money for this month has already been sent, and I want the
                  records changed anyway.</span>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setRecalc(null)} data-testid="recalc-cancel"
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={applyRecalc} data-testid="recalc-apply"
                disabled={recalcApplying || recalc.changed === 0 || (recalc.already_exported && !recalcConfirmed)}
                className="px-4 py-2 rounded-lg bg-[#1E2A47] text-white text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50">
                {recalcApplying ? "Applying..." : `Apply to ${recalc.changed} record(s)`}
              </button>
            </div>
          </div>
        </Modal>
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

            {/* Attendance info — "Not Employed" only appears when it applies, so a
                normal payslip keeps its three tiles. Days before joining or after
                the last working day are unpaid but are NOT absence, and must never
                be shown as LOP on a document the employee reads. */}
            <div className={`grid gap-3 ${Number(showSlip.non_employed_days) > 0 ? "grid-cols-4" : "grid-cols-3"}`}>
              {[
                ["Days in Month", daysInPeriod(showSlip.period)],
                ["LOP Days",      showSlip.lop_days != null ? showSlip.lop_days : 0],
                ...(Number(showSlip.non_employed_days) > 0
                  ? [["Not Employed", Number(showSlip.non_employed_days)]]
                  : []),
                ["Payable Days",  showSlip.present_days != null
                  ? Number(showSlip.present_days)
                  : Math.max(0, daysInPeriod(showSlip.period)
                      - (showSlip.lop_days != null ? Number(showSlip.lop_days) : 0)
                      - Number(showSlip.non_employed_days || 0))],
              ].map(([label, val]) => (
                <div key={label} className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className={`text-lg font-bold ${label === "LOP Days" && Number(val) > 0 ? "text-red-600" : label === "Not Employed" ? "text-slate-600" : "text-[#1E2A47]"}`}>{val}</p>
                </div>
              ))}
            </div>

            {Number(showSlip.non_employed_days) > 0 && (
              <p className="text-[11px] text-slate-500 italic" data-testid="slip-non-employed-note">
                {showSlip.non_employed_days} day(s) this month fall outside the employment
                period (before joining or after the last working day) and are already
                excluded from pay. Enter LOP below only for days the employee was on the
                rolls and absent.
              </p>
            )}

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
                <button onClick={() => markPaid()} disabled={finalizing || showSlip.status === "draft" || showSlip.on_hold} data-testid="mark-paid-btn"
                  title={showSlip.on_hold
                    ? "This salary is on hold. Release it before marking as paid."
                    : showSlip.status === "draft" ? "Save adjustments first to move record to Processed before marking as paid" : ""}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">
                  {finalizing ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Marking...</> : <><CheckCircle2 size={14} /> Mark as Paid</>}
                </button>
              </div>
            )}
            {showSlip.status === "paid" && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm space-y-2 text-green-800">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-green-600" />
                  <span>
                    <strong>Paid{showSlip.paid_at ? ` on ${String(showSlip.paid_at).slice(0, 10)}` : ""}.</strong>{" "}
                    Locked — the figures cannot be edited, and Recalculate LOP will not touch it.
                  </span>
                </div>
                {showSlip.paid_outside_neft && (
                  <p className="text-xs text-green-700" data-testid="slip-paid-outside">
                    Recorded manually — this employee was not in a NEFT file for this month.
                    {showSlip.paid_exception_reason ? ` Reason: ${showSlip.paid_exception_reason}` : ""}
                  </p>
                )}
                {isManager && (
                  <button onClick={reopenSlip} disabled={reopening} data-testid="reopen-slip-btn"
                    className="flex items-center gap-2 px-3 py-1.5 bg-white border border-green-300 text-green-800 rounded-lg text-xs font-semibold hover:bg-green-100">
                    <Unlock size={12} /> Reopen payslip
                  </button>
                )}
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
