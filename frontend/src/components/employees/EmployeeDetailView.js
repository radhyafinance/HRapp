import React, { useEffect, useState } from "react";
import { UserCheck } from "lucide-react";
import API from "../../utils/api";

const ROLE_LABELS = { hr_admin: "HR Admin", management: "Management", managers: "Managers", employee: "HO Staff", field_agent: "Field Staff" };

export function EmployeeDetailView({ emp }) {
  const [managerInfo, setManagerInfo] = useState(null);

  useEffect(() => {
    if (!emp?.reporting_to) return;
    API.get(`/employees/${emp.reporting_to}`)
      .then(r => setManagerInfo(`${r.data.first_name} ${r.data.last_name} (${r.data.designation})`))
      .catch(() => setManagerInfo(null));
  }, [emp?.reporting_to]);

  const addr = emp.address || {};
  const sal = emp.salary || {};
  const bank = emp.bank_details || {};

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
          ["Bank Name", bank.bank_name],
          ["Account #", bank.account_number],
          ["IFSC", bank.ifsc_code],
          ["Emergency Contact", emp.emergency_contact?.name],
          ["Emergency Mobile", emp.emergency_contact?.mobile],
        ].map(([label, val]) => val && (
          <div key={label} className="flex justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">{label}</span>
            <span className="text-[#0F172A] font-medium text-right">{val}</span>
          </div>
        ))}
      </div>
      {(addr.current || addr.permanent) && (
        <div className="border-t pt-2">
          {addr.current && <p className="text-sm"><span className="text-slate-500">Current Address: </span><span className="font-medium">{addr.current}</span></p>}
          {addr.permanent && addr.permanent !== addr.current && <p className="text-sm mt-1"><span className="text-slate-500">Permanent Address: </span><span className="font-medium">{addr.permanent}</span></p>}
        </div>
      )}
    </div>
  );
}
