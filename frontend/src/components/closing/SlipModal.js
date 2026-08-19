import React, { useEffect, useState } from "react";
import API from "../../utils/api";
import { X, AlertTriangle, Loader2 } from "lucide-react";

/**
 * One deposit slip, full size.
 *
 * The image is fetched only when the modal opens. A branch can photograph five
 * or six slips an evening and Head Office may have five branches on screen —
 * loading every image with the day would pull several megabytes of receipts
 * nobody has asked to look at.
 *
 * Two things are shown that a plainer viewer would leave out:
 *
 *  - WHETHER THE BRANCH CORRECTED THE MACHINE. Gemini reads the amount and the
 *    BM confirms it. An approver's first question about a figure is whether a
 *    human agreed with what was read or overrode it, and by how much.
 *  - THE BRANCH'S OWN NOTE, written when the amount was confirmed and fixed from
 *    that moment. A note added after seeing the totals is a different kind of
 *    statement, and the record should not blur them.
 */

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

export default function SlipModal({ slip, onClose }) {
  const [img, setImg] = useState(null);      // null loading | "error" | data url
  const o = slip?.ocr || {};
  const confirmed = slip?.status === "confirmed" && slip?.amount != null;
  const reading = o.status === "reading";
  const read = o.amount;

  useEffect(() => {
    if (!slip) return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await API.get(`/closing/slips/${slip.id}/image`);
        if (!alive) return;
        setImg(r.data?.image_b64
          ? `data:${r.data.mime || "image/jpeg"};base64,${r.data.image_b64}`
          : "error");
      } catch {
        if (alive) setImg("error");
      }
    })();
    return () => { alive = false; };
  }, [slip]);

  // Escape closes. A modal over a photograph on a phone is easy to get stuck in.
  useEffect(() => {
    const on = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  if (!slip) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3"
         onClick={onClose} data-testid="slip-modal">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white flex items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            {/* AN UNCONFIRMED SLIP HAS NO AMOUNT, and rendering one as Rs 0 was a
                lie about a photograph of real money. Head Office can now see
                slips before the branch has confirmed them, so this is the common
                case rather than an edge one. */}
            {confirmed ? (
              <div className="text-lg font-semibold tabular-nums text-slate-900">
                {money(slip.amount)}
              </div>
            ) : (
              <div>
                <div className="text-lg font-semibold tabular-nums text-slate-500">
                  {reading ? "Being read…"
                   : read != null ? `${money(read)} (read, not confirmed)`
                   : "Amount not confirmed"}
                </div>
                <div className="text-xs text-amber-700">
                  The branch has not confirmed this slip yet.
                </div>
              </div>
            )}
            <div className="text-xs text-slate-500">
              {slip.bank_name || "Bank not recorded"}
              {slip.reference_no ? ` · ${slip.reference_no}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"
                  aria-label="Close" data-testid="slip-modal-close">
            <X size={18} />
          </button>
        </div>

        <div className="p-4">
          {slip.amount_was_corrected && (
            <div className="mb-3 flex items-start gap-1.5 rounded-lg border border-amber-300
                            bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                The branch corrected this amount
                {o.amount != null && <> — the slip was read as {money(o.amount)}</>}.
              </span>
            </div>
          )}

          {slip.remark && (
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">
                Branch note
              </div>
              <div className="text-slate-800">{slip.remark}</div>
            </div>
          )}

          {img === null && (
            <div className="flex items-center gap-2 py-10 justify-center text-slate-400 text-sm">
              <Loader2 size={16} className="animate-spin" /> Loading the slip…
            </div>
          )}
          {img === "error" && (
            <div className="py-10 text-center text-sm text-red-700">
              The image could not be loaded.
              {confirmed
                ? " The amount above is still the figure that counts — it was"
                  + " confirmed by the branch."
                : " This slip has no confirmed amount yet, so there is nothing"
                  + " here to check against."}
            </div>
          )}
          {img && img !== "error" && (
            slip.mime === "application/pdf"
              ? <iframe title="slip" src={img} className="w-full h-[70vh] rounded-lg border" />
              : <img src={img} alt="Deposit slip" className="w-full rounded-lg border" />
          )}
        </div>
      </div>
    </div>
  );
}
