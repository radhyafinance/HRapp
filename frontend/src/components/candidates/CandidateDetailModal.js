import React, { useEffect, useState } from "react";
import { Image as ImageIcon, Eye, CalendarClock, FileText, Pencil, Check, X as XIcon } from "lucide-react";
import { Modal } from "../shared/Modal";
import { JoiningKitPanel } from "./JoiningKitPanel";
import API from "../../utils/api";

const STATUS_COLORS = { pending: "bg-amber-100 text-amber-700", selected: "bg-green-100 text-green-700", rejected: "bg-red-100 text-red-700", converted: "bg-blue-100 text-blue-700" };
const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Management", "Operations", "Risk and Credit"];

export function CandidateDetailModal({ candidate, onClose, onSchedule }) {
  const [c, setC] = useState(candidate);
  const [docsMeta, setDocsMeta] = useState(null);
  const [zoomDoc, setZoomDoc] = useState(null);
  const [docBlobs, setDocBlobs] = useState({});

  // Inline edit state for Position + Department
  const [editingRole, setEditingRole] = useState(false);
  const [posDraft, setPosDraft] = useState(c.position || "");
  const [deptDraft, setDeptDraft] = useState(c.department || "");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const startEdit = () => {
    setPosDraft(c.position || "");
    setDeptDraft(c.department || "");
    setSaveErr("");
    setEditingRole(true);
  };
  const cancelEdit = () => { setEditingRole(false); setSaveErr(""); };
  const saveRole = async () => {
    if (!posDraft.trim() || !deptDraft) {
      setSaveErr("Both Position and Department are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await API.put(`/candidates/${c.id}`, {
        position: posDraft.trim(),
        department: deptDraft,
      });
      setC(res.data);
      setEditingRole(false);
    } catch (e) {
      setSaveErr(e.response?.data?.detail || "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await API.get(`/candidates/${candidate.id}/documents`);
        setDocsMeta(res.data);
      } catch (e) { setDocsMeta({}); }
    })();
  }, [candidate.id]);

  useEffect(() => {
    return () => { Object.values(docBlobs).forEach((u) => URL.revokeObjectURL(u)); };
  }, [docBlobs]);

  const fetchDoc = async (type) => {
    try {
      const res = await API.get(`/candidates/${candidate.id}/documents/${type}`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      setDocBlobs(prev => ({ ...prev, [type]: url }));
      return url;
    } catch (e) { return null; }
  };

  return (
    <Modal title={`${c.first_name} ${c.last_name}`} onClose={onClose} wide>
      <div className="space-y-5">
        <div className="bg-slate-50 p-4 rounded-lg flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {editingRole ? (
              <div className="space-y-2" data-testid="role-edit-form">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Position Applied For*</label>
                    <input value={posDraft} onChange={e => setPosDraft(e.target.value)}
                      placeholder="e.g. Field Officer, Branch Manager"
                      data-testid="role-edit-position"
                      className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Department*</label>
                    <select value={deptDraft} onChange={e => setDeptDraft(e.target.value)}
                      data-testid="role-edit-department"
                      className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
                      <option value="">Select Department</option>
                      {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                </div>
                {saveErr && <p className="text-xs text-red-600">{saveErr}</p>}
                <div className="flex gap-2">
                  <button onClick={saveRole} disabled={saving} data-testid="role-save"
                    className="flex items-center gap-1 px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg text-xs font-semibold hover:bg-[#D04A15] disabled:opacity-50">
                    <Check size={12} /> {saving ? "Saving..." : "Save"}
                  </button>
                  <button onClick={cancelEdit} disabled={saving} data-testid="role-cancel"
                    className="flex items-center gap-1 px-3 py-1.5 border border-slate-300 text-slate-600 rounded-lg text-xs hover:bg-slate-100">
                    <XIcon size={12} /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm text-slate-700 font-medium">
                    {c.position || <span className="italic text-slate-400">Position not set</span>}
                    <span className="text-slate-400"> · </span>
                    {c.department || <span className="italic text-slate-400">Department not set</span>}
                  </p>
                  <button onClick={startEdit} data-testid="role-edit-btn"
                    title="Edit position & department"
                    className="p-1 rounded hover:bg-white text-slate-400 hover:text-[#E85B1E]">
                    <Pencil size={12} />
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{c.mobile} {c.email && `• ${c.email}`}</p>
              </>
            )}
          </div>
          <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[c.status]} flex-shrink-0`}>{c.status}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          {[
            ["Aadhaar #", c.aadhaar_number ? c.aadhaar_number.replace(/(\d{4})(?=\d)/g, "$1 ") : "-"],
            ["PAN", c.pan_number || "-"],
            ["DOB", c.dob || "-"],
            ["Gender", c.gender || "-"],
            ["Father / Husband", c.father_or_husband_name || "-"],
            ["Pincode", c.pincode || "-"],
            ["City", c.city || "-"],
            ["State", c.state || "-"],
          ].map(([label, val]) => (
            <div key={label} className="flex justify-between border-b border-slate-100 pb-1">
              <span className="text-slate-500">{label}</span>
              <span className="font-medium text-[#0F172A] text-right">{val}</span>
            </div>
          ))}
          {c.address && (
            <div className="md:col-span-2 border-b border-slate-100 pb-1">
              <p className="text-slate-500 text-xs mb-0.5">Address</p>
              <p className="font-medium text-[#0F172A] text-sm">{c.address}</p>
            </div>
          )}
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-bold text-[#1E2A47] text-sm">Interview</h4>
            <button onClick={() => onSchedule(c)} data-testid="detail-schedule-btn" className="flex items-center gap-1 text-xs px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200">
              <CalendarClock size={12} /> {c.interview_date ? "Reschedule / Share" : "Schedule"}
            </button>
          </div>
          {c.interview_date ? (
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm space-y-1">
              <p><span className="text-slate-500">Date & Time:</span> <span className="font-semibold text-[#0F172A]">{c.interview_date}{c.interview_time && ` • ${c.interview_time}`}</span></p>
              {(c.interviewer_ids?.length > 0 || c.interviewer) && (
                <p><span className="text-slate-500">Interviewer{c.interviewer_ids?.length > 1 ? "s" : ""}:</span>{" "}
                  <span className="font-medium">{c.interviewer_names || c.interviewer_ids?.join(", ") || c.interviewer}</span>
                </p>
              )}
              {c.meet_link && (
                <p className="break-all"><span className="text-slate-500">Meet:</span>{" "}
                  <a href={c.meet_link} target="_blank" rel="noopener noreferrer" className="text-[#E85B1E] hover:underline">{c.meet_link}</a>
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No interview scheduled.</p>
          )}
        </div>

        {(c.status === "selected" || c.status === "converted") && (
          <div className="border-t pt-4" data-testid="joining-section">
            <h4 className="font-bold text-[#1E2A47] text-sm mb-3 flex items-center gap-2">
              <FileText size={14} className="text-[#E85B1E]" /> Joining Kit
            </h4>
            <JoiningKitPanel candidate={c} onCandidateUpdate={setC} />
          </div>
        )}

        <div className="border-t pt-4">
          <h4 className="font-bold text-[#1E2A47] text-sm mb-3">KYC Documents</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[["aadhaar_front", "Aadhaar Front"], ["aadhaar_back", "Aadhaar Back"], ["pan_card", "PAN Card"], ["cv", "CV / Resume"]].map(([key, label]) => {
              const exists = docsMeta && docsMeta[key];
              const blobUrl = docBlobs[key];
              const isCv = key === "cv";
              const cvName = (docsMeta && docsMeta.cv_file_name) || "cv.pdf";
              return (
                <div key={key} className={`border rounded-xl p-2 text-center ${exists ? "border-slate-200 bg-white" : "border-dashed border-slate-300 bg-slate-50/50"}`}>
                  {!exists ? (
                    <div className="h-32 flex flex-col items-center justify-center text-slate-400">
                      <ImageIcon size={24} />
                      <p className="text-xs mt-1">Not uploaded</p>
                    </div>
                  ) : isCv ? (
                    <a
                      href={blobUrl || "#"}
                      onClick={async (e) => {
                        if (!blobUrl) {
                          e.preventDefault();
                          const url = await fetchDoc(key);
                          if (url) window.open(url, "_blank", "noopener,noreferrer");
                        }
                      }}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`open-${key}`}
                      className="h-32 w-full flex flex-col items-center justify-center text-[#E85B1E] hover:bg-[#E85B1E]/5 rounded-lg"
                    >
                      <FileText size={28} />
                      <p className="text-[11px] mt-1 font-semibold truncate max-w-full px-1">{cvName}</p>
                      <p className="text-[10px] text-slate-400">{blobUrl ? "Open in new tab" : "Click to load"}</p>
                    </a>
                  ) : blobUrl ? (
                    <img src={blobUrl} alt={label} className="h-32 w-full object-contain mx-auto cursor-zoom-in" onClick={() => setZoomDoc({ url: blobUrl, label })} />
                  ) : (
                    <button type="button" onClick={() => fetchDoc(key)} data-testid={`load-${key}`} className="h-32 w-full flex flex-col items-center justify-center text-[#E85B1E] hover:bg-[#E85B1E]/5 rounded-lg">
                      <Eye size={20} />
                      <p className="text-xs mt-1 font-semibold">Load image</p>
                    </button>
                  )}
                  <p className="text-xs font-semibold text-slate-700 mt-1">{label}</p>
                </div>
              );
            })}
          </div>
        </div>

        {zoomDoc && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/80" onClick={() => setZoomDoc(null)}>
            <img src={zoomDoc.url} alt={zoomDoc.label} className="max-w-full max-h-full rounded-lg shadow-2xl" />
          </div>
        )}
      </div>
    </Modal>
  );
}
