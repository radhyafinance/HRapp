import React, { useCallback, useEffect, useState } from "react";
import API from "../../utils/api";
import { AlertTriangle, Check, HeartPulse, Landmark } from "lucide-react";

/**
 * Collections that may not be the branch's cash to bank.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The MIS report carries a loan `status`, and two values of it mean the money in
 * the "collected" column may never have passed through a branch manager's hands:
 *
 *   deathclose  the borrower died and the insurer settles the outstanding
 *               principal. It appears exactly like a collection. Nobody at the
 *               branch touched it.
 *   preclosed   either the borrower really did pay the loan off in cash, to the
 *               BM — or the balance was netted off against a new loan and
 *               nothing moved at all. The workbook cannot tell these apart.
 *
 * Across July that was Rs 5,55,190 of Rs 64,43,918 — 8.6% — on 20 of 69
 * branch-days. On 31-Jul NAJIBABAD was told to bank Rs 1,86,410 of which
 * Rs 94,940 was a preclosure; on 20-Jul CHANDPUR's entire Rs 42,033 was this.
 *
 * WHY HEAD OFFICE ANSWERS AND NOT THE BRANCH
 * ------------------------------------------
 * Marking a collection "netted off" REDUCES what a branch has to walk into a
 * bank. That control cannot sit with the person holding the cash — the same
 * reason a BM confirms their own deposit slips but never approves them.
 *
 * A field officer's collection is never asked about. If an officer keyed it, the
 * cash is in a drawer whatever the loan's status has since become.
 */

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

export default function SpecialPanel({ date, onChanged, compact }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await API.get(`/closing/special?date=${date}`);
      setData(r.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load preclosures.");
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const decide = async (item, nettedCount) => {
    setBusy(item.key + item.branch_code); setErr("");
    try {
      await API.post("/closing/special/decide", {
        date: item.date, branch_code: item.branch_code, key: item.key,
        netted_count: nettedCount, count: item.count,
      });
      await load();
      // The deposit target moves the moment this is answered, so the whole day
      // has to be re-read — not just this panel.
      if (onChanged) await onChanged();
    } catch (e) {
      setErr(e?.response?.data?.detail || "That did not save.");
    } finally { setBusy(""); }
  };

  if (!data) return null;
  const items = data.items || [];
  const pending = items.filter((i) => i.resolution === "pending");
  const settled = items.filter((i) => i.resolution === "decided" || i.resolution === "insurance");
  // A field-posted row needs no decision and no explanation; showing it would
  // pad this list with rows nobody has to act on.
  if (!pending.length && !settled.length) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 mb-3"
         data-testid="special-panel">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle size={15} className="text-amber-600" />
        <h3 className="font-medium text-slate-900">Not necessarily the branch's cash</h3>
      </div>
      <p className="text-xs text-slate-500 mb-3 max-w-2xl">
        Preclosures and death settlements are held out of the deposit target until
        they are settled here. A day cannot be approved while anything is still waiting.
      </p>

      {err && <div className="mb-2 text-sm text-red-600">{err}</div>}

      {pending.length > 0 && (
        <div className="mb-3">
          <div className="text-xs uppercase tracking-wide text-amber-700 font-medium mb-1.5">
            Waiting on Head Office — {money(pending.reduce((a, i) => a + i.total, 0))}
          </div>
          <div className="flex flex-col gap-2">
            {pending.map((i) => (
              <div key={i.branch_code + i.key}
                   data-testid={`special-pending-${i.branch_code}`}
                   className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-sm text-amber-900">
                    <strong className="tabular-nums">{money(i.amount)}</strong>
                    {i.count > 1 && <> × {i.count}</>}
                    {" — "}{i.branch_name || i.branch_code}
                    <span className="text-amber-800/70"> · preclosed at {i.time}</span>
                  </div>
                  {i.count === 1 ? (
                    <div className="flex gap-2">
                      <button disabled={!!busy} onClick={() => decide(i, 1)}
                              data-testid={`netted-${i.branch_code}`}
                              className="rounded-lg border border-amber-400 bg-white px-3 py-1.5
                                         text-sm text-amber-900 disabled:opacity-50">
                        Netted off a new loan
                      </button>
                      <button disabled={!!busy} onClick={() => decide(i, 0)}
                              data-testid={`was-cash-${i.branch_code}`}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600
                                         px-3 py-1.5 text-sm text-white disabled:opacity-50">
                        <Check size={14} /> Cash, paid to the BM
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-amber-900">
                      {/* Identical postings are interchangeable: which of the two
                          was netted has no consequence, only how many. */}
                      <span>How many were netted off?</span>
                      {Array.from({ length: i.count + 1 }, (_, n) => (
                        <button key={n} disabled={!!busy} onClick={() => decide(i, n)}
                                className="rounded-lg border border-amber-400 bg-white
                                           w-9 h-9 text-sm disabled:opacity-50">
                          {n}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {i.reopened_from != null && (
                  <div className="mt-1 text-xs text-amber-800">
                    This was answered when there {i.reopened_from === 1 ? "was 1 posting" :
                      `were ${i.reopened_from} postings`}; the MIS now reports {i.count}.
                    Please answer it again.
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!compact && settled.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1.5">
            Settled
          </div>
          <div className="flex flex-col gap-1">
            {settled.map((i) => (
              <div key={i.branch_code + i.key}
                   className="flex flex-wrap items-baseline gap-2 text-xs text-slate-600">
                {i.resolution === "insurance"
                  ? <HeartPulse size={13} className="text-slate-400 shrink-0" />
                  : <Landmark size={13} className="text-slate-400 shrink-0" />}
                <span className="tabular-nums font-medium text-slate-800">
                  {money(i.total)}
                </span>
                <span>{i.branch_name || i.branch_code}</span>
                <span className="text-slate-400">·</span>
                <span>
                  {i.resolution === "insurance"
                    ? "settled by the insurer — never branch cash"
                    : i.netted_count === 0
                      ? "cash, paid to the branch"
                      : i.netted_count === i.count
                        ? "netted off against a new loan"
                        : `${i.netted_count} of ${i.count} netted off`}
                </span>
                {i.decided_by && <span className="text-slate-400">— {i.decided_by}</span>}
                {i.note && <span className="text-slate-500">“{i.note}”</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The one line a branch manager needs: why the figure is lower than the
 * collections above it. Rendered on both layouts.
 */
export function SpecialNote({ totals }) {
  const s = (totals || {}).special || {};
  const excluded = Number(s.excluded) || 0;
  if (excluded <= 0) return null;
  const parts = [];
  if (s.insurance > 0) parts.push(`${money(s.insurance)} settled by an insurer`);
  if (s.netted > 0) parts.push(`${money(s.netted)} netted off against new loans`);
  if (s.pending > 0) parts.push(`${money(s.pending)} awaiting Head Office`);
  return (
    <div className="mt-3 border-t border-[#E85B1E]/20 pt-2.5 text-xs text-amber-800"
         data-testid="special-note">
      <strong>{money(excluded)}</strong> of today's collections is <strong>not</strong> yours
      to bank — {parts.join(", ")}. It is already excluded from the figure above.
    </div>
  );
}
