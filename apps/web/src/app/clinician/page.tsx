"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

const LS_KEYS = {
  transcript: "careloop.demoTranscript.v1",
  segments: "careloop.demoSegments.v1",
  loadedAt: "careloop.demoLoadedAt.v1",
  tasks: "careloop.planTasks.v1",
} as const;

// ---------------- schemas ----------------
const SegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().min(1),
});

const EvidenceSchema = z.object({
  section: z.enum(["subjective", "objective", "assessment", "plan"]).or(z.string()).optional(),
  text: z.string().optional(),

  // timestamp evidence
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),

  // char-span evidence (fallback)
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),

  snippet: z.string().optional(),
  verified: z.boolean().optional(),
});

const SoapSchema = z.object({
  subjective: z.union([z.array(z.string()), z.string()]),
  objective: z.union([z.array(z.string()), z.string()]),
  assessment: z.union([z.array(z.string()), z.string()]),
  plan: z.union([z.array(z.string()), z.string()]),
  evidence: z.array(EvidenceSchema).optional(),
});

const EntitySchema = z.object({
  text: z.string(),
  category: z.string(),
  subCategory: z.string().optional(),
  confidence: z.number().optional(),
  offset: z.number().optional(),
  length: z.number().optional(),
});

const SoapResponseSchema = SoapSchema.extend({
  entities: z.array(EntitySchema).nullable().optional(),
  warnings: z.array(z.string()).optional(),
});

type Segment = z.infer<typeof SegmentSchema>;
type Evidence = z.infer<typeof EvidenceSchema>;
type SoapResponse = z.infer<typeof SoapResponseSchema>;

// ---------------- utils ----------------
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
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  const parts = s
    .split(/\n|•|\u2022|-/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [s];
}

function planToTasks(plan: string[] | string): string[] {
  const lines = asLines(plan);
  return lines
    .map((x) => x.replace(/^\d+\.\s*/, "").trim())
    .filter((x) => x.length >= 3)
    .slice(0, 30);
}

function msToStamp(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
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

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as any) : null;

  if (!res.ok) {
    const msg = json?.error ? String(json.error) : `API ${path} failed: ${res.status}`;
    const code = json?.code ? String(json.code) : undefined;
    const err = new Error(msg) as Error & { code?: string; status?: number; payload?: any };
    err.code = code;
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json as T;
}

async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", body: form });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as any) : null;

  if (!res.ok) {
    const msg = json?.error ? String(json.error) : `API ${path} failed: ${res.status}`;
    const code = json?.code ? String(json.code) : undefined;
    const err = new Error(msg) as Error & { code?: string; status?: number; payload?: any };
    err.code = code;
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json as T;
}

function bestSnippetFromEvidence(
  ev: Evidence,
  transcriptUsed: string,
  segmentsUsed: Segment[] | null
): { label: string; snippet: string; meta?: string } {
  // If backend already provides snippet, prefer it
  if (ev.snippet && ev.snippet.trim()) {
    const meta =
      typeof ev.startMs === "number" && typeof ev.endMs === "number"
        ? `${msToStamp(ev.startMs)}–${msToStamp(ev.endMs)}`
        : typeof ev.start === "number" && typeof ev.end === "number"
        ? `[${ev.start}, ${ev.end}]`
        : undefined;
    return { label: "Evidence", snippet: ev.snippet, meta };
  }

  // Timestamp evidence: pick overlapping segments
  if (
    segmentsUsed?.length &&
    typeof ev.startMs === "number" &&
    typeof ev.endMs === "number" &&
    ev.endMs > ev.startMs
  ) {
    const overlap = segmentsUsed
      .filter((s) => !(s.endMs < ev.startMs! || s.startMs > ev.endMs!))
      .slice(0, 4)
      .map((s) => s.text.trim())
      .filter(Boolean);

    if (overlap.length) {
      return {
        label: "Evidence",
        snippet: overlap.join(" "),
        meta: `${msToStamp(ev.startMs)}–${msToStamp(ev.endMs)}`,
      };
    }
  }

  // Char-span evidence
  if (
    typeof ev.start === "number" &&
    typeof ev.end === "number" &&
    ev.end > ev.start &&
    ev.start >= 0 &&
    ev.end <= transcriptUsed.length
  ) {
    const start = Math.max(0, ev.start - 40);
    const end = Math.min(transcriptUsed.length, ev.end + 80);
    const snippet = transcriptUsed.slice(start, end);
    return {
      label: "Evidence",
      snippet,
      meta: `[${ev.start}, ${ev.end}]`,
    };
  }

  return { label: "Evidence", snippet: "" };
}

// ---------------- component ----------------
export default function ClinicianPage() {
  const [transcript, setTranscript] = useState("");
  const [segments, setSegments] = useState<Segment[] | null>(null);

  const [soapResp, setSoapResp] = useState<SoapResponse | null>(null);
  const [activeView, setActiveView] = useState<"render" | "json" | "evidence" | "entities">("render");
  const [selectedEvidenceIdx, setSelectedEvidenceIdx] = useState<number | null>(null);

  const [audioFile, setAudioFile] = useState<File | null>(null);

  // Two knobs:
  // 1) Redact locally before sending text to the backend (safe default for demos)
  // 2) Enforce server-side PHI gate (for “hard gate” demo). If PHI is detected, backend rejects.
  const [redactBeforeSend, setRedactBeforeSend] = useState(true);
  const [enforceRedactionGate, setEnforceRedactionGate] = useState(false);

  const [busy, setBusy] = useState<{ transcribe: boolean; generate: boolean; redact: boolean; send: boolean }>({
    transcribe: false,
    generate: false,
    redact: false,
    send: false,
  });

  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  // Keep the exact transcript/segments used for the last SOAP generation (for evidence rendering consistency)
  const [transcriptUsed, setTranscriptUsed] = useState<string>("");
  const [segmentsUsed, setSegmentsUsed] = useState<Segment[] | null>(null);

  const transcriptToSend = useMemo(
    () => (redactBeforeSend ? localRedact(transcript) : transcript),
    [transcript, redactBeforeSend]
  );

  const evidence = soapResp?.evidence ?? [];
  const hasEvidence = evidence.length > 0;

  // Load demo transcript/segments if present
  useEffect(() => {
    try {
      const rawT = localStorage.getItem(LS_KEYS.transcript);
      const rawS = localStorage.getItem(LS_KEYS.segments);

      if (rawT && !transcript) setTranscript(rawT);

      if (rawS) {
        const maybe = JSON.parse(rawS);
        const parsed = z.array(SegmentSchema).safeParse(maybe);
        if (parsed.success) setSegments(parsed.data);
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadDemoTranscript() {
    setError(null);
    setNotices([]);
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
    setNotices([]);
    setSoapResp(null);
    setSelectedEvidenceIdx(null);
    setTranscriptUsed("");
    setSegmentsUsed(null);

    setTranscript("");
    setSegments(null);
    setAudioFile(null);
    setActiveView("render");
  }

  async function transcribeAudio() {
    setError(null);
    setNotices([]);
    if (!audioFile) {
      setError("Please choose an audio file first.");
      return;
    }

    setBusy((b) => ({ ...b, transcribe: true }));
    try {
      const form = new FormData();
      form.append("audio", audioFile);

      const resp = await apiPostForm<{
        transcript?: string;
        segments?: Segment[];
        warnings?: string[];
      }>("/transcribe", form);

      const t = String(resp?.transcript ?? "").trim();
      if (!t) throw new Error("Empty transcript from API.");

      const segParsed = z.array(SegmentSchema).safeParse(resp?.segments ?? []);
      const segs = segParsed.success && segParsed.data.length ? segParsed.data : null;

      setTranscript(t);
      setSegments(segs);

      // persist for demo convenience
      try {
        localStorage.setItem(LS_KEYS.transcript, t);
        if (segs) localStorage.setItem(LS_KEYS.segments, JSON.stringify(segs));
      } catch {
        // ignore
      }

      if (resp?.warnings?.length) setNotices(resp.warnings);
      if (!segs) setNotices((n) => [...n, "No timestamp segments returned (evidence may fall back to text spans)."]);
    } catch {
      setError("Transcription failed (or API not running). You can still paste a transcript manually.");
    } finally {
      setBusy((b) => ({ ...b, transcribe: false }));
    }
  }

  async function redactViaApi() {
    setError(null);
    setNotices([]);
    const t = transcript.trim();
    if (!t) {
      setError("Paste a transcript first.");
      return;
    }

    setBusy((b) => ({ ...b, redact: true }));
    try {
      const resp = await apiPost<{ redacted: string; piiDetected?: boolean }>("/privacy/redact", { text: t });
      const redacted = String(resp?.redacted ?? t);

      setTranscript(redacted);
      setRedactBeforeSend(false); // already redacted; don't double-redact
      setNotices((n) => [
        ...n,
        resp?.piiDetected ? "PII detected and redacted (best-effort)." : "Redaction applied (best-effort).",
      ]);
    } catch {
      setError("Redaction failed (or API not running). You can still use local redaction toggle for the demo.");
    } finally {
      setBusy((b) => ({ ...b, redact: false }));
    }
  }

  async function generateSoap() {
    setError(null);
    setNotices([]);
    setSoapResp(null);
    setSelectedEvidenceIdx(null);
    setBusy((b) => ({ ...b, generate: true }));

    try {
      const t = transcriptToSend.trim();
      if (!t) throw new Error("Empty transcript.");

      // If we redact before sending, the raw STT segments may still be unredacted.
      // Evidence linking is best-effort; still pass segments if available (timestamp “wow”).
      const payload = {
        transcript: t,
        segments: segments ?? undefined,
        enforceRedaction: enforceRedactionGate,
      };

      const resp = await apiPost<any>("/clinician/soap", payload);

      const parsed = SoapResponseSchema.safeParse(resp);
      if (!parsed.success) throw new Error("SOAP response did not match expected schema.");

      setSoapResp(parsed.data);
      setTranscriptUsed(t);
      setSegmentsUsed(segments ?? null);
      setActiveView("render");

      if (parsed.data.warnings?.length) setNotices(parsed.data.warnings);
      if ((parsed.data.evidence?.filter((e) => e.verified === false).length ?? 0) > 0) {
        setNotices((n) => [...n, "Some SOAP lines are unverified (no strong evidence match). Review recommended."]);
      }
    } catch (e: any) {
      if (e?.code === "PII_DETECTED") {
        setError("PII detected. Redact before generating SOAP.");
        setNotices([
          "Tip: click “Redact via API” to demonstrate a PHI hard-gate workflow.",
          "Or turn ON “Redact locally before sending” for a safe demo mode.",
        ]);
      } else {
        setError("SOAP generation failed (or API not running). Check API_PROXY_TARGET and backend logs.");
      }
    } finally {
      setBusy((b) => ({ ...b, generate: false }));
    }
  }

  function sendPlanToPatient() {
    setError(null);
    setNotices([]);

    if (!soapResp) {
      setError("Generate a SOAP note first.");
      return;
    }

    setBusy((b) => ({ ...b, send: true }));
    try {
      const tasks = planToTasks(soapResp.plan);
      localStorage.setItem(LS_KEYS.tasks, JSON.stringify(tasks));
      setNotices(["Plan converted to tasks and saved locally for Patient mode (demo)."]);
    } catch {
      setError("Could not save tasks to localStorage (browser policy/private mode).");
    } finally {
      setBusy((b) => ({ ...b, send: false }));
    }
  }

  function openEvidenceForLine(section: "subjective" | "objective" | "assessment" | "plan", line: string) {
    if (!soapResp?.evidence?.length) {
      setActiveView("evidence");
      setSelectedEvidenceIdx(null);
      return;
    }
    const idx = soapResp.evidence.findIndex(
      (e) =>
        String(e.section ?? "").toLowerCase() === section &&
        String(e.text ?? "").trim().toLowerCase() === line.trim().toLowerCase()
    );

    setActiveView("evidence");
    setSelectedEvidenceIdx(idx >= 0 ? idx : null);
  }

  const selectedEvidence = useMemo(() => {
    if (!soapResp?.evidence?.length) return null;
    if (selectedEvidenceIdx == null) return null;
    return soapResp.evidence[selectedEvidenceIdx] ?? null;
  }, [soapResp, selectedEvidenceIdx]);

  const selectedSnippet = useMemo(() => {
    if (!selectedEvidence) return null;
    const { snippet, meta } = bestSnippetFromEvidence(selectedEvidence, transcriptUsed || transcriptToSend, segmentsUsed);
    return { snippet, meta };
  }, [selectedEvidence, transcriptUsed, transcriptToSend, segmentsUsed]);

  const previewRedacted = redactBeforeSend && transcript.trim();

  const evidenceStats = useMemo(() => {
    const total = evidence.length;
    const verified = evidence.filter((e) => e.verified === true).length;
    const unverified = evidence.filter((e) => e.verified === false).length;
    return { total, verified, unverified };
  }, [evidence]);

  const entityStats = useMemo(() => {
    const ents = soapResp?.entities ?? null;
    if (!ents?.length) return null;
    const counts = new Map<string, number>();
    for (const e of ents) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [soapResp?.entities]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Clinician mode</h1>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                Voice/Text → SOAP • Evidence-linked
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-slate-700">
              Paste a synthetic visit transcript (or transcribe audio) and generate a clean SOAP note (S/O/A/P) with
              evidence links and a quality gate.{" "}
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

        {/* Controls */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={redactBeforeSend}
              onChange={(e) => setRedactBeforeSend(e.target.checked)}
            />
            Redact locally before sending to API (demo-safe)
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={enforceRedactionGate}
              onChange={(e) => setEnforceRedactionGate(e.target.checked)}
            />
            Enforce PHI gate on server (block if PII detected)
          </label>

          <button
            onClick={loadDemoTranscript}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
          >
            Load demo transcript
          </button>

          <button
            onClick={redactViaApi}
            disabled={busy.redact || !transcript.trim()}
            className={`rounded-xl px-4 py-2 text-sm font-medium ${
              busy.redact || !transcript.trim()
                ? "cursor-not-allowed bg-slate-100 text-slate-400"
                : "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
            }`}
            title="Call /api/privacy/redact for best-effort redaction"
          >
            {busy.redact ? "Redacting…" : "Redact via API"}
          </button>

          <div className="ml-auto flex flex-wrap gap-2">
            <button
              onClick={clearAll}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Clear
            </button>
            <button
              disabled={!soapResp}
              onClick={() => soapResp && downloadJson("soap-response.json", soapResp)}
              className={`rounded-xl px-4 py-2 text-sm font-medium ${
                soapResp
                  ? "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                  : "cursor-not-allowed bg-slate-100 text-slate-400"
              }`}
            >
              Export full JSON
            </button>
          </div>
        </div>

        {/* Errors / Notices */}
        {error && (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            {error}
          </div>
        )}
        {notices.length > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800">
            <div className="text-xs font-semibold text-slate-700">Notes</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {notices.map((n, i) => (
                <li key={`${n}-${i}`}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        <section className="mt-6 grid gap-6 md:grid-cols-3">
          {/* Input */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
            <h2 className="text-lg font-semibold text-slate-900">Visit input</h2>
            <p className="mt-2 text-sm text-slate-700">
              Use <span className="font-medium">synthetic</span> content for demos. For the “wow” evidence demo, try
              audio transcription (timestamps) and then generate SOAP.
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

                <div className="mt-3 text-xs text-slate-600">
                  {segments?.length ? (
                    <span>
                      Timestamp segments:{" "}
                      <span className="font-semibold text-slate-800">{segments.length}</span>
                    </span>
                  ) : (
                    <span>No segments yet (paste text or transcribe audio).</span>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Generate SOAP</div>
                <p className="mt-1 text-xs text-slate-600">
                  Client validates the JSON schema. Evidence items are marked as verified/unverified.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={generateSoap}
                    disabled={busy.generate || !transcriptToSend.trim()}
                    className={`rounded-xl px-4 py-2 text-sm font-medium ${
                      busy.generate || !transcriptToSend.trim()
                        ? "cursor-not-allowed bg-slate-100 text-slate-400"
                        : "bg-slate-900 text-white hover:bg-slate-800"
                    }`}
                  >
                    {busy.generate ? "Generating…" : "Generate SOAP"}
                  </button>

                  <button
                    onClick={sendPlanToPatient}
                    disabled={busy.send || !soapResp}
                    className={`rounded-xl px-4 py-2 text-sm font-medium ${
                      busy.send || !soapResp
                        ? "cursor-not-allowed bg-slate-100 text-slate-400"
                        : "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                    }`}
                  >
                    {busy.send ? "Saving…" : "Send Plan → Patient tasks"}
                  </button>
                </div>

                <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                  <div className="font-semibold text-slate-700">Demo tip</div>
                  <div className="mt-1">
                    For a safe default: keep <span className="font-medium">local redaction ON</span>. For the “PHI hard
                    gate” demo: turn <span className="font-medium">local redaction OFF</span>, turn{" "}
                    <span className="font-medium">PHI gate ON</span>, then click “Redact via API” after it blocks.
                  </div>
                </div>
              </div>
            </div>

            <label className="mt-4 block">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold text-slate-700">Transcript</span>
                {previewRedacted && (
                  <span className="text-xs text-slate-500">Redacted preview shown below (what is sent to backend)</span>
                )}
              </div>

              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="Paste synthetic visit transcript here…"
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                rows={9}
              />
            </label>

            {previewRedacted && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Redacted preview (sent to API)</div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{transcriptToSend}</div>
              </div>
            )}
          </div>

          {/* Output */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Output</h2>
            <p className="mt-2 text-sm text-slate-700">
              Review the structured note, check evidence, then push the Plan to patient tasks.
            </p>

            <div className="mt-4 inline-flex w-full rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
              <button
                onClick={() => setActiveView("render")}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  activeView === "render" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                }`}
              >
                SOAP
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
              <button
                onClick={() => setActiveView("entities")}
                disabled={!(soapResp?.entities && soapResp.entities.length)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  !(soapResp?.entities && soapResp.entities.length)
                    ? "cursor-not-allowed text-slate-400"
                    : activeView === "entities"
                    ? "bg-slate-900 text-white"
                    : "text-slate-800 hover:bg-slate-50"
                }`}
              >
                Entities
              </button>
              <button
                onClick={() => setActiveView("json")}
                className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  activeView === "json" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                }`}
              >
                JSON
              </button>
            </div>

            {!soapResp ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                Generate a SOAP note to see output here.
              </div>
            ) : activeView === "json" ? (
              <pre className="mt-4 max-h-[520px] overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-900">
                {JSON.stringify(soapResp, null, 2)}
              </pre>
            ) : activeView === "entities" ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
                  Best-effort healthcare entities extracted from the transcript (if enabled on the Azure resource).
                </div>

                {entityStats && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-3">
                    <div className="text-xs font-semibold text-slate-700">Top categories</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {entityStats.map(([cat, count]) => (
                        <span
                          key={cat}
                          className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-800"
                        >
                          {cat} • {count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="max-h-[420px] overflow-auto rounded-2xl border border-slate-200 bg-white p-3">
                  <div className="grid grid-cols-1 gap-2">
                    {(soapResp.entities ?? []).slice(0, 120).map((e, idx) => (
                      <div key={`${e.text}-${idx}`} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-slate-900">{e.text}</div>
                          <div className="text-[11px] text-slate-600">
                            {e.category}
                            {e.subCategory ? ` / ${e.subCategory}` : ""}
                          </div>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-600">
                          {typeof e.confidence === "number" ? `confidence: ${e.confidence.toFixed(2)}` : "confidence: —"}
                          {typeof e.offset === "number" && typeof e.length === "number"
                            ? ` • span: [${e.offset}, ${e.offset + e.length}]`
                            : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : activeView === "evidence" ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
                  Evidence links connect SOAP lines to transcript spans.{" "}
                  <span className="font-semibold">
                    Verified: {evidenceStats.verified}/{evidenceStats.total}
                  </span>{" "}
                  {evidenceStats.unverified ? <span>• Unverified: {evidenceStats.unverified}</span> : null}
                </div>

                {selectedEvidence && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-700">
                        Selected • {String(selectedEvidence.section ?? "section")}
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                          selectedEvidence.verified === false
                            ? "bg-amber-100 text-amber-900"
                            : "bg-emerald-100 text-emerald-900"
                        }`}
                      >
                        {selectedEvidence.verified === false ? "Unverified" : "Verified"}
                      </span>
                    </div>
                    {selectedEvidence.text ? (
                      <div className="mt-2 text-sm text-slate-900">{selectedEvidence.text}</div>
                    ) : null}
                    {selectedSnippet?.snippet ? (
                      <div className="mt-3">
                        <div className="text-[11px] font-semibold text-slate-700">
                          {selectedSnippet.meta ? `Transcript • ${selectedSnippet.meta}` : "Transcript"}
                        </div>
                        <div className="mt-2 whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800">
                          {selectedSnippet.snippet}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 text-xs text-slate-500">
                        No snippet available for this line (best-effort matching).
                      </div>
                    )}
                  </div>
                )}

                <div className="max-h-[360px] overflow-auto rounded-2xl border border-slate-200 bg-white p-3">
                  {(evidence ?? []).slice(0, 60).map((ev, i) => {
                    const verified = ev.verified !== false;
                    const meta =
                      typeof ev.startMs === "number" && typeof ev.endMs === "number"
                        ? `${msToStamp(ev.startMs)}–${msToStamp(ev.endMs)}`
                        : typeof ev.start === "number" && typeof ev.end === "number"
                        ? `[${ev.start}, ${ev.end}]`
                        : "";
                    const isSelected = selectedEvidenceIdx === i;

                    return (
                      <button
                        key={`${i}-${ev.section ?? "s"}-${ev.text ?? ""}`}
                        onClick={() => setSelectedEvidenceIdx(i)}
                        className={`mb-2 w-full rounded-xl border px-3 py-2 text-left ${
                          isSelected
                            ? "border-slate-400 bg-slate-50"
                            : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[11px] font-semibold text-slate-700">
                            {String(ev.section ?? "section")}
                            {meta ? <span className="font-normal text-slate-500"> • {meta}</span> : null}
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              verified ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"
                            }`}
                          >
                            {verified ? "Verified" : "Unverified"}
                          </span>
                        </div>
                        {ev.text ? <div className="mt-1 text-xs text-slate-900">{ev.text}</div> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {(
                  [
                    ["Subjective", "subjective", soapResp.subjective],
                    ["Objective", "objective", soapResp.objective],
                    ["Assessment", "assessment", soapResp.assessment],
                    ["Plan", "plan", soapResp.plan],
                  ] as const
                ).map(([label, key, value]) => (
                  <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold text-slate-700">{label}</div>
                      {hasEvidence ? (
                        <div className="text-[11px] text-slate-500">Click a line to view evidence</div>
                      ) : null}
                    </div>

                    <ul className="mt-2 space-y-1 text-sm text-slate-900">
                      {asLines(value).length ? (
                        asLines(value).map((line, idx) => {
                          // try to find matching evidence and show a badge inline
                          const evIdx = soapResp.evidence?.findIndex(
                            (e) =>
                              String(e.section ?? "").toLowerCase() === key &&
                              String(e.text ?? "").trim().toLowerCase() === line.trim().toLowerCase()
                          );

                          const ev = typeof evIdx === "number" && evIdx >= 0 ? soapResp.evidence?.[evIdx] : null;
                          const verified = ev ? ev.verified !== false : null;

                          return (
                            <li key={`${label}-${idx}`}>
                              <button
                                type="button"
                                onClick={() => openEvidenceForLine(key, line)}
                                className={`w-full rounded-lg border px-3 py-2 text-left ${
                                  hasEvidence ? "border-slate-200 hover:bg-slate-50" : "border-slate-100"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="text-sm text-slate-900">{line}</div>
                                  {verified != null ? (
                                    <span
                                      className={`mt-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                        verified ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"
                                      }`}
                                    >
                                      {verified ? "Verified" : "Unverified"}
                                    </span>
                                  ) : null}
                                </div>
                              </button>
                            </li>
                          );
                        })
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
                {soapResp ? (
                  planToTasks(soapResp.plan).map((t, i) => <li key={`${t}-${i}`}>{t}</li>)
                ) : (
                  <li className="text-slate-500">Generate a SOAP note to preview tasks.</li>
                )}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs font-semibold text-slate-700">How it works</div>
              <div className="mt-2 space-y-2 text-sm text-slate-700">
                <p>• Generate SOAP in Clinician mode.</p>
                <p>
                  • The <span className="font-medium">Plan</span> section is converted into a task list.
                </p>
                <p>
                  • Tasks are saved in <code className="rounded bg-slate-100 px-1">localStorage</code> for demo purposes.
                </p>
              </div>
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Tip: In production, tasks would be stored with consent and compliance controls.
              </div>
            </div>
          </div>
        </section>

        <footer className="mt-8 text-xs text-slate-500">
          API calls go to <code className="rounded bg-slate-100 px-1">/api/*</code> (proxy via{" "}
          <code className="rounded bg-slate-100 px-1">API_PROXY_TARGET</code>). If the backend isn’t running, you can
          still demo with pasted text and client-side schema validation.
        </footer>
      </div>
    </main>
  );
}
