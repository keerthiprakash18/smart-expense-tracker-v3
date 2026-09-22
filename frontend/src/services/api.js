import axios from "axios";

const AUTH_STORAGE_VERSION = "2026-09-22-reset-v2";
const storedAuthVersion = localStorage.getItem("smart_expense_auth_version");
if (storedAuthVersion !== AUTH_STORAGE_VERSION) {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.setItem("smart_expense_auth_version", AUTH_STORAGE_VERSION);
}

const configuredBaseUrl = (import.meta.env.VITE_API_URL || "").trim().replace(/\/$/, "");

// Development uses Vite's /api proxy when VITE_API_URL is omitted.
// Production/Capacitor should set VITE_API_URL at build time; Railway is the safe fallback.
export const API_BASE_URL =
  configuredBaseUrl ||
  (import.meta.env.DEV ? "" : "https://smart-expense-tracker-v3-production.up.railway.app");

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 90000,
});

export const getAccessToken = () => localStorage.getItem("access_token");
export const getRefreshToken = () => localStorage.getItem("refresh_token");

export const setTokens = (accessToken, refreshToken = null) => {
  if (accessToken) localStorage.setItem("access_token", accessToken);
  if (refreshToken) localStorage.setItem("refresh_token", refreshToken);
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

  // Let Axios/browser generate the multipart boundary.
  if (config.data instanceof FormData) {
    delete config.headers["Content-Type"];
  }
  return config;
});

let refreshPromise = null;

const refreshAccessToken = async () => {
  const refresh = getRefreshToken();
  if (!refresh) throw new Error("No refresh token available");

  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_BASE_URL}/api/token/refresh/`, { refresh }, { timeout: 30000 })
      .then((response) => {
        const access = response.data?.access;
        if (!access) throw new Error("Refresh response did not include an access token");
        setTokens(access, response.data?.refresh || refresh);
        return access;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthEndpoint = String(originalRequest?.url || "").includes("/api/token/");

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isAuthEndpoint &&
      getRefreshToken()
    ) {
      originalRequest._retry = true;
      try {
        const access = await refreshAccessToken();
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${access}`;
        return api(originalRequest);
      } catch {
        notifyAuthExpired();
      }
    } else if (error.response?.status === 401 && !isAuthEndpoint) {
      notifyAuthExpired();
    }

    return Promise.reject(error);
  }
);

export default api;
