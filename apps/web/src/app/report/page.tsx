"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Term = {
  term: string;
  normalized?: string;
  translation?: string;
  meaning?: string; // short definition
  whyItMatters?: string; // 1 short sentence
  category?: "lab" | "imaging" | "diagnosis" | "general";
  source?: { title: string; url: string };
  evidence?: { snippet: string };
};

type LabValue = {
  name: string;
  value: number | string;
  unit?: string;
  refRange?: string; // e.g. "3.9–5.5"
  flag?: "low" | "normal" | "high";
  date?: string;
  evidence?: { snippet: string };
};

type IngestResponse = {
  cleanedText?: string;
  terms?: Term[];
  labs?: LabValue[];
  warnings?: string[];
};

type AnalyzeResponse = {
  clinicianSummary?: string;
  patientPlanDraft?: string;
  hypotheses?: { text: string; confidence?: number }[];
  nextSteps?: string[];
  warnings?: string[];
};

const SAMPLE_REPORT = `DISCHARGE SUMMARY (SYNTHETIC DEMO)

Reason for admission: chest discomfort, shortness of breath.

ECG: sinus rhythm. No acute ischemic changes.
Imaging: CT angiography negative for pulmonary embolism. Mild atelectasis.
Labs:
- Troponin I: 0.01 ng/mL (ref 0.00–0.04)
- CRP: 18 mg/L (ref 0–5)
- WBC: 12.4 x10^9/L (ref 4.0–10.0)
- Hemoglobin: 138 g/L (ref 120–160)
- Creatinine: 92 umol/L (ref 45–90)

Assessment: status post viral infection. No evidence of myocardial infarction. Benign course likely.
Plan: follow-up with primary care. Return if worsening symptoms.`;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function localRedact(text: string): string {
  let t = String(text ?? "");
  // emails
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
  // phones (very rough)
  t = t.replace(
    /(\+?\d{1,3}[\s-]?)?(\(?\d{1,4}\)?[\s-]?)?[\d\s-]{6,}\d/g,
    "[REDACTED_PHONE]"
  );
  // dates (rough)
  t = t.replace(/\b(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/g, "[REDACTED_DATE]");
  return t;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
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
    const err: any = new Error(msg);
    err.code = json?.code;
    throw err;
  }

  return (json ?? {}) as T;
}

// --------- Local fallback extractors (demo-safe) ---------

const TERM_KB: Record<
  string,
  Omit<Term, "term"> & { synonyms?: string[] }
> = {
  "status post": {
    normalized: "status post",
    translation: "after / following",
    meaning: "Indicates something happened after a prior event or procedure.",
    whyItMatters: "Helps clinicians anchor findings to a known prior event.",
    category: "general",
    source: { title: "MedlinePlus Medical Words", url: "https://medlineplus.gov/medicalwords.html" },
    synonyms: ["s/p"],
  },
  fractura: {
    normalized: "fracture",
    translation: "fracture",
    meaning: "A break in a bone.",
    whyItMatters: "May require immobilization, pain control, and follow-up imaging.",
    category: "imaging",
    source: { title: "MedlinePlus - Fractures", url: "https://medlineplus.gov/fractures.html" },
  },
  stenosis: {
    normalized: "narrowing",
    translation: "narrowing",
    meaning: "Abnormal narrowing of a passage (e.g., vessel or valve).",
    whyItMatters: "Can reduce flow and cause symptoms depending on severity.",
    category: "diagnosis",
    source: { title: "NHS - General health information", url: "https://www.nhs.uk/" },
  },
  benign: {
    normalized: "benign",
    translation: "non-cancerous / not dangerous",
    meaning: "Not cancerous; often lower risk.",
    whyItMatters: "Usually changes urgency and intensity of treatment.",
    category: "diagnosis",
    source: { title: "NCI Dictionary", url: "https://www.cancer.gov/publications/dictionaries/cancer-terms" },
  },
  benignus: {
    normalized: "benign",
    translation: "benign",
    meaning: "Latin form of benign.",
    whyItMatters: "Usually changes urgency and intensity of treatment.",
    category: "diagnosis",
    source: { title: "NCI Dictionary", url: "https://www.cancer.gov/publications/dictionaries/cancer-terms" },
  },
  malignant: {
    normalized: "malignant",
    translation: "cancerous / aggressive",
    meaning: "Cancerous or potentially aggressive.",
    whyItMatters: "Often requires prompt evaluation and treatment.",
    category: "diagnosis",
    source: { title: "NCI Dictionary", url: "https://www.cancer.gov/publications/dictionaries/cancer-terms" },
  },
  malignus: {
    normalized: "malignant",
    translation: "malignant",
    meaning: "Latin form of malignant.",
    whyItMatters: "Often requires prompt evaluation and treatment.",
    category: "diagnosis",
    source: { title: "NCI Dictionary", url: "https://www.cancer.gov/publications/dictionaries/cancer-terms" },
  },
  atelectasis: {
    normalized: "atelectasis",
    translation: "partial lung collapse",
    meaning: "Part of the lung is not fully expanded.",
    whyItMatters: "Can be mild/temporary, but may relate to infection, mucus, or shallow breathing.",
    category: "imaging",
    source: { title: "MedlinePlus - Atelectasis", url: "https://medlineplus.gov/ency/article/000065.htm" },
  },
};

function detectTermsLocally(text: string): Term[] {
  const lower = String(text ?? "").toLowerCase();
  const out: Term[] = [];
  const add = (key: string, matched: string) => {
    const base = TERM_KB[key];
    if (!base) return;
    const snippet = makeSnippet(text, matched, 80);
    out.push({
      term: matched,
      normalized: base.normalized,
      translation: base.translation,
      meaning: base.meaning,
      whyItMatters: base.whyItMatters,
      category: base.category,
      source: base.source,
      evidence: snippet ? { snippet } : undefined,
    });
  };

  for (const key of Object.keys(TERM_KB)) {
    const base = TERM_KB[key];
    const patterns = [key, ...(base.synonyms ?? [])].map(escapeRegExp);
    const re = new RegExp(`\\b(${patterns.join("|")})\\b`, "ig");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const matched = String(m[1] ?? "").trim();
      // dedupe by normalized+match
      const sig = `${key}::${matched.toLowerCase()}`;
      if (out.some((t) => `${(t.normalized ?? "").toLowerCase()}::${t.term.toLowerCase()}` === sig)) continue;
      add(key, matched);
    }
  }

  // Small extra heuristic for typical report terms
  const quick = [
    { k: "ischemic", meaning: "Reduced blood flow to tissue." },
    { k: "embolism", meaning: "A blockage (often a clot) that travels in blood vessels." },
  ];
  for (const q of quick) {
    const re = new RegExp(`\\b${escapeRegExp(q.k)}\\w*\\b`, "ig");
    const m = re.exec(text);
    if (m?.[0]) {
      const matched = m[0];
      out.push({
        term: matched,
        normalized: matched.toLowerCase(),
        translation: matched.toLowerCase(),
        meaning: q.meaning,
        whyItMatters: "Provides clinical context for symptoms and risk.",
        category: "general",
        source: { title: "MedlinePlus Medical Words", url: "https://medlineplus.gov/medicalwords.html" },
        evidence: { snippet: makeSnippet(text, matched, 80) },
      });
    }
  }

  return out.slice(0, 30);
}

function extractLabsLocally(text: string): LabValue[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const labs: LabValue[] = [];

  // Patterns like: "CRP: 18 mg/L (ref 0–5)"
  const re1 =
    /^\s*[-•]?\s*([A-Za-z][A-Za-z0-9\s./()%+-]{1,40}?)\s*:\s*([<>]?\s*\d+(?:\.\d+)?)\s*([A-Za-zµuμ\/^0-9.\-×x ]{0,20})\s*\((?:ref|reference)\s*([^)]+)\)\s*$/i;

  // Patterns like: "WBC: 12.4 x10^9/L (ref 4.0–10.0)"
  // (covered by re1 mostly; keep for safety)
  for (const line of lines) {
    const m = re1.exec(line);
    if (!m) continue;

    const name = (m[1] ?? "").trim();
    const rawVal = (m[2] ?? "").replace(/\s+/g, "");
    const unit = (m[3] ?? "").trim() || undefined;
    const ref = (m[4] ?? "").trim();

    const num = Number(rawVal.replace("<", "").replace(">", ""));
    const value: number | string = Number.isFinite(num) ? num : rawVal;

    const flag = computeFlag(value, ref);
    labs.push({
      name,
      value,
      unit,
      refRange: ref,
      flag,
      evidence: { snippet: line.trim() },
    });
  }

  return labs.slice(0, 50);
}

function computeFlag(value: number | string, refRange: string): LabValue["flag"] {
  const v = typeof value === "number" ? value : Number(String(value).replace(/[<>]/g, ""));
  if (!Number.isFinite(v)) return "normal";

  // Extract first two numbers as low/high from something like "0.00–0.04" or "0-5"
  const nums = String(refRange)
    .replace(/–/g, "-")
    .match(/-?\d+(?:\.\d+)?/g)
    ?.map((x) => Number(x))
    .filter((x) => Number.isFinite(x)) ?? [];

  if (nums.length >= 2) {
    const low = nums[0];
    const high = nums[1];
    if (v < low) return "low";
    if (v > high) return "high";
    return "normal";
  }

  return "normal";
}

function makeSnippet(full: string, needle: string, radius = 80) {
  const s = String(full ?? "");
  const n = String(needle ?? "");
  if (!s || !n) return "";
  const idx = s.toLowerCase().indexOf(n.toLowerCase());
  if (idx < 0) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(s.length, idx + n.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < s.length ? "…" : "";
  return `${prefix}${s.slice(start, end).trim()}${suffix}`;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function badgeForFlag(flag?: LabValue["flag"]) {
  if (flag === "high") return { label: "High", cls: "bg-rose-100 text-rose-900" };
  if (flag === "low") return { label: "Low", cls: "bg-amber-100 text-amber-900" };
  return { label: "Normal", cls: "bg-emerald-100 text-emerald-900" };
}

function toSafeUrl(url?: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export default function ReportPage() {
  const [mode, setMode] = useState<"patient" | "clinician" | "split">("split");

  const [reportText, setReportText] = useState<string>(SAMPLE_REPORT);

  const [redactBeforeSend, setRedactBeforeSend] = useState(true);
  const [enforceRedactionGate, setEnforceRedactionGate] = useState(false);

  const [busy, setBusy] = useState<{ ingest: boolean; analyze: boolean }>({ ingest: false, analyze: false });
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  const [cleanedText, setCleanedText] = useState<string>("");
  const [terms, setTerms] = useState<Term[]>([]);
  const [labs, setLabs] = useState<LabValue[]>([]);

  const [selectedTermIdx, setSelectedTermIdx] = useState<number | null>(null);

  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);

  const textToSend = useMemo(() => {
    const t = reportText.trim();
    return redactBeforeSend ? localRedact(t) : t;
  }, [reportText, redactBeforeSend]);

  const cleanedToUse = (cleanedText || reportText).trim();

  const abnormalLabs = useMemo(() => labs.filter((l) => l.flag && l.flag !== "normal"), [labs]);

  async function ingest() {
    setError(null);
    setNotices([]);
    setAnalysis(null);
    setSelectedTermIdx(null);

    const t = textToSend.trim();
    if (!t) {
      setError("Paste a report first.");
      return;
    }

    setBusy((b) => ({ ...b, ingest: true }));
    try {
      const resp = await apiPost<IngestResponse>("/report/ingest", {
        text: t,
        enforceRedaction: enforceRedactionGate,
      });

      const ct = String(resp.cleanedText ?? t);
      setCleanedText(ct);

      const termList = Array.isArray(resp.terms) ? resp.terms : [];
      const labList = Array.isArray(resp.labs) ? resp.labs : [];

      setTerms(termList);
      setLabs(labList);

      if (resp.warnings?.length) setNotices(resp.warnings);
      if (!termList.length && !labList.length) {
        setNotices((n) => [...n, "No structured items returned by API (or API not running)."]);
      }
    } catch (e: any) {
      // Local fallback: keep demo stable without backend
      const ct = textToSend.trim();
      setCleanedText(ct);
      const localTerms = detectTermsLocally(ct);
      const localLabs = extractLabsLocally(ct);
      setTerms(localTerms);
      setLabs(localLabs);
      setNotices((n) => [
        ...n,
        "API ingest failed — using local fallback extraction (demo-safe).",
      ]);

      if (e?.code === "PII_DETECTED") setError("PII detected. Redact before ingest/analyze.");
    } finally {
      setBusy((b) => ({ ...b, ingest: false }));
    }
  }

  async function analyze() {
    setError(null);
    setNotices([]);

    const t = (cleanedText || textToSend).trim();
    if (!t) {
      setError("Paste a report first.");
      return;
    }

    setBusy((b) => ({ ...b, analyze: true }));
    try {
      const resp = await apiPost<AnalyzeResponse>("/report/analyze", {
        text: t,
        labs,
        terms,
        enforceRedaction: enforceRedactionGate,
      });

      setAnalysis(resp);
      if (resp.warnings?.length) setNotices(resp.warnings);
    } catch (e: any) {
      // Local fallback summary
      const abn = abnormalLabs
        .map((l) => `- ${l.name}: ${l.value}${l.unit ? " " + l.unit : ""} (${l.refRange ?? "ref n/a"}) → ${l.flag}`)
        .join("\n");

      const clinician = [
        "STRUCTURED SUMMARY (fallback)",
        "",
        "Abnormal / noteworthy findings:",
        abn || "- None detected from parsed labs.",
        "",
        "Interpretation (informational):",
        "- Abnormal values can be caused by many factors; correlate with symptoms/exam.",
        "",
        "Suggested next steps (draft, clinician review):",
        "- Re-check flagged labs if clinically indicated.",
        "- Monitor symptoms; follow local guidelines.",
      ].join("\n");

      const patient = [
        "PATIENT-FRIENDLY PLAN (fallback)",
        "",
        "What this likely means:",
        "This summary highlights numbers that are outside typical reference ranges. This is not a diagnosis.",
        "",
        "What to watch:",
        abnormalLabs.length ? abnormalLabs.map((l) => `- ${l.name}: aim to move toward the reference range (${l.refRange ?? "n/a"})`).join("\n") : "- No flagged lab values found in this report text.",
        "",
        "When to contact a clinician urgently:",
        "- New or worsening chest pain, severe shortness of breath, fainting, severe weakness, or any alarming symptoms.",
      ].join("\n");

      setAnalysis({
        clinicianSummary: clinician,
        patientPlanDraft: patient,
        warnings: ["API analyze failed — using local fallback summary (demo-safe)."],
      });

      setNotices((n) => [...n, "API analyze failed — using local fallback summary (demo-safe)."]);
      if (e?.code === "PII_DETECTED") setError("PII detected. Redact before analyzing.");
    } finally {
      setBusy((b) => ({ ...b, analyze: false }));
    }
  }

  function clearAll() {
    setError(null);
    setNotices([]);
    setAnalysis(null);
    setCleanedText("");
    setTerms([]);
    setLabs([]);
    setSelectedTermIdx(null);
  }

  const selectedTerm = typeof selectedTermIdx === "number" ? terms[selectedTermIdx] : null;

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
                Medical Report Interpreter
              </h1>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                Labs & Findings • Tap-to-explain
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-slate-700">
              Paste a <span className="font-medium">synthetic</span> lab/imaging/discharge report. The app extracts terms and lab values,
              compares to reference ranges, and generates a clinician draft + patient-friendly plan.
              <span className="text-slate-500"> Informational only — not medical advice.</span>
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-700">
              <Link
                href="/"
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 hover:bg-slate-50"
              >
                ← Home
              </Link>

              <button
                onClick={() => setReportText(SAMPLE_REPORT)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 hover:bg-slate-50"
              >
                Load sample
              </button>

              <button
                onClick={clearAll}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 hover:bg-slate-50"
              >
                Clear output
              </button>
            </div>
          </div>

          {/* Mode switch */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="text-xs font-semibold text-slate-700">View</div>
            <div className="mt-2 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
              {(["split", "patient", "clinician"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-700 hover:text-slate-900"
                  }`}
                >
                  {m === "split" ? "Split" : m === "patient" ? "Patient" : "Clinician"}
                </button>
              ))}
            </div>

            <div className="mt-3 space-y-2 text-xs text-slate-700">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={redactBeforeSend}
                  onChange={(e) => setRedactBeforeSend(e.target.checked)}
                />
                Local redaction before send
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={enforceRedactionGate}
                  onChange={(e) => setEnforceRedactionGate(e.target.checked)}
                />
                Enforce server PHI gate (if supported)
              </label>
            </div>
          </div>
        </div>

        {/* Error / notices */}
        {(error || notices.length) && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                {error}
              </div>
            )}
            {notices.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-slate-700">
                {notices.slice(0, 6).map((n, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-slate-400" />
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Input */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">Report text</h2>
              <div className="flex gap-2">
                <button
                  onClick={ingest}
                  disabled={busy.ingest}
                  className={`rounded-xl px-4 py-2 text-sm font-medium ${
                    busy.ingest
                      ? "cursor-not-allowed bg-slate-100 text-slate-400"
                      : "bg-slate-900 text-white hover:bg-slate-800"
                  }`}
                >
                  {busy.ingest ? "Extracting…" : "Extract terms & labs"}
                </button>
                <button
                  onClick={analyze}
                  disabled={busy.analyze}
                  className={`rounded-xl px-4 py-2 text-sm font-medium ${
                    busy.analyze
                      ? "cursor-not-allowed bg-slate-100 text-slate-400"
                      : "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                  }`}
                >
                  {busy.analyze ? "Analyzing…" : "Generate summaries"}
                </button>
              </div>
            </div>

            <p className="mt-2 text-sm text-slate-700">
              Use only anonymized/synthetic content. If you enable local redaction, obvious PHI (email/phone/date) will be masked.
            </p>

            <textarea
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              className="mt-4 h-[360px] w-full resize-none rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-300"
              placeholder="Paste report text here…"
            />

            {redactBeforeSend && reportText.trim() && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Preview (redacted before send)</div>
                <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap text-xs text-slate-800">
                  {textToSend.slice(0, 1200)}
                  {textToSend.length > 1200 ? "\n\n…(truncated)" : ""}
                </pre>
              </div>
            )}
          </div>

          {/* Extraction summary panel */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Extracted</h2>
            <p className="mt-2 text-sm text-slate-700">
              Tap a term for a minimal explanation. Labs are flagged low/normal/high using the provided reference ranges (when present).
            </p>

            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-slate-600">Terms</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{terms.length}</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-slate-600">Labs</div>
                <div className="mt-1 text-2xl font-semibold text-slate-900">{labs.length}</div>
              </div>
            </div>

            {abnormalLabs.length > 0 && (
              <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                <span className="font-semibold">{abnormalLabs.length}</span> lab value(s) flagged outside the reference range.
              </div>
            )}

            <div className="mt-4">
              <div className="text-xs font-semibold text-slate-700">Terms</div>
              {terms.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {terms.slice(0, 18).map((t, idx) => (
                    <button
                      key={`${idx}-${t.term}`}
                      onClick={() => setSelectedTermIdx(idx)}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-800 hover:bg-slate-50"
                      title="Tap to explain"
                    >
                      {t.term}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  No terms yet. Click “Extract terms & labs”.
                </div>
              )}
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold text-slate-700">Labs (quick view)</div>
              {labs.length ? (
                <div className="mt-2 space-y-2">
                  {labs.slice(0, 6).map((l, i) => {
                    const b = badgeForFlag(l.flag);
                    return (
                      <div
                        key={`${i}-${l.name}`}
                        className="rounded-2xl border border-slate-200 bg-white p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">{l.name}</div>
                            <div className="mt-0.5 text-xs text-slate-600">
                              {String(l.value)}
                              {l.unit ? ` ${l.unit}` : ""}{" "}
                              {l.refRange ? <span className="text-slate-500">• ref {l.refRange}</span> : null}
                            </div>
                          </div>
                          <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${b.cls}`}>
                            {b.label}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  No labs yet. Click “Extract terms & labs”.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main outputs */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {(mode === "split" || mode === "patient") && (
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-slate-900">Patient view</h2>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
                  Plain English • Clinician review needed
                </span>
              </div>

              <div className="mt-4">
                <div className="text-xs font-semibold text-slate-700">My values vs normal</div>
                {labs.length ? (
                  <div className="mt-2 overflow-auto rounded-2xl border border-slate-200">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-700">
                        <tr>
                          <th className="px-3 py-2 text-left">Test</th>
                          <th className="px-3 py-2 text-left">My value</th>
                          <th className="px-3 py-2 text-left">Unit</th>
                          <th className="px-3 py-2 text-left">Reference</th>
                          <th className="px-3 py-2 text-left">Flag</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {labs.map((l, i) => {
                          const b = badgeForFlag(l.flag);
                          return (
                            <tr key={`${i}-${l.name}`} className="bg-white">
                              <td className="px-3 py-2 font-medium text-slate-900">{l.name}</td>
                              <td className="px-3 py-2 text-slate-900">{String(l.value)}</td>
                              <td className="px-3 py-2 text-slate-700">{l.unit ?? "—"}</td>
                              <td className="px-3 py-2 text-slate-700">{l.refRange ?? "—"}</td>
                              <td className="px-3 py-2">
                                <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${b.cls}`}>
                                  {b.label}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    No lab values extracted yet.
                  </div>
                )}
              </div>

              <div className="mt-6">
                <div className="text-xs font-semibold text-slate-700">Patient-friendly plan (draft)</div>
                <pre className="mt-2 whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-900">
                  {analysis?.patientPlanDraft ||
                    "Click “Generate summaries” to produce a patient-friendly explanation and a draft plan (for clinician review)."}
                </pre>
                <div className="mt-2 text-xs text-slate-600">
                  Disclaimer: informational only; do not use as a diagnosis or to replace professional care.
                </div>
              </div>
            </section>
          )}

          {(mode === "split" || mode === "clinician") && (
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-slate-900">Clinician view</h2>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
                  Structured draft • Evidence-aware
                </span>
              </div>

              <div className="mt-4">
                <div className="text-xs font-semibold text-slate-700">Clinical-style summary (draft)</div>
                <pre className="mt-2 whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-900">
                  {analysis?.clinicianSummary ||
                    "Click “Generate summaries” to produce a clinician-facing draft: abnormal findings + hypotheses + next steps."}
                </pre>
              </div>

              {(analysis?.hypotheses?.length || analysis?.nextSteps?.length) && (
                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs font-semibold text-slate-700">Hypotheses</div>
                    <ul className="mt-2 space-y-2 text-sm text-slate-900">
                      {(analysis?.hypotheses ?? []).slice(0, 6).map((h, i) => (
                        <li key={i} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                          <div className="font-medium">{h.text}</div>
                          {typeof h.confidence === "number" && (
                            <div className="mt-1 text-xs text-slate-600">
                              Confidence: {clamp(Math.round(h.confidence * 100), 0, 100)}%
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs font-semibold text-slate-700">Next steps</div>
                    <ul className="mt-2 space-y-2 text-sm text-slate-900">
                      {(analysis?.nextSteps ?? []).slice(0, 8).map((s, i) => (
                        <li key={i} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold text-slate-700">Abnormal findings (quick)</div>
                {abnormalLabs.length ? (
                  <ul className="mt-2 space-y-2 text-sm text-slate-900">
                    {abnormalLabs.slice(0, 10).map((l, i) => (
                      <li key={i} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                        <span className="font-semibold">{l.name}</span>: {String(l.value)}
                        {l.unit ? ` ${l.unit}` : ""}{" "}
                        {l.refRange ? <span className="text-slate-600">(ref {l.refRange})</span> : null}{" "}
                        <span className="text-slate-700">→ {l.flag}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    No abnormal findings from extracted labs.
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        {/* Term drawer */}
        {selectedTerm && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-slate-700">Tap-to-explain</div>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">
                  {selectedTerm.term}
                  {selectedTerm.translation ? (
                    <span className="ml-2 text-sm font-medium text-slate-600">
                      → {selectedTerm.translation}
                    </span>
                  ) : null}
                </h3>
              </div>
              <button
                onClick={() => setSelectedTermIdx(null)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Meaning</div>
                <div className="mt-2 text-sm text-slate-900">{selectedTerm.meaning ?? "—"}</div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Why it matters</div>
                <div className="mt-2 text-sm text-slate-900">{selectedTerm.whyItMatters ?? "—"}</div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-semibold text-slate-700">Where it appears</div>
                <div className="mt-2 text-sm text-slate-900">
                  {selectedTerm.category ? selectedTerm.category.toUpperCase() : "—"}
                </div>
                {(() => {
                  const u = toSafeUrl(selectedTerm.source?.url);
                  return u ? (
                    <a
                      className="mt-2 inline-block text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-4 hover:decoration-slate-500"
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Learn more: {selectedTerm.source?.title ?? "Source"}
                    </a>
                  ) : (
                    <div className="mt-2 text-xs text-slate-600">No external source link.</div>
                  );
                })()}
              </div>
            </div>

            {selectedTerm.evidence?.snippet && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold text-slate-700">Evidence (from report)</div>
                <div className="mt-2 text-sm text-slate-800">{selectedTerm.evidence.snippet}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
