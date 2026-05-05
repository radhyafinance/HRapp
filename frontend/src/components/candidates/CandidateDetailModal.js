import React, { useEffect, useState } from "react";
import { Image as ImageIcon, Eye, CalendarClock, FileText } from "lucide-react";
import { Modal } from "../shared/Modal";
import { JoiningKitPanel } from "./JoiningKitPanel";
import API from "../../utils/api";

const STATUS_COLORS = { pending: "bg-amber-100 text-amber-700", selected: "bg-green-100 text-green-700", rejected: "bg-red-100 text-red-700", converted: "bg-blue-100 text-blue-700" };

export function CandidateDetailModal({ candidate, onClose, onSchedule }) {
  const [c, setC] = useState(candidate);
  const [docsMeta, setDocsMeta] = useState(null);
  const [zoomDoc, setZoomDoc] = useState(null);
  const [docBlobs, setDocBlobs] = useState({});

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
        <div className="bg-slate-50 p-4 rounded-lg flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-500">{c.position} • {c.department}</p>
            <p className="text-xs text-slate-400 mt-0.5">{c.mobile} {c.email && `• ${c.email}`}</p>
          </div>
          <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[c.status]}`}>{c.status}</span>
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
          <div className="grid grid-cols-3 gap-3">
            {[["aadhaar_front", "Aadhaar Front"], ["aadhaar_back", "Aadhaar Back"], ["pan_card", "PAN Card"]].map(([key, label]) => {
              const exists = docsMeta && docsMeta[key];
              const blobUrl = docBlobs[key];
              return (
                <div key={key} className={`border rounded-xl p-2 text-center ${exists ? "border-slate-200 bg-white" : "border-dashed border-slate-300 bg-slate-50/50"}`}>
                  {!exists ? (
                    <div className="h-32 flex flex-col items-center justify-center text-slate-400">
                      <ImageIcon size={24} />
                      <p className="text-xs mt-1">Not uploaded</p>
                    </div>
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
