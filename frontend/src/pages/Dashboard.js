import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import API from "../utils/api";
import { Users, CalendarCheck, FileText, CreditCard, TrendingUp, UserPlus, Clock, Video, Mail, Phone, CalendarX, FileEdit, AlertCircle, DoorOpen, ChevronRight, Shield, Check, X, Loader2 } from "lucide-react";
import { QuickPunchCard } from "../components/dashboard/QuickPunchCard";
import OdometerCard from "../components/dashboard/OdometerCard";
import { toLocalDateStr } from "../utils/shiftRules";

// Drilldown modal for present/absent/on-leave
function DrilldownModal({ title, endpoint, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    API.get(endpoint).then(r => setRows(r.data)).catch(() => setRows([])).finally(() => setLoading(false));
  }, [endpoint]);
  const fmt = (t) => { if (!t) return "—"; const d = new Date(t); return isNaN(d) ? t : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }); };
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="font-bold text-[#1E2A47] text-base" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-slate-400" /></div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-10">No records found</p>
          ) : rows.map((r, i) => (
            <div key={i} className="px-5 py-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#1E2A47]">{r.name || r.employee_id}</p>
                <p className="text-xs text-slate-500">{r.designation || r.leave_type || ""}  {r.branch ? `· ${r.branch}` : ""}</p>
              </div>
              <div className="text-xs text-slate-400 text-right flex-shrink-0">
                {r.punch_in_time ? <p>In: {fmt(r.punch_in_time)}</p> : null}
                {r.punch_out_time ? <p>Out: {fmt(r.punch_out_time)}</p> : null}
                {r.start_date && r.end_date ? <p>{r.start_date} → {r.end_date}</p> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 rounded-b-xl">
          <p className="text-xs text-slate-400">{rows.length} employee{rows.length !== 1 ? "s" : ""}</p>
        </div>
      </div>
    </div>
  );
}


const StatCard = ({ label, value, icon: Icon, color, sub, onClick }) => (
  <div onClick={onClick}
    className={`bg-white border border-slate-200 rounded-lg p-5 flex items-center gap-4 hover:-translate-y-0.5 transition-transform shadow-sm ${onClick ? "cursor-pointer hover:border-[#E85B1E]" : ""}`}
    data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
    <div className={`w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
      <Icon size={22} className="text-white" />
    </div>
    <div>
      <p className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{value ?? "-"}</p>
      <p className="text-sm text-slate-500">{label}</p>
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
    </div>
  </div>
);

// ───────────────────────────────────────────────────────────────
//  Personal Dashboard — for HO Staff (employee) and Field Staff
// ───────────────────────────────────────────────────────────────
function PersonalDashboard({ user }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const res = await API.get("/dashboard/my-stats");
      setData(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="bg-slate-200 animate-pulse rounded-lg h-24"></div>)}
      </div>
    );
  }

  return (
    <>
      <QuickPunchCard user={user} todayStatus={data?.today_status} onPunched={fetchData} />
      <OdometerCard />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label="Absent This Month" value={data?.absent_this_month ?? 0}
          icon={CalendarX} color="bg-red-500" sub={data?.month_label} />
        <StatCard label="Pending Leaves" value={data?.pending_leaves ?? 0}
          icon={FileText} color="bg-amber-500" sub="Awaiting approval"
          onClick={() => navigate("/leaves")} />
        <StatCard label="Pending Regularisations" value={data?.pending_regularisations ?? 0}
          icon={FileEdit} color="bg-blue-500" sub="Awaiting HR review"
          onClick={() => navigate("/attendance")} />
      </div>

      {/* Quick Links */}
      <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 rounded-t-lg">
          <h3 className="font-bold text-[#1E2A47] text-base" style={{ fontFamily: "'Outfit', sans-serif" }}>Quick Actions</h3>
        </div>
        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Attendance History", path: "/attendance", icon: CalendarCheck, color: "bg-green-50 text-green-700 border-green-200" },
            { label: "Apply Leave", path: "/leaves", icon: FileText, color: "bg-blue-50 text-blue-700 border-blue-200" },
            { label: "View Payslip", path: "/payroll", icon: CreditCard, color: "bg-[#FFF5F0] text-[#E85B1E] border-orange-200" },
            { label: "Performance", path: "/performance", icon: TrendingUp, color: "bg-purple-50 text-purple-700 border-purple-200" },
          ].map(({ label, path, icon: Icon, color }) => (
            <a key={label} href={path}
              data-testid={`quick-action-${label.toLowerCase().replace(/\s+/g, '-')}`}
              className={`flex items-center gap-2 p-3 rounded-lg border text-sm font-medium transition-all hover:-translate-y-0.5 ${color}`}>
              <Icon size={16} />
              {label}
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────
//  Admin / Manager Dashboard — company-wide stats
// ───────────────────────────────────────────────────────────────
function AdminDashboard({ user }) {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [myInterviews, setMyInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exitPending, setExitPending] = useState(null);
  const [drilldown, setDrilldown] = useState(null); // { title, endpoint }
  const canSeeInterviews = ["hr_admin", "management", "managers"].includes(user?.role);
  const canSeePayroll = ["hr_admin", "management"].includes(user?.role);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const calls = [
          API.get("/dashboard/stats"),
          API.get("/dashboard/recent-activity"),
          API.get("/exit/my-pending-count"),
        ];
        if (canSeeInterviews) calls.push(API.get("/candidates/my-interviews"));
        const results = await Promise.all(calls);
        setStats(results[0].data);
        setActivity(results[1].data);
        setExitPending(results[2].data);
        if (canSeeInterviews && results[3]) setMyInterviews(results[3].data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [canSeeInterviews]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(8)].map((_, i) => <div key={i} className="bg-slate-200 animate-pulse rounded-lg h-24"></div>)}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Employees" value={stats?.total_employees} icon={Users} color="bg-[#1E2A47]"
          onClick={() => navigate("/employees")} />
        <StatCard label="Present Today" value={stats?.present_today} icon={CalendarCheck} color="bg-green-500"
          onClick={() => setDrilldown({ title: "Present Today", endpoint: "/dashboard/drilldown/present" })} />
        <StatCard label="On Leave" value={stats?.on_leave_today} icon={Clock} color="bg-amber-500"
          onClick={() => setDrilldown({ title: "On Leave Today", endpoint: "/dashboard/drilldown/on-leave" })} />
        <StatCard label="Absent" value={stats?.absent_today} icon={Users} color="bg-red-500"
          onClick={() => setDrilldown({ title: "Absent Today", endpoint: "/dashboard/drilldown/absent" })} />
        <StatCard label="Pending Leaves" value={stats?.pending_leaves} icon={FileText} color="bg-blue-500" sub="Awaiting approval"
          onClick={() => navigate("/leaves")} />
        <StatCard label="Candidates" value={stats?.total_candidates} icon={UserPlus} color="bg-purple-500" sub={`${stats?.pending_candidates ?? 0} pending`}
          onClick={() => navigate("/candidates")} />
        <StatCard label="Exit Requests" value={stats?.exit_requests} icon={TrendingUp} color="bg-orange-500"
          onClick={() => navigate("/exit")} />
        {canSeePayroll && (
          <StatCard label="Payroll (Month)" value={stats?.payroll_processed_this_month} icon={CreditCard} color="bg-[#E85B1E]" sub="Records processed"
            onClick={() => navigate("/payroll")} />
        )}
      </div>

      {drilldown && (
        <DrilldownModal
          title={drilldown.title}
          endpoint={drilldown.endpoint}
          onClose={() => setDrilldown(null)}
        />
      )}

      {/* Exit Pending Actions Alert */}
      {exitPending?.total > 0 && (
        <div
          onClick={() => navigate("/exit")}
          className="mb-6 cursor-pointer group border border-red-200 bg-red-50 rounded-xl overflow-hidden hover:border-red-400 hover:shadow-md transition-all"
          data-testid="exit-pending-dashboard-card"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-4">
              <div className="w-11 h-11 rounded-xl bg-red-500 flex items-center justify-center flex-shrink-0 shadow-sm">
                <DoorOpen size={20} className="text-white" />
              </div>
              <div>
                <p className="font-bold text-red-700 text-sm flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full">
                    {exitPending.total > 9 ? "9+" : exitPending.total}
                  </span>
                  Exit Action{exitPending.total !== 1 ? "s" : ""} Pending
                </p>
                <div className="flex flex-wrap gap-3 mt-1">
                  {exitPending.approvals > 0 && (
                    <span className="text-xs text-red-600 flex items-center gap-1">
                      <AlertCircle size={11} /> {exitPending.approvals} approval{exitPending.approvals !== 1 ? "s" : ""} needed
                    </span>
                  )}
                  {exitPending.noc > 0 && (
                    <span className="text-xs text-amber-700 flex items-center gap-1">
                      <Shield size={11} /> {exitPending.noc} NOC section{exitPending.noc !== 1 ? "s" : ""} to fill
                    </span>
                  )}
                  {exitPending.docs > 0 && (
                    <span className="text-xs text-blue-700 flex items-center gap-1">
                      <Check size={11} /> {exitPending.docs} doc{exitPending.docs !== 1 ? "s" : ""} upload pending
                    </span>
                  )}
                </div>
              </div>
            </div>
            <ChevronRight size={18} className="text-red-400 group-hover:translate-x-1 transition-transform flex-shrink-0" />
          </div>
        </div>
      )}

      {canSeeInterviews && myInterviews.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm mb-6" data-testid="my-interviews-panel">
          <div className="px-5 py-4 border-b border-slate-100 bg-violet-50/50 rounded-t-lg flex items-center justify-between">
            <div>
              <h3 className="font-bold text-[#1E2A47] text-base flex items-center gap-2" style={{ fontFamily: "'Outfit', sans-serif" }}>
                <Users size={16} className="text-violet-600" /> My Interviews
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">Candidates assigned to you — upcoming + recent past</p>
            </div>
            <span className="px-2.5 py-1 bg-violet-100 text-violet-700 rounded-full text-xs font-bold">{myInterviews.length}</span>
          </div>
          <div className="divide-y divide-slate-100">
            {myInterviews.slice(0, 6).map(i => {
              const today_iso = toLocalDateStr();
              const isToday = i.interview_date === today_iso;
              const isPast = i.interview_date && i.interview_date < today_iso;
              return (
                <div key={i.id} data-testid={`interview-${i.id}`}
                  className={`px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-slate-50 ${isToday ? "bg-orange-50/40" : ""}`}>
                  <div className="flex-shrink-0 text-center w-14">
                    <p className={`text-[10px] font-bold uppercase ${isToday ? "text-[#E85B1E]" : isPast ? "text-slate-400" : "text-violet-600"}`}>
                      {isToday ? "Today" : isPast ? "Past" : new Date(i.interview_date).toLocaleDateString("en-IN", { weekday: "short" })}
                    </p>
                    <p className={`text-lg font-bold ${isToday ? "text-[#E85B1E]" : "text-[#1E2A47]"}`}>
                      {i.interview_date ? new Date(i.interview_date).getDate() : "—"}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {i.interview_date ? new Date(i.interview_date).toLocaleDateString("en-IN", { month: "short" }) : ""}
                    </p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#1E2A47]">{i.name}</p>
                    <p className="text-xs text-slate-500">{i.position}{i.department ? ` · ${i.department}` : ""}</p>
                    <div className="flex flex-wrap gap-3 mt-1 text-[11px] text-slate-500">
                      {i.interview_time && <span className="inline-flex items-center gap-1"><Clock size={11} /> {i.interview_time}</span>}
                      {i.mobile && <span className="inline-flex items-center gap-1"><Phone size={11} /> {i.mobile}</span>}
                      {i.email && <span className="inline-flex items-center gap-1"><Mail size={11} /> {i.email}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {i.meet_link && (
                      <a href={i.meet_link} target="_blank" rel="noopener noreferrer"
                        data-testid={`interview-meet-${i.id}`}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700">
                        <Video size={11} /> Join Meet
                      </a>
                    )}
                    <button onClick={() => navigate(`/candidates?open=${i.id}`)}
                      data-testid={`view-candidate-${i.id}`}
                      className="px-2.5 py-1.5 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2a3a5c]">
                      View Profile
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {myInterviews.length > 6 && (
            <div className="px-5 py-2.5 border-t border-slate-100 text-center">
              <a href="/candidates" className="text-xs text-[#E85B1E] hover:underline font-semibold">View all in Candidates →</a>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 rounded-t-lg">
            <h3 className="font-bold text-[#1E2A47] text-base" style={{ fontFamily: "'Outfit', sans-serif" }}>Recent Activity</h3>
          </div>
          <div className="p-4 space-y-3 max-h-72 overflow-y-auto">
            {activity.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">No recent activity</p>
            ) : activity.map((a, i) => (
              <div key={a._id || `${a.time}-${i}`} className="flex items-center gap-3 py-2 border-b border-slate-50 last:border-0">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${a.type === "attendance" ? "bg-green-100 text-green-600" : "bg-blue-100 text-blue-600"}`}>
                  {a.type === "attendance" ? <CalendarCheck size={14} /> : <FileText size={14} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#0F172A] truncate">{a.message}</p>
                  <p className="text-xs text-slate-400">{a.time ? new Date(a.time).toLocaleTimeString("en-IN") : ""}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 rounded-t-lg">
            <h3 className="font-bold text-[#1E2A47] text-base" style={{ fontFamily: "'Outfit', sans-serif" }}>Quick Actions</h3>
          </div>
          <div className="p-4 grid grid-cols-2 gap-3">
            {[
              { label: "Mark Attendance", path: "/attendance", icon: CalendarCheck, color: "bg-green-50 text-green-700 border-green-200" },
              { label: "Apply Leave", path: "/leaves", icon: FileText, color: "bg-blue-50 text-blue-700 border-blue-200" },
              { label: "View Payslip", path: "/payroll", icon: CreditCard, color: "bg-[#FFF5F0] text-[#E85B1E] border-orange-200" },
              { label: "Performance", path: "/performance", icon: TrendingUp, color: "bg-purple-50 text-purple-700 border-purple-200" },
            ].map(({ label, path, icon: Icon, color }) => (
              <a key={label} href={path}
                data-testid={`quick-action-${label.toLowerCase().replace(/\s+/g, '-')}`}
                className={`flex items-center gap-2 p-3 rounded-lg border text-sm font-medium transition-all hover:-translate-y-0.5 ${color}`}>
                <Icon size={16} />
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────
//  Top-level — picks the right view based on role
// ───────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user } = useAuth();
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const isPersonalRole = ["employee", "field_agent"].includes(user?.role);

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
          Good {new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 17 ? "Afternoon" : "Evening"}, {user?.name?.split(" ")[0]}!
        </h1>
        <p className="text-slate-500 text-sm mt-1">{today}</p>
      </div>

      {isPersonalRole ? <PersonalDashboard user={user} /> : <AdminDashboard user={user} />}
    </div>
  );
}
