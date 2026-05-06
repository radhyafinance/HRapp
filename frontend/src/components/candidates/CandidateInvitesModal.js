/**
 * Modal: HR-side management of Candidate self-onboarding invite links.
 *
 *  - Generate a fresh invite (creates a single-use 7-day token, returns public URL).
 *  - List existing invites with status (active / used / expired / revoked).
 *  - Copy a link to the clipboard with one click.
 *  - Revoke an active invite.
 */
import React, { useEffect, useState } from "react";
import { X, Plus, Copy, Trash2, Check, Loader2, Link2 } from "lucide-react";
import API from "../../utils/api";

const STATUS_STYLE = {
  active:  "bg-green-100 text-green-700",
  used:    "bg-blue-100 text-blue-700",
  expired: "bg-slate-100 text-slate-500",
  revoked: "bg-red-100 text-red-700",
};

export function CandidateInvitesModal({ onClose, onCandidateCreated }) {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const fetchInvites = async () => {
    setLoading(true);
    try {
      const r = await API.get("/candidate-invites");
      setInvites(r.data);
    } catch (e) {
      console.error("fetchInvites failed", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchInvites(); }, []);

  // Refresh used-invite count once a minute so HR sees new self-onboarded
  // candidates show up without manually closing/reopening the modal.
  useEffect(() => {
    const id = setInterval(fetchInvites, 60_000);
    return () => clearInterval(id);
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const r = await API.post("/candidate-invites", { note: note.trim() || null });
      setInvites([r.data, ...invites]);
      setNote("");
      // Auto-copy the new link
      try {
        await navigator.clipboard.writeText(r.data.public_url);
        setCopiedId(r.data.id);
        setTimeout(() => setCopiedId(null), 2500);
      } catch {}
    } catch (e) {
      alert(e.response?.data?.detail || "Failed to generate link.");
    } finally {
      setCreating(false);
    }
  };

  const copy = async (inv) => {
    try {
      await navigator.clipboard.writeText(inv.public_url);
      setCopiedId(inv.id);
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      // Fallback if clipboard API blocked (older mobile browsers)
      window.prompt("Copy this link", inv.public_url);
    }
  };

  const revoke = async (inv) => {
    if (!window.confirm("Revoke this link? The candidate will no longer be able to submit using it.")) return;
    setBusyId(inv.id);
    try {
      await API.delete(`/candidate-invites/${inv.id}`);
      setInvites(invites.map(i => i.id === inv.id ? { ...i, status: "revoked" } : i));
    } catch (e) {
      alert(e.response?.data?.detail || "Failed to revoke link.");
    } finally {
      setBusyId(null);
    }
  };

  const formatDate = (iso) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    } catch { return iso; }
  };

  // If a previously-active invite has flipped to "used" since last refresh,
  // the candidate must have just submitted — let parent refresh too.
  useEffect(() => {
    if (invites.some(i => i.status === "used") && onCandidateCreated) {
      onCandidateCreated();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invites.length]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60" data-testid="invites-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#E85B1E]/10 flex items-center justify-center text-[#E85B1E]">
              <Link2 size={18} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
                Candidate Invite Links
              </h3>
              <p className="text-xs text-slate-500">
                Generate a single-use link, share it with the candidate, and they can self-upload Aadhaar, PAN, photo & CV.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" data-testid="close-invites">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Generate new */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Generate New Link</p>
            <div className="flex gap-2">
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Optional note (e.g. 'Sent to Ravi via WhatsApp')"
                data-testid="invite-note"
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              />
              <button onClick={create} disabled={creating} data-testid="generate-invite"
                className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-50">
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Generate Link
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Each link is single-use, expires after 7 days, and is auto-revoked the moment the candidate submits.
            </p>
          </div>

          {/* Existing invites */}
          {loading ? (
            <div className="text-center py-12 text-slate-400 text-sm">Loading...</div>
          ) : invites.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-sm">No invite links yet. Generate one above.</div>
          ) : (
            <div className="space-y-2">
              {invites.map(inv => (
                <div key={inv.id} className="border border-slate-200 rounded-xl p-3 bg-white" data-testid={`invite-row-${inv.id}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLE[inv.status] || ""}`}>
                      {inv.status}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {inv.status === "used" ? `Used: ${formatDate(inv.used_at)}` : `Expires: ${formatDate(inv.expires_at)}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input readOnly value={inv.public_url} data-testid={`invite-url-${inv.id}`}
                      className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-600 truncate" />
                    {inv.status === "active" && (
                      <>
                        <button onClick={() => copy(inv)} data-testid={`copy-${inv.id}`}
                          title="Copy link"
                          className="p-2 rounded-lg bg-[#1E2A47]/5 text-[#1E2A47] hover:bg-[#1E2A47]/10">
                          {copiedId === inv.id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                        </button>
                        <button onClick={() => revoke(inv)} disabled={busyId === inv.id} data-testid={`revoke-${inv.id}`}
                          title="Revoke link"
                          className="p-2 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50">
                          {busyId === inv.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      </>
                    )}
                  </div>
                  {inv.note && (
                    <p className="text-[11px] text-slate-500 mt-1.5 italic">Note: {inv.note}</p>
                  )}
                  {inv.status === "used" && inv.candidate_id && (
                    <p className="text-[11px] text-blue-600 mt-1.5">→ Candidate created. Open the Candidates list to review and assign role.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
