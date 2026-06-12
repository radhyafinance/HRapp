import React, { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import NotificationBell from "./NotificationBell";
import API from "../utils/api";
import {
  LayoutDashboard, Users, UserPlus, CalendarCheck, FileText,
  CreditCard, TrendingUp, LogOut, Settings, Menu, X,
  DoorOpen, Award, MapPin, Calendar
} from "lucide-react";

const NAV_ITEMS = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["hr_admin", "management", "managers", "employee", "field_agent"] },
  { path: "/candidates", label: "Candidates", icon: UserPlus, roles: ["hr_admin", "management"] },
  { path: "/employees", label: "Employees", icon: Users, roles: ["hr_admin", "management", "managers"] },
  { path: "/attendance", label: "Attendance", icon: CalendarCheck, roles: ["hr_admin", "management", "managers", "employee", "field_agent"] },
  { path: "/calendar", label: "Calendar", icon: Calendar, roles: ["hr_admin", "management", "managers", "employee", "field_agent"] },
  { path: "/field-tracking", label: "Field Tracking", icon: MapPin, roles: ["hr_admin", "management", "managers"] },
  { path: "/leaves", label: "Leaves", icon: FileText, roles: ["hr_admin", "management", "managers", "employee", "field_agent"] },
  { path: "/payroll", label: "Payroll", icon: CreditCard, roles: ["hr_admin", "management", "managers", "employee", "field_agent"] },
  { path: "/performance", label: "Performance", icon: TrendingUp, roles: ["hr_admin", "management", "managers", "employee", "field_agent"] },
  { path: "/exit", label: "Exit", icon: DoorOpen, roles: ["hr_admin", "management", "managers", "employee", "field_agent"] },
  { path: "/letters", label: "Letters", icon: Award, roles: ["hr_admin", "management"] },
  { path: "/gratuity", label: "Gratuity", icon: Award, roles: ["hr_admin", "management"] },
  { path: "/settings", label: "Settings", icon: Settings, roles: ["hr_admin"] },
];

// Priority paths for mobile bottom navigation
const MOBILE_NAV_PRIORITY = ["/dashboard", "/attendance", "/leaves", "/employees", "/payroll", "/calendar"];
const MOBILE_LABELS = {
  "/dashboard": "Home", "/attendance": "Attend", "/leaves": "Leaves",
  "/employees": "Team", "/payroll": "Payroll", "/calendar": "Calendar",
};

const ROLE_LABELS = {
  hr_admin: "HR Admin",
  management: "Management",
  managers: "Managers",
  employee: "HO Staff",
  field_agent: "Field Staff",
};

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [photoUrl, setPhotoUrl] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileData, setProfileData] = useState(null);
  const [exitPendingCount, setExitPendingCount] = useState(0);

  // Poll for pending exit actions (managers + admin only)
  useEffect(() => {
    const POLLING_ROLES = ["hr_admin", "managers", "management"];
    if (!POLLING_ROLES.includes(user?.role)) return;
    const fetchCount = () => {
      API.get("/exit/my-pending-count")
        .then(r => setExitPendingCount(r.data?.total || 0))
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    return () => clearInterval(interval);
  }, [user?.role]);

  // Load passport photo for employees
  useEffect(() => {
    if (!user?.employee_id) return;
    let objectUrl = null;
    API.get(`/employees/${user.employee_id}/documents`)
      .then(res => {
        if (res.data.documents?.passport_photo?.uploaded) {
          return API.get(`/employees/${user.employee_id}/documents/passport_photo/file`, { responseType: "blob" });
        }
      })
      .then(imgRes => {
        if (imgRes) {
          objectUrl = URL.createObjectURL(imgRes.data);
          setPhotoUrl(objectUrl);
        }
      })
      .catch(() => {});
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [user?.employee_id]);

  const openProfile = async () => {
    setProfileOpen(true);
    if (profileData || !user?.employee_id) return;
    try {
      const res = await API.get(`/employees/${user.employee_id}`);
      const data = { ...res.data };
      if (data.reporting_to) {
        try {
          const mgr = await API.get(`/employees/${data.reporting_to}`);
          data._manager_name = `${mgr.data.first_name || ""} ${mgr.data.last_name || ""}`.trim();
        } catch { /* no manager found */ }
      }
      setProfileData(data);
    } catch { /* silently ignore */ }
  };

  const filteredNav = NAV_ITEMS.filter(item => item.roles.includes(user?.role));

  // Mobile bottom nav: top 4 priority items accessible to this role
  const mobileNavItems = MOBILE_NAV_PRIORITY
    .map(p => NAV_ITEMS.find(n => n.path === p))
    .filter(item => item && item.roles.includes(user?.role))
    .slice(0, 4);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-5 border-b border-[#2A3A5E]">
        <div className="flex items-center gap-3">
          <img
            src="https://customer-assets.emergentagent.com/job_9e8a8b1c-6fe9-429d-9ba5-f0ea612fef99/artifacts/r2mv4l59_Icons-03.png"
            alt="Radhya"
            className="w-10 h-10 rounded-lg object-cover"
          />
          <div>
            <p className="text-white font-bold text-base leading-tight" style={{ fontFamily: "'Outfit', sans-serif" }}>RADHYA</p>
            <p className="text-slate-400 text-xs">Micro Finance</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 overflow-y-auto">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3 px-2">Menu</p>
        <div className="space-y-1">
          {filteredNav.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                  isActive
                    ? "bg-[#E85B1E] text-white shadow-sm"
                    : "text-slate-300 hover:bg-[#2A3A5E] hover:text-white"
                }`
              }
              data-testid={`nav-${label.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <Icon size={18} />
              <span className="flex-1">{label}</span>
              {path === "/exit" && exitPendingCount > 0 && (
                <span className="flex-shrink-0 min-w-[20px] h-5 flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 leading-none"
                  data-testid="exit-pending-badge">
                  {exitPendingCount > 9 ? "9+" : exitPendingCount}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* User Profile */}
      <div className="p-4 border-t border-[#2A3A5E]">
        <div className="flex items-center gap-3 mb-3 px-2">
          <div className="w-9 h-9 rounded-full bg-[#E85B1E] flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
            {user?.name?.charAt(0) || "U"}
          </div>
          <div className="overflow-hidden">
            <p className="text-white text-sm font-semibold truncate">{user?.name || "User"}</p>
            <p className="text-slate-400 text-xs">{ROLE_LABELS[user?.role] || user?.role}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          data-testid="logout-button"
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:bg-[#2A3A5E] hover:text-white text-sm transition-all"
        >
          <LogOut size={16} />
          <span>Logout</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-[#F8FAFC] overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 flex-shrink-0 bg-[#1E2A47] flex-col">
        <SidebarContent />
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-[80] flex">
          <div className="w-72 bg-[#1E2A47] flex flex-col h-full shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#2A3A5E]">
              <span className="text-white font-bold text-sm" style={{ fontFamily: "'Outfit', sans-serif" }}>Menu</span>
              <button onClick={() => setSidebarOpen(false)} className="p-2 rounded-lg hover:bg-[#2A3A5E] text-slate-400">
                <X size={18} />
              </button>
            </div>
            <SidebarContent />
          </div>
          <div className="flex-1 bg-black/50" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="bg-white border-b border-slate-200 px-4 lg:px-6 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden p-2 rounded-lg hover:bg-slate-100 text-slate-600"
              onClick={() => setSidebarOpen(true)}
              data-testid="mobile-menu-btn"
            >
              <Menu size={20} />
            </button>
            <div>
              <p className="text-[#1E2A47] font-bold text-sm" style={{ fontFamily: "'Outfit', sans-serif" }}>
                Radhya Micro Finance HR
              </p>
              {user?.employee_id && (
                <p className="text-slate-400 text-xs">{user.employee_id}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <div className="w-8 h-8 rounded-full bg-[#E85B1E] flex items-center justify-center text-white text-sm font-bold overflow-hidden cursor-pointer ring-2 ring-transparent hover:ring-[#E85B1E]/40 transition-all"
              onClick={openProfile}
              data-testid="profile-avatar"
              title="View profile"
            >
              {photoUrl
                ? <img src={photoUrl} alt={user?.name} className="w-full h-full object-cover" />
                : <span>{user?.name?.charAt(0) || "U"}</span>
              }
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 pb-24 lg:p-6 lg:pb-6">
          <Outlet />
        </main>
      </div>

      {/* Profile dropdown panel */}
      {profileOpen && (
        <div className="fixed inset-0 z-[80]" onClick={() => setProfileOpen(false)}>
          <div
            className="absolute top-14 right-4 w-72 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
            onClick={e => e.stopPropagation()}
            data-testid="profile-panel"
          >
            {/* Header */}
            <div className="bg-[#1E2A47] px-5 py-5 flex flex-col items-center gap-2">
              <div className="w-20 h-20 rounded-full overflow-hidden bg-[#E85B1E] flex items-center justify-center text-white text-3xl font-bold border-4 border-white/20 shadow-lg">
                {photoUrl
                  ? <img src={photoUrl} alt={user?.name} className="w-full h-full object-cover" />
                  : <span>{user?.name?.charAt(0) || "U"}</span>
                }
              </div>
              <div className="text-center">
                <p className="text-white font-bold text-base">{user?.name}</p>
                {user?.employee_id && <p className="text-orange-300 text-sm font-mono">{user.employee_id}</p>}
                <p className="text-slate-400 text-xs mt-0.5">{ROLE_LABELS[user?.role] || user?.role}</p>
              </div>
            </div>

            {/* Employee details */}
            {user?.employee_id && (
              <div className="p-4">
                {!profileData ? (
                  <p className="text-slate-400 text-sm text-center py-3">Loading...</p>
                ) : (
                  <div className="space-y-2">
                    {[
                      ["Designation",       profileData.designation],
                      ["Department",        profileData.department],
                      ["Branch",            profileData.branch],
                      ["Reporting Manager", profileData._manager_name || profileData.reporting_to],
                      ["Date of Joining",   profileData.joining_date],
                      ["Blood Group",       profileData.blood_group],
                      ["UAN",               profileData.uan_number],
                      ["ESIC",              profileData.esi_number],
                      ["Bank Account",      profileData.bank_details?.account_number],
                      ["IFSC",              profileData.bank_details?.ifsc_code],
                    ].map(([label, val]) => (
                      <div key={label} className="flex justify-between items-center text-xs border-b border-slate-50 pb-1.5">
                        <span className="text-slate-400 font-medium">{label}</span>
                        <span className={`font-semibold text-right max-w-[60%] ${val ? "text-[#1E2A47]" : "text-slate-300"}`}>
                          {val || "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Logout */}
            <div className="p-3 border-t border-slate-100">
              <button onClick={handleLogout}
                className="w-full py-2 text-sm text-red-600 font-semibold hover:bg-red-50 rounded-lg flex items-center justify-center gap-2 transition-colors"
                data-testid="profile-logout-btn">
                <LogOut size={14} /> Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Navigation */}
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-[60] bg-white border-t border-slate-200 flex items-stretch shadow-[0_-2px_12px_rgba(0,0,0,0.08)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        data-testid="mobile-bottom-nav"
      >
        {mobileNavItems.map(({ path, label, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 flex-1 py-2 min-h-[56px] transition-colors ${
                isActive ? "text-[#E85B1E]" : "text-slate-500 hover:text-slate-700"
              }`
            }
            data-testid={`mobile-nav-${path.replace("/", "")}`}
          >
            {({ isActive }) => (
              <>
                <div className={`p-1.5 rounded-lg transition-colors ${isActive ? "bg-orange-50" : ""}`}>
                  <Icon size={20} />
                </div>
                <span className="text-[10px] font-semibold leading-none">
                  {MOBILE_LABELS[path] || label}
                </span>
              </>
            )}
          </NavLink>
        ))}
        {/* More button to open full menu */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="flex flex-col items-center justify-center gap-1 flex-1 py-2 min-h-[56px] text-slate-500 hover:text-slate-700 transition-colors relative"
          data-testid="mobile-nav-more"
        >
          <div className="p-1.5 rounded-lg relative">
            <Menu size={20} />
            {exitPendingCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full px-0.5 leading-none"
                data-testid="mobile-exit-badge">
                {exitPendingCount > 9 ? "9+" : exitPendingCount}
              </span>
            )}
          </div>
          <span className="text-[10px] font-semibold leading-none">More</span>
        </button>
      </nav>
    </div>
  );
}
