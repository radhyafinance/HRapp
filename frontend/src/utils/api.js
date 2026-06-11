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
  return config;
});

API.interceptors.response.use(
  (res) => res,
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
