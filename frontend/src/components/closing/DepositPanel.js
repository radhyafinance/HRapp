import React, { useRef, useState } from "react";
import API from "../../utils/api";
import { Camera, Check, Trash2, AlertTriangle, Loader2, Send } from "lucide-react";

/**
 * What a Branch Manager does at 9pm: photograph the deposit slips, confirm what
 * each one says, count the cash still in the drawer, and submit.
 *
 * THE EXTRACTED AMOUNT IS NEVER COMMITTED ON ITS OWN. Gemini fills the box; the
 * BM has to tap Confirm. That is the primary control, not a formality — these
 * are thermal BC/merchant receipts photographed in bad light, and the sum check
 * against the MIS catches a misread rather than preventing one.
 *
 * A slip the model could not read is still uploadable. The BM is standing at a
 * bank at 9pm; the fallback is typing the number, not going home.
 */

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/**
 * Shrink before upload. A modern phone camera produces 4–8 MB per photo, and
 * these are 2G/3G villages — a full-size upload is the difference between one
 * tap and a BM giving up and using WhatsApp.
 */
async function downscale(file, maxPx = 1600, quality = 0.8) {
  if (file.type === "application/pdf") {
    const buf = await file.arrayBuffer();
    let s = ""; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
    return { b64: btoa(s), mime: "application/pdf" };
  }
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  const dataUrl = c.toDataURL("image/jpeg", quality);
  return { b64: dataUrl.split(",")[1], mime: "image/jpeg" };
}

export default function DepositPanel({ branch, date, onChanged, onBeforeSubmit,
                                       onNotice }) {
  const c = branch.closing || {};
  const slips = c.slips || [];
  const ledger = c.ledger || {};
  const state = c.state || "awaiting";
  const fileRef = useRef(null);

  const [busy, setBusy] = useState("");
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [drafts, setDrafts] = useState({});     // slipId -> typed amount
  const [counted, setCounted] = useState(
    c.cash_counted == null ? "" : String(c.cash_counted));
  // THE TARGET THE MANAGER WAS LOOKING AT WHEN THEY COUNTED.
  //
  // Reading `ledger.should_hold` at click time reads it from live props, and the
  // parent replaces those on every poll — so a change that landed WHILE they
  // counted moved the baseline under the guard, and the comparison then checked
  // the new figure against itself and passed. That is the exact case the guard
  // was written for. Frozen the moment they touch the box.
  const seenTarget = useRef(null);
  const noteTarget = (v) => {
    if (seenTarget.current === null) seenTarget.current = Number(ledger.should_hold) || 0;
    setCounted(v);
  };

  const confirmedTotal = slips
    .filter((s) => s.status === "confirmed")
    .reduce((a, s) => a + (Number(s.amount) || 0), 0);
  const unconfirmed = slips.filter((s) => s.status !== "confirmed");
  const locked = state === "approved";

  const run = async (label, fn) => {
    setBusy(label); setError("");
    try { await fn(); await onChanged(); }
    // e.message matters now: the submit path throws its own Error when the
    // collections moved while the BM was counting, and that sentence is the
    // whole point of stopping. Falling through to "that did not work" would
    // turn the most important message on this screen into a shrug.
    catch (e) {
      setError(e?.response?.data?.detail || e?.message
               || "That did not work. Try again.");
    }
    finally { setBusy(""); setPhase(""); }
  };

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";               // so the same file can be picked twice
    if (!file) return;
    await run("upload", async () => {
      const { b64, mime } = await downscale(file);
      await API.post("/closing/slips", {
        date, branch_code: branch.branch_code, image_b64: b64, mime,
      });
    });
  };

  if (locked) {
    return (
      <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm">
        <div className="font-medium text-emerald-900 flex items-center gap-1.5">
          <Check size={15} /> Approved
        </div>
        <div className="text-emerald-800 mt-1">
          {money(c.ledger?.deposited)} banked · {money(c.cash_counted)} held.
          Confirmed against the bank{c.approved_by ? ` by ${c.approved_by}` : ""}.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h3 className="font-medium text-slate-900">Bank deposit</h3>
        <StateChip state={state} />
      </div>

      {c.reject_reason && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>Returned by Accounts:</strong> {c.reject_reason}
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {note && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
             data-testid="closing-submit-note">
          {note}
        </div>
      )}

      {slips.map((s) => {
        const o = s.ocr || {};
        const draft = drafts[s.id] ?? (s.amount ?? o.amount ?? "");
        const done = s.status === "confirmed";
        return (
          <div key={s.id}
               className={`mb-2 rounded-lg border p-3 ${done ? "border-slate-200 bg-slate-50" : "border-amber-300 bg-amber-50"}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500">
                {s.bank_name || "Slip"}{s.reference_no ? ` · ${s.reference_no}` : ""}
              </div>
              <button onClick={() => run("void" + s.id, () => API.delete(`/closing/slips/${s.id}`))}
                      className="text-slate-400 hover:text-red-600" aria-label="Remove slip">
                <Trash2 size={14} />
              </button>
            </div>

            {o.needs_review && !done && (
              <div className="mt-1 text-xs text-amber-800 flex items-start gap-1">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  {(o.review_reasons || []).length
                    ? `${o.review_reasons.join("; ")}.`
                    : "Check this one."}{" "}
                  Type the amount from the slip.
                </span>
              </div>
            )}

            {done ? (
              <div className="mt-1 flex items-center justify-between">
                <span className="text-lg font-semibold tabular-nums text-slate-900">{money(s.amount)}</span>
                <span className="text-xs text-emerald-700 flex items-center gap-1">
                  <Check size={13} /> confirmed
                </span>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number" inputMode="decimal" placeholder="Amount on the slip"
                  value={draft}
                  onChange={(ev) => setDrafts((d) => ({ ...d, [s.id]: ev.target.value }))}
                  className="flex-1 min-w-0 border border-slate-300 rounded-lg px-3 py-2 text-base tabular-nums outline-none focus:ring-2 focus:ring-[#E85B1E]"
                />
                <button
                  disabled={!draft || busy}
                  onClick={() => run("confirm" + s.id, () =>
                    API.patch(`/closing/slips/${s.id}`, { amount: Number(draft) }))}
                  className="rounded-lg bg-[#E85B1E] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* No `capture` attribute, deliberately. It forces the camera on Android
          Chrome and can hide the gallery entirely — and slips routinely arrive
          by WhatsApp rather than being photographed here, so the BM must be able
          to pick an existing image. Without `capture` the picker still offers
          the camera; with it, half the real sources are unreachable. */}
      <input ref={fileRef} type="file" accept="image/*,application/pdf"
             onChange={onPick} className="hidden"
             data-testid="slip-file" />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={!!busy}
        className="w-full mb-3 inline-flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 px-4 py-3 text-sm font-medium text-slate-600 disabled:opacity-50"
        data-testid="slip-add"
      >
        {busy === "upload"
          ? <><Loader2 size={16} className="animate-spin" /> Reading the slip…</>
          : <><Camera size={16} /> Add a deposit slip — photo or from WhatsApp</>}
      </button>

      <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1">
        <L label="Cash collected today" value={money(ledger.cash_collected)} />
        {Number(ledger.opening_hold) > 0 && (
          <L label="Brought forward" value={money(ledger.opening_hold)} />
        )}
        <L label="Deposited (confirmed slips)" value={money(confirmedTotal)} />
        <div className="border-t border-slate-200 pt-1 mt-1">
          <L label="Should still be in hand" value={money(ledger.should_hold)} strong />
        </div>
      </div>

      <div className="mt-3">
        <label className="text-xs text-slate-600">Cash you are actually holding</label>
        <input
          type="number" inputMode="decimal" placeholder="Count it and enter the amount"
          value={counted} onChange={(e) => noteTarget(e.target.value)}
          className="w-full mt-1 border border-slate-300 rounded-lg px-3 py-2.5 text-base tabular-nums outline-none focus:ring-2 focus:ring-[#E85B1E]"
          data-testid="cash-counted"
        />
        {counted !== "" && (
          <Difference counted={Number(counted)} should={Number(ledger.should_hold) || 0} />
        )}
      </div>

      <button
        disabled={!!busy || counted === "" || unconfirmed.length > 0}
        onClick={() => run("submit", async () => {
          // Check for late collections BEFORE recording anything.
          //
          // An officer posting at 21:44 while the manager counts at 21:40 is not
          // an edge case — Rs 27,354 of cash landed against 14-Aug three days
          // after that day closed. Filing against the older figure produces a
          // shortfall that surfaces days later with nobody able to explain it.
          const was = seenTarget.current ?? (Number(ledger.should_hold) || 0);
          setPhase("checking");
          const r = onBeforeSubmit ? await onBeforeSubmit() : { status: "fresh" };

          const checked = r.day && (r.status === "delivered" || r.status === "fresh");
          let couldNotCheck = !checked;
          if (checked) {
            const row = (r.day.branches || []).find(
              (b) => b.branch_code === branch.branch_code);
            const now = Number(row?.closing?.ledger?.should_hold);
            // No row for this branch, or an unusable figure, is NOT a pass. The
            // MIS dropping a branch from the report is a documented failure
            // mode, and it used to skip the comparison silently and set no note
            // either way — a check that did not happen, indistinguishable from
            // one that did.
            if (!row || !Number.isFinite(now)) {
              couldNotCheck = true;
            } else if (Math.abs(now - was) >= 0.01) {
              // Stop and show it. Submitting silently against a number that just
              // moved is the failure the pull was for.
              throw new Error(
                `Collections changed while you were counting: you should now be ` +
                `holding ${money(now)}, not ${money(was)}. ` +
                `Check your cash and press Send again.`);
            }
          }

          setPhase("sending");
          await API.post("/closing/submit", {
            date, branch_code: branch.branch_code, cash_counted: Number(counted),
          });

          // WE SUBMIT ANYWAY WHEN THE CHECK COULD NOT BE MADE, and say so.
          //
          // The alternative is refusing, and a manager standing at a bank at
          // 21:50 who cannot submit has no fallback at all — whereas one who
          // submits a figure that later moves is covered by the drift warning
          // Accounts sees. But it must not pass unremarked: an unmentioned
          // failed check is indistinguishable from a check that passed.
          const say = onNotice || setNote;
          say(couldNotCheck
            ? "Sent — but we could not check for late collections just now, so this "
              + "is against the figures already on screen. Check the day before banking."
            : "");
        })}
        className="w-full mt-3 inline-flex items-center justify-center gap-2 rounded-lg bg-[#181831] px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
        data-testid="closing-submit"
      >
        {busy === "submit"
          // Not "Sending…" while it is only WAITING. The wait can run to a
          // couple of minutes, and a label that claims a send has happened when
          // nothing has left the phone is the wrong thing to show someone
          // standing at a bank.
          ? <><Loader2 size={16} className="animate-spin" />{" "}
              {phase === "checking" ? "Checking for late collections…" : "Sending…"}</>
          : <><Send size={15} /> {state === "deposited" ? "Update and resend" : "Send to Accounts"}</>}
      </button>
      {unconfirmed.length > 0 && (
        <p className="mt-1.5 text-xs text-amber-700 text-center">
          {unconfirmed.length} slip{unconfirmed.length === 1 ? "" : "s"} still need
          {unconfirmed.length === 1 ? "s" : ""} an amount confirmed.
        </p>
      )}
      {state === "deposited" && (
        <p className="mt-1.5 text-xs text-slate-500 text-center">
          Sent. Accounts will confirm it against the bank tomorrow.
        </p>
      )}
    </div>
  );
}

function Difference({ counted, should }) {
  const diff = Math.round((counted - should) * 100) / 100;
  if (diff === 0) {
    return <p className="mt-1.5 text-xs text-emerald-700">Matches exactly.</p>;
  }
  return (
    <p className="mt-1.5 text-xs text-amber-800">
      {diff > 0 ? `${money(diff)} MORE than expected` : `${money(-diff)} SHORT`} —
      you can still send this, but say what happened to Accounts.
    </p>
  );
}

function L({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-600 text-xs">{label}</span>
      <span className={`tabular-nums ${strong ? "font-semibold text-slate-900" : "text-slate-800"}`}>
        {value}
      </span>
    </div>
  );
}

export function StateChip({ state }) {
  const map = {
    awaiting: ["Not sent", "bg-slate-100 text-slate-600 border-slate-200"],
    deposited: ["With Accounts", "bg-amber-50 text-amber-800 border-amber-300"],
    approved: ["Approved", "bg-emerald-50 text-emerald-800 border-emerald-300"],
  };
  const [label, cls] = map[state] || map.awaiting;
  return <span className={`text-xs px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}
