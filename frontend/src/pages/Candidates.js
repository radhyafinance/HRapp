import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { UserPlus, Search, CalendarClock, Undo2, Link2 } from "lucide-react";
import { AddCandidateModal } from "../components/candidates/AddCandidateModal";
import { CandidateDetailModal } from "../components/candidates/CandidateDetailModal";
import { ScheduleInterviewModal } from "../components/candidates/ScheduleInterviewModal";
import { CandidateInvitesModal } from "../components/candidates/CandidateInvitesModal";

const STATUS_COLORS = { pending: "bg-amber-100 text-amber-700", selected: "bg-green-100 text-green-700", rejected: "bg-red-100 text-red-700", converted: "bg-blue-100 text-blue-700" };

export default function Candidates() {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showDetail, setShowDetail] = useState(null);
  const [scheduleFor, setScheduleFor] = useState(null);
  const [invitesOpen, setInvitesOpen] = useState(false);

  const fetchCandidates = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search) params.search = search;
      const res = await API.get("/candidates", { params });
      setCandidates(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchCandidates(); }, [search, statusFilter]);

  const handleStatusUpdate = async (candId, status, extra = {}) => {
    try {
      await API.put(`/candidates/${candId}`, { status, ...extra });
      fetchCandidates();
      if (showDetail?.id === candId) setShowDetail({ ...showDetail, status, ...extra });
    } catch (e) { alert(e.response?.data?.detail || "Update failed"); }
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Candidate Management</h1>
          <p className="text-slate-500 text-sm">{candidates.length} candidates</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setInvitesOpen(true)} data-testid="invite-link-btn"
            className="flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors">
            <Link2 size={16} /> Invite Links
          </button>
          <button onClick={() => setShowAdd(true)} data-testid="add-candidate-btn"
            className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
            <UserPlus size={16} /> Add Candidate
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search candidates..."
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="selected">Selected</option>
          <option value="rejected">Rejected</option>
          <option value="converted">Converted</option>
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="candidates-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Name", "Mobile", "Aadhaar", "PAN", "Position", "Department", "Interview", "Status", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : candidates.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-400">No candidates found</td></tr>
                : candidates.map(c => (
                  <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{c.first_name} {c.last_name}</p>
                      <p className="text-xs text-slate-400">{c.email || "-"}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.mobile}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-600">{c.aadhaar_number ? `XXXX-XXXX-${c.aadhaar_number.slice(-4)}` : "-"}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-600">{c.pan_number || "-"}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.position}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.department}</td>
                    <td className="px-4 py-3 text-xs">
                      {c.interview_date ? (
                        <div>
                          <p className="font-medium text-slate-700">{c.interview_date}{c.interview_time && ` ${c.interview_time}`}</p>
                          {c.meet_link && <a href={c.meet_link} target="_blank" rel="noopener noreferrer" className="text-[#E85B1E] hover:underline truncate inline-block max-w-[140px]">Meet link</a>}
                        </div>
                      ) : <span className="text-slate-300">Not scheduled</span>}
                    </td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[c.status] || "bg-slate-100 text-slate-700"}`}>{c.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <button onClick={() => setShowDetail(c)} data-testid={`view-cand-${c.id}`} className="text-xs px-2 py-1 bg-[#1E2A47]/10 text-[#1E2A47] rounded-lg hover:bg-[#1E2A47]/20">View</button>
                        <button onClick={() => setScheduleFor(c)} data-testid={`schedule-cand-${c.id}`} className="flex items-center gap-1 text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200">
                          <CalendarClock size={12} /> {c.interview_date ? "Reschedule" : "Schedule"}
                        </button>
                        {c.status === "pending" && (
                          <>
                            <button onClick={() => handleStatusUpdate(c.id, "selected")} data-testid={`select-cand-${c.id}`} className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-lg hover:bg-green-200">Select</button>
                            <button onClick={() => handleStatusUpdate(c.id, "rejected", { rejection_reason: "Not suitable" })} data-testid={`reject-cand-${c.id}`} className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded-lg hover:bg-red-200">Reject</button>
                          </>
                        )}
                        {(c.status === "selected" || c.status === "rejected") && (
                          <button onClick={() => handleStatusUpdate(c.id, "pending", { rejection_reason: "" })} data-testid={`undo-cand-${c.id}`}
                            className="flex items-center gap-1 text-xs px-2 py-1 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200" title={`Undo ${c.status}`}>
                            <Undo2 size={12} /> Undo
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && <AddCandidateModal onClose={() => setShowAdd(false)} onAdded={fetchCandidates} />}

      {showDetail && (
        <CandidateDetailModal
          candidate={showDetail}
          onClose={() => setShowDetail(null)}
          onSchedule={(c) => { setShowDetail(null); setScheduleFor(c); }}
        />
      )}

      {scheduleFor && (
        <ScheduleInterviewModal
          candidate={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onSaved={(updated) => {
            setScheduleFor(null);
            setCandidates((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
          }}
        />
      )}

      {invitesOpen && (
        <CandidateInvitesModal
          onClose={() => setInvitesOpen(false)}
          onCandidateCreated={fetchCandidates}
        />
      )}
    </div>
  );
}
