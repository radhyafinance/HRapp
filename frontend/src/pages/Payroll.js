import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Play, Download, Eye, X, CreditCard } from "lucide-react";

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

export default function Payroll() {
  const { user } = useAuth();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [filterPeriod, setFilterPeriod] = useState("");
  const [showSlip, setShowSlip] = useState(null);
  const isManager = ["hr_admin", "management"].includes(user?.role);

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
      alert("Export failed");
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
          </div>
        )}
      </div>

      {/* Filter */}
      <div className="flex gap-3 mb-4">
        <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="payroll-period-filter">
          <option value="">All Periods</option>
          {["2025-01","2025-02","2025-03","2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02"].map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="payroll-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Period", "Gross", "EPF (Emp)", "ESIC (Emp)", "Net Salary", "Status", "Action"].map(h => (
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
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${r.status === "paid" ? "bg-green-100 text-green-700" : r.status === "processed" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>{r.status}</span></td>
                    <td className="px-4 py-3">
                      <button onClick={() => setShowSlip(r)} data-testid={`view-slip-${r.id}`} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><Eye size={16} /></button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {showSlip && (
        <Modal title="Payslip" onClose={() => setShowSlip(null)}>
          <div className="space-y-4" data-testid="payslip-modal">
            <div className="bg-[#1E2A47] text-white p-4 rounded-lg">
              <p className="text-lg font-bold">{showSlip.employee_name}</p>
              <p className="text-slate-300 text-sm">{showSlip.designation} • {showSlip.department}</p>
              <p className="text-slate-400 text-xs mt-1">{showSlip.employee_id} | {showSlip.period}</p>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Earnings</p>
              {[["Basic", showSlip.basic], ["HRA", showSlip.hra], ["Special Allowance", showSlip.special_allowance], ["Canteen Allowance", showSlip.canteen_allowance], ["Conveyance", showSlip.conveyance_allowance]].map(([label, val]) => val > 0 && (
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
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Deductions</p>
              {[["EPF (Employee 12%)", showSlip.epf_employee], ["ESIC (Employee 0.75%)", showSlip.esic_employee], ["TDS", showSlip.tds], ["Other Deductions", showSlip.other_deductions]].map(([label, val]) => val > 0 && (
                <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-1">
                  <span className="text-slate-600">{label}</span>
                  <span className="text-red-600 font-medium">-₹{val?.toLocaleString("en-IN")}</span>
                </div>
              ))}
            </div>
            <div className="bg-[#E85B1E] text-white p-4 rounded-lg flex justify-between items-center">
              <span className="font-bold text-lg">Net Salary</span>
              <span className="font-bold text-2xl">₹{showSlip.net_salary?.toLocaleString("en-IN")}</span>
            </div>
            <div className="text-xs text-slate-500 space-y-1 bg-slate-50 p-3 rounded-lg">
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
