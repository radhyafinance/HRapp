/**
 * DigiLockerCallback — opened as a popup after user authorises on DigiLocker.
 * Reads ?state=<session_id> from URL, calls fetch-and-store, then posts
 * DIGILOCKER_DONE to the opener and closes itself.
 */
import React, { useEffect, useState } from "react";
import { ShieldCheck, AlertCircle, Loader2, CheckCircle2 } from "lucide-react";
import API from "../utils/api";

// Diagnostic: shows EVERYTHING DigiLocker shared for this pull (name + type),
// so HR can see whether a marksheet was even returned. A marksheet the employee
// only uploaded to DigiLocker (not one digitally issued by the board) will not
// appear in this list at all.
function SharedDocsList({ available }) {
  if (!available || available.length === 0) return null;
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-left">
      <p className="text-xs font-semibold text-slate-700 mb-1.5">
        DigiLocker shared these {available.length} document(s):
      </p>
      <ul className="space-y-1">
        {available.map((d, i) => (
          <li key={i} className="text-xs text-slate-600">
            • {d.name || "(unnamed)"}{d.doctype ? ` — ${d.doctype}` : ""}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-slate-400 mt-2">
        If a marksheet is missing here, DigiLocker didn't share it (it may be a self-uploaded file, not an issued document).
      </p>
    </div>
  );
}

export default function DigiLockerCallback() {
  const [status, setStatus] = useState("loading"); // loading | success | error
  const [message, setMessage] = useState("Fetching documents from DigiLocker...");
  const [stored, setStored] = useState([]);
  const [available, setAvailable] = useState([]); // everything DigiLocker actually shared (diagnostic)

  const DOC_LABELS = {
    pan_card: "PAN Card",
    aadhaar_front: "Aadhaar Card",
    aadhaar_back: "Aadhaar Card (Back)",
    driving_license_front: "Driving Licence",
    voter_id_front: "Voter ID",
    edu_10th: "10th Certificate",
    edu_12th: "12th Certificate",
    edu_graduation: "Graduation Certificate",
    edu_post_graduation: "Post-Graduation Certificate",
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("state") || params.get("oAuthState") || params.get("session_id");

    if (!sessionId) {
      setStatus("error");
      setMessage("Missing session ID. Please try again from the HR portal.");
      return;
    }

    // Token lives in localStorage (same origin as main window)
    const token = localStorage.getItem("auth_token");
    if (!token) {
      setStatus("error");
      setMessage("Session expired. Please log in again and retry.");
      return;
    }

    (async () => {
      try {
        const res = await API.post(`/digilocker/fetch-and-store/${sessionId}`);
        const data = res.data;
        setAvailable(data.available || []);

        if (data.success) {
          setStored(data.stored || []);
          setStatus("success");
          setMessage(data.message || "Documents fetched successfully.");
        } else if (data.already_done) {
          setStored(data.stored || []);
          setStatus("success");
          setMessage("Documents were already downloaded.");
        } else {
          setStatus("error");
          setMessage(data.message || "No documents could be downloaded from DigiLocker.");
        }

        // Notify opener
        if (window.opener) {
          window.opener.postMessage(
            { type: "DIGILOCKER_DONE", sessionId, stored: data.stored || [], success: data.success },
            window.location.origin,
          );
        }

        // Auto-close after 20 seconds (longer so the shared-documents list can be read)
        setTimeout(() => {
          window.close();
        }, 20000);
      } catch (err) {
        const detail = err.response?.data?.detail || err.message || "Unknown error";
        setStatus("error");
        setMessage(`Failed to process DigiLocker documents: ${detail}`);
        if (window.opener) {
          window.opener.postMessage(
            { type: "DIGILOCKER_DONE", sessionId, stored: [], success: false, error: detail },
            window.location.origin,
          );
        }
        setTimeout(() => window.close(), 5000);
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-[#F5F5F0] flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
        {/* Logo / header */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-10 h-10 bg-[#1E2A47] rounded-xl flex items-center justify-center">
            <ShieldCheck size={20} className="text-white" />
          </div>
          <div className="text-left">
            <p className="text-xs text-slate-500">Radhya Micro Finance</p>
            <p className="text-sm font-bold text-[#1E2A47]">DigiLocker Integration</p>
          </div>
        </div>

        {status === "loading" && (
          <div className="space-y-4">
            <Loader2 size={40} className="text-[#E85B1E] animate-spin mx-auto" />
            <p className="text-sm font-semibold text-[#1E2A47]">Processing Documents</p>
            <p className="text-xs text-slate-500">{message}</p>
          </div>
        )}

        {status === "success" && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle2 size={32} className="text-green-600" />
            </div>
            <p className="text-sm font-semibold text-[#1E2A47]">Documents Verified!</p>
            <p className="text-xs text-slate-500">{message}</p>
            {stored.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-left">
                <p className="text-xs font-semibold text-green-800 mb-1.5">Stored documents:</p>
                <ul className="space-y-1">
                  {stored.map((k) => (
                    <li key={k} className="flex items-center gap-1.5 text-xs text-green-700">
                      <CheckCircle2 size={11} />
                      {DOC_LABELS[k] || k}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[11px] text-slate-400">This window will close automatically…</p>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-4">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto">
              <AlertCircle size={32} className="text-red-500" />
            </div>
            <p className="text-sm font-semibold text-[#1E2A47]">Something went wrong</p>
            <p className="text-xs text-slate-500">{message}</p>
            <p className="text-[11px] text-slate-400">This window will close shortly. Please try again.</p>
          </div>
        )}
      </div>
    </div>
  );
}
