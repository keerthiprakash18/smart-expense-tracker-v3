import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import api, {
  getAccessToken,
  clearTokens,
} from "../services/api";
import { isSupabaseMode, supabase, supabaseConfigurationError, getRecoveryUserId } from '../services/supabaseClient';
import { readSupabaseAuthState } from '../services/supabaseAuth';

const AuthContext = createContext(null);

const LegacyAuthProvider = ({ children }) => {
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

  const loginUser = (accessToken, _refreshToken = null) => {
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

function SupabaseAuthProvider({ children }) {
  // A stored Django token never authenticates a Supabase route.
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [mfaFactors, setMfaFactors] = useState([]);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [authError, setAuthError] = useState('');
  const syncRef = useRef(async () => false);

  useEffect(() => {
    let active = true;
    let revision = 0;
    let timer;
    if (!supabase) {
      setAuthError(supabaseConfigurationError?.message || 'Supabase is not configured.');
      setLoading(false);
      return undefined;
    }
    const synchronize = async () => {
      const request = ++revision;
      try {
        const initialized = await supabase.auth.initialize();
        if (initialized.error) throw initialized.error;
        const state = await readSupabaseAuthState();
        if (!active || request !== revision) return false;
        const recovering = Boolean(state.session && getRecoveryUserId() === state.session.user.id);
        setRecoveryPending(recovering);
        setNeedsMfa(state.needsMfa);
        setMfaFactors(state.factors);
        setToken(state.authenticated && !recovering ? state.session.access_token : null);
        setAuthError('');
        return state.authenticated && !recovering;
      } catch (error) {
        if (active && request === revision) {
          setToken(null);
          setAuthError(error.message || 'Unable to validate your session. Please sign in again.');
        }
        return false;
      } finally {
        if (active && request === revision) setLoading(false);
      }
    };
    syncRef.current = synchronize;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      // This callback must stay synchronous: invoking Auth methods here can
      // deadlock the SDK's session lock. Defer validation to a later task.
      ++revision;
      clearTimeout(timer);
      if (event === 'SIGNED_OUT') {
        setToken(null);
        setNeedsMfa(false);
        setMfaFactors([]);
        setRecoveryPending(false);
        setLoading(false);
        return;
      }
      if (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') {
        setToken(null);
        setLoading(true);
      }
      timer = setTimeout(() => { void synchronize(); }, 0);
    });
    const expire = () => {
      ++revision;
      clearTimeout(timer);
      setToken(null);
      setNeedsMfa(false);
      setRecoveryPending(false);
      setLoading(false);
      void supabase.auth.signOut({ scope: 'local' })
        .then(({ error }) => { if (active && error) setAuthError(`Session expired; sign-out could not complete: ${error.message}`); })
        .catch((error) => { if (active) setAuthError(`Session expired; sign-out could not complete: ${error.message}`); });
    };
    window.addEventListener('smart-expense-auth-expired', expire);
    void synchronize();
    return () => {
      active = false;
      ++revision;
      clearTimeout(timer);
      subscription.unsubscribe();
      window.removeEventListener('smart-expense-auth-expired', expire);
      syncRef.current = async () => false;
    };
  }, []);

  const logoutUser = () => {
    setToken(null);
    setNeedsMfa(false);
    setRecoveryPending(false);
    // Existing shell callers do not await logoutUser. Keep failures visible on
    // the login screen instead of creating an unhandled promise rejection.
    if (supabase) void supabase.auth.signOut({ scope: 'local' })
      .then(({ error }) => { if (error) setAuthError(`Sign-out could not complete: ${error.message}`); })
      .catch((error) => setAuthError(`Sign-out could not complete: ${error.message}`));
  };
  const refreshAuthState = () => syncRef.current();
  return <AuthContext.Provider value={{
    token, isAuthenticated: Boolean(token), loading, needsMfa, mfaFactors,
    recoveryPending, authError, loginUser: refreshAuthState, logoutUser, refreshAuthState,
  }}>{children}</AuthContext.Provider>;
}

export const AuthProvider = ({ children }) => isSupabaseMode
  ? <SupabaseAuthProvider>{children}</SupabaseAuthProvider>
  : <LegacyAuthProvider>{children}</LegacyAuthProvider>;

export const useAuth = () => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error(
      "useAuth must be used inside an AuthProvider"
    );
  }

  return context;
};
