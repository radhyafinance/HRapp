import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Play, Download, Eye, X, FileText, Save, CheckCircle2, Trash2 } from "lucide-react";

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
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
  const [editRemarks, setEditRemarks] = useState("");
  const [savingEdits, setSavingEdits] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const isManager = ["hr_admin", "management"].includes(user?.role);

  // When opening the payslip modal, prime edit fields with stored values
  const openSlip = (r) => {
    setShowSlip(r);
    setEditTds(r.tds || 0);
    setEditOtherDed(r.other_deductions || 0);
    setEditOtherAdd(r.other_additions || 0);
    setEditRemarks(r.remarks || "");
  };

  const saveEdits = async () => {
    if (!showSlip) return;
    setSavingEdits(true);
    try {
      const res = await API.put(`/payroll/${showSlip.id}`, {
        tds: parseFloat(editTds) || 0,
        other_deductions: parseFloat(editOtherDed) || 0,
        other_additions: parseFloat(editOtherAdd) || 0,
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
      alert(`Processed ${res.data.processed} payroll records for ${months[selectedMonth-1]} ${selectedYear}`);
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
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Payroll</h1>
          <p className="text-slate-500 text-sm">{records.length} records</p>
        </div>
        {isManager && (
          <div className="flex flex-wrap gap-2">
            <select value={selectedMonth} onChange={e => setSelectedMonth(+e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
              {months.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
            </select>
            <select value={selectedYear} onChange={e => setSelectedYear(+e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
              {[2023, 2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={handleProcess} disabled={processing} data-testid="process-payroll-btn"
              className="flex items-center gap-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-60 transition-colors">
              <Play size={14} /> {processing ? "Processing..." : "Process Payroll"}
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

      {/* Filter */}
      <div className="flex gap-3 mb-4">
        <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="payroll-period-filter">
          <option value="">All Periods</option>
          {["2025-01","2025-02","2025-03","2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04","2026-05"].map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="payroll-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Period", "Gross", "EPF (Emp)", "ESIC (Emp)", "Net Salary", "Status", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : records.length === 0 ? <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400">No payroll records. Process payroll to see records.</td></tr>
                : records.map(r => (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{r.employee_name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.period}</td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-700">₹{r.gross_salary?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-sm text-red-600">-₹{r.epf_employee?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-sm text-red-600">-₹{r.esic_employee?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3 text-sm font-bold text-green-700">₹{r.net_salary?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${r.status === "paid" ? "bg-green-100 text-green-700" : r.status === "processed" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>{r.status}</span>
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
                ))}
            </tbody>
          </table>
        </div>
      </div>

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
                ["Payable Days",  showSlip.present_days || showSlip.working_days || 26],
                ["Leave Days",    showSlip.leave_days || 0],
              ].map(([label, val]) => (
                <div key={label} className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="text-lg font-bold text-[#1E2A47]">{val}</p>
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
                  <div className="grid grid-cols-3 gap-2 pt-2">
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
                  <p className="text-[11px] text-slate-500 italic">Saving these will recalculate Net Salary and move status to <span className="font-semibold">Processed</span>.</p>
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

            {/* HR action buttons */}
            {isManager && showSlip.status !== "paid" && (
              <div className="flex flex-col sm:flex-row gap-2">
                <button onClick={saveEdits} disabled={savingEdits} data-testid="save-payroll-edits-btn"
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50">
                  {savingEdits ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</> : <><Save size={14} /> Save Adjustments</>}
                </button>
                <button onClick={markPaid} disabled={finalizing || showSlip.status === "draft"} data-testid="mark-paid-btn"
                  title={showSlip.status === "draft" ? "Save adjustments first to move record to Processed before marking as paid" : ""}
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
