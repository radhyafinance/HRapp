import React, { useEffect, useState } from "react";
import { FileText, CheckCircle2, AlertCircle, UserCheck } from "lucide-react";
import API from "../../utils/api";
import { SalaryBreakupForm } from "../shared/SalaryBreakupForm";

export function JoiningKitPanel({ candidate, onCandidateUpdate }) {
  const [empId, setEmpId] = useState(candidate.employee_id || "");
  const [joiningDate, setJoiningDate] = useState(candidate.expected_joining_date || "");
  const [joiningLocation, setJoiningLocation] = useState(candidate.joining_location || "");
  const [savingMeta, setSavingMeta] = useState(false);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState("");
  const [showConvert, setShowConvert] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertedInfo, setConvertedInfo] = useState(null);
  const [convertForm, setConvertForm] = useState({
    role: "field_agent",
    ctc_monthly: "", basic: "", hra: "", special_allowance: "",
    canteen_allowance: "", conveyance_allowance: "", epf_employee: "",
    bank_name: "", account_number: "", account_number_confirm: "",
    ifsc_code: "", reporting_to: "", password: "",
  });
  const [reportingToInfo, setReportingToInfo] = useState(null);
  const [reportingToChecking, setReportingToChecking] = useState(false);

  const basic      = parseFloat(convertForm.basic)              || 0;
  const hra        = parseFloat(convertForm.hra)               || 0;
  const special    = parseFloat(convertForm.special_allowance) || 0;
  const canteen    = parseFloat(convertForm.canteen_allowance) || 0;
  const conv       = parseFloat(convertForm.conveyance_allowance) || 0;
  const grossDisplay = basic + hra + special + canteen + conv;

  const ifscValid = !convertForm.ifsc_code || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(convertForm.ifsc_code.toUpperCase());
  const accNumMatch = !convertForm.account_number || convertForm.account_number === convertForm.account_number_confirm;

  useEffect(() => {
    const value = (convertForm.reporting_to || "").trim().toUpperCase();
    setReportingToInfo(null);
    if (!value) return;
    setReportingToChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await API.get(`/employees/${value}`);
        const e = res.data;
        setReportingToInfo({ name: `${e.first_name || ""} ${e.last_name || ""}`.trim(), designation: e.designation, department: e.department });
      } catch (err) {
        setReportingToInfo({ error: err.response?.status === 404 ? `No employee with ID ${value}` : "Lookup failed" });
      } finally {
        setReportingToChecking(false);
      }
    }, 350);
    return () => { clearTimeout(t); setReportingToChecking(false); };
  }, [convertForm.reporting_to]);

  const dirty = empId.trim() !== (candidate.employee_id || "") || joiningDate !== (candidate.expected_joining_date || "") || joiningLocation !== (candidate.joining_location || "");

  const fetchSuggestion = async () => {
    setSuggestionLoading(true);
    try {
      const res = await API.get("/candidates/meta/next-employee-id");
      setEmpId(res.data.suggestion);
    } catch (e) {
      setErr(e.response?.data?.detail || "Could not fetch suggestion");
    } finally {
      setSuggestionLoading(false);
    }
  };

  const saveMeta = async () => {
    setErr("");
    setSavingMeta(true);
    try {
      const res = await API.put(`/candidates/${candidate.id}`, {
        employee_id: empId.trim().toUpperCase(),
        expected_joining_date: joiningDate || "",
        joining_location: joiningLocation || "",
      });
      onCandidateUpdate(res.data);
    } catch (e) {
      setErr(e.response?.data?.detail || "Failed to save");
    } finally {
      setSavingMeta(false);
    }
  };

  const downloadKit = async () => {
    setErr("");
    setDownloading(true);
    try {
      const res = await API.get(`/candidates/${candidate.id}/joining-kit`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `JoiningKit_${candidate.first_name || ""}_${candidate.last_name || ""}.pdf`.replace(/\s+/g, "_");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch (e) {
      try {
        const text = await e.response.data.text();
        setErr(JSON.parse(text).detail || "Failed to generate PDF");
      } catch (_) {
        setErr("Failed to generate PDF");
      }
    } finally {
      setDownloading(false);
    }
  };

  const ready = !!(candidate.employee_id && candidate.expected_joining_date) && !dirty;
  const isConverted = candidate.status === "converted";

  const doConvert = async () => {
    setErr("");
    if (convertForm.ifsc_code && !ifscValid) { setErr("Invalid IFSC code. Must be 4 letters + 0 + 6 alphanumeric (e.g. HDFC0001234)."); return; }
    if (convertForm.account_number && !accNumMatch) { setErr("Account numbers do not match. Please re-enter to confirm."); return; }
    if (reportingToInfo?.error) { setErr(reportingToInfo.error); return; }
    if (grossDisplay <= 0) { setErr("Please fill in Basic Salary (and other salary components) before converting."); return; }
    setConverting(true);
    try {
      const payload = {
        role: convertForm.role || "employee",
        ctc_monthly: parseFloat(convertForm.ctc_monthly) || 0,
        basic:               parseFloat(convertForm.basic)              || 0,
        hra:                 parseFloat(convertForm.hra)               || 0,
        special_allowance:   parseFloat(convertForm.special_allowance) || 0,
        canteen_allowance:   parseFloat(convertForm.canteen_allowance) || 0,
        conveyance_allowance:parseFloat(convertForm.conveyance_allowance) || 0,
        epf_employee:        parseFloat(convertForm.epf_employee)      || 0,
      };
      if (convertForm.bank_name) payload.bank_name = convertForm.bank_name;
      if (convertForm.account_number) payload.account_number = convertForm.account_number;
      if (convertForm.ifsc_code) payload.ifsc_code = convertForm.ifsc_code.toUpperCase();
      if (convertForm.reporting_to) payload.reporting_to = convertForm.reporting_to.trim().toUpperCase();
      if (convertForm.password) payload.password = convertForm.password;

      const res = await API.post(`/candidates/${candidate.id}/convert-to-employee`, payload);
      setConvertedInfo(res.data);
      setShowConvert(false);
      onCandidateUpdate({ ...candidate, status: "converted", employee_db_id: res.data.employee_db_id });
    } catch (e) {
      setErr(e.response?.data?.detail || "Conversion failed");
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Employee ID <span className="text-red-500">*</span></label>
          <div className="flex gap-2">
            <input type="text" value={empId} onChange={(e) => setEmpId(e.target.value.toUpperCase())} placeholder="e.g. RMF0001" data-testid="employee-id-input"
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white" />
            <button type="button" onClick={fetchSuggestion} disabled={suggestionLoading} data-testid="suggest-employee-id-btn"
              className="px-3 py-2 text-xs bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 whitespace-nowrap" title="Suggest next available ID">
              {suggestionLoading ? "..." : "Auto"}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Tentative Joining Date <span className="text-red-500">*</span></label>
          <input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} data-testid="tentative-joining-date"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white" />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Joining Location</label>
          <input type="text" value={joiningLocation} onChange={(e) => setJoiningLocation(e.target.value)} placeholder="Head Office, Moradabad" data-testid="joining-location-input"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white" />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <button type="button" onClick={saveMeta} disabled={savingMeta || !dirty || !empId.trim() || !joiningDate} data-testid="save-joining-meta-btn"
          className="flex-1 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50">
          {savingMeta ? "Saving..." : "Save Details"}
        </button>
        <button type="button" onClick={downloadKit} disabled={downloading || !ready} data-testid="download-joining-kit-btn"
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-50">
          {downloading ? (
            <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Generating...</>
          ) : (
            <><FileText size={14} /> Download Joining Kit (PDF)</>
          )}
        </button>
      </div>

      <div className="border-t border-amber-200 pt-3">
        {convertedInfo ? (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm" data-testid="conversion-success">
            <div className="flex items-start gap-2">
              <CheckCircle2 size={16} className="text-green-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-green-800">{convertedInfo.message}</p>
                <p className="text-xs text-green-700 mt-1">Employee ID: <span className="font-mono">{convertedInfo.employee_id}</span></p>
                <p className="text-xs text-green-700">Default password: <span className="font-mono">{convertedInfo.default_password}</span> — share with employee on day 1.</p>
              </div>
            </div>
          </div>
        ) : isConverted ? (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm flex items-center gap-2" data-testid="already-converted">
            <CheckCircle2 size={16} className="text-blue-600" />
            <span className="text-blue-800 font-semibold">Already converted to Employee</span>
          </div>
        ) : (
          <>
            <button type="button" onClick={() => setShowConvert((s) => !s)} disabled={!ready} data-testid="open-convert-employee-btn"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
              <UserCheck size={14} /> {showConvert ? "Cancel Conversion" : "Convert to Employee"}
            </button>
            {!ready && <p className="text-[11px] text-amber-700 mt-2">Save Employee ID and Joining Date first.</p>}
          </>
        )}

        {showConvert && (
          <div className="mt-3 bg-white border border-slate-200 rounded-lg p-3 space-y-3" data-testid="convert-form">
            <p className="text-xs text-slate-500">Fill salary components, role and bank details. KYC documents (Aadhaar / PAN) and personal data will be copied automatically.</p>

            {/* Salary breakup */}
            <SalaryBreakupForm
              form={convertForm}
              onChange={(key, val) => setConvertForm(prev => ({ ...prev, [key]: val }))}
            />

            {/* Role */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Role</label>
              <select value={convertForm.role} onChange={e => setConvertForm({ ...convertForm, role: e.target.value })} data-testid="convert-role-select"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
                <option value="field_agent">Field Staff</option>
                <option value="employee">HO Staff</option>
                <option value="managers">Managers</option>
                <option value="hr_admin">HR Admin</option>
                <option value="management">Management</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reporting To (Employee ID)</label>
              <input value={convertForm.reporting_to} onChange={e => setConvertForm({ ...convertForm, reporting_to: e.target.value.toUpperCase() })}
                placeholder="e.g. RMF0002" data-testid="convert-reporting-to"
                className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${reportingToInfo?.error ? "border-red-300" : "border-slate-300"}`} />
              {reportingToChecking && <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1"><div className="w-3 h-3 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" /> Looking up...</p>}
              {!reportingToChecking && reportingToInfo && !reportingToInfo.error && (
                <p className="text-[11px] text-green-700 mt-1 flex items-center gap-1" data-testid="reporting-to-name">
                  <CheckCircle2 size={12} /> {reportingToInfo.name} <span className="text-slate-500">— {reportingToInfo.designation}, {reportingToInfo.department}</span>
                </p>
              )}
              {!reportingToChecking && reportingToInfo?.error && (
                <p className="text-[11px] text-red-600 mt-1 flex items-center gap-1" data-testid="reporting-to-error">
                  <AlertCircle size={12} /> {reportingToInfo.error}
                </p>
              )}
            </div>

            <div className="border-t border-slate-100 pt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Bank Name</label>
                <input value={convertForm.bank_name} onChange={e => setConvertForm({ ...convertForm, bank_name: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">IFSC Code</label>
                <input value={convertForm.ifsc_code} onChange={e => setConvertForm({ ...convertForm, ifsc_code: e.target.value.toUpperCase() })}
                  data-testid="convert-ifsc" placeholder="HDFC0001234" maxLength={11}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${convertForm.ifsc_code && !ifscValid ? "border-red-300" : "border-slate-300"}`} />
                {convertForm.ifsc_code && !ifscValid && <p className="text-[11px] text-red-600 mt-1" data-testid="ifsc-error">Invalid format. Must be 4 letters + 0 + 6 alphanumeric.</p>}
                {convertForm.ifsc_code && ifscValid && <p className="text-[11px] text-green-600 mt-1" data-testid="ifsc-valid">Valid IFSC format.</p>}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Bank A/c No.</label>
                <input type="password" value={convertForm.account_number} onChange={e => setConvertForm({ ...convertForm, account_number: e.target.value.replace(/\D/g, "") })}
                  data-testid="convert-account-number" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Re-enter A/c No. <span className="text-slate-400">(confirmation)</span></label>
                <input value={convertForm.account_number_confirm} onChange={e => setConvertForm({ ...convertForm, account_number_confirm: e.target.value.replace(/\D/g, "") })}
                  data-testid="convert-account-number-confirm"
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${convertForm.account_number_confirm && !accNumMatch ? "border-red-300" : "border-slate-300"}`} />
                {convertForm.account_number_confirm && !accNumMatch && <p className="text-[11px] text-red-600 mt-1" data-testid="account-number-mismatch">Account numbers do not match.</p>}
                {convertForm.account_number_confirm && accNumMatch && convertForm.account_number && <p className="text-[11px] text-green-600 mt-1">Account numbers match.</p>}
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Initial Password <span className="text-slate-400">(default: Welcome@123)</span></label>
                <input value={convertForm.password} onChange={e => setConvertForm({ ...convertForm, password: e.target.value })}
                  placeholder="Welcome@123" data-testid="convert-password"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>

            {grossDisplay > 0 && (
              <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-2">
                <strong>Will copy:</strong> Name, Mobile, Email, DOB, Gender, Father/Husband, Aadhaar, PAN, Address, Department, Designation, Joining Date, Joining Location, KYC document images.
              </div>
            )}

            <button type="button" onClick={doConvert}
              disabled={converting || grossDisplay <= 0 || !ifscValid || !accNumMatch || reportingToInfo?.error}
              data-testid="confirm-convert-btn"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
              {converting ? (
                <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Converting...</>
              ) : (
                <><UserCheck size={14} /> Confirm — Create Employee</>
              )}
            </button>
            {grossDisplay <= 0 && <p className="text-[11px] text-amber-700">Fill in salary components (Basic, HRA etc.) to enable conversion.</p>}
          </div>
        )}
      </div>

      {!ready && (empId.trim() === "" || !joiningDate) && (
        <p className="text-[11px] text-amber-700">Set both <strong>Employee ID</strong> and <strong>Tentative Joining Date</strong> (then click Save Details) to enable the PDF download.</p>
      )}
      {dirty && <p className="text-[11px] text-amber-700">You have unsaved changes — click Save Details before downloading.</p>}
      {err && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
        </div>
      )}
      <p className="text-[11px] text-slate-500">The PDF mirrors the company's <em>Joining Kit Online</em> document 1:1 — bilingual labels, all sections, with KYC fields auto-filled.</p>
    </div>
  );
}
