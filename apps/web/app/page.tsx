"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { config } from "@/lib/config";
import { apiClient, hasAuthToken } from "@/lib/netpulse-client";
import {
  confirmSignUp,
  resendSignUpCode,
  signInWithPassword,
  signOut,
  signUpWithPassword
} from "@/lib/cognito-auth";

type AuthMode = "signin" | "register";

export default function HomePage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState(config.demoOrgId);
  const [orgName, setOrgName] = useState(config.defaultWorkspaceName);

  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [needsVerification, setNeedsVerification] = useState(false);

  const [isBusy, setIsBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [isCreatingOrg, setIsCreatingOrg] = useState(false);
  const [createOrgError, setCreateOrgError] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(() => hasAuthToken());
  const hasTestingPresets =
    Boolean(config.testAlertEmail) || Boolean(config.testSlackWebhookUrl) || Boolean(config.testWebhookUrl);
  const loadBalancerBaseUrl = config.loadBalancerUrl.trim().replace(/\/$/, "");
  const grafanaDashboardUrl = config.grafanaDashboardUrl.trim();
  const prometheusUrl = config.prometheusUrl.trim();

  const resetMessages = () => {
    setAuthError(null);
    setAuthNotice(null);
  };

  const handleSignIn = async () => {
    if (!email.trim() || !password.trim()) {
      setAuthError("Email and password are required");
      return;
    }

    try {
      setIsBusy(true);
      resetMessages();
      await signInWithPassword(email.trim(), password);
      setIsAuthenticated(true);
      setNeedsVerification(false);
      setAuthNotice("Signed in successfully");
      if (orgId.trim()) {
        router.push(`/org/${encodeURIComponent(orgId.trim())}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed";
      setAuthError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleRegister = async () => {
    if (!email.trim() || !password.trim()) {
      setAuthError("Email and password are required");
      return;
    }

    if (password !== confirmPassword) {
      setAuthError("Passwords do not match");
      return;
    }

    if (password.length < 10) {
      setAuthError("Password must be at least 10 characters");
      return;
    }

    try {
      setIsBusy(true);
      resetMessages();
      const signup = await signUpWithPassword(email.trim(), password);
      if (signup.userConfirmed) {
        await signInWithPassword(email.trim(), password);
        setIsAuthenticated(true);
        setNeedsVerification(false);
        setAuthNotice("Account created and signed in");
      } else {
        setNeedsVerification(true);
        setAuthNotice("Registration created. Enter the verification code from your email.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Registration failed";
      setAuthError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!email.trim() || !verificationCode.trim() || !password.trim()) {
      setAuthError("Email, verification code, and password are required");
      return;
    }

    try {
      setIsBusy(true);
      resetMessages();
      await confirmSignUp(email.trim(), verificationCode.trim());
      await signInWithPassword(email.trim(), password);
      setIsAuthenticated(true);
      setNeedsVerification(false);
      setAuthNotice("Email verified and signed in");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verification failed";
      setAuthError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleResend = async () => {
    if (!email.trim()) {
      setAuthError("Email is required to resend verification code");
      return;
    }

    try {
      setIsBusy(true);
      resetMessages();
      await resendSignUpCode(email.trim());
      setAuthNotice("Verification code resent");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not resend verification code";
      setAuthError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!hasAuthToken()) {
      setCreateOrgError("Sign in first to create a workspace");
      return;
    }

    if (!orgName.trim()) {
      setCreateOrgError("Workspace name is required");
      return;
    }

    try {
      setIsCreatingOrg(true);
      setCreateOrgError(null);
      const organization = await apiClient.createOrganization(orgName.trim());
      setOrgId(organization.orgId);
      router.push(`/org/${encodeURIComponent(organization.orgId)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create workspace";
      setCreateOrgError(message);
    } finally {
      setIsCreatingOrg(false);
    }
  };

  return (
    <main>
      <section className="panel" style={{ marginTop: 40 }}>
        <h1 style={{ marginTop: 0, fontSize: "clamp(2rem, 6vw, 3.4rem)" }}>NetPulse</h1>
        <p className="small" style={{ maxWidth: 720 }}>
          I built a distributed uptime monitoring system similar to Datadog.
          NetPulse provides multi-region checks, SLA tracking, failure simulation, live incident streams,
          and alert fanout across email, Slack, and generic webhooks.
        </p>
        <div className="panel" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>Reliability Upgrade Highlights</h2>
          <ul style={{ marginTop: 0 }}>
            <li className="small">
              Implemented PgBouncer for advanced PostgreSQL connection pooling, preventing database connection
              exhaustion during simulated spikes of 10,000+ concurrent regional worker writes.
            </li>
            <li className="small">
              Enforced Zero-Trust architecture by establishing Mutual TLS (mTLS) encryption between distributed
              regional checkers and the centralized monitoring engine.
            </li>
          </ul>
        </div>
        {config.showTestingHints || hasTestingPresets ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <h2 style={{ marginTop: 0 }}>Recruiter Testing Presets</h2>
            <p className="small" style={{ marginTop: 0 }}>
              Sign in, create a workspace, then open the dashboard to use prefilled alert-channel test values.
            </p>
            <p className="small" style={{ marginTop: 0 }}>
              Preset email: <code>{config.testAlertEmail || "not configured"}</code>
            </p>
            <p className="small" style={{ marginTop: 0 }}>
              Preset Slack webhook: <code>{config.testSlackWebhookUrl || "not configured"}</code>
            </p>
            <p className="small" style={{ marginTop: 0 }}>
              Preset generic webhook: <code>{config.testWebhookUrl || "not configured"}</code>
            </p>
          </div>
        ) : null}
        {loadBalancerBaseUrl ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <h2 style={{ marginTop: 0 }}>Load Balancer Drill Surface</h2>
            <p className="small" style={{ marginTop: 0 }}>
              Dynamic service discovery + circuit breaker endpoints are live for this environment.
            </p>
            <p className="small" style={{ marginTop: 0 }}>
              URL: <code>{loadBalancerBaseUrl}</code>
            </p>
            <div className="input-row">
              <a href={`${loadBalancerBaseUrl}/healthz`} target="_blank" rel="noreferrer">
                <code>/healthz</code>
              </a>
              <a href={`${loadBalancerBaseUrl}/backends`} target="_blank" rel="noreferrer">
                <code>/backends</code>
              </a>
              <a href={`${loadBalancerBaseUrl}/metrics`} target="_blank" rel="noreferrer">
                <code>/metrics</code>
              </a>
            </div>
            {grafanaDashboardUrl ? (
              <p className="small" style={{ marginTop: 10 }}>
                Grafana:{" "}
                <a href={grafanaDashboardUrl} target="_blank" rel="noreferrer">
                  <code>{grafanaDashboardUrl}</code>
                </a>
              </p>
            ) : null}
            {prometheusUrl ? (
              <p className="small" style={{ marginTop: 0 }}>
                Prometheus:{" "}
                <a href={prometheusUrl} target="_blank" rel="noreferrer">
                  <code>{prometheusUrl}</code>
                </a>
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="input-row" style={{ marginTop: 16 }}>
          <input
            type="text"
            placeholder="org_..."
            value={orgId}
            onChange={(event) => setOrgId(event.currentTarget.value)}
            style={{ minWidth: 320 }}
          />
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
            onClick={() => router.push("/register")}
          >
            Register
          </button>
          <button
            type="button"
            onClick={() => {
              signOut();
              setIsAuthenticated(false);
              resetMessages();
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
                resetMessages();
              }}
            >
              Sign Out
            </button>
          ) : null}
        </div>

        <div className="panel" style={{ marginTop: 18 }}>
          <h2 style={{ marginTop: 0 }}>Authentication</h2>
          <div className="input-row" style={{ marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => {
                setAuthMode("signin");
                setNeedsVerification(false);
                resetMessages();
              }}
              style={{ opacity: authMode === "signin" ? 1 : 0.7 }}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode("register");
                resetMessages();
              }}
              style={{ opacity: authMode === "register" ? 1 : 0.7 }}
            >
              Register
            </button>
          </div>

          <div className="input-row">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              style={{ minWidth: 280 }}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              style={{ minWidth: 280 }}
            />
            {authMode === "register" ? (
              <input
                type="password"
                placeholder="Confirm Password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                style={{ minWidth: 280 }}
              />
            ) : null}
          </div>

          <div className="input-row" style={{ marginTop: 12 }}>
            {authMode === "signin" ? (
              <button type="button" disabled={isBusy} onClick={() => void handleSignIn()}>
                {isBusy ? "Signing In..." : "Sign In"}
              </button>
            ) : (
              <button type="button" disabled={isBusy} onClick={() => void handleRegister()}>
                {isBusy ? "Registering..." : "Create Account"}
              </button>
            )}
          </div>

          {needsVerification ? (
            <div className="panel" style={{ marginTop: 12 }}>
              <h3 style={{ marginTop: 0 }}>Verify Email</h3>
              <div className="input-row">
                <input
                  type="text"
                  placeholder="Verification code"
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.currentTarget.value)}
                />
                <button type="button" disabled={isBusy} onClick={() => void handleConfirm()}>
                  Confirm & Sign In
                </button>
                <button type="button" disabled={isBusy} onClick={() => void handleResend()}>
                  Resend Code
                </button>
              </div>
            </div>
          ) : null}

          {authError ? <p style={{ color: "var(--down)", marginTop: 10 }}>{authError}</p> : null}
          {authNotice ? <p style={{ color: "var(--ok)", marginTop: 10 }}>{authNotice}</p> : null}
        </div>

        <div className="panel" style={{ marginTop: 18 }}>
          <h2 style={{ marginTop: 0 }}>Get Started Faster</h2>
          <p className="small" style={{ marginTop: 0 }}>
            After signing in, create a workspace and open it immediately.
          </p>
          <div className="input-row">
            <input
              type="text"
              placeholder="Workspace name"
              value={orgName}
              onChange={(event) => setOrgName(event.currentTarget.value)}
              style={{ minWidth: 320 }}
            />
            <button type="button" disabled={isCreatingOrg} onClick={() => void handleCreateWorkspace()}>
              {isCreatingOrg ? "Creating..." : "Create Workspace & Open"}
            </button>
          </div>
          {createOrgError ? <p style={{ color: "var(--down)", marginTop: 10 }}>{createOrgError}</p> : null}
        </div>

        <p className="small" style={{ marginTop: 12 }}>
          Public demo is read-only and does not require login.
        </p>
      </section>
    </main>
  );
}
