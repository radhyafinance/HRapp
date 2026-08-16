import React, { useCallback, useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import ClosingDesktop from "../components/closing/ClosingDesktop";
import ClosingMobile from "../components/closing/ClosingMobile";

/**
 * Daily cash closing.
 *
 * Splits by VIEWPORT WIDTH, not by native-vs-browser. Head Office opening this
 * on a phone wants the phone layout, and a Branch Manager who happens to be at a
 * desktop wants the table — the deciding factor is the screen, not the wrapper.
 *
 * Auto-refreshes during the evening because that is when the number is actually
 * moving: officers post until 21:00–23:00, so a screen left open at 19:30 would
 * otherwise show a figure that quietly went stale while someone read it.
 */

const MOBILE_Q = "(max-width: 767px)";

function useIsMobile() {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(MOBILE_Q).matches
      : false
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_Q);
    const on = (e) => setM(e.matches);
    // Safari before 14 has no addEventListener on MediaQueryList, and some of
    // the handsets in the field are old enough to matter.
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", on);
      else mq.removeListener(on);
    };
  }, []);
  return m;
}

/** Today in IST, as YYYY-MM-DD — the basis the backend files collections under. */
function todayIST() {
  const s = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return s; // en-CA gives ISO order
}

export default function DailyClosing() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const isAdmin = ["hr_admin", "management"].includes(user?.role);

  const [date, setDate] = useState(todayIST);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const isToday = date === todayIST();

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError("");
    try {
      const res = await API.get(`/closing/day?date=${date}`);
      setData(res.data);
    } catch (e) {
      // A failed poll must not blank a figure that was on screen a second ago —
      // an empty table reads as "nothing was collected", which is a different
      // and much more alarming claim than "we could not reach the server".
      setError(e?.response?.data?.detail || "Could not load the day's collections.");
    } finally {
      setLoading(false);
    }
    if (isAdmin) {
      try {
        const st = await API.get("/closing/status");
        setStatus(st.data);
      } catch { /* the health strip is optional; the figures are not */ }
    }
  }, [date, isAdmin]);

  useEffect(() => { load(); }, [load]);

  // Keep today's screen live through the evening window, quietly.
  useEffect(() => {
    if (!isToday) return undefined;
    const t = setInterval(() => {
      const h = Number(new Date().toLocaleString("en-GB",
        { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
      // Only while collections are actually landing. Polling all night would
      // wake a phone for a number that cannot change.
      if (h >= 8 && h <= 23) load(false);
    }, 3 * 60 * 1000);
    return () => clearInterval(t);
  }, [isToday, load]);

  const onRefresh = async () => {
    // Everyone gets the spinner. It used to be set only for admins, so a branch
    // manager's tap looked like nothing had happened at all.
    setRefreshing(true);
    setError("");
    try {
      // Only Head Office may make the server go and hit the MIS; a manager's
      // refresh re-reads what the poller already stored. The backend enforces
      // this too — this is not the security boundary, just the correct call.
      if (isAdmin) await API.post(`/closing/refresh?date=${date}`);
      await load(false);
    } catch (e) {
      setError(e?.response?.data?.detail || "The MIS fetch failed.");
    } finally {
      setRefreshing(false);
    }
  };

  const props = {
    data, status, loading, refreshing, date, isToday,
    onRefresh,
    onDateChange: setDate,
    canRefresh: true,
    // Re-reads after a slip, a submission or an approval. Passed down rather
    // than each panel refetching itself, so one action refreshes one screen.
    onChanged: () => load(false),
  };

  return (
    <div className={isMobile ? "px-1" : ""}>
      {error && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800"
             data-testid="closing-error">
          {error}
        </div>
      )}
      {isMobile ? <ClosingMobile {...props} /> : <ClosingDesktop {...props} />}
    </div>
  );
}
