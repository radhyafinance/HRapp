import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import API from "../utils/api";
import { Users, CalendarCheck, FileText, CreditCard, TrendingUp, UserPlus, Clock, Video, Mail, Phone, CalendarX, FileEdit, AlertCircle } from "lucide-react";
import { QuickPunchCard } from "../components/dashboard/QuickPunchCard";
import { WebAuthnSetupCard } from "../components/dashboard/WebAuthnSetupCard";

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

      <WebAuthnSetupCard />

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
  const canSeeInterviews = ["hr_admin", "management", "managers"].includes(user?.role);
  const canSeePayroll = ["hr_admin", "management"].includes(user?.role);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const calls = [
          API.get("/dashboard/stats"),
          API.get("/dashboard/recent-activity"),
        ];
        if (canSeeInterviews) calls.push(API.get("/candidates/my-interviews"));
        const results = await Promise.all(calls);
        setStats(results[0].data);
        setActivity(results[1].data);
        if (canSeeInterviews && results[2]) setMyInterviews(results[2].data);
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
        <StatCard label="Total Employees" value={stats?.total_employees} icon={Users} color="bg-[#1E2A47]" />
        <StatCard label="Present Today" value={stats?.present_today} icon={CalendarCheck} color="bg-green-500" />
        <StatCard label="On Leave" value={stats?.on_leave_today} icon={Clock} color="bg-amber-500" />
        <StatCard label="Absent" value={stats?.absent_today} icon={Users} color="bg-red-500" />
        <StatCard label="Pending Leaves" value={stats?.pending_leaves} icon={FileText} color="bg-blue-500" sub="Awaiting approval" />
        <StatCard label="Candidates" value={stats?.total_candidates} icon={UserPlus} color="bg-purple-500" sub={`${stats?.pending_candidates} pending`} />
        <StatCard label="Exit Requests" value={stats?.exit_requests} icon={TrendingUp} color="bg-orange-500" />
        {canSeePayroll && (
          <StatCard label="Payroll (Month)" value={stats?.payroll_processed_this_month} icon={CreditCard} color="bg-[#E85B1E]" sub="Records processed" />
        )}
      </div>

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
              const today_iso = new Date().toISOString().split("T")[0];
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
