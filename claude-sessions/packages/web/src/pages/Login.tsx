// AI-generated. See PROMPT.md for the prompts and model used.

import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useLogin } from "../lib/api";
import { useAuth } from "../lib/auth";

export const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading } = useAuth();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login.mutateAsync({ email, password });
      navigate("/", { replace: true });
    } catch {
      // error message is rendered below
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 bg-card border border-border rounded-lg p-6"
      >
        <div>
          <h1 className="text-xl font-semibold">Claude Sessions</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to view your sessions.</p>
        </div>
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded border border-border bg-background"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded border border-border bg-background"
          />
        </label>
        {login.isError && (
          <div className="text-sm text-red-500" data-testid="login-error">
            {login.error instanceof Error ? login.error.message : "Login failed"}
          </div>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full px-3 py-2 rounded bg-foreground text-background font-medium disabled:opacity-50"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
};
