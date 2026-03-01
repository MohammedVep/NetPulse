"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  confirmSignUp,
  resendSignUpCode,
  signInWithPassword,
  signUpWithPassword
} from "@/lib/cognito-auth";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [needsVerification, setNeedsVerification] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resetMessages = () => {
    setError(null);
    setNotice(null);
  };

  const handleRegister = async () => {
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 10) {
      setError("Password must be at least 10 characters");
      return;
    }

    try {
      setIsBusy(true);
      resetMessages();
      const signup = await signUpWithPassword(email.trim(), password);

      if (signup.userConfirmed) {
        await signInWithPassword(email.trim(), password);
        router.push("/");
        return;
      }

      setNeedsVerification(true);
      setNotice("Registration created. Enter the verification code sent to your email.");
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : "Registration failed";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!email.trim() || !password.trim() || !verificationCode.trim()) {
      setError("Email, password, and verification code are required");
      return;
    }

    try {
      setIsBusy(true);
      resetMessages();
      await confirmSignUp(email.trim(), verificationCode.trim());
      await signInWithPassword(email.trim(), password);
      router.push("/");
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : "Verification failed";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleResend = async () => {
    if (!email.trim()) {
      setError("Email is required to resend code");
      return;
    }

    try {
      setIsBusy(true);
      resetMessages();
      await resendSignUpCode(email.trim());
      setNotice("Verification code resent");
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : "Could not resend code";
      setError(message);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <main>
      <section className="panel" style={{ marginTop: 40, maxWidth: 780 }}>
        <h1 style={{ marginTop: 0 }}>Create NetPulse Account</h1>
        <p className="small">
          Register with email and password. We will send a verification code to activate your account.
        </p>

        <div className="input-row" style={{ marginTop: 12 }}>
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
          <input
            type="password"
            placeholder="Confirm Password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.currentTarget.value)}
            style={{ minWidth: 280 }}
          />
        </div>

        <div className="input-row" style={{ marginTop: 12 }}>
          <button type="button" disabled={isBusy} onClick={() => void handleRegister()}>
            {isBusy ? "Registering..." : "Create Account"}
          </button>
          <button type="button" onClick={() => router.push("/")}>
            Back to Home
          </button>
        </div>

        {needsVerification ? (
          <div className="panel" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Verify Email</h2>
            <div className="input-row">
              <input
                type="text"
                placeholder="Verification code"
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.currentTarget.value)}
                style={{ minWidth: 260 }}
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

        {error ? <p style={{ color: "var(--down)", marginTop: 10 }}>{error}</p> : null}
        {notice ? <p style={{ color: "var(--ok)", marginTop: 10 }}>{notice}</p> : null}
      </section>
    </main>
  );
}
