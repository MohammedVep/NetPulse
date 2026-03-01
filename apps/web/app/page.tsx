"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState("");
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
        </div>
      </section>
    </main>
  );
}
