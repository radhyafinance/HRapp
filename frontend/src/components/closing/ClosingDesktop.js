import React, { useState } from "react";
import { RefreshCw, AlertTriangle, Building2, Clock, Check, X } from "lucide-react";
import Freshness from "./Freshness";
import API from "../../utils/api";
import DepositPanel, { StateChip } from "./DepositPanel";
import SlipModal from "./SlipModal";
import SpecialPanel, { SpecialNote } from "./SpecialPanel";

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

/**
 * Minutes since an ISO timestamp, computed HERE rather than taken from the
 * server's own arithmetic.
 *
 * `minutes_since_last_run` is correct at the moment the response is built and
 * then frozen: a screen left open at 16:49 kept saying "checked 2 min ago" while
 * the freshness line above it, which recomputes, climbed past four. Two numbers
 * measuring the same instant, disagreeing on screen, is how an evening gets
 * spent doubting a pipeline that was working.
 */
function minsSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

export default function ClosingDesktop({
  data, status, loading, onRefresh, refreshing, waitedS, date, onDateChange, canRefresh, isToday,
  onChanged, onBeforeSubmit, onNotice, isAdmin,
}) {
  const branches = data?.branches || [];
  const t = data?.totals || {};
  const warnings = data?.warnings || [];
  // Filing a closing is the branch's job, reviewing it is Head Office's. See
  // the same line in ClosingMobile: counting branches conflated the two, so an
  // admin opening a day where one branch had reported was handed that branch's
  // deposit panel.
  const canAct = branches.length === 1 && !isAdmin && !data?.can_approve && !!onChanged;

  // WHAT HAS REACHED A BANK, AND WHAT HAS NOT.
  //
  // Summed from the SAME ledger objects the rows above render, never recomputed
  // from the raw figures. A footer that does its own arithmetic is a second
  // source of truth, and this screen has already had one of those: the carried
  // box summing a live recount while the ledger under it showed the frozen
  // figure, ₹15,000 apart with nothing to say which was right. An approved day
  // keeps its frozen ledger, so this total stays equal to what is on screen.
  //
  // `should_hold` is opening + collected − deposited, so cash carried from
  // EARLIER days is already inside it. That is deliberate: a branch quietly
  // holding ₹50,000 from last Monday is the thing this figure exists to expose.
  const totalBanked = branches.reduce(
    (a, b) => a + (Number(b.closing?.ledger?.deposited) || 0), 0);
  // Branches with cash in hand and no row in today's report contribute nothing
  // to the loop above — they have no row to loop over — so they are added from
  // the same list the carried-forward box names them in.
  const elsewhere = (t.carried_elsewhere || []).reduce(
    (a, e) => a + (Number(e.amount) || 0), 0);
  const totalOutstanding = branches.reduce(
    (a, b) => a + (Number(b.closing?.ledger?.should_hold) || 0), 0) + elsewhere;

  // A poller that has not run for a while is the failure this screen must not
  // hide. 45 minutes is well past the 15-minute daytime cadence.
  // Recomputed on every render, so it ages with the page instead of freezing
  // at whatever the server said when this screen was opened.
  const ranMinsAgo = minsSince(status && status.last_run_at);
  const stale = ranMinsAgo != null && ranMinsAgo >= 45;
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
              {refreshing ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
      </div>

      {/* Freshness, for everybody — not only the admins who can see the health
          strip. The manager at 21:00 is the person who most needs to know
          whether this figure is four minutes or four hours old. */}
      <Freshness updatedAt={data?.updated_at} refreshing={refreshing}
                 waitedS={waitedS} isToday={isToday} />

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
              ? <>Checked the MIS {ranMinsAgo ?? "?"} min ago</>
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        {/* FIRST, deliberately. Cash carried from earlier days appears in no
            other figure on this screen — not in today's collections, not in
            today's deposit target — so a branch can carry it for days with
            nobody at Head Office noticing. It is the number that was missing. */}
        <Stat
          label="Cash carried forward"
          value={money(t.carried_in)}
          sub={t.carried_in ? "Not yet banked, from earlier days" : "Nothing outstanding"}
          warn={Boolean(t.carried_in)}
        >
          {/* Branches with a hold and NO ROW in the table below. The server sends
              them separately precisely so this can name them — a headline figure
              with part of it traceable nowhere on the page is worse than no
              headline at all. */}
          {(t.carried_elsewhere || []).map((e) => (
            <div key={e.branch_code} className="text-xs text-amber-900 mt-1">
              {e.branch_name || e.branch_code || "unnamed branch"} {money(e.amount)}
              <span className="text-amber-800/70"> — no collections reported today</span>
            </div>
          ))}
        </Stat>
        <Stat label="Demand as per CDS" value={money(t.demand_cds)} sub="What was due today" />
        <Stat label="Collected" value={money(t.collected)} sub={`${branches.length} branch${branches.length === 1 ? "" : "es"}`} />
        <Stat label="UPI — already in a bank" value={money(t.upi)} sub="Not to be deposited" />
        <Stat
          label="Cash to deposit"
          value={money(t.expected_deposit)}
          sub="What the slips must add up to"
          emphasis
        >
          {/* Why this is lower than Collected. Without it the figure just
              looks wrong, and a BM who cannot explain a number stops
              trusting the screen that shows it. */}
          <SpecialNote totals={t} />
        </Stat>
      </div>

      {(isAdmin || data?.can_approve) && (
        <SpecialPanel date={date} onChanged={onChanged} />
      )}

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
                  {/* The two figures the day is actually judged on, and the only
                      place they were not shown. The Banked column carried a
                      per-branch amount with no total under it, and the amount
                      still owed to a bank appeared nowhere at all. */}
                  <td className="px-4 py-3" data-testid="closing-footer-banked">
                    <div className="tabular-nums text-slate-900">
                      {money(totalBanked)}{" "}
                      <span className="text-xs font-normal text-slate-500">banked</span>
                    </div>
                    <div className="tabular-nums text-amber-800 mt-0.5"
                         data-testid="closing-footer-outstanding">
                      {money(totalOutstanding)}{" "}
                      <span className="text-xs font-normal text-amber-700">
                        still to deposit
                      </span>
                    </div>
                    {elsewhere > 0 && (
                      <div className="text-xs font-normal text-amber-700 mt-0.5">
                        includes {money(elsewhere)} at branches with no collections today
                      </div>
                    )}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* THE BM'S OWN JOB, ON THIS LAYOUT TOO.
          It used to exist only in the mobile layout, and the split is by
          VIEWPORT WIDTH — so a 375x812 handset turned sideways is 812px wide and
          became "desktop": the deposit panel vanished mid-count and the typed
          cash was lost. A manager on a laptop had no way to file a closing at
          all. */}
      {canAct && (
        <div className="mt-5 max-w-xl">
          <DepositPanel branch={branches[0]} date={date} onChanged={onChanged}
                        onBeforeSubmit={onBeforeSubmit} onNotice={onNotice} />
        </div>
      )}

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
  // The slip ID, not the slip. Holding the object froze it at click time, so
  // a revision landing while the modal was open left it showing one figure
  // and the row two inches behind it showing another.
  const [showingId, setShowingId] = useState(null);
  const showing = slips.find((x) => x.id === showingId) || null;
  if (!slips.length) return null;

  return (
    <div className="mt-1">
      <button onClick={() => setOpen(!open)} className="text-slate-500 underline underline-offset-2"
              data-testid="slip-viewer-toggle">
        {open ? "Hide" : `View ${slips.length} slip${slips.length === 1 ? "" : "s"}`}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {slips.map((s) => (
            // The whole row opens the slip. Thumbnails used to load inline for
            // every slip at once, which fetched several megabytes of receipts to
            // read a table — and were too small to check a figure against anyway.
            <button key={s.id} onClick={() => setShowingId(s.id)}
                    data-testid={`slip-row-${s.id}`}
                    className="w-full text-left rounded border border-slate-200 bg-white
                               px-2 py-1.5 hover:border-[#E85B1E] hover:bg-orange-50/40">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-slate-500">
                  {s.bank_name || "Slip"}{s.reference_no ? ` · ${s.reference_no}` : ""}
                </span>
                <span className="tabular-nums font-medium text-slate-900">
                  {s.status === "confirmed" && s.amount != null ? money(s.amount) : "—"}
                </span>
              </div>
              {s.amount_was_corrected && (
                <div className="text-amber-700">amount corrected by the branch</div>
              )}
              {s.remark && <div className="text-slate-500 truncate">“{s.remark}”</div>}
              {(s.ocr || {}).status === "reading" && (
                <div className="text-slate-400">being read…</div>
              )}
              {s.status !== "confirmed" && (s.ocr || {}).status !== "reading" && (
                <div className="text-amber-700">not yet confirmed</div>
              )}
            </button>
          ))}
        </div>
      )}
      {showing && <SlipModal slip={showing} onClose={() => setShowingId(null)} />}
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
        {/* The amount, at the size of an amount. This whole cell inherits
            text-xs, so the one figure the column exists to show — what the
            branch actually banked — was rendered smaller than the branch name
            beside it. */}
        <div className="mt-1 text-sm font-semibold tabular-nums text-emerald-800">
          {money(c.ledger?.deposited)}{" "}
          <span className="text-xs font-normal text-emerald-700">banked</span>
        </div>
        <SlipViewer slips={c.slips || []} />
      </div>
    );
  }
  if (c.state !== "deposited") {
    // A DAY STILL OPEN IS NOT A BLANK DAY.
    //
    // This used to return the chip and nothing else, so while a branch manager
    // was photographing and confirming slips, Head Office saw a status word and
    // no figures at all — everything appeared only after Send. A confirmed slip
    // is a fact, and there is no reason to withhold it. It is labelled as still
    // in progress so a partial set is not mistaken for a finished one.
    const led = c.ledger || {};
    return (
      <div className="text-xs text-slate-500">
        <StateChip state={c.state || "awaiting"} />
        {c.reject_reason && <div className="mt-1 text-red-600">returned</div>}
        {(c.slips || []).length > 0 && (
          <>
            <div className="mt-1 text-sm font-semibold tabular-nums text-slate-800">
              {money(led.deposited)}{" "}
              <span className="text-xs font-normal text-slate-500">banked so far</span>
            </div>
            <div className="text-slate-400">in progress — not yet sent</div>
            <SlipViewer slips={c.slips || []} />
          </>
        )}
      </div>
    );
  }

  const led = c.ledger || {};
  return (
    <div className="text-xs">
      {/* The row an approver decides on. Both figures were 12px grey; the
          decision is about the amounts, so the amounts are what carry weight. */}
      <div className="tabular-nums">
        <span className="text-sm font-semibold text-slate-900">{money(led.deposited)}</span>
        <span className="text-xs text-slate-500"> banked</span>
        <span className="text-xs text-slate-400"> · </span>
        <span className="text-sm font-semibold text-slate-900">{money(c.cash_counted)}</span>
        <span className="text-xs text-slate-500"> held</span>
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

function Stat({ label, value, sub, emphasis, warn, children }) {
  const box = warn ? "border-amber-300 bg-amber-50"
            : emphasis ? "border-[#E85B1E]/40 bg-[#E85B1E]/5"
            : "border-slate-200 bg-white";
  const fig = warn ? "text-amber-900" : emphasis ? "text-[#E85B1E]" : "text-slate-900";
  return (
    <div className={`rounded-xl border p-4 ${box}`}>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${fig}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
      {children}
    </div>
  );
}

const Th = ({ children, className = "text-right" }) => (
  <th className={`px-4 py-2.5 font-medium ${className}`}>{children}</th>
);
