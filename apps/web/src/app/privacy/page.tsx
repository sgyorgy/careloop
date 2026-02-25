"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

function localRedact(text: string): string {
  let t = text;

  // Email
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  // Phone-ish (very rough)
  t = t.replace(
    /(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g,
    "[REDACTED_PHONE]"
  );

  // Address-ish (very rough; HU + EN street tokens)
  t = t.replace(
    /\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/gi,
    "[REDACTED_ADDR]"
  );

  // Dates of birth-ish (simple patterns)
  t = t.replace(
    /\b(19|20)\d{2}[.\-/ ](0?[1-9]|1[0-2])[.\-/ ](0?[1-9]|[12]\d|3[01])\b/g,
    "[REDACTED_DATE]"
  );

  return t;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

const EXAMPLES = [
  "My email is demo.person@example.com and my phone is +36 20 123 4567. Address: Középtemető utca 1.",
  "Patient born 2006-04-18 reports abdominal pain after dairy. Call 06-30-555-1234.",
  "Contact: test.user+hackathon@domain.hu, 1st Avenue, 12.",
];

export default function PrivacyPage() {
  const [text, setText] = useState(EXAMPLES[0]);
  const [mode, setMode] = useState<"local" | "api">("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiRedacted, setApiRedacted] = useState<string | null>(null);

  const localOut = useMemo(() => localRedact(text), [text]);

  async function runApiRedaction() {
    setError(null);
    setBusy(true);
    setApiRedacted(null);
    try {
      // Expect backend to implement POST /privacy/redact -> { redacted: string } (or { text: string })
      const resp = await apiPost<{ redacted?: string; text?: string }>("/privacy/redact", { text });
      const out = (resp.redacted ?? resp.text ?? "").toString();
      if (!out.trim()) throw new Error("Empty redaction result.");
      setApiRedacted(out);
    } catch {
      setError(
        "API redaction failed (or backend not running). Local redaction still works for demo, but production should use a stronger server-side approach."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
                Privacy & Safety
              </h1>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                No PHI • Synthetic-first
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-slate-700">
              This prototype is designed to avoid storing or processing real personal health information. Use synthetic or
              anonymized data only. The redaction demo below shows how identifiers can be masked before analysis.
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
          </div>
        </header>

        <section className="mt-6 grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
            <h2 className="text-lg font-semibold text-slate-900">Redaction demo</h2>
            <p className="mt-2 text-sm text-slate-700">
              Pick a sample, edit the text, and see identifiers masked. For real compliance, use robust server-side PHI
              handling—this local demo is intentionally simple.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setText(ex);
                    setApiRedacted(null);
                    setError(null);
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
                }}
                rows={6}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              />
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
                <button
                  onClick={() => setMode("local")}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    mode === "local"
                      ? "bg-slate-900 text-white"
                      : "text-slate-800 hover:bg-slate-50"
                  }`}
                >
                  Local
                </button>
                <button
                  onClick={() => setMode("api")}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    mode === "api"
                      ? "bg-slate-900 text-white"
                      : "text-slate-800 hover:bg-slate-50"
                  }`}
                >
                  API
                </button>
              </div>

              {mode === "api" && (
                <button
                  onClick={runApiRedaction}
                  disabled={busy}
                  className={`rounded-xl px-4 py-2 text-sm font-medium ${
                    busy
                      ? "cursor-not-allowed bg-slate-100 text-slate-400"
                      : "bg-slate-900 text-white hover:bg-slate-800"
                  }`}
                >
                  {busy ? "Running…" : "Run API redaction"}
                </button>
              )}

              <div className="text-xs text-slate-500">
                {mode === "api" ? (
                  <>
                    Calls <code className="rounded bg-slate-100 px-1">/api/privacy/redact</code>
                  </>
                ) : (
                  "Runs in-browser (demo only)."
                )}
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                {error}
              </div>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Local redacted output</div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{localOut}</div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">API redacted output</div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-slate-900">
                  {apiRedacted ?? (
                    <span className="text-slate-500">
                      {mode === "api"
                        ? "Click “Run API redaction” to test the backend."
                        : "Switch to API mode to test the backend redaction."}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
              <div className="font-semibold text-slate-700">Important</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Keep demos synthetic/anonymized (no names, emails, phone numbers, addresses, IDs).</li>
                <li>Do not log raw transcripts/notes in production; scrub logs and store only what’s needed.</li>
                <li>
                  Local redaction is intentionally minimal. For real deployments, use a robust server-side policy + audits.
                </li>
              </ul>
            </div>
          </div>

          <aside className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold text-slate-900">Data handling policy</h3>
            <div className="mt-3 space-y-3 text-sm text-slate-700">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold text-slate-700">Storage</div>
                <div className="mt-1">
                  Demo: stores synthetic data in <code className="rounded bg-white px-1">localStorage</code> only.
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold text-slate-700">Retention</div>
                <div className="mt-1">Ephemeral by default; users can clear data anytime.</div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold text-slate-700">Access</div>
                <div className="mt-1">No accounts required for demo. No sharing outside the device.</div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="text-xs font-semibold text-slate-700">Safety</div>
                <div className="mt-1">
                  Outputs are informational and not medical advice. Clinical decisions require professional judgment.
                </div>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
              Tip: In your pitch, say “privacy-by-design” and show this page for bonus points.
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
