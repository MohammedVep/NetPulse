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
  const [isJoiningOrg, setIsJoiningOrg] = useState(false);
  const [joinOrgError, setJoinOrgError] = useState<string | null>(null);
  const [joinOrgNotice, setJoinOrgNotice] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(() => hasAuthToken());
  const hasTestingPresets =
    Boolean(config.testAlertEmail) || Boolean(config.testSlackWebhookUrl) || Boolean(config.testWebhookUrl);
  const loadBalancerBaseUrl = config.loadBalancerUrl.trim().replace(/\/$/, "");
  const grafanaDashboardUrl = config.grafanaDashboardUrl.trim();
  const prometheusUrl = config.prometheusUrl.trim();
  const loadBalancerLinks = loadBalancerBaseUrl
    ? {
        healthz: `${loadBalancerBaseUrl}/healthz`,
        backends: `${loadBalancerBaseUrl}/backends`,
        metrics: `${loadBalancerBaseUrl}/metrics`,
        drill: `${loadBalancerBaseUrl}/admin/failure-mode?unhealthy=true`
      }
    : null;

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

  const handleJoinOrganization = async () => {
    if (!orgId.trim()) {
      setJoinOrgError("Organization id is required");
      setJoinOrgNotice(null);
      return;
    }

    if (!hasAuthToken()) {
      setJoinOrgError("Sign in first to join an organization");
      setJoinOrgNotice(null);
      return;
    }

    try {
      setIsJoiningOrg(true);
      setJoinOrgError(null);
      setJoinOrgNotice(null);
      await apiClient.joinOrganization(orgId.trim());
      setJoinOrgNotice("Joined organization as Viewer. Open dashboard to start tracking.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to join organization";
      setJoinOrgError(message);
      setJoinOrgNotice(null);
    } finally {
      setIsJoiningOrg(false);
    }
  };

  return (
    <main>
      <section className="panel soft" style={{ marginTop: 26 }}>
        <span className="pill">Monitoring SaaS · Massive Concurrency + Zero Trust</span>
        <h1 className="hero-title" style={{ marginTop: 14 }}>
          NetPulse Reliability Control Plane
        </h1>
        <p className="small hero-subtitle">
          NetPulse now combines dynamic load balancer service discovery, automatic circuit breaking, Prometheus +
          Grafana observability, PgBouncer-backed write burst handling, and mTLS worker-to-core encryption.
        </p>

        <div className="signal-grid" style={{ marginTop: 8 }}>
          <article className="signal-card">
            <strong>Dynamic Service Discovery</strong>
            <p className="small">Backends auto-register through Consul/etcd and routing updates without restarts.</p>
          </article>
          <article className="signal-card">
            <strong>Active Health + Circuit Breaking</strong>
            <p className="small">Failing nodes are auto-ejected, probed in isolation, then re-admitted on recovery.</p>
          </article>
          <article className="signal-card">
            <strong>Observability Pipeline</strong>
            <p className="small">Live runtime metrics expose connections, latency, and 5xx behavior for drill proof.</p>
          </article>
          <article className="signal-card">
            <strong>PgBouncer Pooling</strong>
            <p className="small">Connection pooling absorbs 10,000+ simulated worker writes without exhausting Postgres.</p>
          </article>
          <article className="signal-card">
            <strong>mTLS Zero-Trust Plane</strong>
            <p className="small">Regional checkers and queue core communicate over cert-authenticated encrypted links.</p>
          </article>
        </div>

        <div className="split-grid" style={{ marginTop: 14 }}>
          <article className="panel soft stack">
            <h2 className="section-head">Runtime Surface</h2>
            {loadBalancerLinks ? (
              <>
                <p className="small" style={{ marginTop: 0 }}>
                  Environment load balancer: <code>{loadBalancerBaseUrl}</code>
                </p>
                <div className="control-row">
                  <a href={loadBalancerLinks.healthz} target="_blank" rel="noreferrer">
                    <code>/healthz</code>
                  </a>
                  <a href={loadBalancerLinks.backends} target="_blank" rel="noreferrer">
                    <code>/backends</code>
                  </a>
                  <a href={loadBalancerLinks.metrics} target="_blank" rel="noreferrer">
                    <code>/metrics</code>
                  </a>
                </div>
                <div className="command">curl {loadBalancerLinks.drill}</div>
                {grafanaDashboardUrl ? (
                  <p className="small" style={{ marginTop: 0 }}>
                    Grafana: <a href={grafanaDashboardUrl}>{grafanaDashboardUrl}</a>
                  </p>
                ) : null}
                {prometheusUrl ? (
                  <p className="small" style={{ marginTop: 0 }}>
                    Prometheus: <a href={prometheusUrl}>{prometheusUrl}</a>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="small" style={{ marginTop: 0 }}>
                Set <code>NEXT_PUBLIC_LOAD_BALANCER_URL</code> to surface live service discovery, routing, and drill
                endpoints in this page.
              </p>
            )}
          </article>

          <article className="panel soft stack">
            <h2 className="section-head">Quick Access</h2>
            <p className="small" style={{ marginTop: 0 }}>
              Session: <span className={`status ${isAuthenticated ? "HEALTHY" : "DEGRADED"}`}>{isAuthenticated ? "AUTHENTICATED" : "ANONYMOUS"}</span>
            </p>
            <div className="input-row">
              <input
                type="text"
                placeholder="org_..."
                value={orgId}
                onChange={(event) => setOrgId(event.currentTarget.value)}
                style={{ minWidth: 280 }}
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
            </div>
            <div className="control-row">
              <button type="button" onClick={() => router.push("/register")}>
                Register Route
              </button>
              <button type="button" disabled={isJoiningOrg} onClick={() => void handleJoinOrganization()}>
                {isJoiningOrg ? "Joining..." : "Join Org as Viewer"}
              </button>
              <button
                type="button"
                onClick={() => {
                  signOut();
                  setIsAuthenticated(false);
                  resetMessages();
                  setJoinOrgError(null);
                  setJoinOrgNotice(null);
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
                    setJoinOrgError(null);
                    setJoinOrgNotice(null);
                  }}
                >
                  Sign Out
                </button>
              ) : null}
            </div>
            {joinOrgError ? <p style={{ color: "var(--down)", margin: 0 }}>{joinOrgError}</p> : null}
            {joinOrgNotice ? <p style={{ color: "var(--ok)", margin: 0 }}>{joinOrgNotice}</p> : null}
          </article>
        </div>
      </section>

      <section className="split-grid" style={{ marginTop: 14 }}>
        <article className="panel stack">
          <h2 className="section-head">Authentication</h2>
          <div className="control-row" style={{ marginBottom: 2 }}>
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
              style={{ minWidth: 250 }}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              style={{ minWidth: 220 }}
            />
            {authMode === "register" ? (
              <input
                type="password"
                placeholder="Confirm Password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                style={{ minWidth: 220 }}
              />
            ) : null}
          </div>

          <div className="control-row">
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
            <div className="panel soft stack">
              <h3 className="section-head">Verify Email</h3>
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

          {authError ? <p style={{ color: "var(--down)", margin: 0 }}>{authError}</p> : null}
          {authNotice ? <p style={{ color: "var(--ok)", margin: 0 }}>{authNotice}</p> : null}
        </article>

        <article className="panel stack">
          <h2 className="section-head">Workspace Bootstrap</h2>
          <p className="small" style={{ marginTop: 0 }}>
            Create a workspace and jump directly into the dashboard. Public demo mode remains read-only.
          </p>
          <div className="input-row">
            <input
              type="text"
              placeholder="Workspace name"
              value={orgName}
              onChange={(event) => setOrgName(event.currentTarget.value)}
              style={{ minWidth: 260 }}
            />
            <button type="button" disabled={isCreatingOrg} onClick={() => void handleCreateWorkspace()}>
              {isCreatingOrg ? "Creating..." : "Create Workspace & Open"}
            </button>
          </div>
          {createOrgError ? <p style={{ color: "var(--down)", margin: 0 }}>{createOrgError}</p> : null}

          {(config.showTestingHints || hasTestingPresets) ? (
            <div className="panel soft stack">
              <h3 className="section-head">Recruiter Test Presets</h3>
              <p className="small" style={{ marginTop: 0 }}>
                Presets are auto-loaded from environment values for quick failure and alert-channel drills.
              </p>
              <p className="small" style={{ margin: 0 }}>
                Email: <code>{config.testAlertEmail || "not configured"}</code>
              </p>
              <p className="small" style={{ margin: 0 }}>
                Slack: <code>{config.testSlackWebhookUrl || "not configured"}</code>
              </p>
              <p className="small" style={{ margin: 0 }}>
                Webhook: <code>{config.testWebhookUrl || "not configured"}</code>
              </p>
            </div>
          ) : null}
        </article>
      </section>
    </main>
  );
}
