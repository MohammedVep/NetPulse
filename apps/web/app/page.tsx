"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { config } from "@/lib/config";

export default function HomePage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState(config.demoOrgId);
  const [token, setToken] = useState("");

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
          <input
            type="password"
            placeholder="Cognito JWT token (optional)"
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            style={{ minWidth: 320 }}
          />
          <button
            type="button"
            onClick={() => {
              if (!orgId.trim()) return;
              if (token.trim()) {
                window.localStorage.setItem("netpulse_token", token.trim());
              }
              router.push(`/org/${encodeURIComponent(orgId.trim())}`);
            }}
          >
            Open Dashboard
          </button>
          <button
            type="button"
            onClick={() => {
              window.localStorage.removeItem("netpulse_token");
              router.push(`/org/${encodeURIComponent(config.demoOrgId)}`);
            }}
          >
            Open Public Demo
          </button>
        </div>
        <p className="small" style={{ marginTop: 10 }}>
          Public demo is read-only and does not require login.
        </p>
      </section>
    </main>
  );
}
