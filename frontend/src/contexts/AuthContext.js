import React, { createContext, useContext, useState, useEffect, useMemo } from "react";
import API from "../utils/api";

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

  const login = async (username, password) => {
    const res = await API.post("/auth/login", { username, password });
    const { access_token, user: userData } = res.data;
    localStorage.setItem("auth_token", access_token);
    localStorage.setItem("auth_user", JSON.stringify(userData));
    setUser(userData);
    return userData;
  };

  const loginWithToken = (access_token, userData) => {
    localStorage.setItem("auth_token", access_token);
    localStorage.setItem("auth_user", JSON.stringify(userData));
    setUser(userData);
    return userData;
  };

  const logout = () => {
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
