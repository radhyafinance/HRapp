import React, { createContext, useContext, useState, useEffect, useMemo } from "react";
import API from "../utils/api";
import { initFieldTracking, stopFieldTracking } from "../utils/fieldTracking";
import { initPush } from "../utils/pushNotifications";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    const stored = localStorage.getItem("auth_user");
    if (token && stored) {
      setUser(JSON.parse(stored));
    }
    setLoading(false);
  }, []);

  // Start GPS field tracking once a user is signed in (native app only; no-op
  // in the browser). Idempotent — safe to run on every auth change.
  useEffect(() => {
    if (user) {
      initFieldTracking();
      initPush();
    }
  }, [user]);

  const login = async (username, password) => {
    const res = await API.post("/auth/login", { username, password });
    const { access_token, user: userData, must_change_password } = res.data;
    // Always store the token (needed for forced-password-change API call)
    localStorage.setItem("auth_token", access_token);
    if (!must_change_password) {
      localStorage.setItem("auth_user", JSON.stringify(userData));
      setUser(userData);
    }
    // Return full data including must_change_password so Login page can decide
    return { ...userData, must_change_password: !!must_change_password };
  };

  const loginWithToken = (access_token, userData) => {
    localStorage.setItem("auth_token", access_token);
    localStorage.setItem("auth_user", JSON.stringify(userData));
    setUser(userData);
    return userData;
  };

  const logout = () => {
    stopFieldTracking();
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
    setUser(null);
  };

  const updateUser = (updates) => {
    const updated = { ...user, ...updates };
    localStorage.setItem("auth_user", JSON.stringify(updated));
    setUser(updated);
  };

  const contextValue = useMemo(
    () => ({ user, login, loginWithToken, logout, loading, updateUser }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, loading]
  );

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
