import React, { useEffect, useState } from "react";
import { UserCheck, ShieldCheck, ShieldX, Loader } from "lucide-react";
import API from "../../utils/api";
import { useAuth } from "../../contexts/AuthContext";

const ROLE_LABELS = { hr_admin: "HR Admin", management: "Management", managers: "Managers", employee: "HO Staff", field_agent: "Field Staff" };

export function EmployeeDetailView({ emp: initialEmp }) {
  const { user } = useAuth();
  const canSeeSensitive = ["hr_admin", "management"].includes(user?.role);
  const [emp, setEmp] = useState(initialEmp);
  const [managerInfo, setManagerInfo] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState(null); // { ok, text }

  useEffect(() => { setEmp(initialEmp); }, [initialEmp]);

  useEffect(() => {
    if (!emp?.reporting_to) return;
    API.get(`/employees/${emp.reporting_to}`)
      .then(r => setManagerInfo(`${r.data.first_name} ${r.data.last_name} (${r.data.designation})`))
      .catch(() => setManagerInfo(null));
  }, [emp?.reporting_to]);

  const addr = emp.address || {};
  const sal = emp.salary || {};
  const bank = emp.bank_details || {};

  const hasBankDetails = bank.account_number && bank.ifsc_code;

  async function handleVerifyBank() {
    setVerifying(true);
    setVerifyMsg(null);
    try {
      const res = await API.post(`/employees/${emp.employee_id}/verify-bank`);
      const d = res.data;
      const verified = d.verified;
      const name = d.verified_name || "";
      const score = d.name_match_score != null ? ` (match: ${d.name_match_score}%)` : "";
      setVerifyMsg({
        ok: verified,
        text: verified
          ? `Verified — Account holder: ${name || "Name not returned"}${score}`
          : `Verification failed. ${d.raw?.message || d.raw?.error || "Account may be invalid or inactive."}`,
      });
      // Refresh bank details state to show updated verified badge
      setEmp(prev => ({
        ...prev,
        bank_details: {
          ...prev.bank_details,
          verified,
          verified_name: name,
          verified_at: new Date().toISOString(),
        },
      }));
    } catch (e) {
      const msg = e.response?.data?.detail || "Could not reach verification service.";
      setVerifyMsg({ ok: false, text: msg });
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg">
        <div className="w-16 h-16 rounded-full bg-[#1E2A47] flex items-center justify-center text-white text-2xl font-bold">
          {emp.first_name?.charAt(0)}{emp.last_name?.charAt(0)}
        </div>
        <div>
          <h3 className="text-lg font-bold text-[#1E2A47]">{emp.first_name} {emp.last_name}</h3>
          <p className="text-[#E85B1E] font-semibold text-sm">{emp.employee_id}</p>
          <p className="text-slate-500 text-sm">{emp.designation} • {emp.department}</p>
        </div>
      </div>

      {emp.reporting_to && (
        <div className="flex items-center gap-3 p-3 bg-[#E85B1E]/5 border border-[#E85B1E]/20 rounded-lg">
          <UserCheck size={16} className="text-[#E85B1E] flex-shrink-0" />
          <div>
            <p className="text-xs text-slate-500">Reporting Manager</p>
            <p className="text-sm font-semibold text-[#1E2A47]">
              {emp.reporting_to}
              {managerInfo && <span className="font-normal text-slate-500"> — {managerInfo}</span>}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        {[
          ["Email", emp.email],
          ["Mobile", emp.mobile],
          ["Role", ROLE_LABELS[emp.role] || emp.role],
          ["Status", emp.status],
          ["Joining Date", emp.joining_date],
          ["Joining Location", emp.joining_location],
          ["Branch", emp.branch],
          ["Date of Birth", emp.date_of_birth],
          ["Gender", emp.gender],
          ["Father / Husband", emp.father_or_husband_name],
          ["Aadhaar #", emp.aadhaar_number ? emp.aadhaar_number.replace(/(\d{4})(?=\d)/g, "$1 ") : null],
          ["PAN", emp.pan_number],
          ["UAN Number", emp.uan_number],
          ["ESI Number", emp.esi_number],
          ["Blood Group", emp.blood_group],
          ["City", emp.city],
          ["State", emp.state],
          ["Pincode", emp.pincode],
          ["Monthly CTC", sal.ctc_monthly ? `₹${sal.ctc_monthly.toLocaleString("en-IN")}` : null],
          ["Annual CTC", sal.ctc_annual ? `₹${sal.ctc_annual.toLocaleString("en-IN")}` : null],
          ["Gross Salary", sal.gross ? `₹${sal.gross.toLocaleString("en-IN")}/month` : null],
          ["Basic", sal.basic ? `₹${sal.basic.toLocaleString("en-IN")}` : null],
          ["HRA", sal.hra ? `₹${sal.hra.toLocaleString("en-IN")}` : null],
          ["Special Allowance", sal.special_allowance ? `₹${sal.special_allowance.toLocaleString("en-IN")}` : null],
          ...(canSeeSensitive ? [
            ["Bank Name", bank.bank_name],
            ["Account #", bank.account_number],
            ["IFSC", bank.ifsc_code],
          ] : []),
          ["Emergency Contact", emp.emergency_contact?.name],
          ["Emergency Mobile", emp.emergency_contact?.mobile],
        ].map(([label, val]) => val && (
          <div key={label} className="flex justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">{label}</span>
            <span className="text-[#0F172A] font-medium text-right">{val}</span>
          </div>
        ))}
      </div>

      {/* Bank Account Verification */}
      {canSeeSensitive && hasBankDetails && (
        <div className="border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Bank Verification</p>
            {bank.verified != null && (
              bank.verified
                ? <span className="flex items-center gap-1 text-xs font-semibold text-green-600"><ShieldCheck size={13} /> Verified</span>
                : <span className="flex items-center gap-1 text-xs font-semibold text-red-500"><ShieldX size={13} /> Not Verified</span>
            )}
          </div>

          {bank.verified && bank.verified_name && (
            <p className="text-xs text-slate-500 mb-2">
              Bank name: <span className="font-semibold text-[#0F172A]">{bank.verified_name}</span>
              {bank.verified_at && <span className="ml-2 text-slate-400">· {new Date(bank.verified_at).toLocaleDateString("en-IN")}</span>}
            </p>
          )}

          <button
            onClick={handleVerifyBank}
            disabled={verifying}
            data-testid="verify-bank-btn"
            className="flex items-center gap-2 px-4 py-2 bg-[#1E2A47] text-white text-xs font-semibold rounded-lg hover:bg-[#2d3d63] disabled:opacity-60 transition-colors"
          >
            {verifying ? <><Loader size={13} className="animate-spin" /> Verifying...</> : <><ShieldCheck size={13} /> {bank.verified ? "Re-verify Account" : "Verify Account"}</>}
          </button>

          {verifyMsg && (
            <div className={`mt-2 flex items-start gap-2 text-xs p-2.5 rounded-lg ${verifyMsg.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
              {verifyMsg.ok ? <ShieldCheck size={13} className="mt-0.5 flex-shrink-0" /> : <ShieldX size={13} className="mt-0.5 flex-shrink-0" />}
              {verifyMsg.text}
            </div>
          )}
        </div>
      )}

      {(addr.current || addr.permanent) && (
        <div className="border-t pt-2">
          {addr.current && <p className="text-sm"><span className="text-slate-500">Current Address: </span><span className="font-medium">{addr.current}</span></p>}
          {addr.permanent && addr.permanent !== addr.current && <p className="text-sm mt-1"><span className="text-slate-500">Permanent Address: </span><span className="font-medium">{addr.permanent}</span></p>}
        </div>
      )}
    </div>
  );
}
