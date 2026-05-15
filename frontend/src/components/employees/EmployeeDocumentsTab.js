import React, { useEffect, useState } from "react";
import { Upload, Eye, Download, Trash2, CheckCircle2, AlertCircle, FileText, ShieldCheck } from "lucide-react";
import API from "../../utils/api";
import { compressImage, fileToBase64String } from "../../utils/imageCompression";
import { DigiLockerButton } from "../digilocker/DigiLockerButton";

const DOC_GROUPS = [
  { title: "KYC", items: [["aadhaar_front", "Aadhaar — Front"], ["aadhaar_back", "Aadhaar — Back"], ["pan_card", "PAN Card"], ["voter_id_front", "Voter ID — Front"], ["voter_id_back", "Voter ID — Back"], ["driving_license_front", "Driving License — Front"], ["driving_license_back", "Driving License — Back"], ["passport_photo", "Passport-size Photo"]] },
  { title: "Education", items: [["edu_10th", "10th Certificate"], ["edu_12th", "12th Certificate"], ["edu_graduation", "Graduation"], ["edu_post_graduation", "Post-Graduation"], ["edu_phd", "Ph.D"], ["edu_other", "Other Qualification"]] },
  { title: "Banking & Statutory", items: [["cancelled_cheque", "Cancelled Cheque / Passbook"], ["pf_proof", "PF Proof"], ["esic_proof", "ESIC Proof"]] },
  { title: "Other", items: [["bike_rc", "Bike RC"], ["bike_puc_insurance", "Bike PUC / Insurance"], ["police_verification", "Police Verification"], ["medical_form", "Medical Form"]] },
  { title: "Joining Kit", items: [["joining_kit_pdf", "Joining Kit (Generated)"], ["signed_joining_kit", "Signed Joining Kit (uploaded back)"]] },
];

export function EmployeeDocumentsTab({ employeeId, onDocsChanged }) {
  const [docs, setDocs] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [err, setErr] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await API.get(`/employees/${employeeId}/documents`);
      setDocs(res.data.documents || {});
    } catch (e) { setErr("Failed to load documents"); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, [employeeId]);

  const upload = async (docType, file) => {
    if (!file) return;
    setErr("");
    setBusyKey(docType);
    try {
      let toSend = file;
      if (file.type.startsWith("image/")) {
        toSend = await compressImage(file, { maxBytes: 1024 * 1024 });
      } else if (file.size > 5 * 1024 * 1024) {
        setErr("File too large. Please keep PDFs under 5 MB.");
        setBusyKey(null);
        return;
      }
      const b64 = await fileToBase64String(toSend);
      await API.post(`/employees/${employeeId}/documents`, {
        doc_type: docType, data_base64: b64,
        mime_type: toSend.type || "application/octet-stream",
        file_name: toSend.name || `${docType}.bin`,
      });
      await refresh();
      onDocsChanged && onDocsChanged();
    } catch (e) {
      setErr(e.response?.data?.detail || "Upload failed");
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (docType) => {
    if (!confirm(`Delete ${docType}?`)) return;
    setBusyKey(docType);
    try {
      await API.delete(`/employees/${employeeId}/documents/${docType}`);
      await refresh();
      onDocsChanged && onDocsChanged();
    } catch (e) { setErr("Delete failed"); }
    finally { setBusyKey(null); }
  };

  const view = async (docType) => {
    try {
      const res = await API.get(`/employees/${employeeId}/documents/${docType}/file`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { setErr("Could not open document"); }
  };

  const download = async (docType, fallbackName) => {
    try {
      const res = await API.get(`/employees/${employeeId}/documents/${docType}/file`, { responseType: "blob", params: { as_attachment: true } });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = fallbackName || `${docType}.bin`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setErr("Could not download document"); }
  };

  const generateJoiningKit = async () => {
    setErr("");
    setBusyKey("joining_kit_pdf");
    try {
      const res = await API.get(`/employees/${employeeId}/joining-kit`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `JoiningKit_${employeeId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      try {
        const text = await e.response.data.text();
        setErr(JSON.parse(text).detail || "Failed to generate kit");
      } catch (_) {
        setErr("Failed to generate kit");
      }
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) return <p className="text-center text-slate-400 py-8">Loading...</p>;

  return (
    <div className="space-y-5">
      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
        </div>
      )}

      {/* DigiLocker fetch panel */}
      <DigiLockerButton
        contextType="employee"
        contextId={employeeId}
        onComplete={refresh}
      />

      {DOC_GROUPS.map(g => (
        <div key={g.title}>
          <h4 className="font-bold text-[#1E2A47] text-sm mb-3">{g.title}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {g.items.map(([key, label]) => {
              const meta = docs[key] || { uploaded: false };
              const busy = busyKey === key;
              return (
                <div key={key} className={`border rounded-lg p-3 ${meta.uploaded ? "border-green-200 bg-green-50/40" : "border-slate-200 bg-slate-50/40"}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs font-semibold text-[#1E2A47] truncate">{label}</p>
                    {meta.uploaded ? (
                      <span className="flex items-center gap-1 text-[10px] text-green-700 font-medium">
                        {meta.digilocker_verified ? (
                          <><ShieldCheck size={11} className="text-blue-600" /><span className="text-blue-700">DigiLocker Verified</span></>
                        ) : (
                          <><CheckCircle2 size={11} /> Uploaded</>
                        )}
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400 font-medium">Not uploaded</span>
                    )}
                  </div>
                  {meta.uploaded && (
                    <p className="text-[10px] text-slate-500 mb-2 truncate" title={meta.file_name}>
                      {meta.file_name || "—"} • {meta.size ? `${Math.round(meta.size / 1024)} KB` : ""}
                    </p>
                  )}
                  <div className="flex gap-1.5 flex-wrap">
                    <label className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-[#E85B1E] text-white rounded cursor-pointer hover:bg-[#D04A15]">
                      <Upload size={11} /> {meta.uploaded ? "Replace" : "Upload"}
                      <input type="file" accept="image/*,application/pdf" capture="environment" hidden
                        onChange={e => upload(key, e.target.files?.[0])}
                        data-testid={`upload-${key}`} disabled={busy} />
                    </label>
                    {key === "joining_kit_pdf" && (
                      <button type="button" onClick={generateJoiningKit} disabled={busyKey === "joining_kit_pdf"}
                        data-testid="generate-joining-kit-btn"
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
                        <FileText size={11} /> {busyKey === "joining_kit_pdf" ? "Generating..." : "Generate Now"}
                      </button>
                    )}
                    {meta.uploaded && (
                      <>
                        <button type="button" onClick={() => view(key)} disabled={busy} data-testid={`view-doc-${key}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-[#1E2A47]/10 text-[#1E2A47] rounded hover:bg-[#1E2A47]/20">
                          <Eye size={11} /> View
                        </button>
                        <button type="button" onClick={() => download(key, meta.file_name)} disabled={busy} data-testid={`download-doc-${key}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-blue-100 text-blue-700 rounded hover:bg-blue-200">
                          <Download size={11} /> Download
                        </button>
                        <button type="button" onClick={() => remove(key)} disabled={busy} data-testid={`delete-doc-${key}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-red-100 text-red-700 rounded hover:bg-red-200">
                          <Trash2 size={11} /> Delete
                        </button>
                      </>
                    )}
                    {busy && <span className="text-[11px] text-slate-500">Working...</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-slate-500 italic">Image files are auto-compressed to under 1 MB before upload. PDFs must be under 5 MB.</p>
    </div>
  );
}
