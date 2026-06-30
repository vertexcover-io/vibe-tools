// AI-generated. See PROMPT.md for the prompts and model used.

import { type ReactNode, createContext, useContext } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useMe } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true });

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const me = useMe();
  const value: AuthState = {
    user: me.data?.user ?? null,
    loading: me.isLoading,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthState => useContext(AuthContext);

export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
};
