import React, { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import API from "../utils/api";
import { Users, CalendarCheck, FileText, CreditCard, TrendingUp, UserPlus, Clock, MapPin } from "lucide-react";

const StatCard = ({ label, value, icon: Icon, color, sub }) => (
  <div className="bg-white border border-slate-200 rounded-lg p-5 flex items-center gap-4 hover:-translate-y-0.5 transition-transform shadow-sm" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
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

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, actRes] = await Promise.all([
          API.get("/dashboard/stats"),
          API.get("/dashboard/recent-activity"),
        ]);
        setStats(statsRes.data);
        setActivity(actRes.data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
          Good {new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 17 ? "Afternoon" : "Evening"}, {user?.name?.split(" ")[0]}!
        </h1>
        <p className="text-slate-500 text-sm mt-1">{today}</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="bg-slate-200 animate-pulse rounded-lg h-24"></div>
          ))}
        </div>
      ) : (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard label="Total Employees" value={stats?.total_employees} icon={Users} color="bg-[#1E2A47]" />
            <StatCard label="Present Today" value={stats?.present_today} icon={CalendarCheck} color="bg-green-500" />
            <StatCard label="On Leave" value={stats?.on_leave_today} icon={Clock} color="bg-amber-500" />
            <StatCard label="Absent" value={stats?.absent_today} icon={Users} color="bg-red-500" />
            <StatCard label="Pending Leaves" value={stats?.pending_leaves} icon={FileText} color="bg-blue-500" sub="Awaiting approval" />
            <StatCard label="Candidates" value={stats?.total_candidates} icon={UserPlus} color="bg-purple-500" sub={`${stats?.pending_candidates} pending`} />
            <StatCard label="Exit Requests" value={stats?.exit_requests} icon={TrendingUp} color="bg-orange-500" />
            <StatCard label="Payroll (Month)" value={stats?.payroll_processed_this_month} icon={CreditCard} color="bg-[#E85B1E]" sub="Records processed" />
          </div>

          {/* Recent Activity */}
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

            {/* Quick Links */}
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
                  <a
                    key={label}
                    href={path}
                    data-testid={`quick-action-${label.toLowerCase().replace(/\s+/g, '-')}`}
                    className={`flex items-center gap-2 p-3 rounded-lg border text-sm font-medium transition-all hover:-translate-y-0.5 ${color}`}
                  >
                    <Icon size={16} />
                    {label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
