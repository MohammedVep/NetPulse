"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { config } from "@/lib/config";
import { hasAuthToken } from "@/lib/netpulse-client";
import { signInWithPassword, signOut } from "@/lib/cognito-auth";

export default function HomePage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState(config.demoOrgId);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(() => hasAuthToken());

  return (
    <main>
      <section className="panel" style={{ marginTop: 40 }}>
        <h1 style={{ marginTop: 0, fontSize: "clamp(2rem, 6vw, 3.4rem)" }}>NetPulse</h1>
        <p className="small" style={{ maxWidth: 640 }}>
          I built a distributed uptime monitoring system similar to Datadog.
          NetPulse provides multi-region checks, SLA tracking, failure simulation, live incident streams,
          and alert fanout across email, Slack, and generic webhooks.
        </p>

        <div className="input-row" style={{ marginTop: 16 }}>
          <input
            type="text"
            placeholder="org_..."
            value={orgId}
            onChange={(event) => setOrgId(event.currentTarget.value)}
            style={{ minWidth: 320 }}
          />
        </div>

        <div className="input-row" style={{ marginTop: 12 }}>
          <input
            type="email"
            placeholder="Cognito username/email"
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            style={{ minWidth: 320 }}
          />
          <input
            type="password"
            placeholder="Cognito password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            style={{ minWidth: 320 }}
          />
          <button
            type="button"
            disabled={isSigningIn}
            onClick={async () => {
              if (!orgId.trim() || !email.trim() || !password.trim()) {
                setAuthError("Org ID, username/email, and password are required");
                return;
              }

              try {
                setIsSigningIn(true);
                setAuthError(null);
                await signInWithPassword(email.trim(), password);
                setIsAuthenticated(true);
                router.push(`/org/${encodeURIComponent(orgId.trim())}`);
              } catch (error) {
                const message = error instanceof Error ? error.message : "Login failed";
                setAuthError(message);
              } finally {
                setIsSigningIn(false);
              }
            }}
          >
            {isSigningIn ? "Signing In..." : "Sign In & Open Dashboard"}
          </button>
        </div>

        <div className="input-row" style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => {
              if (!orgId.trim()) return;
              router.push(`/org/${encodeURIComponent(orgId.trim())}`);
            }}
          >
            Open Dashboard
          </button>
          <button
            type="button"
            onClick={() => {
              signOut();
              setIsAuthenticated(false);
              setAuthError(null);
              router.push(`/org/${encodeURIComponent(config.demoOrgId)}`);
            }}
          >
            Open Public Demo
          </button>
          {isAuthenticated ? (
            <button
              type="button"
              onClick={() => {
                signOut();
                setIsAuthenticated(false);
              }}
            >
              Sign Out
            </button>
          ) : null}
        </div>

        {authError ? <p style={{ color: "var(--down)", marginTop: 10 }}>{authError}</p> : null}

        <p className="small" style={{ marginTop: 10 }}>
          Public demo is read-only and does not require login.
        </p>
      </section>
    </main>
  );
}
