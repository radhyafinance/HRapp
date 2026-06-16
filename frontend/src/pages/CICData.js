import React, { useState, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { Upload, Download, X, FileSpreadsheet, Calendar, ShieldAlert, CheckCircle, Loader2, Package } from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

const CIC_LABELS = [
  { key: "cibil",    label: "CIBIL",    light: "bg-blue-50 border-blue-200 text-blue-700",    btnCls: "border-blue-300 text-blue-700 hover:bg-blue-50" },
  { key: "crif",     label: "CRIF",     light: "bg-emerald-50 border-emerald-200 text-emerald-700", btnCls: "border-emerald-300 text-emerald-700 hover:bg-emerald-50" },
  { key: "equifax",  label: "Equifax",  light: "bg-orange-50 border-orange-200 text-orange-700",  btnCls: "border-orange-300 text-orange-700 hover:bg-orange-50" },
  { key: "experian", label: "Experian", light: "bg-violet-50 border-violet-200 text-violet-700",  btnCls: "border-violet-300 text-violet-700 hover:bg-violet-50" },
];

function inputToDDMMYYYY(isoDate) {
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
  const [dataDate, setDataDate] = useState("");
  const [uploadDate, setUploadDate] = useState("");
  const [uidTags, setUidTags] = useState([]);
  const [uidInput, setUidInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { token, recordCount, skipped }
  const [error, setError] = useState("");
  const fileRef = useRef();

  if (!isAllowed) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <ShieldAlert size={48} className="text-slate-300" />
        <p className="text-slate-500 text-lg font-medium">Access Restricted</p>
        <p className="text-slate-400 text-sm">This tool is only available to authorised users.</p>
        <button onClick={() => navigate("/dashboard")} className="mt-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm">
          Back to Dashboard
        </button>
      </div>
    );
  }

  const addUidTag = (raw) => {
    const uid = raw.trim();
    if (uid && !uidTags.includes(uid)) setUidTags(prev => [...prev, uid]);
    setUidInput("");
  };

  const handleUidKeyDown = (e) => {
    if (["Enter", ",", " "].includes(e.key)) { e.preventDefault(); addUidTag(uidInput); }
  };

  const validate = () => {
    if (!file) return "Please upload an Excel (.xlsx) file.";
    if (!dataDate) return "Please select a Date of Data.";
    if (!uploadDate) return "Please select a Date of Upload.";
    return "";
  };

  // Step 1: process the Excel and get a download token (no file download here)
  const handleGenerate = async () => {
    setError(""); setResult(null);
    const err = validate();
    if (err) return setError(err);

    const allUids = [...uidTags, ...(uidInput.trim() ? [uidInput.trim()] : [])];
    const fd = new FormData();
    fd.append("file", file);
    fd.append("from_date", inputToDDMMYYYY(dataDate));
    fd.append("to_date", inputToDDMMYYYY(uploadDate));
    fd.append("excluded_uids", allUids.join("\n"));

    setLoading(true);
    try {
      // Use fetch (not Axios) so FormData Content-Type/boundary is set correctly by the browser
      const authToken = localStorage.getItem("auth_token");
      const res = await fetch(`${BACKEND_URL}/api/cic/generate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data?.detail;
        const msg = Array.isArray(detail)
          ? detail.map(e => e.msg || JSON.stringify(e)).join("; ")
          : (typeof detail === "string" ? detail : "Failed to generate CDF files.");
        setError(msg);
        return;
      }
      setResult({
        token: data.download_token,
        recordCount: data.record_count,
        skipped: data.skipped_count,
      });
    } catch (e) {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Step 2: download via anchor click (direct user gesture, same-origin → guaranteed download)
  const triggerUrl = (url, filename) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;   // forces save-dialog on same-origin URLs
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadZip = () => {
    if (!result?.token) return;
    const filename = `CIC_CDF_${inputToDDMMYYYY(dataDate)}_${inputToDDMMYYYY(uploadDate)}.zip`;
    triggerUrl(`${BACKEND_URL}/api/cic/download/${result.token}`, filename);
  };

  const downloadCic = (cicKey) => {
    if (!result?.token) return;
    const filenameMap = {
      cibil:    `MF8361_MFI_${inputToDDMMYYYY(dataDate)}_${inputToDDMMYYYY(uploadDate)}_DailyData.CDF`,
      crif:     `NBF0005342_MFI_DailyData_${inputToDDMMYYYY(dataDate)}_${inputToDDMMYYYY(uploadDate)}.CDF`,
      equifax:  `009FZ04381_MFI_DailyData_${inputToDDMMYYYY(dataDate)}_${inputToDDMMYYYY(uploadDate)}.CDF`,
      experian: `259263_${inputToDDMMYYYY(dataDate)}_${inputToDDMMYYYY(uploadDate)}_MFI_DAILY.CDF`,
    };
    triggerUrl(`${BACKEND_URL}/api/cic/download/${result.token}?cic=${cicKey}`, filenameMap[cicKey]);
  };

  const canGenerate = !!file && !!dataDate && !!uploadDate;

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }} className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
          CIC Data Converter
        </h1>
        <p className="text-slate-500 text-sm mt-1">Convert HighMark Excel data to CDF format for Credit Information Companies</p>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {CIC_LABELS.map(c => (
          <span key={c.key} className={`px-3 py-1 rounded-full text-xs font-bold border ${c.light}`}>{c.label}</span>
        ))}
      </div>

      <div className="space-y-5">

        {/* Step 1 — Upload */}
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
                <button onClick={(e) => { e.stopPropagation(); setFile(null); setResult(null); if (fileRef.current) fileRef.current.value = ""; }}
                  className="text-green-600 hover:text-red-500"><X size={16} /></button>
              </div>
            ) : (
              <>
                <Upload size={24} className="text-slate-400 mx-auto mb-2" />
                <p className="text-sm text-slate-500">Click to select Excel file (.xlsx)</p>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" accept=".xlsx" onChange={e => { if (e.target.files[0]) { setFile(e.target.files[0]); setResult(null); } }} className="hidden" data-testid="cic-file-input" />
        </div>

        {/* Step 2 — Dates */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h2 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E2A47] text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">2</span>
            Set Dates
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1">
                <Calendar size={12} /> Date of Data
              </label>
              <input type="date" value={dataDate} onChange={e => { setDataDate(e.target.value); setResult(null); }} data-testid="cic-from-date"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1E2A47]" />
              {dataDate && <p className="text-xs text-slate-400 mt-1">CDF: <span className="font-mono">{inputToDDMMYYYY(dataDate)}</span></p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1">
                <Calendar size={12} /> Date of Upload
              </label>
              <input type="date" value={uploadDate} onChange={e => { setUploadDate(e.target.value); setResult(null); }} data-testid="cic-to-date"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1E2A47]" />
              {uploadDate && <p className="text-xs text-slate-400 mt-1">CDF: <span className="font-mono">{inputToDDMMYYYY(uploadDate)}</span></p>}
            </div>
          </div>
        </div>

        {/* Step 3 — Exclude UIDs */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h2 className="text-sm font-bold text-slate-700 mb-1 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E2A47] text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">3</span>
            Exclude by Account Number <span className="font-normal text-slate-400 ml-1">(optional)</span>
          </h2>
          <p className="text-xs text-slate-400 mb-3 ml-7">Enter Account Numbers to remove those records from the CDF output</p>
          {uidTags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {uidTags.map(uid => (
                <span key={uid} className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-50 border border-red-200 text-red-700 rounded-full text-xs font-mono">
                  {uid}
                  <button onClick={() => setUidTags(p => p.filter(u => u !== uid))}><X size={10} /></button>
                </span>
              ))}
            </div>
          )}
          <input
            type="text" value={uidInput}
            onChange={e => setUidInput(e.target.value)}
            onKeyDown={handleUidKeyDown}
            onBlur={() => uidInput.trim() && addUidTag(uidInput)}
            placeholder="Type Account Number and press Enter or comma to add..."
            data-testid="cic-uid-input"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#1E2A47]"
          />
          <p className="text-xs text-slate-400 mt-1.5">
            Press Enter, comma, or Space after each Account Number.{" "}
            {uidTags.length > 0 && <span className="text-red-600 font-medium">{uidTags.length} account{uidTags.length > 1 ? "s" : ""} will be excluded.</span>}
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <ShieldAlert size={16} className="flex-shrink-0" /> {error}
          </div>
        )}

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={loading || !canGenerate}
          data-testid="cic-generate-btn"
          className="w-full flex items-center justify-center gap-2 py-3 bg-[#1E2A47] text-white rounded-xl font-semibold text-sm
            hover:bg-[#2a3a5c] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading
            ? <><Loader2 size={16} className="animate-spin" /> Processing {file?.name}…</>
            : <><Package size={16} /> Process &amp; Prepare CDF Files</>
          }
        </button>

        {/* Download panel — shown after successful generation */}
        {result && (
          <div className="bg-white border border-green-200 rounded-xl shadow-sm overflow-hidden">
            {/* Header */}
            <div className="flex items-start gap-3 p-4 bg-green-50 border-b border-green-200">
              <CheckCircle size={18} className="text-green-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-green-700">Files are ready to download!</p>
                <p className="text-xs text-green-600 mt-0.5">
                  {result.recordCount} records processed.
                  {result.skipped > 0 && ` ${result.skipped} excluded.`}
                  {" "}Links expire in 5 minutes.
                </p>
              </div>
            </div>

            {/* ZIP download */}
            <div className="p-4 border-b border-slate-100">
              <button
                onClick={downloadZip}
                data-testid="cic-download-zip"
                className="w-full flex items-center justify-center gap-2 py-3 bg-[#1E2A47] text-white rounded-xl font-semibold text-sm
                  hover:bg-[#2a3a5c] transition-colors"
              >
                <Package size={16} /> Download All 4 CDF Files (ZIP)
              </button>
            </div>

            {/* Individual CIC buttons */}
            <div className="p-4">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Or download individually</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {CIC_LABELS.map(c => (
                  <button
                    key={c.key}
                    onClick={() => downloadCic(c.key)}
                    data-testid={`cic-download-${c.key}`}
                    className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg border text-xs font-bold
                      transition-all hover:-translate-y-0.5 ${c.btnCls}`}
                  >
                    <Download size={16} />
                    {c.label}
                    <span className="font-normal text-[10px] opacity-70">.CDF</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Info */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-500 space-y-1">
          <p className="font-semibold text-slate-600 mb-2">Generated file names:</p>
          <p>• <strong>CIBIL</strong> — <span className="font-mono">MF8361_MFI_{"{DataDate}"}_{"{UploadDate}"}_DailyData.CDF</span></p>
          <p>• <strong>CRIF</strong> — <span className="font-mono">NBF0005342_MFI_DailyData_{"{DataDate}"}_{"{UploadDate}"}.CDF</span></p>
          <p>• <strong>Equifax</strong> — <span className="font-mono">009FZ04381_MFI_DailyData_{"{DataDate}"}_{"{UploadDate}"}.CDF</span></p>
          <p>• <strong>Experian</strong> — <span className="font-mono">259263_{"{DataDate}"}_{"{UploadDate}"}_MFI_DAILY.CDF</span></p>
          <p className="pt-2 border-t border-slate-200 mt-2">The <strong>Date of Data</strong> replaces the "Date of Account Information" field in every record. Both dates appear in the file header and name.</p>
        </div>

      </div>
    </div>
  );
}
