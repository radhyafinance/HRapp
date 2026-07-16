import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { CheckCircle2, XCircle, Loader2, User } from "lucide-react";

/**
 * Public ID-card verification — what the QR on an employee card opens.
 *
 * Anyone (a bank, a borrower, the police) lands here by scanning; there is no
 * login. Uses raw axios rather than the shared API client on purpose: that
 * client force-redirects to /login on a 401, which must never happen here.
 *
 * The route is /verify/:token and is exempt from the Android web block in
 * PlatformGate — do not rename the path without updating PUBLIC_PREFIXES there.
 */
const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const STATUS_TEXT = {
  active: "Active employee",
  probation: "Active employee (probation)",
  notice_period: "Active employee (serving notice)",
  exited: "No longer employed",
  absconding: "No longer employed",
  terminated: "No longer employed",
  invalid: "Not a valid ID",
};

function todayLabel() {
  return new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function VerifyEmployee() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    axios
      .get(`${API}/public/verify/${token}`)
      .then((r) => alive && setState({ loading: false, data: r.data }))
      .catch((e) =>
        alive &&
        setState({
          loading: false,
          error:
            e.response?.status === 429
              ? "Too many checks from this network. Please wait a minute and try again."
              : "Could not reach the verification service. Check your connection and try again.",
        })
      );
    return () => { alive = false; };
  }, [token]);

  return (
    <div className="min-h-screen bg-[#12122a] flex items-start justify-center p-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-5">
          <div className="text-white font-bold tracking-[0.2em] text-sm">RADHYA</div>
          <div className="text-slate-400 text-[10px] tracking-[0.15em] uppercase mt-0.5">
            Micro Finance Private Limited
          </div>
        </div>

        <div className="bg-white rounded-2xl overflow-hidden shadow-2xl">
          {state.loading && (
            <div className="p-10 flex flex-col items-center gap-3 text-slate-500">
              <Loader2 size={26} className="animate-spin" />
              <span className="text-sm">Checking this ID…</span>
            </div>
          )}

          {!state.loading && state.error && (
            <div className="p-8 text-center">
              <p className="text-sm text-slate-700">{state.error}</p>
            </div>
          )}

          {!state.loading && state.data && <Result d={state.data} token={token} />}
        </div>

        <p className="text-center text-slate-500 text-[10px] mt-5 leading-relaxed">
          This page reads the employee's live status from the Radhya HR system.
        </p>
      </div>
    </div>
  );
}

function Result({ d, token }) {
  const valid = !!d.valid;
  const statusText = STATUS_TEXT[d.status] || STATUS_TEXT.invalid;

  return (
    <>
      <div className={`px-6 py-7 text-center text-white ${valid ? "bg-gradient-to-b from-[#12a15b] to-[#0c7a44]" : "bg-gradient-to-b from-[#e5483b] to-[#b52f24]"}`}>
        <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-3">
          {valid ? <CheckCircle2 size={30} /> : <XCircle size={30} />}
        </div>
        <h1 className="text-lg font-bold uppercase tracking-wide" data-testid="verify-headline">
          {valid ? "Identity Verified" : "ID Not Valid"}
        </h1>
        <p className="text-xs opacity-90 mt-1">
          {valid ? "This is a genuine, active employee ID." : "This person is no longer an employee."}
        </p>
      </div>

      <div className="p-5">
        {d.name && (
          <div className="flex items-center gap-3">
            <div className={`w-14 h-14 rounded-full bg-slate-100 border-2 border-slate-200 flex items-center justify-center overflow-hidden flex-shrink-0 ${valid ? "" : "grayscale opacity-80"}`}>
              {valid && d.has_photo ? (
                <img src={`${API}/public/verify/${token}/photo`} alt="" className="w-full h-full object-cover" />
              ) : (
                <User size={26} className="text-slate-400" />
              )}
            </div>
            <div className="min-w-0">
              <div className="font-bold uppercase text-[#181831] leading-tight truncate">{d.name}</div>
              {d.designation && (
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mt-0.5 truncate">
                  {d.designation}
                </div>
              )}
            </div>
          </div>
        )}

        <div className={`${d.name ? "mt-4 border-t border-slate-100 pt-4" : ""} space-y-2.5`}>
          {d.employee_id && (
            <Row k="Employee ID" v={<span className="font-mono">{d.employee_id}</span>} />
          )}
          <Row
            k="Status"
            v={
              <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ${valid ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${valid ? "bg-green-600" : "bg-red-600"}`} />
                {statusText}
              </span>
            }
          />
          {valid && <Row k="Verified on" v={todayLabel()} />}
        </div>

        {!valid && (
          <div className="mt-4 text-[11px] leading-relaxed text-[#8a3b34] bg-[#fdeceb] border border-[#f6d3cf] rounded-lg p-3 font-semibold">
            Do not accept this card as proof of employment. Please report misuse to
            {" "}
            <a href="mailto:mail@radhyafinance.com" className="underline">mail@radhyafinance.com</a>.
          </div>
        )}

        <div className="mt-4 text-center text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400">
          Radhya Micro Finance Private Limited
        </div>
      </div>
    </>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="text-slate-500 font-bold uppercase tracking-wider">{k}</span>
      <span className="text-[#181831] font-bold text-right">{v}</span>
    </div>
  );
}
