// AI-generated. See PROMPT.md for the prompts and model used.

import { LogOut, Search } from "lucide-react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { useLogout } from "./lib/api";
import { AuthProvider, RequireAuth, useAuth } from "./lib/auth";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";
import { RepoView } from "./pages/RepoView";
import { SearchPage } from "./pages/Search";
import { SessionView } from "./pages/SessionView";

const TopBar = () => {
  const { user } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <nav className="border-b border-border px-4 py-2 flex items-center justify-between bg-background">
      <Link to="/" className="font-semibold text-sm tracking-tight">
        Claude Sessions
      </Link>
      <div className="flex items-center gap-3">
        <Link
          to="/search"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <Search size={14} /> Search
        </Link>
        <span className="text-xs text-muted-foreground">{user.email}</span>
        <button
          type="button"
          onClick={async () => {
            await logout.mutateAsync();
            navigate("/login", { replace: true });
          }}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <LogOut size={14} /> Logout
        </button>
      </div>
    </nav>
  );
};

export const App = () => {
  return (
    <AuthProvider>
      <div className="flex flex-col h-full">
        <TopBar />
        <main className="flex-1 min-h-0">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <HomePage />
                </RequireAuth>
              }
            />
            <Route
              path="/repos/:canonical"
              element={
                <RequireAuth>
                  <RepoView />
                </RequireAuth>
              }
            />
            <Route
              path="/sessions/:id"
              element={
                <RequireAuth>
                  <SessionView />
                </RequireAuth>
              }
            />
            <Route
              path="/search"
              element={
                <RequireAuth>
                  <SearchPage />
                </RequireAuth>
              }
            />
            <Route
              path="*"
              element={
                <div className="p-8 text-center text-sm text-muted-foreground">Not found.</div>
              }
            />
          </Routes>
        </main>
      </div>
    </AuthProvider>
  );
};
