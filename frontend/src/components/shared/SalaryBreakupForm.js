import React from "react";

/**
 * Reusable salary breakup form.
 * Manual fields:   CTC, Basic, HRA, Special, Canteen, Conveyance, EPF (employee)
 * Auto-computed:   ESIC employee (0.75%), ESIC employer (3.25%), Gratuity (Basic×15/26/12)
 *
 * Props:
 *   form      — object containing the salary field keys
 *   onChange  — (fieldKey, value) callback
 */
export function SalaryBreakupForm({ form, onChange }) {
  const ctc      = parseFloat(form.ctc_monthly)       || 0;
  const basic    = parseFloat(form.basic)              || 0;
  const hra      = parseFloat(form.hra)               || 0;
  const special  = parseFloat(form.special_allowance) || 0;
  const canteen  = parseFloat(form.canteen_allowance) || 0;
  const conv     = parseFloat(form.conveyance_allowance) || 0;
  const epfRaw  = form.epf_employee;
  const epfExempt = epfRaw === null || epfRaw === undefined || epfRaw === "" || parseFloat(epfRaw) === 0;
  const epf      = epfExempt ? 0 : (parseFloat(epfRaw) || 0);

  const gross          = basic + hra + special + canteen + conv;
  const esicApplicable = basic > 0 && basic <= 21000;
  const esicEmp        = esicApplicable ? Math.round(basic * 0.0075) : 0;
  const esicEr         = esicApplicable ? Math.round(basic * 0.0325) : 0;
  const epfEr          = epfExempt ? 0 : (basic > 0 ? Math.round(basic * 0.12) : 0);
  const gratuity       = basic > 0 ? Math.round((basic * 15) / 26 / 12) : 0;
  const totalDeduction = epf + esicEmp;
  const netTakeHome    = gross - totalDeduction;
  const totalCostToCompany = gross + epfEr + esicEr + gratuity;

  const F = (key, label) => (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1">
        {label} <span className="text-slate-400 font-normal">(₹)</span>
      </label>
      <input
        type="number"
        min="0"
        step="1"
        value={form[key] ?? ""}
        onChange={e => onChange(key, e.target.value)}
        placeholder="0"
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
        data-testid={`sal-${key}`}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Manual inputs */}
      <div className="grid grid-cols-2 gap-3">
        {F("ctc_monthly",          "Monthly CTC")}
        {F("basic",                "Basic Salary")}
        {F("hra",                  "HRA")}
        {F("special_allowance",    "Special Allowance")}
        {F("canteen_allowance",    "Canteen Allowance")}
        {F("conveyance_allowance", "Conveyance Allowance")}
        {F("epf_employee",         "EPF (Employee share)")}
      </div>

      {/* Auto-computed summary — only show when at least basic is entered */}
      {gross > 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm space-y-2">
          {/* Gross row */}
          <div className="flex justify-between items-center pb-2 border-b border-slate-200">
            <span className="font-semibold text-slate-600">Gross Salary</span>
            <span className="font-bold text-[#1E2A47]">₹{gross.toLocaleString("en-IN")}/mo</span>
          </div>

          {/* Auto-computed deductions */}
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Auto-Computed</p>

          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-slate-500">EPF — Employer (12% of Basic)</span>
              <span className={`font-medium ${epfExempt ? "text-slate-400 italic" : "text-orange-600"}`}>
                {epfExempt ? "Exempt" : `₹${epfEr.toLocaleString("en-IN")}`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">ESIC — Employee (0.75% of Basic)</span>
              <span className={`font-medium ${esicApplicable ? "text-red-600" : "text-slate-400 italic"}`}>
                {esicApplicable ? `-₹${esicEmp.toLocaleString("en-IN")}` : "Not applicable (Basic > ₹21,000)"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">ESIC — Employer (3.25% of Basic)</span>
              <span className={`font-medium ${esicApplicable ? "text-orange-600" : "text-slate-400 italic"}`}>
                {esicApplicable ? `₹${esicEr.toLocaleString("en-IN")}` : "Not applicable"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Gratuity provision (Basic × 15 ÷ 26 ÷ 12)</span>
              <span className="font-medium text-orange-600">₹{gratuity.toLocaleString("en-IN")}/mo</span>
            </div>
          </div>

          {/* Net & CTC summary */}
          <div className="border-t border-slate-200 pt-2 space-y-1.5">
            {(epf > 0 || esicEmp > 0) && (
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">
                  Total deductions (EPF ₹{epf.toLocaleString("en-IN")} + ESIC ₹{esicEmp.toLocaleString("en-IN")})
                </span>
                <span className="text-red-600 font-medium">-₹{totalDeduction.toLocaleString("en-IN")}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="font-semibold text-slate-600">Net Take-Home</span>
              <span className="font-bold text-green-700">₹{netTakeHome.toLocaleString("en-IN")}/mo</span>
            </div>
            <div className="flex justify-between">
              <span className="font-semibold text-slate-600">Monthly Cost to Company</span>
              <span className="font-bold text-[#E85B1E]">₹{totalCostToCompany.toLocaleString("en-IN")}/mo</span>
            </div>
            {ctc > 0 && ctc !== totalCostToCompany && (
              <p className="text-[10px] text-amber-600 italic">
                Entered CTC ₹{ctc.toLocaleString("en-IN")} differs from computed ₹{totalCostToCompany.toLocaleString("en-IN")} — use computed value as reference.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
