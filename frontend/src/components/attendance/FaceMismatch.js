import React, { useEffect, useState } from "react";
import { X, AlertTriangle } from "lucide-react";
import API from "../../utils/api";

/**
 * Modal that shows a flagged punch photo side-by-side with the employee's
 * reference passport photo. Used by HR / Management / Manager to review
 * punches where the face match check failed.
 *
 * Props:
 *   record   – the attendance record (must include id, employee_id,
 *              punch_in_photo / punch_out_photo, *_face_warning,
 *              *_face_distance fields)
 *   side     – "in" | "out"   which side of the record to show
 *   onClose  – callback
 */
export function FaceMismatchModal({ record, side = "in", onClose }) {
  const [refPhoto, setRefPhoto] = useState(null);
  const [refError, setRefError] = useState("");
  const [refLoading, setRefLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setRefLoading(true);
    setRefError("");
    setRefPhoto(null);
    API.get(`/employees/${record.employee_id}/documents/passport_photo/file`, { responseType: "blob" })
      .then((res) => {
        if (!active) return;
        setRefPhoto(URL.createObjectURL(res.data));
      })
      .catch(() => {
        if (!active) return;
        setRefError("Reference passport photo not found on file.");
      })
      .finally(() => active && setRefLoading(false));
    return () => {
      active = false;
      if (refPhoto) URL.revokeObjectURL(refPhoto);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.employee_id]);

  const punchPhoto = side === "out" ? record.punch_out_photo : record.punch_in_photo;
  const warning    = side === "out" ? record.punch_out_face_warning : record.punch_in_face_warning;
  const distance   = side === "out" ? record.punch_out_face_distance : record.punch_in_face_distance;
  const time       = side === "out" ? record.punch_out_time : record.punch_in_time;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60" data-testid="face-mismatch-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center text-red-600">
              <AlertTriangle size={18} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
                Face Mismatch — {side === "out" ? "Punch Out" : "Punch In"}
              </h3>
              <p className="text-xs text-slate-500">
                {record.employee_name || record.employee_id}
                {record.designation ? ` · ${record.designation}` : ""}
                {record.date ? ` · ${record.date}` : ""}
                {time ? ` · ${new Date(time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : ""}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" data-testid="close-face-modal">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Side-by-side photos */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Punch photo (captured at the time) */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                Punch {side === "out" ? "Out" : "In"} Selfie
              </p>
              <div className="relative bg-slate-100 rounded-xl overflow-hidden aspect-[4/5] flex items-center justify-center">
                {punchPhoto ? (
                  <img src={`data:image/jpeg;base64,${punchPhoto}`} alt="Punch selfie"
                    className="w-full h-full object-cover" data-testid="flagged-punch-photo" />
                ) : (
                  <p className="text-xs text-slate-400 px-4 text-center">Photo not available</p>
                )}
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-red-600 text-white text-[10px] font-bold uppercase tracking-wider">
                  Flagged
                </div>
              </div>
            </div>

            {/* Reference passport photo */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                Reference Passport Photo
              </p>
              <div className="relative bg-slate-100 rounded-xl overflow-hidden aspect-[4/5] flex items-center justify-center">
                {refLoading ? (
                  <div className="w-6 h-6 border-2 border-slate-300 border-t-[#E85B1E] rounded-full animate-spin" />
                ) : refPhoto ? (
                  <img src={refPhoto} alt="Passport reference"
                    className="w-full h-full object-cover" data-testid="reference-passport-photo" />
                ) : (
                  <p className="text-xs text-slate-400 px-4 text-center">{refError || "Not on file"}</p>
                )}
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-[#1E2A47] text-white text-[10px] font-bold uppercase tracking-wider">
                  On File
                </div>
              </div>
            </div>
          </div>

          {/* Diagnostic details */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">Face Check Result</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-[11px] text-slate-500">Status</p>
                <p className="font-semibold text-red-600">Mismatch</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Distance Score</p>
                <p className="font-semibold text-slate-700">
                  {distance != null ? Number(distance).toFixed(3) : "—"}
                  <span className="text-xs text-slate-400 font-normal ml-1">(0 = exact, &gt;0.40 = mismatch)</span>
                </p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Reason</p>
                <p className="font-semibold text-slate-700">{warning || "—"}</p>
              </div>
            </div>
            {record.geofence_verified === false && (
              <p className="text-[11px] text-red-600 mt-2">
                ⚠ Punch was also outside the geofence — review carefully before accepting.
              </p>
            )}
          </div>

          <div className="text-xs text-slate-500 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-3">
            <strong className="text-slate-700">What to check:</strong> Face the same person? Common reasons for false mismatch include
            poor lighting, beard/hair changes, mask/glasses, or the reference passport photo being too old/low-resolution.
            If something looks off (different person, photo of a screen, etc.), use Attendance Regularisation to correct
            the record and notify HR.
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-4 py-2 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50" data-testid="close-face-modal-footer">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Tiny inline badge that surfaces a face-mismatch on an attendance row.
 * Renders nothing if neither side failed.
 *
 *  • If only one side failed, shows a single badge.
 *  • If both failed, shows two badges side-by-side.
 *  • Clicking opens the FaceMismatchModal for that side.
 */
export function FaceMismatchBadge({ record, onOpen }) {
  const inFlag  = record.punch_in_face_matched === false;
  const outFlag = record.punch_out_face_matched === false;
  if (!inFlag && !outFlag) return null;

  return (
    <span className="inline-flex items-center gap-1 ml-1">
      {inFlag && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpen("in"); }}
          data-testid={`face-warn-in-${record.id}`}
          title="Face mismatch on punch in — click to review"
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold uppercase tracking-wider hover:bg-red-200 transition-colors"
        >
          <AlertTriangle size={10} /> Face IN
        </button>
      )}
      {outFlag && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpen("out"); }}
          data-testid={`face-warn-out-${record.id}`}
          title="Face mismatch on punch out — click to review"
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold uppercase tracking-wider hover:bg-red-200 transition-colors"
        >
          <AlertTriangle size={10} /> Face OUT
        </button>
      )}
    </span>
  );
}
