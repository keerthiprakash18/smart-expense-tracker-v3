import axios from "axios";
import { Capacitor } from "@capacitor/core";

const AUTH_STORAGE_VERSION = "2026-10-09-cookie-refresh-v1";
const storedAuthVersion = localStorage.getItem("smart_expense_auth_version");
if (storedAuthVersion !== AUTH_STORAGE_VERSION) {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.setItem("smart_expense_auth_version", AUTH_STORAGE_VERSION);
}

const configuredBaseUrl = (import.meta.env.VITE_API_URL || "").trim().replace(/\/$/, "");
const nativeFallback = "https://smart-expense-tracker-v3-production.up.railway.app";

// Web production stays same-origin through Vercel rewrites so the HttpOnly
// refresh cookie is first-party. Native Capacitor builds use VITE_API_URL.
export const API_BASE_URL = Capacitor.isNativePlatform()
  ? (configuredBaseUrl || nativeFallback)
  : (import.meta.env.DEV ? configuredBaseUrl : "");

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 90000,
  withCredentials: true,
  headers: { "X-Requested-With": "XMLHttpRequest" },
});

export const getAccessToken = () => localStorage.getItem("access_token");
export const setTokens = (accessToken) => {
  if (accessToken) localStorage.setItem("access_token", accessToken);
};
export const clearTokens = () => {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
};

export const notifyAuthExpired = () => {
  clearTokens();
  window.dispatchEvent(new CustomEvent("smart-expense-auth-expired"));
};

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  config.headers = config.headers || {};
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers["X-Requested-With"] = "XMLHttpRequest";
  if (config.data instanceof FormData) delete config.headers["Content-Type"];
  return config;
});

let refreshPromise = null;

export const refreshAccessToken = async () => {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_BASE_URL}/api/token/refresh/`, {}, {
        timeout: 30000,
        withCredentials: true,
        headers: { "X-Requested-With": "XMLHttpRequest" },
      })
      .then((response) => {
        const access = response.data?.access;
        if (!access) throw new Error("Refresh response did not include an access token");
        setTokens(access);
        return access;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const url = String(originalRequest?.url || "");
    const isLogin = url.includes("/api/token/") && !url.includes("/api/token/refresh/");
    const isRefreshCall = url.includes("/api/token/refresh/");

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isLogin && !isRefreshCall) {
      originalRequest._retry = true;
      try {
        const access = await refreshAccessToken();
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${access}`;
        return api(originalRequest);
      } catch {
        notifyAuthExpired();
        return Promise.reject(error);
      }
    }

    if (error.response?.status === 401 && isRefreshCall) notifyAuthExpired();
    return Promise.reject(error);
  }
);

export default api;
