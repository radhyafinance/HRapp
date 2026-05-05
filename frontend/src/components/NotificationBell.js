import React, { useEffect, useRef, useState } from "react";
import { Bell, X, Calendar, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import API from "../utils/api";

const POLL_MS = 30_000;

function timeAgo(iso) {
  if (!iso) return "";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const lastNotifiedIdsRef = useRef(new Set());

  const fetch = async () => {
    try {
      const res = await API.get("/notifications", { params: { limit: 30 } });
      setUnread(res.data.unread || 0);
      setItems(res.data.items || []);

      // Fire browser popup for newly-arrived unread items (session only)
      if ("Notification" in window && Notification.permission === "granted") {
        for (const it of res.data.items || []) {
          if (!it.read && !lastNotifiedIdsRef.current.has(it.id)) {
            lastNotifiedIdsRef.current.add(it.id);
            try {
              new Notification(it.title || "Radhya HR", {
                body: it.message || "",
                icon: "/logo192.png",
                tag: it.id,
              });
            } catch (_) { /* ignore */ }
          } else {
            lastNotifiedIdsRef.current.add(it.id);
          }
        }
      }
    } catch (e) { /* quiet */ }
  };

  useEffect(() => {
    fetch();
    const t = setInterval(fetch, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const handleOpen = async () => {
    setOpen(o => !o);
    if (!open) {
      setLoading(true);
      await fetch();
      // Politely ask for browser-notification permission on first click
      if ("Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch (_) { /* ignore */ }
      }
      setLoading(false);
    }
  };

  const markRead = async (id) => {
    try {
      await API.post(`/notifications/${id}/read`);
      setItems(items.map(n => n.id === id ? { ...n, read: true } : n));
      setUnread(u => Math.max(0, u - 1));
    } catch (e) { /* quiet */ }
  };

  const markAllRead = async () => {
    try {
      await API.post("/notifications/read-all");
      setItems(items.map(n => ({ ...n, read: true })));
      setUnread(0);
    } catch (e) { /* quiet */ }
  };

  const handleClick = async (n) => {
    if (!n.read) await markRead(n.id);
    if (n.link) navigate(n.link);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button onClick={handleOpen}
        data-testid="notification-bell"
        className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-[#1E2A47]">
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 bg-[#E85B1E] text-white text-[10px] font-bold rounded-full flex items-center justify-center"
            data-testid="notif-unread-badge">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white border border-slate-200 rounded-xl shadow-xl z-50 max-h-[70vh] overflow-hidden flex flex-col"
            data-testid="notif-panel">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Notifications</h3>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <button onClick={markAllRead} data-testid="mark-all-read-btn"
                    className="text-[11px] px-2 py-1 rounded text-[#E85B1E] hover:bg-[#E85B1E]/10 font-semibold">
                    Mark all read
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-slate-100"><X size={14} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && items.length === 0 ? (
                <p className="text-center text-xs text-slate-400 py-8">Loading…</p>
              ) : items.length === 0 ? (
                <p className="text-center text-xs text-slate-400 py-10">You're all caught up 🎉</p>
              ) : (
                items.map(n => (
                  <button key={n.id} onClick={() => handleClick(n)}
                    data-testid={`notif-item-${n.id}`}
                    className={`w-full text-left px-4 py-3 border-b border-slate-100 last:border-b-0 flex gap-3 items-start transition-colors ${n.read ? "bg-white hover:bg-slate-50" : "bg-orange-50/50 hover:bg-orange-50"}`}>
                    <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${n.type === "interview" ? "bg-violet-100 text-violet-600" : "bg-slate-100 text-slate-500"}`}>
                      {n.type === "interview" ? <Users size={14} /> : <Calendar size={14} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 justify-between">
                        <p className={`text-sm truncate ${n.read ? "text-slate-600" : "font-semibold text-[#1E2A47]"}`}>{n.title}</p>
                        {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-[#E85B1E] flex-shrink-0" />}
                      </div>
                      <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">{n.message}</p>
                      <p className="text-[10px] text-slate-400 mt-1">{timeAgo(n.created_at)}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
