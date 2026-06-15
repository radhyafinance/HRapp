import React, { useState, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import API from "../utils/api";
import { Upload, Download, X, FileSpreadsheet, Calendar, ShieldAlert, CheckCircle, Loader2 } from "lucide-react";

const CIC_LABELS = [
  { key: "cibil",   label: "CIBIL",   color: "bg-blue-600",   light: "bg-blue-50 border-blue-200 text-blue-700" },
  { key: "crif",    label: "CRIF",    color: "bg-emerald-600", light: "bg-emerald-50 border-emerald-200 text-emerald-700" },
  { key: "equifax", label: "Equifax", color: "bg-orange-600",  light: "bg-orange-50 border-orange-200 text-orange-700" },
  { key: "experian",label: "Experian",color: "bg-violet-600",  light: "bg-violet-50 border-violet-200 text-violet-700" },
];

function toDisplayDate(ddmmyyyy) {
  if (!ddmmyyyy || ddmmyyyy.length !== 8) return "";
  return `${ddmmyyyy.slice(0, 2)}/${ddmmyyyy.slice(2, 4)}/${ddmmyyyy.slice(4)}`;
}

function inputToDDMMYYYY(isoDate) {
  // isoDate is "YYYY-MM-DD"
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}${m}${y}`;
}

export default function CICData() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const ALLOWED_IDS = ["RMF0007", "RMF0003"];
  const isAllowed = ALLOWED_IDS.includes(user?.employee_id) || user?.role === "hr_admin";

  const [file, setFile] = useState(null);
  const [fromDate, setFromDate] = useState("");     // YYYY-MM-DD from input[type=date]
  const [toDate, setToDate] = useState("");         // YYYY-MM-DD from input[type=date]
  const [excludedUids, setExcludedUids] = useState("");
  const [uidTags, setUidTags] = useState([]);       // confirmed tags
  const [uidInput, setUidInput] = useState("");     // current UID being typed
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { recordCount, skipped }
  const [error, setError] = useState("");
  const fileRef = useRef();

  if (!isAllowed) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <ShieldAlert size={48} className="text-slate-300" />
        <p className="text-slate-500 text-lg font-medium">Access Restricted</p>
        <p className="text-slate-400 text-sm">This tool is only available to authorised users.</p>
        <button onClick={() => navigate("/dashboard")}
          className="mt-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm">
          Back to Dashboard
        </button>
      </div>
    );
  }

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (f) setFile(f);
  };

  const addUidTag = (raw) => {
    const uid = raw.trim();
    if (uid && !uidTags.includes(uid)) {
      setUidTags(prev => [...prev, uid]);
    }
    setUidInput("");
  };

  const handleUidKeyDown = (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      addUidTag(uidInput);
    }
  };

  const removeTag = (uid) => setUidTags(prev => prev.filter(u => u !== uid));

  const handleGenerate = async () => {
    setError("");
    setResult(null);
    if (!file) return setError("Please upload an Excel (.xlsx) file.");
    if (!fromDate) return setError("Please select a From Date.");
    if (!toDate) return setError("Please select a To Date.");

    const fromDDMMYYYY = inputToDDMMYYYY(fromDate);
    const toDDMMYYYY = inputToDDMMYYYY(toDate);

    // Finalise any partially typed UID
    const allUids = [...uidTags];
    if (uidInput.trim()) allUids.push(uidInput.trim());

    const formData = new FormData();
    formData.append("file", file);
    formData.append("from_date", fromDDMMYYYY);
    formData.append("to_date", toDDMMYYYY);
    formData.append("excluded_uids", allUids.join("\n"));

    setLoading(true);
    try {
      const res = await API.post("/cic/generate", formData, {
        responseType: "blob",
        headers: { "Content-Type": "multipart/form-data" },
      });
      const recordCount = res.headers?.["x-record-count"];
      const skipped = res.headers?.["x-skipped-count"];
      setResult({ recordCount, skipped });

      // Trigger download
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `CIC_CDF_${fromDDMMYYYY}_${toDDMMYYYY}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      let msg = "Failed to generate CDF files.";
      if (err.response?.data) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          msg = parsed.detail || msg;
        } catch (_) {}
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }} className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
          CIC Data Converter
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Convert HighMark Excel data to CDF format for Credit Information Companies
        </p>
      </div>

      {/* CIC badges */}
      <div className="flex flex-wrap gap-2 mb-6">
        {CIC_LABELS.map(c => (
          <span key={c.key} className={`px-3 py-1 rounded-full text-xs font-bold border ${c.light}`}>{c.label}</span>
        ))}
      </div>

      <div className="space-y-5">

        {/* Step 1 — Upload Excel */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h2 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E2A47] text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">1</span>
            Upload HighMark Excel File
          </h2>
          <div
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
              ${file ? "border-green-400 bg-green-50" : "border-slate-300 bg-slate-50 hover:border-[#E85B1E] hover:bg-orange-50/30"}`}
            data-testid="cic-file-dropzone"
          >
            {file ? (
              <div className="flex items-center justify-center gap-3">
                <FileSpreadsheet size={20} className="text-green-600" />
                <span className="text-sm font-medium text-green-700">{file.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                  className="text-green-600 hover:text-red-500">
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                <Upload size={24} className="text-slate-400 mx-auto mb-2" />
                <p className="text-sm text-slate-500">Click to select or drop Excel file (.xlsx)</p>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" accept=".xlsx" onChange={handleFileChange} className="hidden" data-testid="cic-file-input" />
        </div>

        {/* Step 2 — Dates */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h2 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E2A47] text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">2</span>
            Set Date Range
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1">
                <Calendar size={12} /> From Date
              </label>
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                data-testid="cic-from-date"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1E2A47]"
              />
              {fromDate && <p className="text-xs text-slate-400 mt-1">CDF format: {inputToDDMMYYYY(fromDate)}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1">
                <Calendar size={12} /> To Date
              </label>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                data-testid="cic-to-date"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1E2A47]"
              />
              {toDate && <p className="text-xs text-slate-400 mt-1">CDF format: {inputToDDMMYYYY(toDate)}</p>}
            </div>
          </div>
        </div>

        {/* Step 3 — Exclude UIDs */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h2 className="text-sm font-bold text-slate-700 mb-1 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E2A47] text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">3</span>
            Exclude by UID <span className="font-normal text-slate-400">(optional)</span>
          </h2>
          <p className="text-xs text-slate-400 mb-3 ml-7">Enter 12-digit Aadhaar UIDs to exclude from the CDF output</p>

          {/* Tag display */}
          {uidTags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {uidTags.map(uid => (
                <span key={uid} className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-50 border border-red-200 text-red-700 rounded-full text-xs font-mono">
                  {uid}
                  <button onClick={() => removeTag(uid)} className="hover:text-red-900"><X size={10} /></button>
                </span>
              ))}
            </div>
          )}

          <input
            type="text"
            value={uidInput}
            onChange={e => setUidInput(e.target.value)}
            onKeyDown={handleUidKeyDown}
            onBlur={() => uidInput.trim() && addUidTag(uidInput)}
            placeholder="Type UID and press Enter or comma to add..."
            data-testid="cic-uid-input"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#1E2A47]"
          />
          <p className="text-xs text-slate-400 mt-1.5">Press Enter, comma, or Space after each UID. {uidTags.length > 0 && <span className="text-red-600 font-medium">{uidTags.length} UID{uidTags.length > 1 ? "s" : ""} will be excluded.</span>}</p>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <ShieldAlert size={16} className="flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Success */}
        {result && (
          <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
            <CheckCircle size={18} className="text-green-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-green-700">CDF files generated successfully!</p>
              <p className="text-xs text-green-600 mt-0.5">
                {result.recordCount} records exported across 4 CDF files.
                {result.skipped > 0 && ` ${result.skipped} record${result.skipped > 1 ? "s" : ""} excluded.`}
                {" "}Your ZIP file has been downloaded.
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                {CIC_LABELS.map(c => (
                  <span key={c.key} className={`px-2 py-0.5 rounded text-[10px] font-bold border ${c.light}`}>
                    {c.label} ✓
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={loading || !file || !fromDate || !toDate}
          data-testid="cic-generate-btn"
          className="w-full flex items-center justify-center gap-2 py-3 bg-[#1E2A47] text-white rounded-xl font-semibold text-sm
            hover:bg-[#2a3a5c] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <><Loader2 size={16} className="animate-spin" /> Generating CDF files…</>
          ) : (
            <><Download size={16} /> Generate &amp; Download All 4 CDF Files (ZIP)</>
          )}
        </button>

        {/* Info box */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-500 space-y-1">
          <p className="font-semibold text-slate-600 mb-2">What gets generated:</p>
          {CIC_LABELS.map(c => (
            <p key={c.key}>• <span className="font-medium">{c.label}</span> — standard CDF with {c.label}-specific header, member ID &amp; footer</p>
          ))}
          <p className="pt-1 border-t border-slate-200 mt-2">The "Date of Account Information" field in every record is updated to match the <strong>From Date</strong> you selected.</p>
        </div>

      </div>
    </div>
  );
}
