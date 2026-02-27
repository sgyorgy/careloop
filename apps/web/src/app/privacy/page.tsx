"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type PhiType = "email" | "phone" | "address" | "dob" | "id_like";

type PhiFinding = {
  type: PhiType;
  count: number;
  examples: string[];
};

type PrivacyPrefs = {
  // If PHI is detected, block any request that could leave the device (API / cloud) unless redacted first.
  hardGateEnabled: boolean;
  // When hard-gate triggers, automatically send a locally-redacted payload to the API instead of the raw input.
  sendRedactedToApi: boolean;
  // If enabled, avoid persisting any preferences/state (best-effort; browser still may keep caches).
  ephemeralMode: boolean;
};

const PREFS_KEY = "careloop_privacy_prefs_v1";

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Minimal, demo-only client-side redaction. */
function localRedact(text: string): string {
  let t = text;

  // Email
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  // Phone-ish (very rough)
  t = t.replace(
    /(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g,
    "[REDACTED_PHONE]"
  );

  // Address-ish (rough; HU + EN street tokens)
  t = t.replace(
    /\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/gi,
    "[REDACTED_ADDR]"
  );

  // Dates of birth-ish
  t = t.replace(
    /\b(19|20)\d{2}[.\-/ ](0?[1-9]|1[0-2])[.\-/ ](0?[1-9]|[12]\d|3[01])\b/g,
    "[REDACTED_DATE]"
  );

  // ID-like (very rough: long digit sequences)
  t = t.replace(/\b\d{9,}\b/g, "[REDACTED_ID]");

  return t;
}

/** Best-effort local PHI detector (demo only). */
function detectPHI(text: string): PhiFinding[] {
  const findings: PhiFinding[] = [];

  const push = (type: PhiType, matches: RegExpMatchArray | null) => {
    if (!matches || matches.length === 0) return;
    const unique = Array.from(new Set(matches)).slice(0, 3);
    findings.push({ type, count: matches.length, examples: unique });
  };

  // Email
  push("email", text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi));

  // Phone-ish
  push(
    "phone",
    text.match(/(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g)
  );

  // Address-ish
  push(
    "address",
    text.match(
      /\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/gi
    )
  );

  // DOB-ish
  push(
    "dob",
    text.match(/\b(19|20)\d{2}[.\-/ ](0?[1-9]|1[0-2])[.\-/ ](0?[1-9]|[12]\d|3[01])\b/g)
  );

  // ID-like
  push("id_like", text.match(/\b\d{9,}\b/g));

  return findings;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.error ? String(json.error) : `API ${path} failed: ${res.status}`;
    throw new Error(msg);
  }

  return (json ?? {}) as T;
}

const EXAMPLES = [
  "My email is demo.person@example.com and my phone is +36 20 123 4567. Address: Középtemető utca 1.",
  "Lab report: HbA1c 8.2% (ref 4.0–5.6), LDL 4.1 mmol/L (ref <3.0). Patient born 2006-04-18. Call 06-30-555-1234.",
  "Imaging: Mild spinal stenosis at L4-L5. Status post fracture. Contact: test.user+hackathon@domain.hu, 1st Avenue 12. ID: 12345678901",
];

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn";
}) {
  const cls =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : tone === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-slate-200 bg-white text-slate-700";
  return <span className={`rounded-full border px-3 py-1 text-xs shadow-sm ${cls}`}>{children}</span>;
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900">{label}</div>
        {description && <div className="mt-1 text-xs text-slate-600">{description}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full border transition ${
          checked ? "border-slate-900 bg-slate-900" : "border-slate-300 bg-white"
        }`}
        aria-pressed={checked}
      >
        <span
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition ${
            checked ? "left-5" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export default function PrivacyPage() {
  const [text, setText] = useState(EXAMPLES[0]);
  const [mode, setMode] = useState<"local" | "api">("local");
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiRedacted, setApiRedacted] = useState<string | null>(null);
  const [apiPiiDetected, setApiPiiDetected] = useState<boolean | null>(null);

  const [prefs, setPrefs] = useState<PrivacyPrefs>({
    hardGateEnabled: true,
    sendRedactedToApi: true,
    ephemeralMode: true,
  });

  // Load prefs (best-effort).
  useEffect(() => {
    try {
      const stored = safeJsonParse<PrivacyPrefs>(localStorage.getItem(PREFS_KEY));
      if (stored) setPrefs((p) => ({ ...p, ...stored }));
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist prefs unless ephemeral.
  useEffect(() => {
    if (prefs.ephemeralMode) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // ignore
    }
  }, [prefs]);

  const findings = useMemo(() => detectPHI(text), [text]);
  const findingCount = findings.reduce((acc, f) => acc + f.count, 0);
  const hasPHI = findingCount > 0;

  const localOut = useMemo(() => localRedact(text), [text]);

  const cloudBlocked =
    mode === "api" && prefs.hardGateEnabled && hasPHI && !prefs.sendRedactedToApi; // would attempt to send raw PHI

  const payloadPreview = useMemo(() => {
    if (mode !== "api") return null as null | { willSend: "raw" | "locally-redacted" | "blocked"; text: string };
    if (!prefs.hardGateEnabled) return { willSend: "raw", text };
    if (!hasPHI) return { willSend: "raw", text };
    if (prefs.sendRedactedToApi) return { willSend: "locally-redacted", text: localOut };
    return { willSend: "blocked", text: "" };
  }, [mode, prefs.hardGateEnabled, prefs.sendRedactedToApi, hasPHI, text, localOut]);

  async function runApiRedaction() {
    setApiError(null);
    setBusy(true);
    setApiRedacted(null);
    setApiPiiDetected(null);

    try {
      const toSend = payloadPreview?.willSend === "locally-redacted" ? payloadPreview.text : text;

      if (payloadPreview?.willSend === "blocked") {
        throw new Error("Blocked by PHI gate");
      }

      // Backend contract: POST /privacy/redact -> { redacted?: string; text?: string; piiDetected?: boolean }
      const resp = await apiPost<{ redacted?: string; text?: string; piiDetected?: boolean }>("/privacy/redact", {
        text: toSend,
        // helpful hint for backend logs / routing (safe, no content)
        client_mode: payloadPreview?.willSend ?? "raw",
      });

      const out = (resp.redacted ?? resp.text ?? "").toString();
      if (!out.trim()) throw new Error("Empty redaction result.");
      setApiRedacted(out);
      setApiPiiDetected(resp.piiDetected ?? null);
    } catch (e) {
      const msg =
        e instanceof Error && e.message === "Blocked by PHI gate"
          ? "Blocked: PHI detected and the hard gate is enabled. Turn on “Send redacted to API” or remove identifiers."
          : "API redaction failed (or backend not running). Local redaction still works for demo; production should use a strong server-side policy + auditing.";
      setApiError(msg);
    } finally {
      setBusy(false);
    }
  }

  function clearCareLoopStorage() {
    try {
      const keys = Object.keys(localStorage);
      const toRemove = keys.filter((k) =>
        /(careloop|patient|clinician|soap|diary|tasks|demo|visit|report|reports|lab|labs|finding|findings)/i.test(k)
      );
      toRemove.forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem(PREFS_KEY);
      setApiRedacted(null);
      setApiError(null);
      setApiPiiDetected(null);
    } catch {
      // ignore
    }
  }

  function clearAllStorage() {
    const ok = window.confirm("This will clear ALL localStorage for this site (not just CareLoop demo data). Continue?");
    if (!ok) return;
    try {
      localStorage.clear();
      setApiRedacted(null);
      setApiError(null);
      setApiPiiDetected(null);
    } catch {
      // ignore
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Privacy & Safety</h1>
              <Badge tone="good">Synthetic-first</Badge>
              <Badge tone={hasPHI ? "warn" : "good"}>{hasPHI ? "PHI detected (demo text)" : "No PHI detected"}</Badge>
              <Badge>{prefs.ephemeralMode ? "Ephemeral mode" : "Prefs persisted"}</Badge>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-slate-700">
              CareLoop is a prototype. Use <b>synthetic</b> or properly <b>anonymized</b> text/audio/report snippets
              only. This page demonstrates (1) PHI detection, (2) redaction, and (3) a “hard gate” that prevents
              cloud-bound processing unless identifiers are masked first.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              ← Home
            </Link>
            <Link
              href="/patient"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Patient mode
            </Link>
            <Link
              href="/clinician"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Clinician mode
            </Link>
            <Link
              href="/report"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Report interpreter
            </Link>
          </div>
        </header>

        <section className="mt-6 grid gap-6 md:grid-cols-3">
          {/* Main */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
            <h2 className="text-lg font-semibold text-slate-900">PHI gate + Redaction demo</h2>
            <p className="mt-2 text-sm text-slate-700">
              Pick a sample, edit it, and see what gets flagged and masked. The local redaction is intentionally
              minimal; API mode demonstrates a stronger server-side approach (and is what the Report Interpreter should
              rely on for anything that leaves the browser).
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setText(ex);
                    setApiRedacted(null);
                    setApiError(null);
                    setApiPiiDetected(null);
                  }}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                >
                  Sample {i + 1}
                </button>
              ))}
            </div>

            <label className="mt-4 block">
              <span className="text-xs font-semibold text-slate-700">Input text</span>
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setApiRedacted(null);
                  setApiError(null);
                  setApiPiiDetected(null);
                }}
                rows={6}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              />
            </label>

            {/* Findings */}
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs font-semibold text-slate-700">PHI detection (local)</div>
                <div className="text-xs text-slate-500">{hasPHI ? `${findingCount} signal(s) found` : "No signals found"}</div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {hasPHI ? (
                  findings.map((f) => (
                    <span
                      key={f.type}
                      className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-900"
                      title={f.examples.join(" • ")}
                    >
                      {f.type} ×{f.count}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-600">
                    Tip: try adding an email/phone/address/date of birth to see the gate trigger.
                  </span>
                )}
              </div>

              <div className="mt-3 text-xs text-slate-600">
                This detector is best-effort for demos. The correct rule is still: <b>don’t input real PHI</b>.
              </div>
            </div>

            {/* Controls */}
            <div className="mt-4 grid gap-3">
              <Toggle
                label="Hard gate (block external processing when PHI is detected)"
                description="If PHI signals exist, API/cloud calls are blocked unless you send a redacted payload."
                checked={prefs.hardGateEnabled}
                onChange={(v) => setPrefs((p) => ({ ...p, hardGateEnabled: v }))}
              />
              <Toggle
                label="Send locally-redacted payload to API when gate triggers"
                description="If enabled, the app will mask identifiers locally before sending to /api/privacy/redact."
                checked={prefs.sendRedactedToApi}
                onChange={(v) => setPrefs((p) => ({ ...p, sendRedactedToApi: v }))}
              />
              <Toggle
                label="Ephemeral mode"
                description="Do not persist preferences. Recommended for live demos (also consider incognito)."
                checked={prefs.ephemeralMode}
                onChange={(v) => setPrefs((p) => ({ ...p, ephemeralMode: v }))}
              />
            </div>

            {/* Mode switch + action */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
                <button
                  onClick={() => setMode("local")}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    mode === "local" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                  }`}
                >
                  Local only
                </button>
                <button
                  onClick={() => setMode("api")}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    mode === "api" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                  }`}
                >
                  API
                </button>
              </div>

              {mode === "api" && (
                <button
                  onClick={runApiRedaction}
                  disabled={busy || cloudBlocked}
                  className={`rounded-xl px-4 py-2 text-sm font-medium ${
                    busy || cloudBlocked
                      ? "cursor-not-allowed bg-slate-100 text-slate-400"
                      : "bg-slate-900 text-white hover:bg-slate-800"
                  }`}
                  title={
                    cloudBlocked
                      ? "Blocked by PHI gate. Enable 'Send locally-redacted payload' or remove identifiers."
                      : undefined
                  }
                >
                  {busy ? "Running…" : cloudBlocked ? "Blocked by PHI gate" : "Run API redaction"}
                </button>
              )}

              <div className="text-xs text-slate-500">
                {mode === "api" ? (
                  <>
                    Calls <code className="rounded bg-slate-100 px-1">/api/privacy/redact</code>. Use this before sending
                    any report/diary/note content to cloud-backed AI.
                  </>
                ) : (
                  "Runs in-browser only (demo)."
                )}
              </div>
            </div>

            {/* Payload preview */}
            {mode === "api" && payloadPreview && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-700">External-processing preview</div>
                  <Badge
                    tone={
                      payloadPreview.willSend === "raw"
                        ? "warn"
                        : payloadPreview.willSend === "blocked"
                        ? "warn"
                        : "good"
                    }
                  >
                    {payloadPreview.willSend === "raw"
                      ? "Will send: raw"
                      : payloadPreview.willSend === "locally-redacted"
                      ? "Will send: locally redacted"
                      : "Blocked"}
                  </Badge>
                </div>
                <div className="mt-2 text-xs text-slate-600">
                  This is what would leave the browser when you press “Run API redaction”.
                </div>
                {payloadPreview.willSend !== "blocked" && (
                  <div className="mt-3 whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900">
                    {payloadPreview.text}
                  </div>
                )}
              </div>
            )}

            {apiError && (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                {apiError}
              </div>
            )}

            {/* Outputs */}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Local redacted output</div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{localOut}</div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-700">API redacted output</div>
                  {mode === "api" && apiPiiDetected !== null && (
                    <Badge tone={apiPiiDetected ? "warn" : "good"}>
                      {apiPiiDetected ? "Server flagged PII" : "Server: no PII flagged"}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-slate-900">
                  {apiRedacted ?? (
                    <span className="text-slate-500">
                      {mode === "api"
                        ? "Press “Run API redaction” to test the backend."
                        : "Switch to API mode to test the backend redaction."}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Demo hygiene */}
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
              <div className="font-semibold text-slate-700">Demo hygiene</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  <b>Use synthetic data only</b>. This page intentionally uses “PHI-like” samples to show masking.
                </li>
                <li>
                  <b>No content logging</b>: logs should contain timestamps, status codes, and sizes—never raw notes/transcripts/reports.
                </li>
                <li>
                  The hard gate demonstrates “privacy-by-design”: if identifiers appear, the system blocks or redacts before any external processing.
                </li>
              </ul>
            </div>
          </div>

          {/* Sidebar */}
          <aside className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold text-slate-900">Data handling controls</h3>

            <div className="mt-3 space-y-3 text-sm text-slate-700">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold text-slate-700">Storage (demo)</div>
                <div className="mt-1">
                  Recommended: ephemeral + incognito. If other pages store demo state in{" "}
                  <code className="rounded bg-white px-1">localStorage</code> (diary, SOAP, tasks, reports), you can
                  clear it below.
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={clearCareLoopStorage}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                >
                  Clear CareLoop demo data (best-effort)
                </button>
                <button
                  onClick={clearAllStorage}
                  className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-900 hover:bg-rose-100"
                >
                  Clear ALL site localStorage
                </button>
                <div className="text-xs text-slate-500">
                  “Clear CareLoop” removes keys matching: careloop / patient / clinician / soap / diary / tasks / demo /
                  visit / report / labs / findings.
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold text-slate-700">Safety note</div>
                <div className="mt-1">
                  Outputs are informational and not medical advice. Clinical decisions require professional judgment.
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold text-slate-700">Pitch line</div>
                <div className="mt-1">
                  “We don’t just talk about compliance — the app enforces it with a PHI gate + redaction before any external AI processing.”
                </div>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
              Tip: keep API mode OFF during demos unless you’re sure keys/network are stable—local mode still proves the privacy design.
            </div>
          </aside>
        </section>

        <footer className="mt-8 text-xs text-slate-500">
          API calls go to <code className="rounded bg-slate-100 px-1">/api/*</code> (proxy via{" "}
          <code className="rounded bg-slate-100 px-1">API_PROXY_TARGET</code>).
        </footer>
      </div>
    </main>
  );
}
