import React, { useState } from "react";
import { Camera, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { CameraCapture } from "./CameraCapture";
import { retakePunchPhoto } from "../../utils/punch";

/**
 * Offers ONE retake after a punch whose face check failed.
 *
 * The punch itself has already been recorded and is never at risk — this only
 * replaces the face-check result attached to it. That ordering is deliberate:
 * making the punch depend on a successful face check would mean a bad camera or
 * a dark room could stop someone marking their attendance.
 *
 * Renders nothing unless the check actually failed (`face_matched === false`).
 * A punch that was never verified at all — a timeout, say — comes back as
 * `null`, and there is nothing for the employee to fix there.
 *
 * Props:
 *   result     – the punch response (needs face_matched, face_warning)
 *   employeeId – whose record to amend
 *   side       – "in" | "out"
 *   onDone     – called after a completed attempt, so the parent can refresh
 */
export function FaceRetakePrompt({ result, employeeId, side, onDone }) {
  const [showCamera, setShowCamera] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState(null);

  if (!result || result.face_matched !== false) return null;

  const handleCapture = async (photo_base64) => {
    setShowCamera(false);
    setSending(true);
    const res = await retakePunchPhoto(side, { employee_id: employeeId, photo_base64 });
    setOutcome(res);
    setSending(false);
    // Refresh either way: on success the flag is gone, on failure the record may
    // still have changed (a different warning), and the parent should show it.
    onDone && onDone();
  };

  // One attempt only — once there is an outcome the offer does not come back.
  if (outcome) {
    const good = outcome.success && outcome.face_matched;
    return (
      <div
        className={`mt-3 p-2.5 rounded-lg text-xs flex items-start gap-2 ${
          good ? "bg-green-500/20 text-green-100" : "bg-amber-500/20 text-amber-100"
        }`}
        data-testid="face-retake-outcome"
      >
        {good ? <CheckCircle size={14} className="mt-0.5 flex-shrink-0" />
              : <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />}
        <span>{outcome.message || (good ? "Face verified." : "Could not verify that photo.")}</span>
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-amber-500/15 border border-amber-400/30 text-xs"
      data-testid="face-retake-prompt">
      <p className="text-amber-100 leading-relaxed">
        <strong>Your punch is saved.</strong> We could not verify your photo
        {result.face_warning ? ` — ${result.face_warning}` : "."}
      </p>
      <p className="text-amber-200/80 mt-1">
        You can retake it once. Face the camera in good light.
      </p>
      <button
        type="button"
        onClick={() => setShowCamera(true)}
        disabled={sending}
        data-testid="face-retake-btn"
        className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-semibold disabled:opacity-60"
      >
        {sending ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
        {sending ? "Checking…" : "Retake photo"}
      </button>
      {showCamera && (
        <CameraCapture onCapture={handleCapture} onClose={() => setShowCamera(false)} />
      )}
    </div>
  );
}

export default FaceRetakePrompt;
