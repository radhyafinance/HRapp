import React, { useState } from "react";
import { RefreshCw, AlertTriangle, Clock, Banknote } from "lucide-react";
import Freshness from "./Freshness";
import DepositPanel, { StateChip } from "./DepositPanel";
import SlipModal from "./SlipModal";

/**
 * The phone view — what a Branch Manager sees at 9pm, standing somewhere.
 *
 * A BM needs one number: how much cash they have to bank. Everything else is
 * supporting detail, so the deposit figure is the only thing rendered large and
 * the collected/UPI split sits under it as explanation.
 *
 * Head Office on a phone gets the same screen with one card per branch, because
 * the alternative — a table squeezed onto 375px — is the thing people give up on
 * and go back to WhatsApp for.
 *
 * The "still rising" line matters more here than on the desktop. This screen
 * will be read during the evening, while officers are still posting, and a BM
 * who deposits against a 19:00 figure will be short.
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

export default function ClosingMobile({
  data, status, loading, onRefresh, refreshing, waitedS, date, onDateChange, canRefresh, isToday,
  onChanged, onBeforeSubmit, onNotice,
}) {
  const branches = data?.branches || [];
  const t = data?.totals || {};
  const warnings = data?.warnings || [];
  const single = branches.length === 1;
  // Money we could not classify is excluded from the deposit figure. When there
  // is only one branch the per-branch cards below are skipped, so without this
  // the BM sees a total that is quietly short with nothing explaining it.
  const unknownTotal = branches.reduce((a, b) => a + (Number(b.unknown) || 0), 0);
  // Recomputed on every render, so it ages with the page instead of freezing
  // at whatever the server said when this screen was opened.
  const ranMinsAgo = minsSince(status && status.last_run_at);
  const stale = ranMinsAgo != null && ranMinsAgo >= 45;
  const lastPost = branches.reduce(
    (a, b) => (b.last_posted_at && b.last_posted_at > a ? b.last_posted_at : a), "");

  return (
    <div className="pb-6">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h1 className="text-xl font-semibold text-slate-900">Daily Closing</h1>
        <button
          onClick={onRefresh}
          disabled={refreshing || !canRefresh}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
          aria-label="Refresh"
          data-testid="closing-refresh-mobile"
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "…" : "Check"}
        </button>
      </div>

      <Freshness updatedAt={data?.updated_at} refreshing={refreshing}
                 waitedS={waitedS} isToday={isToday} />

      <input
        type="date"
        value={date}
        onChange={(e) => onDateChange(e.target.value)}
        className="w-full mb-3 border border-slate-300 rounded-lg px-3 py-2.5 text-base bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none"
        data-testid="closing-date-mobile"
      />

      {/* CARRIED FORWARD, ABOVE THE HERO.
          Cash from earlier days appears in no other figure here — not in today's
          collections, not in today's deposit target — so a branch could carry it
          for days with nobody noticing. It only renders when there IS something
          outstanding; a zero every night trains people to stop reading it. */}
      {t.carried_in > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 mb-3"
             data-testid="closing-carried">
          <div className="text-xs uppercase tracking-wide text-amber-800 font-medium">
            Cash carried forward
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-amber-900">
            {money(t.carried_in)}
          </div>
          <div className="text-sm text-amber-900/80 mt-0.5">
            Not yet banked, from earlier days
            {single && branches[0]?.closing?.carried_in?.from_date
              ? ` — held since ${branches[0].closing.carried_in.from_date}` : ""}
          </div>
          {(t.carried_elsewhere || []).map((e) => (
            <div key={e.branch_code} className="text-sm text-amber-900 mt-0.5">
              {e.branch_name || e.branch_code} {money(e.amount)} — no collections
              reported today
            </div>
          ))}
          {single && branches[0]?.closing?.carried_in?.remark && (
            <div className="mt-1.5 text-sm text-amber-900 border-t border-amber-300/60 pt-1.5">
              “{branches[0].closing.carried_in.remark}”
            </div>
          )}
        </div>
      )}

            {/* The hero number. For a BM this is their branch; for HO it is everything. */}
      <div className="rounded-2xl border border-[#E85B1E]/40 bg-[#E85B1E]/5 p-5 mb-3">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-[#E85B1E] font-medium">
          <Banknote size={14} /> Cash to deposit
        </div>
        <div className="mt-1 text-4xl font-semibold tabular-nums text-[#E85B1E] leading-tight"
             data-testid="closing-hero">
          {loading ? "…" : money(t.expected_deposit)}
        </div>
        <div className="text-sm text-slate-600 mt-1">
          {single ? branches[0].branch_name : `across ${branches.length} branch${branches.length === 1 ? "" : "es"}`}
        </div>
        {/* Labelled rows, not columns. Three figures side by side at 375px
            forces ₹-amounts to wrap mid-number, which is unreadable. */}
        <div className="mt-3 border-t border-[#E85B1E]/20 pt-3 text-sm space-y-1.5">
          <Row label="Demand as per CDS" value={money(t.demand_cds)} muted />
          <Row label="Collected" value={money(t.collected)} />
          {/* No icon on this label: at 11px a lucide glyph reads as a
              missing-character box, i.e. like a rendering fault. */}
          <Row label="UPI — already banked" value={money(t.upi)} muted />
        </div>
        {unknownTotal > 0 && (
          <div className="mt-3 border-t border-[#E85B1E]/20 pt-2.5 text-xs text-amber-800"
               data-testid="closing-unknown-note">
            <strong>{money(unknownTotal)}</strong> was collected in a way this system does not
            recognise, so it is <strong>not</strong> included above. Check with Head Office before
            banking — do not assume it is cash.
          </div>
        )}
      </div>

      {isToday && lastPost && (
        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
          Latest posting <strong>{lastPost.slice(0, 5)}</strong>. Officers post until 21:00–23:00,
          so this can still go up — check again before you bank.
        </p>
      )}

      {stale && (
        <p className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 mb-3 flex items-start gap-1.5">
          <Clock size={13} className="mt-0.5 shrink-0" />
          <span>
            Last checked with the MIS {ranMinsAgo ?? "?"} minutes ago —
            these figures may be out of date.
          </span>
        </p>
      )}

      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 mb-3">
          <div className="flex items-center gap-1.5 font-medium text-amber-900 text-sm mb-1">
            <AlertTriangle size={14} /> Needs a look
          </div>
          <ul className="list-disc pl-4 space-y-1 text-xs text-amber-900">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {!loading && branches.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 text-center text-sm text-slate-500">
          No collections recorded for this day.
          <div className="text-xs text-slate-400 mt-1">Expected on a Sunday or a holiday.</div>
        </div>
      )}

      {/* The BM's actual job for the evening. Only when this is their own single
          branch — Head Office looking at four branches is reviewing, not banking. */}
      {single && onChanged && (
        <div className="mb-3">
          <DepositPanel branch={branches[0]} date={date} onChanged={onChanged}
                        onBeforeSubmit={onBeforeSubmit} onNotice={onNotice} />
        </div>
      )}

      {/* Per-branch cards. Skipped when there is only one, since the hero card
          already IS that branch and repeating it just adds scrolling. */}
      {!single && branches.map((b) => (
        <div key={b.branch_code || b.branch_name}
             className="rounded-xl border border-slate-200 bg-white p-4 mb-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <div className="font-medium text-slate-900 flex items-center gap-2">
              {b.branch_name}
              {b.closing && <StateChip state={b.closing.state} />}
            </div>
            <div className="text-lg font-semibold tabular-nums text-slate-900">
              {money(b.expected_deposit)}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
            <span>Demand (CDS) {money(b.demand_cds)}</span>
            <span>Collected {money(b.collected)}</span>
            <span>UPI {money(b.upi)}</span>
            <span>{b.txn_count} txns</span>
            {b.last_posted_at && <span>last {b.last_posted_at.slice(0, 5)}</span>}
          </div>
          {b.unknown > 0 && (
            <div className="mt-1.5 text-xs text-amber-700">
              {money(b.unknown)} unclassified — excluded from the deposit figure
            </div>
          )}
          {/* What the branch has banked, and the slips behind it. Head Office on
              a handset used to get totals and a status word — no amounts, no
              slips, nothing to approve against. */}
          <BranchDeposit branch={b} />
        </div>
      ))}

      <p className="mt-3 text-[11px] text-slate-400 leading-relaxed">
        This is what the day owes, not proof it was banked.
      </p>
    </div>
  );
}

function Row({ label, value, muted }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={muted ? "text-slate-500 text-xs" : "text-slate-600 text-xs"}>{label}</span>
      <span className={`tabular-nums ${muted ? "text-slate-700" : "font-medium text-slate-900"}`}>
        {value}
      </span>
    </div>
  );
}


/**
 * One branch's banking, on a phone, for somebody who is not that branch.
 *
 * Head Office opening this on a handset used to see a branch name, a figure and
 * a status chip — no amounts banked, no slips, nothing to approve against. The
 * per-branch card is where that belongs, because on a phone there is no table to
 * put it in.
 */
function BranchDeposit({ branch }) {
  const c = branch.closing || {};
  const slips = c.slips || [];
  const led = c.ledger || {};
  // The slip ID, not the slip. Holding the object froze it at click time, so
  // a revision landing while the modal was open left it showing one figure
  // and the row two inches behind it showing another.
  const [showingId, setShowingId] = useState(null);
  const showing = slips.find((x) => x.id === showingId) || null;
  const carried = c.carried_in || {};

  if (!slips.length && !c.cash_counted && !carried.amount) return null;

  return (
    <div className="mt-2 border-t border-slate-100 pt-2 text-xs">
      {carried.amount > 0 && (
        <div className="text-amber-800 mb-1">
          {money(carried.amount)} carried in
          {carried.from_date ? ` from ${carried.from_date}` : ""}
          {carried.remark ? ` — “${carried.remark}”` : ""}
          {/* Both of these are sent by the server and were rendered nowhere. A
              figure Accounts has REFUSED, or one the earlier day has since been
              recounted away from, is not the same as a settled balance. */}
          {carried.disputed && (
            <div className="text-red-700">Accounts returned that day's count — not settled.</div>
          )}
          {carried.recounted_to != null && (
            <div className="text-amber-900">
              That day has since been recounted to {money(carried.recounted_to)}.
            </div>
          )}
        </div>
      )}
      <div className="text-slate-600 tabular-nums">
        {money(led.deposited)} banked
        {c.cash_counted != null && <> · {money(c.cash_counted)} held</>}
        {c.state !== "deposited" && c.state !== "approved" && (
          <span className="text-slate-400"> · in progress</span>
        )}
      </div>
      {c.hold_remark && (
        <div className="text-slate-500 mt-0.5">“{c.hold_remark}”</div>
      )}
      {slips.map((s) => (
        <button key={s.id} onClick={() => setShowingId(s.id)}
                data-testid={`slip-row-${s.id}`}
                className="mt-1.5 w-full text-left rounded border border-slate-200 px-3 py-2.5
                           hover:border-[#E85B1E]">
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
          {/* The desktop rows say this and these did not, so a phone showed
              "Slip Rs 0" with no explanation. */}
          {(s.ocr || {}).status === "reading" && (
            <div className="text-slate-400">being read…</div>
          )}
          {s.status !== "confirmed" && (s.ocr || {}).status !== "reading" && (
            <div className="text-amber-700">not yet confirmed</div>
          )}
        </button>
      ))}
      {showing && <SlipModal slip={showing} onClose={() => setShowingId(null)} />}
    </div>
  );
}
