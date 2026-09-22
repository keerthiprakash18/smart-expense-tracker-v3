import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

import api, {
  getAccessToken,
  clearTokens,
} from "../services/api";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(() => getAccessToken());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const expire = () => {
      if (!active) return;
      clearTokens();
      setToken(null);
      setLoading(false);
    };

    const validateStoredSession = async () => {
      const existingToken = getAccessToken();
      if (!existingToken) {
        if (active) {
          setToken(null);
          setLoading(false);
        }
        return;
      }

      try {
        // This request also exercises refresh-token recovery through api.js.
        await api.get("/api/profile/");
        if (active) setToken(getAccessToken());
      } catch {
        if (active) {
          clearTokens();
          setToken(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    window.addEventListener("smart-expense-auth-expired", expire);
    validateStoredSession();

    return () => {
      active = false;
      window.removeEventListener("smart-expense-auth-expired", expire);
    };
  }, []);

  const loginUser = (accessToken, refreshToken = null) => {
    if (!accessToken) return;

    setToken(accessToken);

    // Token storage is handled by the login/API layer.
    // This keeps AuthContext focused on authentication state.
  };

  const logoutUser = () => {
    clearTokens();
    setToken(null);
  };

  const refreshAuthState = () => {
    setToken(getAccessToken());
  };

  const isAuthenticated = Boolean(token);

  return (
    <AuthContext.Provider
      value={{
        token,
        isAuthenticated,
        loading,
        loginUser,
        logoutUser,
        refreshAuthState,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error(
      "useAuth must be used inside an AuthProvider"
    );
  }

  return context;
};