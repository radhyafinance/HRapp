import React, { useState } from "react";
import { Layers } from "lucide-react";

/**
 * Small badge that, on a record with multiple sessions, shows "N sessions" and
 * expands a popover listing each session's in/out/hours. For single-session
 * records (the common case), renders nothing.
 */
export function SessionsBadge({ record }) {
  const sessions = record?.sessions || [];
  const [open, setOpen] = useState(false);
  if (sessions.length < 2) return null;

  return (
    <span className="relative inline-block ml-1.5" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        onMouseEnter={() => setOpen(true)}
        data-testid={`sessions-badge-${record?.id || record?.date}`}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-violet-100 text-violet-700 border border-violet-200 hover:bg-violet-200 transition-colors"
      >
        <Layers size={9} />
        {sessions.length} sessions
      </button>
      {open && (
        <div className="absolute z-30 left-1/2 -translate-x-1/2 top-full mt-1.5 bg-white border border-slate-200 shadow-xl rounded-lg p-2.5 min-w-[200px] text-left">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
            Sessions on {record.date}
          </p>
          <div className="space-y-1">
            {sessions.map((s, i) => (
              <div key={i} className="text-[11px] text-slate-700 flex items-center gap-1.5">
                <span className="font-mono text-violet-600 font-semibold w-4">#{i + 1}</span>
                <span>
                  {s.punch_in_time
                    ? new Date(s.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
                    : "--:--"}
                </span>
                <span className="text-slate-400">→</span>
                {s.punch_out_time ? (
                  <>
                    <span>{new Date(s.punch_out_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-semibold text-slate-700">{(s.hours_worked || 0).toFixed(2)}h</span>
                  </>
                ) : (
                  <span className="italic text-amber-600">open</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

export default SessionsBadge;
