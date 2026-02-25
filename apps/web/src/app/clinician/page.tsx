"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

const LS_KEYS = {
  transcript: "careloop.demoTranscript.v1",
  loadedAt: "careloop.demoLoadedAt.v1",
  tasks: "careloop.planTasks.v1",
} as const;

type EvidenceSpan = {
  section?: "subjective" | "objective" | "assessment" | "plan" | string;
  text?: string; // the SOAP sentence/snippet
  start?: number; // start index in transcript
  end?: number; // end index in transcript
};

type SoapNote = {
  subjective: string[] | string;
  objective: string[] | string;
  assessment: string[] | string;
  plan: string[] | string;
  evidence?: EvidenceSpan[];
};

const SoapSchema = z.object({
  subjective: z.union([z.array(z.string()), z.string()]),
  objective: z.union([z.array(z.string()), z.string()]),
  assessment: z.union([z.array(z.string()), z.string()]),
  plan: z.union([z.array(z.string()), z.string()]),
  evidence: z
    .array(
      z.object({
        section: z.string().optional(),
        text: z.string().optional(),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
      })
    )
    .optional(),
});

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function localRedact(text: string): string {
  let t = text;

  // email
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  // phone-ish
  t = t.replace(
    /(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g,
    "[REDACTED_PHONE]"
  );
  // addresses-ish (very rough)
  t = t.replace(
    /\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/gi,
    "[REDACTED_ADDR]"
  );

  return t;
}

function asLines(v: string[] | string): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s)).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  // split on newlines or bullet-ish separators
  const parts = s
    .split(/\n|•|\u2022|-/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [s];
}

function planToTasks(plan: string[] | string): string[] {
  const lines = asLines(plan);
  // light cleanup: drop too-short fragments
  return lines.map((x) => x.replace(/^\d+\.\s*/, "").trim()).filter((x) => x.length >= 3).slice(0, 20);
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

async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ClinicianPage() {
  const [transcript, setTranscript] = useState("");
  const [soap, setSoap] = useState<SoapNote | null>(null);
  const [activeView, setActiveView] = useState<"render" | "json" | "evidence">("render");

  const [audioFile, setAudioFile] = useState<File | null>(null);

  const [redactBeforeProcessing, setRedactBeforeProcessing] = useState(true);
  const [busy, setBusy] = useState<{ transcribe: boolean; generate: boolean; send: boolean }>({
    transcribe: false,
    generate: false,
    send: false,
  });
  const [error, setError] = useState<string | null>(null);

  const processedTranscript = useMemo(
    () => (redactBeforeProcessing ? localRedact(transcript) : transcript),
    [transcript, redactBeforeProcessing]
  );

  useEffect(() => {
    // Load demo transcript if present
    try {
      const raw = localStorage.getItem(LS_KEYS.transcript);
      if (raw && !transcript) setTranscript(raw);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function transcribeAudio() {
    setError(null);
    if (!audioFile) {
      setError("Please choose an audio file first.");
      return;
    }

    setBusy((b) => ({ ...b, transcribe: true }));
    try {
      const form = new FormData();
      form.append("audio", audioFile);

      // Expect either { transcript } or { text }.
      const resp = await apiPostForm<{ transcript?: string; text?: string }>("/transcribe", form);
      const t = (resp?.transcript ?? resp?.text ?? "").toString();
      if (!t.trim()) throw new Error("Empty transcript from API.");
      setTranscript(t);
    } catch (e) {
      setError(
        "Transcription failed (or API not running). You can still paste a transcript manually."
      );
    } finally {
      setBusy((b) => ({ ...b, transcribe: false }));
    }
  }

  async function generateSoap() {
    setError(null);
    setBusy((b) => ({ ...b, generate: true }));
    setSoap(null);

    try {
      const payload = {
        transcript: processedTranscript,
        // optional: hint for backend schema mode
        output: "soap_json",
      };

      // Accept { soap } or raw SOAP object.
      const resp = await apiPost<any>("/clinician/soap", payload);
      const candidate = resp?.soap ?? resp;

      const parsed = SoapSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new Error("SOAP response did not match expected schema.");
      }

      setSoap(parsed.data);
      setActiveView("render");
    } catch {
      setError(
        "SOAP generation failed (or API not running). Check API_PROXY_TARGET and backend logs."
      );
    } finally {
      setBusy((b) => ({ ...b, generate: false }));
    }
  }

  function sendPlanToPatient() {
    setError(null);
    if (!soap) {
      setError("Generate a SOAP note first.");
      return;
    }
    setBusy((b) => ({ ...b, send: true }));
    try {
      const tasks = planToTasks(soap.plan);
      localStorage.setItem(LS_KEYS.tasks, JSON.stringify(tasks));
      setBusy((b) => ({ ...b, send: false }));
    } catch {
      setBusy((b) => ({ ...b, send: false }));
      setError("Could not save tasks to localStorage (browser policy/private mode).");
    }
  }

  function loadDemoTranscript() {
    setError(null);
    try {
      const raw = localStorage.getItem(LS_KEYS.transcript);
      if (raw) setTranscript(raw);
      else setError("No demo transcript found. Go to Home and click “Load demo → Clinician”.");
    } catch {
      setError("Could not read localStorage.");
    }
  }

  function clearAll() {
    setError(null);
    setSoap(null);
    setTranscript("");
    setAudioFile(null);
  }

  const hasEvidence = Boolean(soap?.evidence?.length);

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
                Clinician mode
              </h1>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                Voice/Text → SOAP • Prototype
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-slate-700">
              Paste a visit transcript (or transcribe audio) and generate a clean SOAP note (S/O/A/P).{" "}
              <span className="text-slate-500">Informational only — not medical advice.</span>
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
              href="/privacy"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Privacy panel
            </Link>
          </div>
        </header>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={redactBeforeProcessing}
              onChange={(e) => setRedactBeforeProcessing(e.target.checked)}
            />
            Redact identifiers before processing
          </label>

          <button
            onClick={loadDemoTranscript}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
          >
            Load demo transcript
          </button>

          <div className="ml-auto flex flex-wrap gap-2">
            <button
              onClick={clearAll}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Clear
            </button>
            <button
              disabled={!soap}
              onClick={() => soap && downloadJson("soap.json", soap)}
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                soap
                  ? "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                  : "cursor-not-allowed bg-slate-100 text-slate-400"
              }`}
            >
              Export SOAP JSON
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            {error}
          </div>
        )}

        <section className="mt-6 grid gap-6 md:grid-cols-3">
          {/* Input column */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
            <h2 className="text-lg font-semibold text-slate-900">Visit input</h2>
            <p className="mt-2 text-sm text-slate-700">
              Use synthetic content for demos. You can transcribe audio via the backend or paste text directly.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Audio (optional)</div>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                  className="mt-2 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-900 file:shadow-sm"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={transcribeAudio}
                    disabled={busy.transcribe || !audioFile}
                    className={`rounded-xl px-4 py-2 text-sm font-medium ${
                      busy.transcribe || !audioFile
                        ? "cursor-not-allowed bg-slate-100 text-slate-400"
                        : "bg-slate-900 text-white hover:bg-slate-800"
                    }`}
                  >
                    {busy.transcribe ? "Transcribing…" : "Transcribe"}
                  </button>
                  <div className="text-xs text-slate-500 self-center">
                    Uses <code className="rounded bg-white px-1">/api/transcribe</code>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Generate SOAP</div>
                <p className="mt-1 text-xs text-slate-600">
                  Output is schema-validated on the client.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={generateSoap}
                    disabled={busy.generate || !processedTranscript.trim()}
                    className={`rounded-xl px-4 py-2 text-sm font-medium ${
                      busy.generate || !processedTranscript.trim()
                        ? "cursor-not-allowed bg-slate-100 text-slate-400"
                        : "bg-slate-900 text-white hover:bg-slate-800"
                    }`}
                  >
                    {busy.generate ? "Generating…" : "Generate SOAP"}
                  </button>

                  <button
                    onClick={sendPlanToPatient}
                    disabled={busy.send || !soap}
                    className={`rounded-xl px-4 py-2 text-sm font-medium ${
                      busy.send || !soap
                        ? "cursor-not-allowed bg-slate-100 text-slate-400"
                        : "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                    }`}
                  >
                    {busy.send ? "Saving…" : "Send Plan → Patient tasks"}
                  </button>

                  <div className="text-xs text-slate-500 self-center">
                    Saves tasks locally for the demo.
                  </div>
                </div>
              </div>
            </div>

            <label className="mt-4 block">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold text-slate-700">Transcript</span>
                {redactBeforeProcessing && transcript.trim() && (
                  <span className="text-xs text-slate-500">Preview shows redacted text</span>
                )}
              </div>

              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="Paste synthetic visit transcript here…"
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                rows={8}
              />
            </label>

            {redactBeforeProcessing && transcript.trim() && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Redacted preview</div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-slate-800">
                  {processedTranscript}
                </div>
              </div>
            )}
          </div>

          {/* Output column */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">SOAP output</h2>
            <p className="mt-2 text-sm text-slate-700">
              Review the structured note, then push the Plan to patient tasks.
            </p>

            <div className="mt-4 inline-flex w-full rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
              <button
                onClick={() => setActiveView("render")}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  activeView === "render"
                    ? "bg-slate-900 text-white"
                    : "text-slate-800 hover:bg-slate-50"
                }`}
              >
                Render
              </button>
              <button
                onClick={() => setActiveView("json")}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  activeView === "json"
                    ? "bg-slate-900 text-white"
                    : "text-slate-800 hover:bg-slate-50"
                }`}
              >
                JSON
              </button>
              <button
                onClick={() => setActiveView("evidence")}
                disabled={!hasEvidence}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  !hasEvidence
                    ? "cursor-not-allowed text-slate-400"
                    : activeView === "evidence"
                    ? "bg-slate-900 text-white"
                    : "text-slate-800 hover:bg-slate-50"
                }`}
              >
                Evidence
              </button>
            </div>

            {!soap ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                Generate a SOAP note to see output here.
              </div>
            ) : activeView === "json" ? (
              <pre className="mt-4 max-h-[420px] overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-900">
                {JSON.stringify(soap, null, 2)}
              </pre>
            ) : activeView === "evidence" ? (
              <div className="mt-4 space-y-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
                  If the backend returns <code className="rounded bg-white px-1">evidence</code> spans, you’ll see links
                  between SOAP snippets and transcript indices.
                </div>
                <div className="max-h-[360px] overflow-auto rounded-2xl border border-slate-200 bg-white p-3">
                  {(soap.evidence ?? []).slice(0, 30).map((ev, i) => {
                    const start = typeof ev.start === "number" ? ev.start : null;
                    const end = typeof ev.end === "number" ? ev.end : null;
                    const ok = start != null && end != null && end > start && start >= 0;
                    const excerpt = ok ? processedTranscript.slice(start!, end!) : "";
                    return (
                      <div
                        key={`${i}`}
                        className="mb-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <div className="text-[11px] font-semibold text-slate-700">
                          {ev.section ?? "section"} {ok ? `• [${start}, ${end}]` : ""}
                        </div>
                        {ev.text ? (
                          <div className="mt-1 text-xs text-slate-900">{ev.text}</div>
                        ) : null}
                        {ok ? (
                          <div className="mt-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
                            {excerpt}
                          </div>
                        ) : (
                          <div className="mt-2 text-xs text-slate-500">
                            No span data available for this item.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {([
                  ["Subjective", soap.subjective],
                  ["Objective", soap.objective],
                  ["Assessment", soap.assessment],
                  ["Plan", soap.plan],
                ] as const).map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs font-semibold text-slate-700">{label}</div>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-900">
                      {asLines(value).length ? (
                        asLines(value).map((line, idx) => <li key={`${label}-${idx}`}>{line}</li>)
                      ) : (
                        <li className="text-slate-500">—</li>
                      )}
                    </ul>
                  </div>
                ))}

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                  Safety: This prototype is informational only and not a substitute for professional medical judgment.
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Plan preview */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Plan → Patient tasks</h2>
              <p className="mt-1 text-sm text-slate-700">
                Preview tasks derived from the SOAP Plan, then store them locally for Patient mode.
              </p>
            </div>

            <Link
              href="/patient?tab=tasks"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Open Patient tasks
            </Link>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold text-slate-700">Task preview</div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-900">
                {soap ? (
                  planToTasks(soap.plan).map((t, i) => <li key={`${t}-${i}`}>{t}</li>)
                ) : (
                  <li className="text-slate-500">Generate a SOAP note to preview tasks.</li>
                )}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold text-slate-700">How it works</div>
              <div className="mt-2 space-y-2 text-sm text-slate-700">
                <p>
                  • You generate SOAP in Clinician mode.
                </p>
                <p>
                  • The <span className="font-medium">Plan</span> section is converted into a task list.
                </p>
                <p>
                  • Tasks are saved in <code className="rounded bg-slate-100 px-1">localStorage</code> for demo purposes.
                </p>
              </div>
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Tip: In production, tasks would be stored with consent and proper compliance controls.
              </div>
            </div>
          </div>
        </section>

        <footer className="mt-8 text-xs text-slate-500">
          API calls go to <code className="rounded bg-slate-100 px-1">/api/*</code> (proxy via{" "}
          <code className="rounded bg-slate-100 px-1">API_PROXY_TARGET</code>). If the backend isn’t running, you can
          still demo with pasted text + client-side validation.
        </footer>
      </div>
    </main>
  );
}
