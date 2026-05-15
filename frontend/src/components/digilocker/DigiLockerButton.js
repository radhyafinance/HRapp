/**
 * DigiLockerButton — reusable component that drives the full DigiLocker flow.
 *
 * Props:
 *   contextType  "candidate" | "employee"
 *   contextId    candidate ObjectId string | employee_id string
 *   onComplete   () => void  — called when documents are successfully fetched
 */
import React, { useState, useEffect, useRef } from "react";
import { ShieldCheck, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import API from "../../utils/api";

export function DigiLockerButton({ contextType, contextId, onComplete }) {
  const [state, setState] = useState("idle"); // idle | initiating | waiting | done | error
  const [msg, setMsg] = useState("");
  const [storedDocs, setStoredDocs] = useState([]);
  const popupRef = useRef(null);
  const listenerRef = useRef(null);

  // Clean up listener + popup on unmount
  useEffect(() => {
    return () => {
      if (listenerRef.current) window.removeEventListener("message", listenerRef.current);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    };
  }, []);

  const handleMessage = (event) => {
    if (event.origin !== window.location.origin) return;
    const { type, stored, success, error } = event.data || {};
    if (type !== "DIGILOCKER_DONE") return;

    window.removeEventListener("message", listenerRef.current);
    listenerRef.current = null;

    if (success && stored?.length > 0) {
      setStoredDocs(stored);
      setMsg(`${stored.length} document(s) verified and saved.`);
      setState("done");
      onComplete && onComplete();
    } else if (success) {
      setState("error");
      setMsg("DigiLocker authorised but no recognisable documents were found.");
    } else {
      setState("error");
      setMsg(error || "DigiLocker verification failed. Please try again.");
    }
  };

  const startFlow = async () => {
    setState("initiating");
    setMsg("");
    setStoredDocs([]);

    try {
      const res = await API.post("/digilocker/initiate", {
        context_type: contextType,
        context_id: contextId,
      });
      const { digilocker_url } = res.data;

      // Open DigiLocker in a popup
      const popup = window.open(
        digilocker_url,
        "digilocker_auth",
        "width=640,height=760,top=80,left=200,toolbar=no,menubar=no,scrollbars=yes",
      );
      popupRef.current = popup;

      if (!popup || popup.closed) {
        setState("error");
        setMsg("Popup was blocked. Please allow popups for this site and try again.");
        return;
      }

      setState("waiting");

      // Register message listener
      const listener = (ev) => handleMessage(ev);
      listenerRef.current = listener;
      window.addEventListener("message", listener);

      // Poll every second to detect if popup was closed without completing
      const poll = setInterval(() => {
        if (popup.closed) {
          clearInterval(poll);
          // Only show error if we haven't already received the message
          if (listenerRef.current) {
            window.removeEventListener("message", listenerRef.current);
            listenerRef.current = null;
            setState("error");
            setMsg("DigiLocker window closed before completing. Please try again.");
          }
        }
      }, 1000);
    } catch (err) {
      setState("error");
      setMsg(err.response?.data?.detail || "Failed to initiate DigiLocker session.");
    }
  };

  const DOC_LABELS = {
    pan_card: "PAN Card",
    aadhaar_front: "Aadhaar Card",
    driving_license_front: "Driving Licence",
    voter_id_front: "Voter ID",
    edu_10th: "10th Certificate",
    edu_12th: "12th Certificate",
    edu_graduation: "Graduation Certificate",
    edu_post_graduation: "Post-Graduation Certificate",
  };

  return (
    <div className="border border-blue-200 bg-blue-50/50 rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-[#1E2A47] rounded-lg flex items-center justify-center flex-shrink-0">
          <ShieldCheck size={16} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-bold text-[#1E2A47]">DigiLocker Document Fetch</p>
          <p className="text-xs text-slate-500">Download verified government documents directly from DigiLocker</p>
        </div>
      </div>

      {/* Status messages */}
      {state === "waiting" && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <Loader2 size={15} className="text-amber-600 animate-spin flex-shrink-0" />
          <p className="text-xs text-amber-800">
            <span className="font-semibold">Waiting for DigiLocker authorisation…</span> Complete the steps in the popup window.
          </p>
        </div>
      )}

      {state === "done" && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 size={14} className="text-green-600" />
            <p className="text-xs font-semibold text-green-800">{msg}</p>
          </div>
          {storedDocs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {storedDocs.map((k) => (
                <span key={k} className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-[10px] font-medium px-2 py-0.5 rounded-full">
                  <ShieldCheck size={9} /> {DOC_LABELS[k] || k}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {state === "error" && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-700">{msg}</p>
        </div>
      )}

      {/* Action button */}
      {state !== "done" && (
        <button
          type="button"
          onClick={startFlow}
          disabled={state === "initiating" || state === "waiting"}
          data-testid="digilocker-fetch-btn"
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#1E2A47] hover:bg-[#162038] disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {state === "initiating" ? (
            <><Loader2 size={15} className="animate-spin" /> Initiating…</>
          ) : state === "waiting" ? (
            <><Loader2 size={15} className="animate-spin" /> Waiting for authorisation…</>
          ) : (
            <><ExternalLink size={15} /> Fetch Documents via DigiLocker</>
          )}
        </button>
      )}

      {state === "done" && (
        <button
          type="button"
          onClick={() => { setState("idle"); setMsg(""); setStoredDocs([]); }}
          data-testid="digilocker-refetch-btn"
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
        >
          Fetch Again
        </button>
      )}

      <p className="text-[10px] text-slate-400">
        Powered by Perfios · Documents are stored as government-verified PDFs in the employee's KYC profile.
      </p>
    </div>
  );
}
