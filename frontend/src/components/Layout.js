import React, { useState } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import {
  LayoutDashboard, Users, UserPlus, CalendarCheck, FileText,
  CreditCard, TrendingUp, LogOut, Settings, Menu, X,
  DoorOpen, Award, MapPin, ChevronRight, Bell, User
} from "lucide-react";

const NAV_ITEMS = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["hr_admin", "management", "branch_manager", "employee", "field_agent"] },
  { path: "/candidates", label: "Candidates", icon: UserPlus, roles: ["hr_admin", "management"] },
  { path: "/employees", label: "Employees", icon: Users, roles: ["hr_admin", "management", "branch_manager"] },
  { path: "/attendance", label: "Attendance", icon: CalendarCheck, roles: ["hr_admin", "management", "branch_manager", "employee", "field_agent"] },
  { path: "/leaves", label: "Leaves", icon: FileText, roles: ["hr_admin", "management", "branch_manager", "employee", "field_agent"] },
  { path: "/payroll", label: "Payroll", icon: CreditCard, roles: ["hr_admin", "management", "branch_manager", "employee", "field_agent"] },
  { path: "/performance", label: "Performance", icon: TrendingUp, roles: ["hr_admin", "management", "branch_manager", "employee", "field_agent"] },
  { path: "/exit", label: "Exit", icon: DoorOpen, roles: ["hr_admin", "management", "branch_manager", "employee", "field_agent"] },
  { path: "/letters", label: "Letters", icon: Award, roles: ["hr_admin", "management"] },
  { path: "/gratuity", label: "Gratuity", icon: Award, roles: ["hr_admin", "management"] },
  { path: "/settings", label: "Settings", icon: Settings, roles: ["hr_admin"] },
];

const ROLE_LABELS = {
  hr_admin: "HR Admin",
  management: "Management",
  branch_manager: "Manager",
  employee: "HO Staff",
  field_agent: "Field Staff",
};

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const filteredNav = NAV_ITEMS.filter(item => item.roles.includes(user?.role));

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
              <span>{label}</span>
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
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="w-64 bg-[#1E2A47] flex flex-col h-full shadow-2xl">
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
            <button className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 relative">
              <Bell size={18} />
            </button>
            <div className="w-8 h-8 rounded-full bg-[#E85B1E] flex items-center justify-center text-white text-sm font-bold">
              {user?.name?.charAt(0) || "U"}
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
