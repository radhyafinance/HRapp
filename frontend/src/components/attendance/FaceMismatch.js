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

  // A distance only exists when the two faces were actually measured against each
  // other. When it is null the detector never found a face in the selfie, so
  // nothing was compared — that is NOT evidence of a different person, and saying
  // "Mismatch" accuses the employee of something the system never checked.
  const compared = distance != null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60" data-testid="face-mismatch-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${compared ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"}`}>
              <AlertTriangle size={18} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
                {compared ? "Face Mismatch" : "Face Not Verified"} — {side === "out" ? "Punch Out" : "Punch In"}
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
                <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-white text-[10px] font-bold uppercase tracking-wider ${compared ? "bg-red-600" : "bg-amber-600"}`}>
                  {compared ? "Flagged" : "Unchecked"}
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
                <p className={`font-semibold ${compared ? "text-red-600" : "text-amber-700"}`}>
                  {compared ? "Mismatch" : "Could not verify"}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">Distance Score</p>
                <p className="font-semibold text-slate-700">
                  {compared ? Number(distance).toFixed(3) : "Not compared"}
                  {/* 0.60 mirrors DEFAULT_TOLERANCE in services/face_match.py. */}
                  <span className="text-xs text-slate-400 font-normal ml-1">
                    {compared ? "(0 = exact, above 0.60 = mismatch)" : "(no face found to measure)"}
                  </span>
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
            {compared ? (
              <>
                <strong className="text-slate-700">What to check:</strong> Is it the same person? Common reasons for a false
                mismatch include poor lighting, beard or hair changes, a mask or glasses, or a reference passport photo that
                is old or low-resolution. If something genuinely looks wrong (different person, photo of a screen), use
                Attendance Regularisation to correct the record and notify HR.
              </>
            ) : (
              <>
                <strong className="text-slate-700">The two photos were never compared.</strong> The system could not find a
                face in the selfie, so it has no opinion on whether this is the right person — judge it by eye. This usually
                means the photo was blurred, dim, backlit or taken at an angle, not that anything is wrong. If the person is
                clearly recognisable above, no action is needed.
              </>
            )}
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

  // Red only when the faces were genuinely compared and differed. A punch where
  // no face could be detected is amber "unchecked" — it deserves a look, but it
  // is not an accusation, and colouring the two alike trains people to ignore both.
  const inCompared  = record.punch_in_face_distance != null;
  const outCompared = record.punch_out_face_distance != null;
  const cls = (c) => c
    ? "bg-red-100 text-red-700 hover:bg-red-200"
    : "bg-amber-100 text-amber-800 hover:bg-amber-200";

  return (
    <span className="inline-flex items-center gap-1 ml-1">
      {inFlag && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpen("in"); }}
          data-testid={`face-warn-in-${record.id}`}
          title={inCompared
            ? "Face did not match the passport photo on punch in — click to review"
            : "No face could be detected in the punch-in selfie, so nothing was compared — click to review"}
          className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${cls(inCompared)}`}
        >
          <AlertTriangle size={10} /> {inCompared ? "Face IN" : "Check IN"}
        </button>
      )}
      {outFlag && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpen("out"); }}
          data-testid={`face-warn-out-${record.id}`}
          title={outCompared
            ? "Face did not match the passport photo on punch out — click to review"
            : "No face could be detected in the punch-out selfie, so nothing was compared — click to review"}
          className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${cls(outCompared)}`}
        >
          <AlertTriangle size={10} /> {outCompared ? "Face OUT" : "Check OUT"}
        </button>
      )}
    </span>
  );
}
