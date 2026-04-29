import React, { useState, useRef, useCallback } from "react";
import { Loader, UserCheck, X } from "lucide-react";
import API from "../../utils/api";

export function ReportingManagerInput({ value, onChange }) {
  const [status, setStatus] = useState(null);
  const [managerName, setManagerName] = useState("");
  const timerRef = useRef(null);

  const lookup = useCallback(async (id) => {
    if (!id || id.trim().length < 4) { setStatus(null); setManagerName(""); return; }
    setStatus("loading");
    try {
      const res = await API.get(`/employees/${id.trim().toUpperCase()}`);
      setManagerName(`${res.data.first_name} ${res.data.last_name} — ${res.data.designation}`);
      setStatus("found");
    } catch {
      setManagerName("");
      setStatus("not_found");
    }
  }, []);

  const handleChange = (e) => {
    const val = e.target.value.toUpperCase();
    onChange(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => lookup(val), 600);
  };

  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1">Reporting Manager (Employee ID)</label>
      <div className="relative">
        <input
          value={value}
          onChange={handleChange}
          placeholder="e.g. RMF0001"
          data-testid="emp-reporting-to"
          className={`w-full border rounded-lg px-3 py-2 pr-9 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none transition-colors
            ${status === "found" ? "border-green-400 bg-green-50" : status === "not_found" ? "border-red-300 bg-red-50" : "border-slate-300"}`}
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
          {status === "loading" && <Loader size={14} className="animate-spin text-slate-400" />}
          {status === "found" && <UserCheck size={14} className="text-green-600" />}
          {status === "not_found" && <X size={14} className="text-red-500" />}
        </span>
      </div>
      {status === "found" && <p className="text-xs text-green-700 mt-1 font-medium">{managerName}</p>}
      {status === "not_found" && <p className="text-xs text-red-500 mt-1">Employee not found</p>}
    </div>
  );
}
