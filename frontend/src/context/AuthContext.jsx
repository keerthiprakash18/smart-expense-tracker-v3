import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  getAccessToken,
  clearTokens,
} from "../services/api";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(() => getAccessToken());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const existingToken = getAccessToken();
    setToken(existingToken);
    setLoading(false);
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