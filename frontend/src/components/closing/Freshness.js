import React, { useEffect, useState } from "react";
import { Clock } from "lucide-react";

/**
 * "Updated 3 minutes ago", in the words a branch manager would use.
 *
 * Shown to everyone, unlike the health strip, which is admin-only. The person
 * standing at a bank at 21:00 deciding whether to trust a deposit target is the
 * one who most needs to know how old it is — and under the on-demand design
 * there is no clock keeping it fresh behind their back.
 */
export default function Freshness({ updatedAt, refreshing, waitedS, isToday }) {
  // Re-render on a timer so "2 minutes ago" does not sit there saying "just now"
  // for half an hour. This is a display tick, not a fetch.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  if (refreshing) {
    return (
      <div className="mb-3 text-sm text-slate-500 flex items-center gap-1.5"
           data-testid="closing-freshness">
        <Clock size={14} className="animate-pulse" />
        Checking the MIS for late collections…
        {waitedS > 6 && (
          // The fetcher runs on a best-effort schedule, so this can take a
          // couple of minutes on a bad evening. A wait somebody can see is a
          // different experience from one they cannot.
          <span className="text-slate-400">
            {waitedS}s{waitedS > 70 ? " — still waiting for the fetcher" : ""}
          </span>
        )}
      </div>
    );
  }
  if (!updatedAt) {
    return (
      <div className="mb-3 text-sm text-slate-500 flex items-center gap-1.5"
           data-testid="closing-freshness">
        <Clock size={14} />
        {isToday ? "Not fetched yet today." : "No fetch recorded for this day."}
      </div>
    );
  }

  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) {
    // Garbage in, honesty out. This used to render "Updated Invalid Date." in
    // calm grey, which reads as reassurance.
    return (
      <div className="mb-3 text-sm text-amber-700 flex items-center gap-1.5"
           data-testid="closing-freshness">
        <Clock size={14} /> Cannot tell how old these figures are. Press Check for updates.
      </div>
    );
  }
  const rawMins = Math.round((Date.now() - t) / 60000);
  // A timestamp in the FUTURE means this handset's clock is wrong — common in
  // the field. Clamping it to zero rendered an hours-old figure as "just now",
  // in grey, with the "check before banking" nudge suppressed. Say so instead.
  if (rawMins < -2) {
    return (
      <div className="mb-3 text-sm text-amber-700 flex items-center gap-1.5"
           data-testid="closing-freshness">
        <Clock size={14} /> This phone's clock looks wrong, so the age of these
        figures cannot be trusted. Press Check for updates before banking.
      </div>
    );
  }
  const mins = Math.max(0, rawMins);
  const when =
    mins < 1 ? "just now"
    : mins === 1 ? "1 minute ago"
    : mins < 60 ? `${mins} minutes ago`
    // Past a day, the bare clock time is a trap: "Updated 09:19 pm" reads as
    // tonight. Carry the date once it is not today.
    : new Date(t).toLocaleString("en-IN",
        mins < 20 * 60
          ? { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }
          : { timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
              hour: "2-digit", minute: "2-digit", hour12: true });

  // An hour old during the evening is worth flagging: that is when the figure
  // moves, and a stale one is what puts the wrong amount in a deposit slip.
  const old = mins >= 60;
  return (
    <div className={`mb-3 text-sm flex items-center gap-1.5 ${old ? "text-amber-700" : "text-slate-500"}`}
         data-testid="closing-freshness">
      <Clock size={14} />
      Updated {when}.
      {old && " Press Check for updates before banking."}
    </div>
  );
}
