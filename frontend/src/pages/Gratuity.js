import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Award } from "lucide-react";

export default function Gratuity() {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [empData, setEmpData] = useState(null);
  const [loading, setLoading] = useState(true);
  const isManager = ["hr_admin", "management"].includes(user?.role);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        if (isManager) {
          const res = await API.get("/gratuity");
          setData(res.data);
        } else if (user?.employee_id) {
          const res = await API.get(`/gratuity/${user.employee_id}`);
          setEmpData(res.data);
        }
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    fetchData();
  }, []);

  if (!isManager && empData) {
    return (
      <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Gratuity</h1>
        </div>
        <div className="max-w-lg">
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-[#E85B1E]/10 flex items-center justify-center">
                <Award size={20} className="text-[#E85B1E]" />
              </div>
              <div>
                <p className="font-bold text-[#1E2A47]">{empData.employee_name}</p>
                <p className="text-sm text-slate-500">{empData.employee_id}</p>
              </div>
            </div>
            {[["Joining Date", empData.joining_date], ["Years of Service", `${empData.years_of_service} years`], ["Last Basic Salary", `₹${empData.last_basic_salary?.toLocaleString("en-IN")}`], ["Monthly Provision", `₹${empData.monthly_provision?.toLocaleString("en-IN")}`]].map(([label, val]) => (
              <div key={label} className="flex justify-between text-sm border-b border-slate-100 py-2">
                <span className="text-slate-500">{label}</span>
                <span className="font-medium text-[#0F172A]">{val}</span>
              </div>
            ))}
            <div className={`mt-4 p-4 rounded-lg ${empData.eligible ? "bg-green-50 border border-green-200" : "bg-amber-50 border border-amber-200"}`}>
              <p className={`font-bold text-lg ${empData.eligible ? "text-green-700" : "text-amber-700"}`}>
                {empData.eligible ? `Eligible: ₹${empData.gratuity_amount?.toLocaleString("en-IN")}` : "Not Eligible (< 5 years)"}
              </p>
              <p className="text-xs mt-1 text-slate-500">{empData.formula}</p>
              {!empData.eligible && <p className="text-xs mt-1 text-amber-600">{empData.note}</p>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Gratuity Calculator</h1>
        <p className="text-slate-500 text-sm">Formula: Basic × 15 × Years / 26 (min 5 years service)</p>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="gratuity-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Joining Date", "Years", "Basic", "Eligible", "Gratuity Amount", "Monthly Provision"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : data.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No employee data</td></tr>
                : data.map(e => (
                  <tr key={e.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium">{e.name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{e.employee_id}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{e.joining_date}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{e.years_of_service}y</td>
                    <td className="px-4 py-3 text-sm text-slate-600">₹{e.gratuity_amount > 0 ? (e.gratuity_amount / e.years_of_service * 26 / 15)?.toFixed(0) : "-"}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${e.eligible ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>{e.eligible ? "Yes" : "No"}</span></td>
                    <td className="px-4 py-3 text-sm font-bold text-[#E85B1E]">{e.eligible ? `₹${e.gratuity_amount?.toLocaleString("en-IN")}` : "-"}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">₹{e.monthly_provision?.toLocaleString("en-IN")}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
