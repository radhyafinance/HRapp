import axios from "axios";

const API = axios.create({
  baseURL: `${process.env.REACT_APP_BACKEND_URL}/api`,
  headers: { "Content-Type": "application/json" },
});

API.interceptors.request.use((config) => {
  const token = localStorage.getItem("auth_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // When sending FormData, remove the default Content-Type so the browser
  // sets it automatically with the correct multipart boundary.
  if (config.data instanceof FormData) {
    delete config.headers["Content-Type"];
  }
  return config;
});

API.interceptors.response.use(
  (res) => {
    // After a successful punch-in/out, reconcile GPS tracking (native app only).
    // Dynamic import avoids a circular dependency with fieldTracking.js.
    const url = res.config?.url || "";
    if (url.includes("/attendance/punch-in") || url.includes("/attendance/punch-out")) {
      import("./fieldTracking").then((m) => m.syncFieldTracking()).catch(() => {});
    }
    return res;
  },
  (err) => {
    // Only force-logout on 401 if it's NOT the login endpoint itself.
    // A failed login returns 401 too — we must let the login page handle that
    // via its own catch block instead of triggering a hard page reload.
    const isAuthEndpoint =
      err.config?.url?.includes("/auth/login") ||
      err.config?.url?.includes("/auth/otp") ||
      err.config?.url?.includes("/auth/forgot-password");
    if (err.response?.status === 401 && !isAuthEndpoint) {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default API;
