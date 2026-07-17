import React, { useCallback, useEffect, useMemo, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import {
  AlertTriangle, Award, CheckCircle2, ClipboardList, Eye, FileText, Play,
  Save, Users, X,
} from "lucide-react";

const HALVES = [
  { half: "H2", label: "H2 — Oct to Mar (reviewed in April)" },
  { half: "H1", label: "H1 — Apr to Sep (reviewed in October)" },
];

const GRADE_STYLE = {
  "A+": "bg-green-100 text-green-700",
  "A": "bg-emerald-100 text-emerald-700",
  "B+": "bg-blue-100 text-blue-700",
  "B": "bg-amber-100 text-amber-700",
  "C": "bg-red-100 text-red-700",
};

const STATUS_STYLE = {
  pending_self: "bg-amber-100 text-amber-700",
  pending_manager: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
};
const STATUS_LABEL = {
  pending_self: "Awaiting self-assessment",
  pending_manager: "Awaiting manager",
  completed: "Completed",
};

function Modal({ title, subtitle, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${wide ? "max-w-5xl" : "max-w-2xl"} max-h-[92vh] overflow-y-auto`}>
        <div className="flex items-start justify-between p-5 border-b sticky top-0 bg-white z-10">
          <div>
            <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Badge({ className, children }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${className}`}>{children}</span>;
}

export default function Performance() {
  const { user } = useAuth();
  const isAdmin = ["hr_admin", "management"].includes(user?.role);

  const [tab, setTab] = useState("my");
  const [mine, setMine] = useState([]);
  const [team, setTeam] = useState([]);
  const [all, setAll] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [period, setPeriod] = useState("");
  const [open, setOpen] = useState(null);
  const [showCycle, setShowCycle] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, t] = await Promise.all([
        API.get("/performance/my").catch(() => ({ data: [] })),
        API.get("/performance/to-review").catch(() => ({ data: [] })),
      ]);
      setMine(m.data || []);
      setTeam(t.data || []);
      if (isAdmin) {
        const [c, a] = await Promise.all([
          API.get("/performance/cycles").catch(() => ({ data: [] })),
          API.get("/performance", { params: period ? { period } : {} }).catch(() => ({ data: [] })),
        ]);
        setCycles(c.data || []);
        setAll(a.data || []);
      }
    } finally {
      setLoading(false);
    }
  }, [isAdmin, period]);

  useEffect(() => { load(); }, [load]);

  // Land on whichever tab actually has something waiting on this person.
  const [tabPicked, setTabPicked] = useState(false);
  useEffect(() => {
    if (loading || tabPicked) return;
    if (mine.some(r => r.status === "pending_self")) setTab("my");
    else if (team.some(r => r.status === "pending_manager")) setTab("team");
    else if (isAdmin) setTab("all");
    setTabPicked(true);
  }, [loading, mine, team, isAdmin, tabPicked]);

  const tabs = useMemo(() => {
    const t = [["my", "My Review", ClipboardList, mine.filter(r => r.status === "pending_self").length]];
    if (team.length) t.push(["team", "My Team", Users, team.filter(r => r.status === "pending_manager").length]);
    if (isAdmin) t.push(["all", "All Reviews", FileText, 0]);
    return t;
  }, [mine, team, isAdmin]);

  const rows = tab === "my" ? mine : tab === "team" ? team : all;

  const openReview = async (r) => {
    try {
      const res = await API.get(`/performance/${r.id}`);
      setOpen(res.data);
    } catch (e) {
      alert(e.response?.data?.detail || "Could not open this review");
    }
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Performance
          </h1>
          <p className="text-slate-500 text-sm">
            Half-yearly appraisal. Your reporting manager's score sets the grade.
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <select value={period} onChange={e => setPeriod(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
              <option value="">All periods</option>
              {cycles.map(c => <option key={c.period} value={c.period}>{c.label}</option>)}
            </select>
            <button onClick={() => setShowCycle(true)} data-testid="open-cycle-btn"
              className="flex items-center gap-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E]">
              <Play size={14} /> Open a Cycle
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {tabs.map(([k, label, Icon, count]) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`perf-tab-${k}`}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              tab === k ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            <Icon size={15} /> {label}
            {count > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${tab === k ? "bg-[#E85B1E] text-white" : "bg-slate-200 text-slate-600"}`}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-slate-400 text-sm py-10 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-400 shadow-sm">
          <Award size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {tab === "my" ? "No appraisal for you yet. HR opens these each half-year."
              : tab === "team" ? "Nothing waiting on you."
              : "No reviews yet. Open a cycle to create them."}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="performance-table">
              <thead><tr className="bg-slate-50 border-b">
                {(tab === "my" ? ["Period", "Form", "Status", "Score", "Grade", ""]
                               : ["Employee", "Period", "Status", "Score", "Grade", ""]).map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                    {tab === "my" ? (
                      <td className="px-4 py-3 text-sm font-medium text-[#0F172A]">{r.label}</td>
                    ) : (
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-[#0F172A]">{r.employee_name}</p>
                        <p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p>
                      </td>
                    )}
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {tab === "my" ? r.template_name : r.label}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <Badge className={STATUS_STYLE[r.status] || "bg-slate-100 text-slate-600"}>
                          {STATUS_LABEL[r.status] || r.status}
                        </Badge>
                        {r.eligibility === "pro_rata" && (
                          <Badge className="bg-purple-100 text-purple-700">Pro-rata</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">
                      {r.manager_total != null
                        ? <span className="font-bold">{r.manager_total}<span className="text-slate-400 font-normal">/100</span></span>
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {r.grade
                        ? <Badge className={GRADE_STYLE[r.grade] || "bg-slate-100 text-slate-600"}>{r.grade} · {r.grade_level}</Badge>
                        : <span className="text-slate-400 text-sm">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => openReview(r)} data-testid={`open-review-${r.id}`}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" title="Open">
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCycle && <CycleModal onClose={() => setShowCycle(false)} onDone={() => { setShowCycle(false); load(); }} />}
      {open && (
        <ReviewModal review={open} user={user} isAdmin={isAdmin}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); load(); }} />
      )}
    </div>
  );
}

/* ── Opening a cycle ────────────────────────────────────────────────────────
   Preview first, always. It writes nothing, and it is the only chance to catch a
   missing template or a wrong designation before any forms exist.            */
function CycleModal({ onClose, onDone }) {
  const [half, setHalf] = useState("H2");
  const [year, setYear] = useState(new Date().getFullYear() - 1);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setPreview(null);
    try {
      const res = await API.post("/performance/cycles/preview", { half, year: Number(year) });
      setPreview(res.data);
    } catch (e) {
      alert(e.response?.data?.detail || "Preview failed");
    } finally { setBusy(false); }
  };

  const create = async () => {
    if (!window.confirm(
      `Create ${preview.included_count} appraisal form(s) for ${preview.label}?` +
      (preview.excluded_count ? `\n\n${preview.excluded_count} employee(s) will NOT get a form — check the list first.` : "")
    )) return;
    setBusy(true);
    try {
      const res = await API.post("/performance/cycles", { half, year: Number(year) });
      alert(`${res.data.created} appraisal form(s) created for ${preview.label}.` +
            (res.data.excluded_count ? `\n\n${res.data.excluded_count} excluded.` : ""));
      onDone();
    } catch (e) {
      alert(e.response?.data?.detail || "Could not open the cycle");
    } finally { setBusy(false); }
  };

  return (
    <Modal wide title="Open an appraisal cycle"
      subtitle="Preview first — nothing is created until you confirm." onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1">Half-year</label>
            <select value={half} onChange={e => { setHalf(e.target.value); setPreview(null); }}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
              {HALVES.map(h => <option key={h.half} value={h.half}>{h.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Starting year</label>
            <input type="number" value={year} onChange={e => { setYear(e.target.value); setPreview(null); }}
              data-testid="cycle-year"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          </div>
        </div>
        <p className="text-[11px] text-slate-500">
          H2 with starting year 2025 means <strong>Oct 2025 – Mar 2026</strong> — the cycle reviewed in April 2026.
        </p>

        <button onClick={run} disabled={busy} data-testid="preview-cycle-btn"
          className="w-full px-4 py-2.5 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50">
          {busy ? "Checking…" : "Preview — who gets a form?"}
        </button>

        {preview && (
          <div className="space-y-3" data-testid="cycle-preview">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={16} className="text-green-600" />
              <span><strong>{preview.included_count}</strong> will get a form for <strong>{preview.label}</strong></span>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0"><tr>
                  {["Employee", "Designation", "Department", "Form", "Increment"].map(h => (
                    <th key={h} className="px-2 py-2 text-left font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {preview.included.map(e => (
                    <tr key={e.employee_id} className="border-t border-slate-100">
                      <td className="px-2 py-1.5"><span className="font-mono text-[#E85B1E]">{e.employee_id}</span> {e.name}</td>
                      <td className="px-2 py-1.5 text-slate-600">{e.designation}</td>
                      <td className="px-2 py-1.5 text-slate-600">{e.department}</td>
                      <td className="px-2 py-1.5 text-slate-600">{e.template_name}</td>
                      <td className="px-2 py-1.5">
                        <Badge className={e.eligibility === "full" ? "bg-green-100 text-green-700" : "bg-purple-100 text-purple-700"}>
                          {e.eligibility === "full" ? "Full" : "Pro-rata"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.excluded_count > 0 && (
              <div className="border border-amber-300 bg-amber-50 rounded-lg p-3" data-testid="cycle-excluded">
                <p className="text-sm font-bold text-amber-900 flex items-center gap-2">
                  <AlertTriangle size={14} /> {preview.excluded_count} will NOT get a form
                </p>
                <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                  {preview.excluded.map(e => (
                    <p key={e.employee_id} className="text-[11px] text-amber-900">
                      <span className="font-mono font-semibold">{e.employee_id}</span> {e.name}
                      {e.designation ? ` (${e.designation})` : ""} — {e.reason}
                    </p>
                  ))}
                </div>
                <p className="text-[10px] text-amber-800 mt-2 italic">
                  Read this before creating. "No PE template" usually means the designation or
                  department is wrong on that employee's record.
                </p>
              </div>
            )}

            <button onClick={create} disabled={busy || !preview.included_count} data-testid="create-cycle-btn"
              className="w-full px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-50">
              {busy ? "Creating…" : `Create ${preview.included_count} appraisal form(s)`}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ── The form ───────────────────────────────────────────────────────────────
   One component, three modes: fill my own, score my report, or read a finished
   one. The mode comes from the review's status and who is looking.           */
function ReviewModal({ review, user, isAdmin, onClose, onSaved }) {
  const me = user?.employee_id;
  const isSelf = review.employee_id === me;
  const isManager = review.reporting_to === me || isAdmin;

  const mode =
    review.status === "pending_self" && (isSelf || isAdmin) ? "self"
    : review.status === "pending_manager" && isManager ? "manager"
    : "view";
  const readOnly = mode === "view";

  const field = mode === "self" ? "self_score" : "manager_score";
  const [scores, setScores] = useState(() =>
    Object.fromEntries(review.parameters.map(p => [p.seq, p[field] ?? ""])));
  const [narr, setNarr] = useState(() =>
    Object.fromEntries((review.narrative || []).map(n => [n.seq, {
      text: mode === "self" ? (n.self_answer || "") : (n.manager_comment || ""),
      rating: (mode === "self" ? n.self_rating : n.manager_rating) || "",
    }])));
  const [improve, setImprove] = useState(review.review_details?.area_of_improvement || "");
  const [recommend, setRecommend] = useState(review.review_details?.special_recommendations || "");
  const [remarks, setRemarks] = useState(review.review_details?.remarks || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const total = useMemo(
    () => review.parameters.reduce((s, p) => s + (parseFloat(scores[p.seq]) || 0), 0),
    [scores, review.parameters]);

  const overweight = review.parameters.filter(p => (parseFloat(scores[p.seq]) || 0) > p.weight);
  const blank = review.parameters.filter(p => scores[p.seq] === "" || scores[p.seq] == null);

  const submit = async () => {
    setErr("");
    if (blank.length) { setErr(`Score every parameter — ${blank.length} still blank.`); return; }
    if (overweight.length) { setErr(`${overweight.length} score(s) are above the parameter's weight.`); return; }
    const items = review.narrative || [];
    for (const n of items) {
      const v = narr[n.seq] || {};
      if (!(v.text || "").trim()) { setErr(`Question ${n.seq} needs ${mode === "self" ? "an answer" : "a comment"}.`); return; }
      if (!(Number(v.rating) >= 1 && Number(v.rating) <= 5)) { setErr(`Question ${n.seq} needs a rating of 1–5.`); return; }
    }
    const body = {
      scores: review.parameters.map(p => ({ seq: p.seq, score: parseFloat(scores[p.seq]) })),
      narrative: items.map(n => mode === "self"
        ? { seq: n.seq, answer: narr[n.seq].text.trim(), rating: Number(narr[n.seq].rating) }
        : { seq: n.seq, comment: narr[n.seq].text.trim(), rating: Number(narr[n.seq].rating) }),
    };
    if (mode === "manager") {
      body.area_of_improvement = improve;
      body.special_recommendations = recommend;
      body.remarks = remarks;
    }
    if (!window.confirm(mode === "self"
      ? `Submit your self-assessment (${total}/100)?\n\nOnce your manager has assessed you, this can no longer be changed.`
      : `Submit your assessment of ${review.employee_name} (${total}/100)?\n\nThis sets their grade and completes the review.`)) return;

    setBusy(true);
    try {
      const res = await API.put(`/performance/${review.id}/${mode}`, body);
      if (mode === "manager") {
        alert(`Assessment submitted.\n\n${review.employee_name}: ${res.data.manager_total}/100 — Grade ${res.data.grade} (${res.data.grade_level})`);
      }
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.detail || "Could not submit");
    } finally { setBusy(false); }
  };

  return (
    <Modal wide onClose={onClose}
      title={mode === "self" ? "My self-assessment" : `${review.employee_name} — assessment`}
      subtitle={`${review.label} · ${review.template_name} · ${review.designation}, ${review.department}`}>
      <div className="space-y-4">
        {review.grade && (
          <div className="bg-[#1E2A47] text-white rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="text-xs opacity-70 uppercase tracking-wider font-bold">Final grade</p>
              <p className="text-2xl font-bold">{review.grade} — {review.grade_level}</p>
            </div>
            <div className="text-right">
              <p className="text-xs opacity-70">Manager score</p>
              <p className="text-2xl font-bold">{review.manager_total}<span className="text-base opacity-60">/100</span></p>
            </div>
          </div>
        )}

        {mode === "manager" && (
          <div className="text-[11px] text-blue-900 bg-blue-50 border border-blue-200 rounded-lg p-2.5 flex items-start gap-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              <strong>Your score sets the grade.</strong> The employee's self-score is shown for
              reference only — it does not count towards the result.
            </span>
          </div>
        )}

        {/* PE grid */}
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50"><tr>
                {["#", "Parameter", "Measured by", "Out of", "Self", "Manager"].map(h => (
                  <th key={h} className="px-2 py-2 text-left font-bold text-slate-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {review.parameters.map(p => {
                  const val = scores[p.seq];
                  const bad = (parseFloat(val) || 0) > p.weight;
                  const input = (
                    <input type="number" min="0" max={p.weight} step="0.5"
                      value={val} onChange={e => setScores(s => ({ ...s, [p.seq]: e.target.value }))}
                      data-testid={`${mode}-score-${p.seq}`}
                      className={`w-16 border rounded px-1.5 py-1 text-xs outline-none focus:ring-2 focus:ring-[#E85B1E] ${bad ? "border-red-400 bg-red-50" : "border-slate-300"}`} />
                  );
                  return (
                    <tr key={p.seq} className="border-t border-slate-100 align-top">
                      <td className="px-2 py-2 text-slate-400">{p.seq}</td>
                      <td className="px-2 py-2">
                        <p className="font-semibold text-[#0F172A]">{p.name}</p>
                        <p className="text-[10px] text-slate-500 leading-snug">{p.description}</p>
                      </td>
                      <td className="px-2 py-2 text-slate-500 text-[10px]">{p.tool}</td>
                      <td className="px-2 py-2 font-bold text-slate-700">{p.weight}</td>
                      <td className="px-2 py-2">
                        {mode === "self" ? input : <span className="text-slate-500">{p.self_score ?? "—"}</span>}
                      </td>
                      <td className="px-2 py-2">
                        {mode === "manager" ? input : <span className="font-semibold text-[#0F172A]">{p.manager_score ?? "—"}</span>}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-[#1E2A47] bg-slate-50 font-bold">
                  <td colSpan={3} className="px-2 py-2 text-right text-[#1E2A47]">TOTAL</td>
                  <td className="px-2 py-2">100</td>
                  <td className="px-2 py-2 text-slate-500">{mode === "self" ? total : (review.self_total ?? "—")}</td>
                  <td className="px-2 py-2 text-[#1E2A47]">{mode === "manager" ? total : (review.manager_total ?? "—")}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        {!readOnly && overweight.length > 0 && (
          <p className="text-[11px] text-red-600 font-semibold">
            {overweight.map(p => `"${p.name}" is out of ${p.weight}`).join(" · ")}
          </p>
        )}

        {/* The assessment sheet */}
        {(review.narrative || []).length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
              Assessment questions
            </h4>
            {review.narrative.map(n => (
              <div key={n.seq} className="border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-[#0F172A]">{n.seq}. {n.question}</p>

                {mode !== "self" && (
                  <div className="bg-slate-50 rounded p-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">
                      Employee's answer{n.self_rating ? ` · rated ${n.self_rating}/5` : ""}
                    </p>
                    <p className="text-[11px] text-slate-700 whitespace-pre-wrap">{n.self_answer || "—"}</p>
                  </div>
                )}

                {!readOnly ? (
                  <div className="space-y-1.5">
                    <textarea rows={3} value={narr[n.seq]?.text || ""}
                      onChange={e => setNarr(s => ({ ...s, [n.seq]: { ...s[n.seq], text: e.target.value } }))}
                      placeholder={mode === "self" ? "Your answer…" : "Your comment on their answer…"}
                      data-testid={`narrative-text-${n.seq}`}
                      className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Rating</span>
                      {[1, 2, 3, 4, 5].map(v => (
                        <button key={v} type="button"
                          onClick={() => setNarr(s => ({ ...s, [n.seq]: { ...s[n.seq], rating: v } }))}
                          data-testid={`narrative-rating-${n.seq}-${v}`}
                          className={`w-7 h-7 rounded-full text-xs font-bold border transition-colors ${
                            Number(narr[n.seq]?.rating) === v
                              ? "bg-[#E85B1E] text-white border-[#E85B1E]"
                              : "border-slate-300 text-slate-500 hover:border-[#E85B1E]"}`}>
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="bg-blue-50 rounded p-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-blue-400 mb-0.5">
                      Manager's comment{n.manager_rating ? ` · rated ${n.manager_rating}/5` : ""}
                    </p>
                    <p className="text-[11px] text-slate-700 whitespace-pre-wrap">{n.manager_comment || "—"}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {mode === "manager" && (
          <div className="space-y-2">
            <h4 className="text-sm font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Review notes</h4>
            {[["Area of improvement", improve, setImprove],
              ["Special recommendations (if any)", recommend, setRecommend],
              ["Remarks", remarks, setRemarks]].map(([label, val, set]) => (
              <div key={label}>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">{label}</label>
                <input value={val} onChange={e => set(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            ))}
          </div>
        )}
        {readOnly && review.review_details?.reviewed_by && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-[11px] text-slate-600 space-y-1">
            <p><strong>Reviewed by:</strong> {review.review_details.reviewed_by} ({review.review_details.reviewer_designation}) on {review.review_details.date}</p>
            {review.review_details.area_of_improvement && <p><strong>Area of improvement:</strong> {review.review_details.area_of_improvement}</p>}
            {review.review_details.special_recommendations && <p><strong>Special recommendations:</strong> {review.review_details.special_recommendations}</p>}
            {review.review_details.remarks && <p><strong>Remarks:</strong> {review.review_details.remarks}</p>}
          </div>
        )}

        {err && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2 flex items-start gap-2">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
          </div>
        )}

        {!readOnly && (
          <button onClick={submit} disabled={busy} data-testid="submit-review-btn"
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-50">
            {busy ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Submitting…</>
                  : <><Save size={14} /> Submit {mode === "self" ? "self-assessment" : "assessment"} — {total}/100</>}
          </button>
        )}
        {mode === "view" && review.status === "pending_self" && (
          <p className="text-center text-xs text-slate-400">Waiting on {review.employee_name}'s self-assessment.</p>
        )}
        {mode === "view" && review.status === "pending_manager" && (
          <p className="text-center text-xs text-slate-400">
            Waiting on their reporting manager. Only {review.reporting_to || "their manager"} can assess this.
          </p>
        )}
      </div>
    </Modal>
  );
}
