import React, { useState } from "react";
import { RefreshCw, AlertTriangle, Building2, Clock, Check, X } from "lucide-react";
import API from "../../utils/api";
import { StateChip } from "./DepositPanel";

/**
 * Head Office view of the day's collections.
 *
 * This screen answers ONE question: how much cash does each branch owe the bank
 * tonight. It deliberately does not claim the day is closed — it cannot know
 * whether the money reached a bank, only what was collected.
 *
 * Two things are shown that a prettier dashboard would hide:
 *
 *  - HOW STALE THE NUMBER IS. The figures come from a poller against the MIS. If
 *    that poller dies, every number here keeps rendering perfectly while being
 *    hours out of date, which is worse than an empty screen. The freshness strip
 *    is not decoration.
 *  - THAT THE DAY IS STILL MOVING. Collections post until 21:00–23:00. A figure
 *    read at 19:00 is not final, and saying so is the entire reason this exists.
 */

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

export default function ClosingDesktop({
  data, status, loading, onRefresh, refreshing, date, onDateChange, canRefresh, isToday,
  onChanged,
}) {
  const branches = data?.branches || [];
  const t = data?.totals || {};
  const warnings = data?.warnings || [];

  // A poller that has not run for a while is the failure this screen must not
  // hide. 45 minutes is well past the 15-minute daytime cadence.
  const stale = status && status.minutes_since_last_run != null && status.minutes_since_last_run >= 45;
  const lastPost = branches.reduce(
    (a, b) => (b.last_posted_at && b.last_posted_at > a ? b.last_posted_at : a), "");

  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Daily Closing</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            What each branch collected, and the cash it owes the bank.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none"
            data-testid="closing-date"
          />
          {canRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-lg bg-[#E85B1E] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              data-testid="closing-refresh"
            >
              <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Fetching…" : "Refresh now"}
            </button>
          )}
        </div>
      </div>

      {status && (
        <div
          className={`mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-4 py-2.5 text-sm ${
            stale
              ? "border-amber-300 bg-amber-50 text-amber-900"
              : "border-slate-200 bg-slate-50 text-slate-600"
          }`}
          data-testid="closing-health"
        >
          <span className="inline-flex items-center gap-1.5">
            <Clock size={14} />
            {status.last_run_at
              ? <>Checked the MIS {status.minutes_since_last_run ?? "?"} min ago</>
              : <>The MIS poller has never run</>}
          </span>
          {status.last_change_at && (
            <span className="text-slate-500">
              {/* Pinned to IST. Without timeZone this rendered in the viewer's
                  own zone while every other time on the page is IST. */}
              Figures last changed {new Date(status.last_change_at).toLocaleTimeString("en-IN",
                { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
            </span>
          )}
          {stale && <strong>These numbers may be out of date.</strong>}
          {status.last_run_ok === false && status.last_run_detail && (
            <span className="text-amber-900">Last attempt failed: {status.last_run_detail}</span>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid="closing-warnings">
          <div className="flex items-center gap-2 font-medium text-amber-900 mb-1.5">
            <AlertTriangle size={16} /> Needs a look
          </div>
          <ul className="list-disc pl-5 space-y-1 text-sm text-amber-900">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Demand as per CDS" value={money(t.demand_cds)} sub="What was due today" />
        <Stat label="Collected" value={money(t.collected)} sub={`${branches.length} branch${branches.length === 1 ? "" : "es"}`} />
        <Stat label="UPI — already in a bank" value={money(t.upi)} sub="Not to be deposited" />
        <Stat
          label="Cash to deposit"
          value={money(t.expected_deposit)}
          sub="What the slips must add up to"
          emphasis
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <Th className="text-left">Branch</Th>
                <Th>Demand (CDS)</Th>
                <Th>Collected</Th>
                <Th>UPI</Th>
                <Th>Cash to deposit</Th>
                <Th>Txns</Th>
                <Th>Last</Th>
                <Th className="text-left">Banked</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && branches.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    No collections recorded for this day.
                    <div className="text-xs text-slate-400 mt-1">
                      Expected on a Sunday or a holiday. On a working day, check the poller above.
                    </div>
                  </td>
                </tr>
              )}
              {branches.map((b) => (
                <tr key={b.branch_code || b.branch_name} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 size={15} className="text-slate-400" />
                      <span className="font-medium text-slate-900">{b.branch_name}</span>
                      {b.branch_code && <span className="text-xs text-slate-400">{b.branch_code}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{money(b.demand_cds)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(b.collected)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{money(b.upi)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-900">
                    {money(b.expected_deposit)}
                    {b.unknown > 0 && (
                      <div className="text-xs font-normal text-amber-700">
                        {money(b.unknown)} unclassified, excluded
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{b.txn_count}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                    {b.last_posted_at ? b.last_posted_at.slice(0, 5) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <BankedCell branch={b} date={date} canApprove={data?.can_approve}
                                onChanged={onChanged} />
                  </td>
                </tr>
              ))}
            </tbody>
            {branches.length > 0 && (
              <tfoot className="bg-slate-50 font-semibold text-slate-900">
                <tr>
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(t.demand_cds)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(t.collected)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(t.upi)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(t.expected_deposit)}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-500 leading-relaxed max-w-3xl">
        This is what the day <strong>owes</strong>, not proof it was banked — deposit slips are
        matched separately.
        {isToday && lastPost && (
          <> The latest posting so far is <strong>{lastPost.slice(0, 5)}</strong>; officers
          post until 21:00–23:00, so today's figures can still rise.</>
        )}
      </p>
    </div>
  );
}

/**
 * The slips themselves, for whoever is approving.
 *
 * Approving means "I have seen this money in the bank", and the person doing it
 * has to be able to see WHAT the branch says it banked — the amounts, the bank,
 * the reference number, and the actual photograph. Approving against a total
 * alone is a rubber stamp, and with no bank feed this is the only control there
 * is.
 *
 * Images load only when opened. There are up to four branches on screen with
 * several slips each, and nobody needs a few megabytes of receipts fetched to
 * read a table.
 */
function SlipViewer({ slips }) {
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState({});
  if (!slips.length) return null;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    for (const s of slips) {
      if (images[s.id]) continue;
      try {
        const r = await API.get(`/closing/slips/${s.id}/image`);
        setImages((m) => ({ ...m, [s.id]: `data:${r.data.mime};base64,${r.data.image_b64}` }));
      } catch {
        setImages((m) => ({ ...m, [s.id]: "error" }));
      }
    }
  };

  return (
    <div className="mt-1">
      <button onClick={toggle} className="text-slate-500 underline underline-offset-2"
              data-testid="slip-viewer-toggle">
        {open ? "Hide" : `View ${slips.length} slip${slips.length === 1 ? "" : "s"}`}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2">
          {slips.map((s) => (
            <div key={s.id} className="rounded border border-slate-200 bg-white p-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-500">
                  {s.bank_name || "Slip"}{s.reference_no ? ` · ${s.reference_no}` : ""}
                </span>
                <span className="tabular-nums font-medium text-slate-900">{money(s.amount)}</span>
              </div>
              {/* Flagged when the human changed what the model read. An approver
                  should know which figures were corrected by hand. */}
              {s.amount_was_corrected && (
                <div className="text-amber-700">amount corrected by the branch</div>
              )}
              {images[s.id] === "error" && <div className="text-red-600">image unavailable</div>}
              {images[s.id] && images[s.id] !== "error" && (
                <a href={images[s.id]} target="_blank" rel="noreferrer">
                  <img src={images[s.id]} alt="Deposit slip"
                       className="mt-1 w-full max-h-40 object-contain bg-slate-50 rounded" />
                </a>
              )}
              {!images[s.id] && <div className="text-slate-400 mt-1">loading…</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The Accounts Manager's whole job, per branch.
 *
 * Approving means "I have seen this money in the account". With no bank feed
 * this is the ONLY control that the cash arrived, so the button deliberately
 * shows what was banked and what is still held rather than being a bare tick —
 * approving without those two numbers in view is a rubber stamp.
 */
function BankedCell({ branch, date, canApprove, onChanged }) {
  const c = branch.closing || {};
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");

  const act = async (path, body) => {
    setBusy(true); setErr("");
    try {
      await API.post(`/closing/${path}`, { date, branch_code: branch.branch_code, ...body });
      setRejecting(false); setReason("");
      if (onChanged) await onChanged();
    } catch (e) {
      setErr(e?.response?.data?.detail || "That did not work.");
    } finally { setBusy(false); }
  };

  if (c.state === "approved") {
    return (
      <div className="text-xs text-emerald-700">
        <StateChip state="approved" />
        <div className="mt-1 tabular-nums">{money(c.ledger?.deposited)} banked</div>
        <SlipViewer slips={c.slips || []} />
      </div>
    );
  }
  if (c.state !== "deposited") {
    return (
      <div className="text-xs text-slate-400">
        <StateChip state={c.state || "awaiting"} />
        {c.reject_reason && <div className="mt-1 text-red-600">returned</div>}
      </div>
    );
  }

  const led = c.ledger || {};
  return (
    <div className="text-xs">
      <div className="tabular-nums text-slate-700">
        {money(led.deposited)} banked · {money(c.cash_counted)} held
      </div>
      <SlipViewer slips={c.slips || []} />
      {led.balanced === false && (
        // Words, not a minus sign. "₹-2,680 vs expected" puts the whole meaning
        // on one character, on the screen where the direction matters most.
        <div className="text-amber-700 tabular-nums">
          {led.difference < 0
            ? `${money(-led.difference)} SHORT`
            : `${money(led.difference)} more than expected`}
        </div>
      )}
      {err && <div className="text-red-600 mt-1">{err}</div>}
      {canApprove && !rejecting && (
        <div className="flex gap-1.5 mt-1.5">
          <button disabled={busy} onClick={() => act("approve")}
                  className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-white disabled:opacity-50"
                  data-testid={`approve-${branch.branch_code}`}>
            <Check size={12} /> Approve
          </button>
          <button disabled={busy} onClick={() => setRejecting(true)}
                  className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-slate-600">
            <X size={12} /> Return
          </button>
        </div>
      )}
      {canApprove && rejecting && (
        <div className="mt-1.5 flex flex-col gap-1">
          <input value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="What is wrong?" autoFocus
                 className="border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-[#E85B1E]" />
          <div className="flex gap-1.5">
            <button disabled={busy || !reason.trim()} onClick={() => act("reject", { reason })}
                    className="rounded bg-red-600 px-2 py-1 text-white disabled:opacity-50">
              Send back
            </button>
            <button onClick={() => { setRejecting(false); setReason(""); }}
                    className="rounded border border-slate-300 px-2 py-1 text-slate-600">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, emphasis }) {
  return (
    <div className={`rounded-xl border p-4 ${emphasis ? "border-[#E85B1E]/40 bg-[#E85B1E]/5" : "border-slate-200 bg-white"}`}>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${emphasis ? "text-[#E85B1E]" : "text-slate-900"}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

const Th = ({ children, className = "text-right" }) => (
  <th className={`px-4 py-2.5 font-medium ${className}`}>{children}</th>
);
