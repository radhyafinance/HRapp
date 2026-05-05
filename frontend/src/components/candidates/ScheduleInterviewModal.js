import React, { useEffect, useState } from "react";
import { AlertCircle, Copy, Send, Mail, X } from "lucide-react";
import { Modal } from "../shared/Modal";
import API from "../../utils/api";

const STATUS_COLORS = { pending: "bg-amber-100 text-amber-700", selected: "bg-green-100 text-green-700", rejected: "bg-red-100 text-red-700", converted: "bg-blue-100 text-blue-700" };

function buildInviteMessage({ first_name, last_name, position, interview_date, interview_time, interviewer_names, meet_link }) {
  const fullName = `${first_name || ""} ${last_name || ""}`.trim();
  const lines = [
    `Hello ${fullName || "Candidate"},`,
    "",
    `You are invited to an interview at Radhya Micro Finance for the role of ${position || "the open position"}.`,
    "",
    `Date: ${interview_date || "TBD"}`,
    `Time: ${interview_time || "TBD"} (IST)`,
  ];
  if (interviewer_names) lines.push(`Interviewer(s): ${interviewer_names}`);
  if (meet_link) {
    lines.push("");
    lines.push(`Google Meet link: ${meet_link}`);
    lines.push("Please join 5 minutes before the scheduled time.");
  }
  lines.push("", "Please confirm your availability by replying to this message.", "", "Regards,", "HR Team — Radhya Micro Finance");
  return lines.join("\n");
}

export function ScheduleInterviewModal({ candidate, onClose, onSaved }) {
  const [date, setDate] = useState(candidate.interview_date || "");
  const [time, setTime] = useState(candidate.interview_time || "");
  const [interviewerIds, setInterviewerIds] = useState(candidate.interviewer_ids || []);
  const [meetLink, setMeetLink] = useState(candidate.meet_link || "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  // Interviewer pool
  const [options, setOptions] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await API.get("/candidates/interviewers/options");
        setOptions(res.data || []);
      } catch (e) { /* quiet */ }
    })();
  }, []);

  const lookup = Object.fromEntries(options.map(o => [o.employee_id, o]));
  const selectedNames = interviewerIds.map(id => lookup[id]?.name || id).join(", ");
  const filtered = options.filter(o => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return true;
    return o.name.toLowerCase().includes(q) || o.employee_id.toLowerCase().includes(q) || (o.designation || "").toLowerCase().includes(q);
  });
  const toggle = (id) => setInterviewerIds(arr => arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]);
  const remove = (id) => setInterviewerIds(arr => arr.filter(x => x !== id));

  const message = buildInviteMessage({
    first_name: candidate.first_name, last_name: candidate.last_name, position: candidate.position,
    interview_date: date, interview_time: time, interviewer_names: selectedNames, meet_link: meetLink,
  });
  const cleanedMobile = (candidate.mobile || "").replace(/\D/g, "");
  const waNumber = cleanedMobile.length === 10 ? `91${cleanedMobile}` : cleanedMobile;
  const waUrl = waNumber ? `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}` : null;
  const subject = `Interview invitation — Radhya Micro Finance (${candidate.position || ""})`;
  const mailto = candidate.email ? `mailto:${candidate.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}` : null;

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const res = await API.put(`/candidates/${candidate.id}`, {
        interview_date: date || "",
        interview_time: time || "",
        interviewer_ids: interviewerIds,
        meet_link: meetLink || "",
      });
      onSaved(res.data);
    } catch (e) {
      setErr(e.response?.data?.detail || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setErr("Could not copy. Select the text and copy manually.");
    }
  };

  return (
    <Modal title="Schedule Interview" onClose={onClose}>
      <div className="space-y-5">
        <div className="bg-slate-50 p-3 rounded-lg flex items-center justify-between">
          <div>
            <p className="font-bold text-[#1E2A47] text-sm">{candidate.first_name} {candidate.last_name}</p>
            <p className="text-xs text-slate-500">{candidate.position} • {candidate.department}</p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_COLORS[candidate.status]}`}>{candidate.status}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="schedule-date" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Time</label>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} data-testid="schedule-time" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          </div>
          <div className="col-span-2 relative">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Interviewer(s) <span className="text-slate-400 font-normal">— pick from managers / management / HR</span>
            </label>
            {interviewerIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {interviewerIds.map(id => (
                  <span key={id} data-testid={`schedule-interviewer-chip-${id}`}
                    className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 bg-[#E85B1E]/10 border border-[#E85B1E]/30 text-[#E85B1E] rounded-full text-xs font-medium">
                    {lookup[id]?.name || id}
                    <button type="button" onClick={() => remove(id)}
                      className="rounded-full hover:bg-[#E85B1E]/20 p-0.5"><X size={10} /></button>
                  </span>
                ))}
              </div>
            )}
            <button type="button" onClick={() => setPickerOpen(o => !o)}
              data-testid="schedule-interviewer-picker-toggle"
              className="w-full text-left border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white hover:border-[#E85B1E]">
              <span className="text-slate-500">
                {interviewerIds.length
                  ? `${interviewerIds.length} interviewer${interviewerIds.length > 1 ? "s" : ""} selected — click to add/remove`
                  : "Select interviewers..."}
              </span>
            </button>
            {pickerOpen && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-72 overflow-hidden flex flex-col"
                data-testid="schedule-interviewer-list">
                <input autoFocus value={pickerSearch} onChange={e => setPickerSearch(e.target.value)}
                  placeholder="Search by name, ID or designation..."
                  className="m-2 px-3 py-2 border border-slate-200 rounded-md text-xs focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                <div className="overflow-y-auto flex-1 border-t border-slate-100">
                  {filtered.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-4">No matches</p>
                  ) : filtered.map(o => {
                    const checked = interviewerIds.includes(o.employee_id);
                    return (
                      <label key={o.employee_id} data-testid={`schedule-interviewer-option-${o.employee_id}`}
                        className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50 ${checked ? "bg-orange-50" : ""}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggle(o.employee_id)}
                          className="rounded border-slate-300 text-[#E85B1E] focus:ring-[#E85B1E]" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-700 truncate">{o.name}</p>
                          <p className="text-[11px] text-slate-500"><span className="font-mono text-[#E85B1E]">{o.employee_id}</span> · {o.designation || "—"} · {o.role}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1">Google Meet Link <span className="text-slate-400 font-normal">(create one in Google Calendar and paste here)</span></label>
            <input type="url" value={meetLink} onChange={e => setMeetLink(e.target.value)} placeholder="https://meet.google.com/..." className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="schedule-meet-link" />
            <p className="text-[10px] text-slate-500 mt-1">
              Tip: open <a className="text-[#E85B1E] hover:underline" href="https://calendar.google.com/calendar/u/0/r/eventedit" target="_blank" rel="noopener noreferrer">Google Calendar → New Event → Add Google Meet</a>, then copy-paste the link here.
            </p>
          </div>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex items-start gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
          </div>
        )}

        <div className="border-t pt-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Invitation message preview</p>
          <pre data-testid="invite-preview" className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 whitespace-pre-wrap font-sans max-h-40 overflow-y-auto">{message}</pre>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={copyMessage} data-testid="copy-invite-btn" className="flex items-center justify-center gap-1 px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-200">
            <Copy size={12} /> {copied ? "Copied!" : "Copy"}
          </button>
          <a href={waUrl || "#"} onClick={(e) => { if (!waUrl) { e.preventDefault(); alert("Mobile number is missing."); } }} target="_blank" rel="noopener noreferrer" data-testid="whatsapp-share-btn"
            className={`flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold ${waUrl ? "bg-green-500 text-white hover:bg-green-600" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}>
            <Send size={12} /> WhatsApp
          </a>
          <a href={mailto || "#"} onClick={(e) => { if (!mailto) { e.preventDefault(); alert("Email is missing."); } }} data-testid="email-share-btn"
            className={`flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold ${mailto ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}>
            <Mail size={12} /> Email
          </a>
        </div>

        <div className="flex gap-3 pt-2 border-t">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Close</button>
          <button type="button" onClick={save} disabled={saving} data-testid="save-schedule-btn" className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
            {saving ? "Saving..." : "Save Interview"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
