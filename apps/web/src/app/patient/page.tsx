"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// ---------------- storage keys ----------------
const LS_KEYS = {
  diary: "careloop.demoDiary.v1",
  tasks: "careloop.planTasks.v1", // string[]
  tasksState: "careloop.planTasksState.v1", // { [taskId]: { done, updatedAt } }
  preVisitSummary: "careloop.preVisitSummary.v2", // { summary, trust, generatedAt }
  transcript: "careloop.demoTranscript.v1", // reuse for demo "send to clinician"
} as const;

// ---------------- schemas ----------------
const DiaryEntrySchema = z.object({
  date: z.string().min(8),
  symptomScore: z.number().min(0).max(10),
  sleepHours: z.number().min(0).max(24),
  moodScore: z.number().min(0).max(10),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const TrendPointSchema = z.object({
  date: z.string(),
  symptomScore: z.number(),
  sleepHours: z.number(),
  moodScore: z.number(),
  // forward-compatible: backend may later return it; UI also computes locally if absent
  sentimentScore: z.number().min(-1).max(1).optional(),
});

const TrendResponseSchema = z.object({
  trend: z.array(TrendPointSchema),
});

const EvidenceRefSchema = z.object({
  entryDate: z.string().optional(),
  entryIndex: z.number().int().nonnegative().optional(),
  snippet: z.string().optional(),
  tag: z.string().optional(),
  score: z.number().optional(),
});

const SummaryItemSchema = z.union([
  z.string(),
  z.object({
    text: z.string().min(1),
    verified: z.boolean().optional(),
    evidence: z.array(EvidenceRefSchema).optional(),
  }),
]);

const SummaryResponseSchema = z.object({
  summary: z.object({
    headline: z.string(),
    bullets: z.array(SummaryItemSchema),
    possibleTriggers: z.array(SummaryItemSchema),
    gentleSuggestions: z.array(SummaryItemSchema),
    questionsForVisit: z.array(z.string()).optional(),
    redFlags: z.array(z.string()).optional(),
    last7DaysAvgSymptom: z.number().nullable(),
  }),
  trust: z
    .object({
      scorePct: z.number().min(0).max(100).optional(),
      verifiedCount: z.number().int().nonnegative().optional(),
      unverifiedCount: z.number().int().nonnegative().optional(),
      totalItems: z.number().int().nonnegative().optional(),
      piiDetected: z.boolean().optional(),
      notes: z.array(z.string()).optional(),
    })
    .optional(),
  piiDetected: z.boolean().optional(),
  redacted: z.boolean().optional(),
});

const RedactResponseSchema = z.object({
  redacted: z.string(),
  piiDetected: z.boolean().optional(),
});

const TranscribeResponseSchema = z.object({
  transcript: z.string(),
  segments: z
    .array(
      z.object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        text: z.string().min(1),
      })
    )
    .optional(),
  warnings: z.array(z.string()).optional(),
});

// ---------------- types ----------------
type DiaryEntry = {
  date: string; // YYYY-MM-DD
  symptomScore: number; // 0-10
  sleepHours: number; // 0-24
  moodScore: number; // 0-10
  notes: string;
  tags?: string[];
};

type TrendPoint = z.infer<typeof TrendPointSchema>;

type EvidenceRef = {
  entryDate?: string; // YYYY-MM-DD
  entryIndex?: number;
  snippet?: string;
  tag?: string;
  score?: number;
};

type SummaryItem = {
  text: string;
  verified: boolean | null; // null = unknown
  evidence: EvidenceRef[];
};

type DiarySummary = {
  headline: string;
  bullets: SummaryItem[];
  possibleTriggers: SummaryItem[];
  gentleSuggestions: SummaryItem[];
  questionsForVisit?: string[];
  redFlags?: string[];
  last7DaysAvgSymptom: number | null;
};

type TrustReport = {
  scorePct: number; // 0-100
  verifiedCount: number;
  unverifiedCount: number;
  totalItems: number;
  piiDetected: boolean;
  notes: string[];
};

type TaskItem = {
  id: string;
  text: string;
  done: boolean;
  updatedAt?: number;
};

type RedactionMode = "local" | "api" | "none";

type ApiError = Error & { status?: number; payload?: any };

// ---------------- helpers ----------------
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function safeJsonParseUnknown(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeDiary(entries: DiaryEntry[]): DiaryEntry[] {
  const cleaned = entries
    .filter((e) => !!e?.date)
    .map((e) => ({
      date: String(e.date).slice(0, 10),
      symptomScore: clamp(Number((e as any).symptomScore ?? 0), 0, 10),
      sleepHours: clamp(Number((e as any).sleepHours ?? 0), 0, 24),
      moodScore: clamp(Number((e as any).moodScore ?? 0), 0, 10),
      notes: String((e as any).notes ?? "").slice(0, 4000),
      tags: Array.isArray((e as any).tags)
        ? (e as any).tags
          .map((t: any) => String(t).trim())
          .filter(Boolean)
          .slice(0, 12)
        : [],
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Deduplicate by date (keep last)
  const byDate = new Map<string, DiaryEntry>();
  for (const e of cleaned) byDate.set(e.date, e);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = nums.reduce((a, b) => a + b, 0);
  return s / nums.length;
}

function lastNDays(diary: DiaryEntry[], n: number): DiaryEntry[] {
  if (!diary.length) return [];
  const latest = diary[diary.length - 1];
  const latestDate = new Date(`${latest.date}T00:00:00Z`).getTime();
  const cutoff = latestDate - (n - 1) * 24 * 60 * 60 * 1000;
  return diary.filter((e) => new Date(`${e.date}T00:00:00Z`).getTime() >= cutoff);
}

function extractTagStats(diary: DiaryEntry[]) {
  const stats = new Map<string, { count: number; avgSymptom: number }>();
  for (const e of diary) {
    const tags = (e.tags ?? []).map((t) => t.toLowerCase());
    for (const tag of tags) {
      const curr = stats.get(tag) ?? { count: 0, avgSymptom: 0 };
      const newCount = curr.count + 1;
      const newAvg = (curr.avgSymptom * curr.count + e.symptomScore) / newCount;
      stats.set(tag, { count: newCount, avgSymptom: newAvg });
    }
  }
  return stats;
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

  // address-ish (very heuristic)
  t = t.replace(
    /\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/gi,
    "[REDACTED_ADDR]"
  );

  return t;
}

function detectLikelyPii(text: string): boolean {
  if (!text.trim()) return false;
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
  const phone = /(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/.test(text);
  const addr =
    /\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/i.test(text);
  return email || phone || addr;
}

// tiny stable hash (not crypto)
function stableId(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `t_${(h >>> 0).toString(16)}`;
}

// very small, local-only sentiment heuristic: returns -1..1 (null if no text)
function localSentimentScore(text: string): number | null {
  const t = String(text ?? "").toLowerCase().trim();
  if (!t) return null;

  const pos = [
    "better",
    "improved",
    "improving",
    "good",
    "great",
    "calm",
    "rested",
    "relief",
    "helped",
    "ok",
    "fine",
  ];
  const neg = [
    "worse",
    "worsening",
    "bad",
    "awful",
    "pain",
    "cramp",
    "nausea",
    "vomit",
    "anxious",
    "panic",
    "tired",
    "insomnia",
    "severe",
    "dizzy",
  ];

  let score = 0;
  for (const w of pos) if (t.includes(w)) score += 1;
  for (const w of neg) if (t.includes(w)) score -= 1;

  // cap & normalize
  const capped = clamp(score, -5, 5);
  const normalized = capped / 5; // -1..1
  return normalized;
}

function computeLocalTrends(diary: DiaryEntry[]): TrendPoint[] {
  return diary.map((e) => ({
    date: e.date,
    symptomScore: e.symptomScore,
    sleepHours: e.sleepHours,
    moodScore: e.moodScore,
    sentimentScore: localSentimentScore(e.notes) ?? undefined,
  }));
}

function computeInsights(diary: DiaryEntry[]) {
  const last7 = lastNDays(diary, 7);
  const last14 = lastNDays(diary, 14);

  const avg7Sym = avg(last7.map((e) => e.symptomScore));
  const avg7Sleep = avg(last7.map((e) => e.sleepHours));
  const avg7Mood = avg(last7.map((e) => e.moodScore));

  const avg14Sym = avg(last14.map((e) => e.symptomScore));

  // quick “trend”: compare first 3 days vs last 3 days of last7
  const first3 = last7.slice(0, 3).map((e) => e.symptomScore);
  const last3 = last7.slice(-3).map((e) => e.symptomScore);
  const d = (avg(last3) ?? 0) - (avg(first3) ?? 0);

  const direction =
    last7.length >= 6
      ? d >= 1
        ? "worsening"
        : d <= -1
          ? "improving"
          : "stable"
      : "insufficient-data";

  const worst = last7.reduce(
    (acc, e) => (!acc || e.symptomScore > acc.symptomScore ? e : acc),
    null as DiaryEntry | null
  );

  const redFlag =
    (worst?.symptomScore ?? 0) >= 9 ||
    (avg7Sym != null && avg14Sym != null && avg7Sym - avg14Sym >= 2);

  return {
    avg7Sym,
    avg7Sleep,
    avg7Mood,
    direction,
    worst,
    redFlag,
  };
}

function normalizeSummaryItem(x: unknown): SummaryItem {
  if (typeof x === "string") return { text: x, verified: null, evidence: [] };

  const o = x as any;
  const text = typeof o?.text === "string" ? o.text : "";
  const verified = typeof o?.verified === "boolean" ? o.verified : null;
  const evidence = Array.isArray(o?.evidence)
    ? o.evidence
      .map((e: any) => ({
        entryDate: typeof e?.entryDate === "string" ? e.entryDate.slice(0, 10) : undefined,
        entryIndex: typeof e?.entryIndex === "number" ? e.entryIndex : undefined,
        snippet: typeof e?.snippet === "string" ? e.snippet.slice(0, 240) : undefined,
        tag: typeof e?.tag === "string" ? e.tag.slice(0, 40) : undefined,
        score: typeof e?.score === "number" ? e.score : undefined,
      }))
      .filter((e: EvidenceRef) => !!(e.entryDate || e.entryIndex != null || e.tag || e.snippet))
    : [];

  return { text: text || "(missing text)", verified, evidence };
}

function computeTrust(summary: DiarySummary): TrustReport {
  const items = [
    ...(summary.bullets ?? []),
    ...(summary.possibleTriggers ?? []),
    ...(summary.gentleSuggestions ?? []),
  ];

  const totalItems = items.length;

  // Heuristic: "verified" if (a) verified===true OR (b) evidence exists and verified!==false
  const verifiedCount = items.filter((i) =>
    i.verified === true ? true : i.verified === false ? false : (i.evidence?.length ?? 0) > 0
  ).length;

  const unverifiedCount = Math.max(0, totalItems - verifiedCount);
  const scorePct = totalItems ? Math.round((verifiedCount / totalItems) * 100) : 0;

  const notes: string[] = [];
  if (!totalItems) notes.push("No items to score yet.");
  else if (verifiedCount === 0) notes.push("No evidence links provided (yet). Add evidence-backed items for higher trust.");
  else if (verifiedCount < totalItems) notes.push("Some items lack evidence links. Treat as hints only.");

  return {
    scorePct,
    verifiedCount,
    unverifiedCount,
    totalItems,
    piiDetected: false,
    notes,
  };
}

function normalizeSummaryFromApi(parsed: z.infer<typeof SummaryResponseSchema>): {
  summary: DiarySummary;
  trust: TrustReport;
  meta: { redacted: boolean; piiDetected: boolean; generatedAt: number };
} {
  const raw = parsed.summary;

  const bullets = (raw.bullets ?? []).map(normalizeSummaryItem).filter((i) => i.text.trim());
  const triggers = (raw.possibleTriggers ?? []).map(normalizeSummaryItem).filter((i) => i.text.trim());
  const suggestions = (raw.gentleSuggestions ?? []).map(normalizeSummaryItem).filter((i) => i.text.trim());

  const summary: DiarySummary = {
    headline: raw.headline,
    bullets,
    possibleTriggers: triggers,
    gentleSuggestions: suggestions,
    questionsForVisit: raw.questionsForVisit?.slice(0, 8),
    redFlags: raw.redFlags?.slice(0, 6),
    last7DaysAvgSymptom: raw.last7DaysAvgSymptom,
  };

  const computed = computeTrust(summary);
  const trust: TrustReport = {
    scorePct: Math.round(parsed.trust?.scorePct ?? computed.scorePct),
    verifiedCount: parsed.trust?.verifiedCount ?? computed.verifiedCount,
    unverifiedCount: parsed.trust?.unverifiedCount ?? computed.unverifiedCount,
    totalItems: parsed.trust?.totalItems ?? computed.totalItems,
    piiDetected: Boolean(parsed.piiDetected ?? parsed.trust?.piiDetected ?? computed.piiDetected),
    notes: (parsed.trust?.notes?.length ? parsed.trust.notes : computed.notes).slice(0, 6),
  };

  const meta = {
    redacted: Boolean(parsed.redacted),
    piiDetected: Boolean(parsed.piiDetected),
    generatedAt: Date.now(),
  };

  return { summary, trust, meta };
}

function formatEvidence(e: EvidenceRef) {
  const bits: string[] = [];
  if (e.entryDate) bits.push(e.entryDate);
  if (e.entryIndex != null) bits.push(`#${e.entryIndex + 1}`);
  if (e.tag) bits.push(`tag:${e.tag}`);
  return bits.join(" • ");
}

function summaryToStoragePayload(summary: DiarySummary, trust: TrustReport) {
  return { summary, trust, generatedAt: Date.now() };
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

async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  const json = text ? safeJsonParseUnknown(text) : null;

  if (!res.ok) {
    const msg = (json as any)?.error ? String((json as any).error) : `API ${path} failed: ${res.status}`;
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    err.payload = json;
    throw err;
  }

  return json as T;
}

async function apiPostForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", body: form, signal });
  const text = await res.text();
  const json = text ? safeJsonParseUnknown(text) : null;

  if (!res.ok) {
    const msg = (json as any)?.error ? String((json as any).error) : `API ${path} failed: ${res.status}`;
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    err.payload = json;
    throw err;
  }

  return json as T;
}

// best-effort: redact only notes; numbers/tags are safe-ish synthetic fields
async function prepareDiaryForApi(diary: DiaryEntry[], mode: RedactionMode, signal?: AbortSignal) {
  if (mode === "none") return { diary, piiDetected: false };

  if (mode === "local") {
    const piiDetected = diary.some((e) => detectLikelyPii(e.notes));
    return {
      diary: diary.map((e) => ({ ...e, notes: localRedact(e.notes) })),
      piiDetected,
    };
  }

  // API redaction: redact notes (bounded to last 30 for speed)
  const limited = diary.slice(-30);
  let piiDetectedAny = false;

  const redactedNotes: string[] = [];
  for (const e of limited) {
    const note = String(e.notes ?? "").trim();
    if (!note) {
      redactedNotes.push(note);
      continue;
    }
    const payloadText = note.slice(0, 20000);

    try {
      const resp = await apiPost<unknown>("/privacy/redact", { text: payloadText }, signal);
      const parsed = RedactResponseSchema.safeParse(resp);
      const redacted = parsed.success ? parsed.data.redacted : localRedact(payloadText);
      piiDetectedAny = piiDetectedAny || Boolean(parsed.success && parsed.data.piiDetected);
      redactedNotes.push(redacted);
    } catch {
      // fallback per-note if API is flaky
      redactedNotes.push(localRedact(payloadText));
      piiDetectedAny = piiDetectedAny || detectLikelyPii(payloadText);
    }
  }

  const merged = diary
    .slice(0, Math.max(0, diary.length - limited.length))
    .concat(limited.map((e, i) => ({ ...e, notes: redactedNotes[i] ?? "" })));

  return { diary: merged, piiDetected: piiDetectedAny };
}

// ---------------- component ----------------
function PatientPageContent() {
  const searchParams = useSearchParams();
  const tab = (searchParams.get("tab") || "diary") as "diary" | "tasks";
  const demo = searchParams.get("demo") === "1";

  const [diary, setDiary] = useState<DiaryEntry[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [summary, setSummary] = useState<DiarySummary | null>(null);
  const [trust, setTrust] = useState<TrustReport | null>(null);
  const [summaryGeneratedAt, setSummaryGeneratedAt] = useState<number | null>(null);

  // Voice diary (optional)
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [sttWarnings, setSttWarnings] = useState<string[]>([]);

  // WOW: Vocal Biomarkers
  const [biomarkerSummary, setBiomarkerSummary] = useState<string | null>(null);

  // WOW: 3D Body Map
  const [showBodyMap, setShowBodyMap] = useState(false);

  /// WOW: Predictive Insights
  type PredictiveInsight = {
    type?: string;
    title: string;
    description: string;
    confidence?: "high" | "medium" | "low" | string | number;
    icon?: string;
  };
  
  const [predictiveInsights, setPredictiveInsights] =
    useState<string | PredictiveInsight[] | null>(null);

  // WOW: AR Scanner
  const [showScanner, setShowScanner] = useState(false);
  const [scannerResult, setScannerResult] = useState<string | null>(null);

  // Sentiment UI (optional)
  const [showSentiment, setShowSentiment] = useState<boolean>(false);

  // WOW: Health Twin
  const [healthTwin, setHealthTwin] = useState<any>(null);
  // WOW: Correlations
  const [correlations, setCorrelations] = useState<any>(null);
  // WOW: Alerts
  const [alerts, setAlerts] = useState<any[]>([]);
  // WOW: Streaks / Gamification
  const [streaks, setStreaks] = useState<any>(null);

  const [busy, setBusy] = useState({
    trends: false,
    summary: false,
    transcribe: false,
    redact: false,
    biomarkers: false,
    insights: false,
    scanning: false,
    healthTwin: false,
    correlations: false,
    alerts: false,
    streaks: false,
  });

  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const [redactionMode, setRedactionMode] = useState<RedactionMode>("local");
  const [windowDays, setWindowDays] = useState<7 | 30>(7);

  // Safety controls for API (backend can ignore; UI stays compatible)
  const [enforcePhiGate, setEnforcePhiGate] = useState<boolean>(true); // block if PII detected
  const [redactOutput, setRedactOutput] = useState<boolean>(true); // allow API to auto-redact output + flag
  const [expandedEvidence, setExpandedEvidence] = useState<Record<string, boolean>>({});



  // Entry form
  const [form, setForm] = useState<DiaryEntry>({
    date: todayISO(),
    symptomScore: 4,
    sleepHours: 7,
    moodScore: 7,
    notes: "",
    tags: [],
  });
  const [tagInput, setTagInput] = useState("");

  // Tasks refresh token (forces re-read localStorage)
  const [tasksRefreshToken, setTasksRefreshToken] = useState(0);

  // Abort controllers for in-flight requests
  const trendsAbortRef = useRef<AbortController | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const sttAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      trendsAbortRef.current?.abort();
      summaryAbortRef.current?.abort();
      sttAbortRef.current?.abort();
    };
  }, []);

  const tasksRaw = useMemo(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEYS.tasks) : null;
      const parsed = raw ? safeJsonParse<string[]>(raw) : null;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }, [tab, tasksRefreshToken]);

  const tasksStateRaw = useMemo(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEYS.tasksState) : null;
      const parsed = raw ? safeJsonParse<Record<string, { done: boolean; updatedAt?: number }>>(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }, [tab, tasksRefreshToken]);

  const tasks: TaskItem[] = useMemo(() => {
    return tasksRaw.slice(0, 50).map((t) => {
      const id = stableId(t);
      const state = (tasksStateRaw as any)[id];
      return { id, text: t, done: Boolean(state?.done), updatedAt: state?.updatedAt };
    });
  }, [tasksRaw, tasksStateRaw]);

  const adherence = useMemo(() => {
    if (!tasks.length) return null;
    const done = tasks.filter((t) => t.done).length;
    const pct = Math.round((done / tasks.length) * 100);
    return { done, total: tasks.length, pct };
  }, [tasks]);

  useEffect(() => {
    // Load diary
    try {
      const raw = localStorage.getItem(LS_KEYS.diary);
      if (raw) {
        const parsed = safeJsonParse<DiaryEntry[]>(raw);
        if (parsed) {
          const normalized = normalizeDiary(parsed);
          setDiary(normalized);
          setTrend(computeLocalTrends(normalized));
        }
      } else if (demo) {
        // Home page loads demo; do nothing here
      }
    } catch {
      // ignore
    }

    // Load cached summary
    try {
      const raw = localStorage.getItem(LS_KEYS.preVisitSummary);
      if (raw) {
        const parsed = safeJsonParse<any>(raw);
        if (parsed?.summary?.headline) {
          setSummary(parsed.summary as DiarySummary);
          if (parsed?.trust) setTrust(parsed.trust as TrustReport);
          if (typeof parsed?.generatedAt === "number") setSummaryGeneratedAt(parsed.generatedAt);
        }
      }
    } catch {
      // ignore
    }
  }, [demo]);

  useEffect(() => {
    setTrend(computeLocalTrends(diary));
  }, [diary]);

  const persistDiary = useCallback((next: DiaryEntry[]) => {
    setDiary(next);
    try {
      localStorage.setItem(LS_KEYS.diary, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const addTag = useCallback((tag: string) => {
    const t = tag.trim();
    if (!t) return;
    const nextTags = Array.from(new Set([...(form.tags ?? []), t])).slice(0, 12);
    setForm((f) => ({ ...f, tags: nextTags }));
  }, [form.tags]);

  const removeTag = useCallback((tag: string) => {
    setForm((f) => ({ ...f, tags: (f.tags ?? []).filter((x) => x !== tag) }));
  }, []);

  const addEntry = useCallback(() => {
    setErr(null);
    setNotes([]);

    const parsed = DiaryEntrySchema.safeParse({
      ...form,
      date: String(form.date).slice(0, 10),
      symptomScore: clamp(Number(form.symptomScore), 0, 10),
      sleepHours: clamp(Number(form.sleepHours), 0, 24),
      moodScore: clamp(Number(form.moodScore), 0, 10),
      notes: String(form.notes ?? "").slice(0, 4000),
      tags: (form.tags ?? []).slice(0, 12),
    });

    if (!parsed.success) {
      setErr("Invalid entry. Please check the inputs.");
      return;
    }

    const entry: DiaryEntry = {
      date: parsed.data.date.slice(0, 10),
      symptomScore: parsed.data.symptomScore,
      sleepHours: parsed.data.sleepHours,
      moodScore: parsed.data.moodScore,
      notes: String(parsed.data.notes ?? ""),
      tags: parsed.data.tags ?? [],
    };

    const next = normalizeDiary([...diary, entry]);
    persistDiary(next);

    setForm((f) => ({ ...f, date: todayISO(), notes: "" }));
  }, [diary, form, persistDiary]);

  const deleteEntry = useCallback((date: string) => {
    const next = diary.filter((e) => e.date !== date);
    persistDiary(next);
  }, [diary, persistDiary]);

  const clearDiaryOnly = useCallback(() => {
    setErr(null);
    setNotes([]);
    setSummary(null);
    setTrust(null);
    setSummaryGeneratedAt(null);
    setTrend([]);
    persistDiary([]);
    try {
      localStorage.removeItem(LS_KEYS.diary);
      localStorage.removeItem(LS_KEYS.preVisitSummary);
    } catch {
      // ignore
    }
  }, [persistDiary]);

  const clearAllDemoData = useCallback(() => {
    setErr(null);
    setNotes([]);
    setSummary(null);
    setTrust(null);
    setSummaryGeneratedAt(null);
    setDiary([]);
    setTrend([]);
    try {
      localStorage.removeItem(LS_KEYS.diary);
      localStorage.removeItem(LS_KEYS.tasks);
      localStorage.removeItem(LS_KEYS.tasksState);
      localStorage.removeItem(LS_KEYS.preVisitSummary);
      // localStorage.removeItem(LS_KEYS.transcript);
    } catch {
      // ignore
    }
    setTasksRefreshToken((x) => x + 1);
  }, []);

  const explainPiiGateFailure = useCallback(() => {
    setNotes((n) => [
      ...n,
      "Safety gate blocked generation: possible PII/PHI detected.",
      "Tip: switch Redaction to Local/API, then retry. Keep content synthetic in demos.",
    ]);
  }, []);

  const refreshTrends = useCallback(async () => {
    setErr(null);
    setNotes([]);
    setBusy((b) => ({ ...b, trends: true }));

    trendsAbortRef.current?.abort();
    trendsAbortRef.current = new AbortController();

    try {
      if (enforcePhiGate && redactionMode === "none") {
        const anyPii = diary.some((e) => detectLikelyPii(e.notes));
        if (anyPii) {
          explainPiiGateFailure();
          return;
        }
      }

      const { diary: payloadDiary, piiDetected } = await prepareDiaryForApi(
        diary,
        redactionMode,
        trendsAbortRef.current.signal
      );
      if (piiDetected) setNotes((n) => [...n, "PII detected and redacted (best-effort) before processing."]);

      const resp = await apiPost<unknown>("/diary/trends", { diary: payloadDiary }, trendsAbortRef.current.signal);
      const parsed = TrendResponseSchema.safeParse(resp);

      if (parsed.success) {
        // merge local sentiment if API doesn’t return it
        const localByDate = new Map(computeLocalTrends(diary).map((p) => [p.date, p]));
        const merged = parsed.data.trend.map((p) => ({
          ...p,
          sentimentScore: p.sentimentScore ?? localByDate.get(p.date)?.sentimentScore,
        }));
        setTrend(merged);
      } else {
        setTrend(computeLocalTrends(diary));
      }
    } catch (e) {
      if ((e as any)?.name !== "AbortError") {
        setTrend(computeLocalTrends(diary));
        setNotes((n) => [...n, "API unavailable — trends computed locally (demo fallback)."]);
      }
    } finally {
      setBusy((b) => ({ ...b, trends: false }));
    }
  }, [diary, enforcePhiGate, explainPiiGateFailure, redactionMode]);

  const generateSummary = useCallback(async () => {
  setErr(null);
  setNotes([]);
  setBusy((b) => ({ ...b, summary: true }));

  summaryAbortRef.current?.abort();
  summaryAbortRef.current = new AbortController();

  let didTimeout = false;
  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    summaryAbortRef.current?.abort();
  }, 15000);

  try {
    // PII gate
    if (enforcePhiGate && redactionMode === "none") {
      const anyPii = diary.some((e) => detectLikelyPii(e.notes));
      if (anyPii) {
        explainPiiGateFailure();
        return;
      }
    }

    // prepare payload (redaction)
    const { diary: payloadDiary, piiDetected } = await prepareDiaryForApi(
      diary,
      redactionMode,
      summaryAbortRef.current.signal
    );

    if (piiDetected) {
      setNotes((n) => [...n, "PII detected and redacted (best-effort) before processing."]);
    }

    // API call
    const resp = await apiPost<unknown>(
      "/diary/summarize",
      {
        diary: payloadDiary,
        enforceRedaction: enforcePhiGate,
        redactOutput,
        windowDays,
      },
      summaryAbortRef.current.signal
    );

    const parsed = SummaryResponseSchema.safeParse(resp);
    if (!parsed.success) throw new Error("Bad summary response");

    const normalized = normalizeSummaryFromApi(parsed.data);

    setSummary(normalized.summary);
    setTrust(normalized.trust);
    setSummaryGeneratedAt(normalized.meta.generatedAt);

    if (normalized.meta.piiDetected) {
      setNotes((n) => [
        ...n,
        normalized.meta.redacted
          ? "PII detected in model output and redacted (best-effort)."
          : "PII detected in model output.",
      ]);
    }

    try {
      localStorage.setItem(
        LS_KEYS.preVisitSummary,
        JSON.stringify(summaryToStoragePayload(normalized.summary, normalized.trust))
      );
    } catch {
      // ignore
    }
  } catch (e: unknown) {
    // Abort legyen néma, kivéve ha timeout miatt abortoltunk
    if ((e as any)?.name === "AbortError" && !didTimeout) return;

    const errObj = e as ApiError;
    const code = errObj?.payload?.code ? String(errObj.payload.code) : "";

    if (code === "PII_DETECTED") {
      explainPiiGateFailure();
      return;
    }

    if (didTimeout) {
      setNotes((n) => [...n, "Summary API timed out — using local fallback."]);
    }

    // ---- LOCAL FALLBACK ----
    const last7 = lastNDays(diary, 7);
    const avgSym = avg(last7.map((x) => x.symptomScore));
    const worst = last7.reduce(
      (acc, x) => (!acc || x.symptomScore > acc.symptomScore ? x : acc),
      null as DiaryEntry | null
    );

    const tagStats = extractTagStats(last7);
    const triggers = Array.from(tagStats.entries())
      .filter(([, v]) => v.count >= 2)
      .sort((a, b) => b[1].avgSymptom - a[1].avgSymptom)
      .slice(0, 4)
      .map(([k]) => k);

    const localSummary: DiarySummary = {
      headline: diary.length
        ? "Pre-visit summary (local fallback)"
        : "Add a few diary entries to generate a summary",
      bullets: diary.length
        ? [
            {
              text:
                avgSym != null
                  ? `Last 7 days avg symptom score: ${avgSym.toFixed(1)} / 10`
                  : "Not enough data for a 7-day average",
              verified: null,
              evidence: [],
            },
            {
              text: worst
                ? `Worst day (last 7 days): ${worst.date} (symptom ${worst.symptomScore}/10)`
                : "No worst day available",
              verified: null,
              evidence: [],
            },
            { text: "Patterns are hints only (not a diagnosis).", verified: null, evidence: [] },
          ]
        : [],
      possibleTriggers: triggers.map((t) => ({ text: t, verified: null, evidence: [] })),
      gentleSuggestions: diary.length
        ? [
            {
              text: "Keep logging meals/sleep alongside symptoms for clearer patterns.",
              verified: null,
              evidence: [],
            },
            {
              text: "If symptoms worsen or new red flags appear, consider contacting a clinician.",
              verified: null,
              evidence: [],
            },
          ]
        : [],
      questionsForVisit: diary.length
        ? [
            "When did symptoms start, and what seems to worsen/improve them?",
            "Any recent diet/med changes, stress, travel, or illness exposures?",
            "Any new red flags (fever, severe pain, dehydration, blood)?",
          ]
        : [],
      redFlags: [],
      last7DaysAvgSymptom: avgSym,
    };

    const localTrust = computeTrust(localSummary);

    setSummary(localSummary);
    setTrust(localTrust);
    setSummaryGeneratedAt(Date.now());

    try {
      localStorage.setItem(
        LS_KEYS.preVisitSummary,
        JSON.stringify(summaryToStoragePayload(localSummary, localTrust))
      );
    } catch {
      // ignore
    }

    if (!didTimeout) {
      setNotes((n) => [...n, "API unavailable — summary generated locally (demo fallback)."]);
    }
  } finally {
    window.clearTimeout(timeoutId);
    setBusy((b) => ({ ...b, summary: false }));
  }
}, [diary, enforcePhiGate, explainPiiGateFailure, redactOutput, redactionMode, windowDays]);

  const transcribeDiaryAudioIntoNotes = useCallback(async () => {
    setErr(null);
    setNotes([]);
    setSttWarnings([]);

    if (!audioFile) {
      setErr("Choose an audio file first.");
      return;
    }

    setBusy((b) => ({ ...b, transcribe: true }));

    sttAbortRef.current?.abort();
    sttAbortRef.current = new AbortController();

    try {
      const formData = new FormData();
      formData.append("audio", audioFile);

      const resp = await apiPostForm<unknown>("/transcribe", formData, sttAbortRef.current.signal);
      const parsed = TranscribeResponseSchema.safeParse(resp);

      if (!parsed.success) throw new Error("Bad STT response");

      const t = parsed.data.transcript.trim();
      if (!t) throw new Error("Empty transcript");

      setForm((f) => ({
        ...f,
        notes: f.notes ? `${f.notes}\n${t}` : t,
        tags: Array.from(new Set([...(f.tags ?? []), "voice"])).slice(0, 12),
      }));

      if (parsed.data.warnings?.length) setSttWarnings(parsed.data.warnings);
      setNotes((n) => [...n, "Audio transcribed. Review notes and save as a diary entry."]);
    } catch (e) {
      if ((e as any)?.name !== "AbortError") {
        setErr("Transcription failed (or API not running). You can still type notes manually.");
      }
    } finally {
      setBusy((b) => ({ ...b, transcribe: false }));
    }
  }, [audioFile]);

  const analyzeVocalBiomarkers = useCallback(async () => {
    if (!audioFile) {
      setErr("Choose an audio file first.");
      return;
    }
    setBusy(b => ({ ...b, biomarkers: true }));
    setBiomarkerSummary(null);
    try {
      const formData = new FormData();
      formData.append("audio", audioFile);
      const resp = await apiPostForm<any>("/diary/biomarkers", formData);
      setBiomarkerSummary(resp.biomarkerSummary);
      setForm(f => ({
        ...f,
        tags: Array.from(new Set([...(f.tags ?? []), "biomarker-verified"])).slice(0, 12),
      }));
    } catch {
      setErr("Failed to analyze biomarkers.");
    } finally {
      setBusy(b => ({ ...b, biomarkers: false }));
    }
  }, [audioFile]);

  const fetchPredictiveInsights = useCallback(async () => {
    // ne induljon el párhuzamosan
    if (busy.insights) return;
  
    setErr(null);
    setNotes([]);
  
    if (diary.length < 3) {
      setErr("Need at least 3 diary entries for predictive insights.");
      return;
    }
  
    setBusy((b) => ({ ...b, insights: true }));
    setPredictiveInsights(null);
  
    try {
      const resp = await apiPost<any>("/diary/insights", { diary });
      const raw = resp?.insights ?? resp;
  
      if (Array.isArray(raw)) setPredictiveInsights(raw);
      else if (typeof raw === "string") setPredictiveInsights(raw);
      else setPredictiveInsights(raw ? JSON.stringify(raw, null, 2) : null);
    } catch (e) {
      setErr("Failed to fetch predictive insights.");
    } finally {
      setBusy((b) => ({ ...b, insights: false }));
    }
  }, [diary, busy.insights, setNotes]);

  const simulateARScanner = useCallback(async () => {
    setShowScanner(true);
    setScannerResult(null);
    setBusy(b => ({ ...b, scanning: true }));
    try {
      // Simulate fake camera delay
      await new Promise(r => setTimeout(r, 2000));
      // Call mock endpoint
      const formData = new FormData();
      const mockBlob = new Blob(["fake image"], { type: "image/jpeg" });
      formData.append("image", mockBlob, "scan.jpg");
      const resp = await apiPostForm<any>("/vision/scan", formData);

      setScannerResult(`Identified: ${resp.identifiedItems?.join(", ") || "Unknown"}\nNutrition/Info: ${resp.nutritionOrInfo}`);

      setForm(f => ({
        ...f,
        notes: f.notes ? `${f.notes}\n[Scanned] ${resp.identifiedItems?.join(", ")}` : `[Scanned] ${resp.identifiedItems?.join(", ")}`,
        tags: Array.from(new Set([...(f.tags ?? []), "scanned-item"])).slice(0, 12)
      }));
    } catch {
      setScannerResult("Scan failed. Ensure backend AR endpoint is mock-enabled.");
    } finally {
      setBusy(b => ({ ...b, scanning: false }));
      setTimeout(() => setShowScanner(false), 4000);
    }
  }, []);

  const handleBodyMapClick = useCallback((part: string) => {
    const noteAdd = `Pain located in ${part}.`;
    setForm(f => ({ ...f, notes: f.notes ? `${f.notes} ${noteAdd}` : noteAdd }));
  }, []);

  // WOW: Fetch Health Twin
  const fetchHealthTwin = useCallback(async () => {
    if (diary.length < 2) return;
    setBusy(b => ({ ...b, healthTwin: true }));
    try {
      const resp = await apiPost<any>("/patient/health-twin", { diary });
      setHealthTwin(resp);
    } catch { /* fallback */ }
    finally { setBusy(b => ({ ...b, healthTwin: false })); }
  }, [diary]);

  // WOW: Fetch Correlations
  const fetchCorrelations = useCallback(async () => {
    if (diary.length < 3) return;
    setBusy(b => ({ ...b, correlations: true }));
    try {
      const resp = await apiPost<any>("/diary/correlations", { diary });
      setCorrelations(resp);
    } catch { /* fallback */ }
    finally { setBusy(b => ({ ...b, correlations: false })); }
  }, [diary]);

  // WOW: Fetch Alerts
  const fetchAlerts = useCallback(async () => {
    if (diary.length < 2) return;
    try {
      const resp = await apiPost<any>("/diary/alerts", { diary });
      setAlerts(resp.alerts ?? []);
    } catch { /* ignore */ }
  }, [diary]);

  // WOW: Fetch Streaks
  const fetchStreaks = useCallback(async () => {
    if (diary.length < 1) return;
    setBusy(b => ({ ...b, streaks: true }));
    try {
      const resp = await apiPost<any>("/patient/streaks", { diary });
      setStreaks(resp);
    } catch { /* ignore */ }
    finally { setBusy(b => ({ ...b, streaks: false })); }
  }, [diary]);

  // Auto-fetch WOW data when diary changes
  useEffect(() => {
    if (diary.length >= 2) {
      fetchHealthTwin();
      fetchAlerts();
      fetchStreaks();
    }
    if (diary.length >= 3) {
      fetchCorrelations();
    }
  }, [diary.length]);

  const toggleTaskDone = useCallback((taskId: string) => {
    try {
      const raw = localStorage.getItem(LS_KEYS.tasksState);
      const parsed = raw ? safeJsonParse<Record<string, { done: boolean; updatedAt?: number }>>(raw) : null;
      const next = parsed && typeof parsed === "object" ? { ...parsed } : {};
      const current = next[taskId]?.done ?? false;
      next[taskId] = { done: !current, updatedAt: Date.now() };
      localStorage.setItem(LS_KEYS.tasksState, JSON.stringify(next));
      setTasksRefreshToken((x) => x + 1);
    } catch {
      setErr("Could not save task state (browser policy/private mode).");
    }
  }, []);

  const canTrend = diary.length >= 2;
  const canSummarize = diary.length >= 1; // ha 1 bejegyzésből is engednéd

  const windowedDiary = useMemo(() => lastNDays(diary, windowDays), [diary, windowDays]);

  const windowedTrend = useMemo(() => {
    const set = new Set(windowedDiary.map((e) => e.date));
    return trend.filter((p) => set.has(p.date));
  }, [trend, windowedDiary]);

  const hasAnySentiment = useMemo(
    () => windowedTrend.some((p) => typeof p.sentimentScore === "number"),
    [windowedTrend]
  );

  useEffect(() => {
    // auto-enable sentiment line if any data appears
    if (hasAnySentiment) setShowSentiment(true);
  }, [hasAnySentiment]);

  const insights = useMemo(() => computeInsights(diary), [diary]);

  const preVisitText = useMemo(() => {
    const lines: string[] = [];
    lines.push("PATIENT PRE-VISIT SUMMARY (synthetic / demo)");
    lines.push(`Window: last ${windowDays} days`);
    if (trust) lines.push(`Trust score (evidence coverage): ${trust.scorePct}% (${trust.verifiedCount}/${trust.totalItems})`);
    if (insights.avg7Sym != null) lines.push(`Avg symptom (7d): ${insights.avg7Sym.toFixed(1)}/10`);
    if (insights.avg7Sleep != null) lines.push(`Avg sleep (7d): ${insights.avg7Sleep.toFixed(1)}h`);
    if (insights.avg7Mood != null) lines.push(`Avg mood (7d): ${insights.avg7Mood.toFixed(1)}/10`);
    lines.push(`Trend: ${insights.direction}`);
    if (insights.worst) lines.push(`Worst day (7d): ${insights.worst.date} • symptom ${insights.worst.symptomScore}/10`);

    if (summary?.redFlags?.length) {
      lines.push("");
      lines.push("Red flags (screening prompts, not diagnosis):");
      for (const r of summary.redFlags.slice(0, 6)) lines.push(`- ${r}`);
    }

    if (summary?.bullets?.length) {
      lines.push("");
      lines.push("Highlights:");
      for (const b of summary.bullets.slice(0, 10)) lines.push(`- ${b.text}`);
    }

    if (summary?.possibleTriggers?.length) {
      const trig = summary.possibleTriggers.map((t) => t.text).filter(Boolean).slice(0, 10);
      if (trig.length) {
        lines.push("");
        lines.push(`Possible triggers: ${trig.join(", ")}`);
      }
    }

    if (summary?.gentleSuggestions?.length) {
      lines.push("");
      lines.push("Suggestions (non-medical):");
      for (const s of summary.gentleSuggestions.slice(0, 8)) lines.push(`- ${s.text}`);
    }

    if (summary?.questionsForVisit?.length) {
      lines.push("");
      lines.push("Questions to discuss at visit:");
      for (const q of summary.questionsForVisit.slice(0, 8)) lines.push(`- ${q}`);
    }

    if (adherence) {
      lines.push("");
      lines.push(`Plan adherence (demo): ${adherence.pct}% (${adherence.done}/${adherence.total})`);
      const missed = tasks.filter((t) => !t.done).slice(0, 8);
      if (missed.length) {
        lines.push("Open tasks:");
        for (const m of missed) lines.push(`- ${m.text}`);
      }
    }

    return lines.join("\n");
  }, [summary, insights, adherence, tasks, windowDays, trust]);

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotes((n) => [...n, "Copied to clipboard."]);
    } catch {
      setErr("Clipboard not available in this browser context.");
    }
  }, []);

  const sendPreVisitToClinicianDemo = useCallback(() => {
    try {
      localStorage.setItem(LS_KEYS.transcript, preVisitText);
      setNotes((n) => [...n, "Sent to Clinician mode (demo): transcript stored locally."]);
    } catch {
      setErr("Could not write to localStorage.");
    }
  }, [preVisitText]);

  const toggleEvidence = useCallback((key: string) => {
    setExpandedEvidence((m) => ({ ...m, [key]: !m[key] }));
  }, []);

  const trustBadge = useCallback(() => {
    if (!trust) return null;
    const label = trust.scorePct >= 75 ? "High confidence" : trust.scorePct >= 40 ? "Mixed confidence" : "Low confidence";
    return (
      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
        {label} • {trust.scorePct}%
      </span>
    );
  }, [trust]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Patient mode</h1>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                Closed-loop • Synthetic-first
              </span>
              {tab === "diary" ? trustBadge() : null}
            </div>
            <p className="mt-2 max-w-2xl text-sm text-slate-700">
              Log symptoms/sleep/mood and generate trends + an evidence-backed pre-visit summary. Tasks come from the clinician SOAP Plan.
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
              href="/clinician"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Clinician mode
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
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            <Link
              href="/patient"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === "diary" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                }`}
            >
              Diary
            </Link>
            <Link
              href="/patient?tab=tasks"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === "tasks" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                }`}
            >
              Tasks
            </Link>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-700">Redaction:</span>
            <select
              value={redactionMode}
              onChange={(e) => setRedactionMode(e.target.value as RedactionMode)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
            >
              <option value="local">Local (demo-safe)</option>
              <option value="api">API (/privacy/redact)</option>
              <option value="none">Off</option>
            </select>
          </div>

          {tab === "diary" ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={enforcePhiGate}
                  onChange={(e) => setEnforcePhiGate(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Block if PII detected
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={redactOutput}
                  onChange={(e) => setRedactOutput(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Redact model output (best-effort)
              </label>
              {hasAnySentiment ? (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={showSentiment}
                    onChange={(e) => setShowSentiment(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Show sentiment (demo)
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="ml-auto flex flex-wrap gap-2">
            <button
              onClick={() => downloadJson("diary.json", diary)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Export diary JSON
            </button>
            <button
              onClick={clearDiaryOnly}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Clear diary
            </button>
            <button
              onClick={clearAllDemoData}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              title="Clears diary + tasks + adherence + cached summary (demo reset)"
            >
              Clear ALL demo data
            </button>
          </div>
        </div>

        {err && (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            {err}
          </div>
        )}
        {notes.length > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800">
            <div className="text-xs font-semibold text-slate-700">Notes</div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {notes.map((n, i) => (
                <li key={`${n}-${i}`}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        {tab === "tasks" ? (
          <section className="mt-6 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Plan tasks</h2>
                  <p className="mt-2 text-sm text-slate-700">
                    Tasks are generated from the clinician SOAP “Plan” and saved locally for the demo.
                  </p>
                </div>
                {adherence ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900">
                    <div className="text-xs font-semibold text-slate-700">Adherence</div>
                    <div className="mt-1">
                      <span className="text-lg font-semibold">{adherence.pct}%</span>{" "}
                      <span className="text-xs text-slate-600">
                        ({adherence.done}/{adherence.total})
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>

              {tasks.length ? (
                <ul className="mt-4 space-y-2">
                  {tasks.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                    >
                      <input
                        type="checkbox"
                        checked={t.done}
                        onChange={() => toggleTaskDone(t.id)}
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                      />
                      <div className="flex-1">
                        <div className="text-sm text-slate-900">{t.text}</div>
                        {t.updatedAt ? (
                          <div className="mt-1 text-[11px] text-slate-500">
                            Updated: {new Date(t.updatedAt).toLocaleString()}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  No tasks yet. Generate a SOAP note in{" "}
                  <Link href="/clinician" className="underline underline-offset-4">
                    Clinician mode
                  </Link>{" "}
                  and send the Plan to the patient.
                </div>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  onClick={() => copyToClipboard(preVisitText)}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Copy check-in summary
                </button>
                <button
                  onClick={sendPreVisitToClinicianDemo}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                  title="Stores a synthetic “transcript” for Clinician mode"
                >
                  Send check-in → Clinician (demo)
                </button>
                <Link
                  href="/clinician"
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                >
                  Open Clinician mode
                </Link>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-base font-semibold text-slate-900">Safety</h3>
              <p className="mt-2 text-sm text-slate-700">
                Prototype only. Tasks and suggestions are informational and not medical advice.
              </p>
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                Tip: keep everything synthetic for demos; never store PHI in this repo or logs.
              </div>
            </div>
          </section>
        ) : (
          <>
            {/* Trends + Summary */}
            <section className="mt-6 grid gap-6 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-slate-900">Trends</h2>
                    <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
                      <button
                        onClick={() => setWindowDays(7)}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${windowDays === 7 ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                          }`}
                      >
                        7d
                      </button>
                      <button
                        onClick={() => setWindowDays(30)}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${windowDays === 30 ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                          }`}
                      >
                        30d
                      </button>
                    </div>
                  </div>

                 <div className="flex flex-wrap gap-2">
                    <button
                      disabled={!canAnalyze || busy.trends}
                      onClick={refreshTrends}
                      className={`rounded-xl px-4 py-2 text-sm font-medium ${
                        !canAnalyze || busy.trends
                          ? "cursor-not-allowed bg-slate-100 text-slate-400"
                          : "bg-slate-900 text-white hover:bg-slate-800"
                      }`}
                    >
                      {busy.trends ? "Refreshing…" : "Refresh trends"}
                    </button>
                  
                    <button
                      disabled={!canAnalyze || busy.summary}
                      onClick={generateSummary}
                      className={`rounded-xl px-4 py-2 text-sm font-medium ${
                        !canAnalyze || busy.summary
                          ? "cursor-not-allowed bg-slate-100 text-slate-400"
                          : "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                      }`}
                    >
                      {busy.summary ? "Generating…" : "Generate summary"}
                    </button>
                  
                    <button
                      disabled={diary.length < 3 || busy.insights}
                      onClick={fetchPredictiveInsights}
                      className={`rounded-xl border px-4 py-2 text-sm font-medium ${
                        diary.length < 3 || busy.insights
                          ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
                          : "border-indigo-200 bg-indigo-50 text-indigo-900 hover:bg-indigo-100"
                      }`}
                    >
                      {busy.insights ? "Analyzing…" : "✨ Predictive Insights"}
                    </button>
                  </div>
                  </div>
                  
                  {predictiveInsights != null && (
                    <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 shadow-inner">
                      <div className="flex items-center gap-2 font-semibold">
                        <span>✨</span> AI Predictive Insights
                      </div>
                  
                      {typeof predictiveInsights === "string" ? (
                        <div className="mt-1 whitespace-pre-wrap">
                          {predictiveInsights.trim() ? predictiveInsights : "No predictive insights available yet."}
                        </div>
                      ) : Array.isArray(predictiveInsights) ? (
                        predictiveInsights.length ? (
                          <div className="mt-3 space-y-3">
                            {predictiveInsights.map((ins: any, i: number) => (
                              <div
                                key={`${ins?.title ?? "ins"}-${i}`}
                                className="flex items-start gap-3 rounded-xl bg-white/60 p-3"
                              >
                                <span className="text-2xl">{ins?.icon ?? "✨"}</span>
                                <div>
                                  <div className="text-sm font-semibold text-slate-900">
                                    {ins?.title ?? "Insight"}
                                  </div>
                                  <div className="mt-0.5 text-xs text-slate-700">
                                    {ins?.description ?? ""}
                                  </div>
                                  {ins?.confidence != null && (
                                    <span className="mt-1 inline-block rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700">
                                      {String(ins.confidence)} confidence
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-1 text-slate-700">No predictive insights returned.</div>
                        )
                      ) : (
                        <pre className="mt-2 text-xs whitespace-pre-wrap text-slate-700">
                          {JSON.stringify(predictiveInsights, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                  
                  <p className="mt-2 text-sm text-slate-700">
                    {canAnalyze
                      ? "Visualize symptoms, sleep, mood — optional sentiment (demo) — over time."
                      : "Add at least 2 entries to see trends."}
                  </p>
                  
                  {insights.redFlag ? (
                    <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                      Pattern flag (demo): symptoms appear significantly worse recently. Consider discussing with a clinician.
                    </div>
                  ) : null}
  
                  <div className="mt-5 w-full" style={{ height: 320 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={windowedTrend}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="date" tickMargin={8} />
                        <YAxis yAxisId="left" tickMargin={8} />
                        {showSentiment && hasAnySentiment ? (
                          <YAxis yAxisId="right" orientation="right" domain={[-1, 1]} tickMargin={8} />
                        ) : null}
                        <Tooltip
                          formatter={(value: any, name: any) => {
                            if (name === "Sentiment (-1..1)") return [Number(value).toFixed(2), name];
                            if (typeof value === "number") return [value.toFixed(1), name];
                            return [String(value), name];
                          }}
                        />
                        <Legend />
                        <Line yAxisId="left" type="monotone" dataKey="symptomScore" name="Symptom (0-10)" dot={false} />
                        <Line yAxisId="left" type="monotone" dataKey="sleepHours" name="Sleep (hours)" dot={false} />
                        <Line yAxisId="left" type="monotone" dataKey="moodScore" name="Mood (0-10)" dot={false} />
                        {showSentiment && hasAnySentiment ? (
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="sentimentScore"
                            name="Sentiment (-1..1)"
                            dot={false}
                          />
                        ) : null}
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
                  <div className="font-semibold">Quick insights</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <div>
                      <div className="text-[11px] text-slate-600">Trend</div>
                      <div className="text-sm text-slate-900">{insights.direction}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-600">Avg symptom (7d)</div>
                      <div className="text-sm text-slate-900">
                        {insights.avg7Sym != null ? `${insights.avg7Sym.toFixed(1)}/10` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-600">Avg sleep (7d)</div>
                      <div className="text-sm text-slate-900">
                        {insights.avg7Sleep != null ? `${insights.avg7Sleep.toFixed(1)}h` : "—"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 text-xs text-slate-500">
                  If the API isn’t running, trends/summary fall back locally for the demo.
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">Pre-visit summary</h2>
                    <p className="mt-2 text-sm text-slate-700">
                      Clinician-friendly, with optional evidence links (patterns only, not diagnosis).
                    </p>
                  </div>
                  {trust ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900">
                      <div className="text-xs font-semibold text-slate-700">Trust score</div>
                      <div className="mt-1">
                        <span className="text-lg font-semibold">{trust.scorePct}%</span>{" "}
                        <span className="text-xs text-slate-600">
                          ({trust.verifiedCount}/{trust.totalItems})
                        </span>
                      </div>
                      {trust.piiDetected ? <div className="mt-1 text-[11px] text-amber-700">PII flagged</div> : null}
                    </div>
                  ) : null}
                </div>

                {summary ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-sm font-medium text-slate-900">{summary.headline}</div>
                      {summary.last7DaysAvgSymptom != null && (
                        <div className="mt-1 text-xs text-slate-600">
                          Last 7 days avg symptom: {summary.last7DaysAvgSymptom.toFixed(1)}/10
                        </div>
                      )}
                      {summaryGeneratedAt ? (
                        <div className="mt-1 text-[11px] text-slate-500">
                          Generated: {new Date(summaryGeneratedAt).toLocaleString()}
                        </div>
                      ) : null}
                    </div>

                    {trust?.notes?.length ? (
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <div className="text-xs font-semibold text-slate-700">Quality & safety</div>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
                          {trust.notes.map((t, i) => (
                            <li key={`${t}-${i}`}>{t}</li>
                          ))}
                        </ul>
                        <div className="mt-2 text-[11px] text-slate-500">
                          Evidence coverage is a prototype metric — it’s not clinical validation.
                        </div>
                      </div>
                    ) : null}

                    {!!summary.redFlags?.length ? (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                        <div className="text-xs font-semibold text-amber-900">Red flags (screening prompts)</div>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                          {summary.redFlags.map((r, i) => (
                            <li key={`${r}-${i}`}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {!!summary.bullets?.length && (
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <div className="text-xs font-semibold text-slate-700">Highlights</div>
                        <ul className="mt-2 space-y-2">
                          {summary.bullets.slice(0, 10).map((b, i) => {
                            const key = `b_${i}_${stableId(b.text)}`;
                            const hasEvidence = (b.evidence?.length ?? 0) > 0;
                            const status =
                              b.verified === true || (b.verified == null && hasEvidence)
                                ? "Verified"
                                : b.verified === false
                                  ? "Unverified"
                                  : "No evidence";

                            return (
                              <li key={key} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="text-sm text-slate-900">{b.text}</div>
                                  <button
                                    onClick={() => toggleEvidence(key)}
                                    className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
                                  >
                                    {expandedEvidence[key] ? "Hide" : "Evidence"}
                                  </button>
                                </div>

                                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-600">
                                  <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">
                                    {status}
                                  </span>
                                  {hasEvidence ? (
                                    <span className="text-slate-500">{b.evidence.length} link(s)</span>
                                  ) : (
                                    <span className="text-slate-500">—</span>
                                  )}
                                </div>

                                {expandedEvidence[key] ? (
                                  <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                                    {hasEvidence ? (
                                      <ul className="space-y-2 text-xs text-slate-700">
                                        {b.evidence.slice(0, 5).map((e, j) => (
                                          <li
                                            key={`${key}_e_${j}`}
                                            className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1"
                                          >
                                            <div className="text-[11px] font-semibold text-slate-700">
                                              {formatEvidence(e) || "Evidence"}
                                            </div>
                                            {e.snippet ? (
                                              <div className="mt-1 text-xs text-slate-700">“{e.snippet}”</div>
                                            ) : null}
                                          </li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <div className="text-xs text-slate-600">No evidence returned for this item.</div>
                                    )}
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <div className="text-xs font-semibold text-slate-700">Possible triggers</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(summary.possibleTriggers?.length
                          ? summary.possibleTriggers
                          : [{ text: "—", verified: null, evidence: [] }]
                        )
                          .slice(0, 10)
                          .map((t, i) => {
                            const hasEvidence = (t.evidence?.length ?? 0) > 0;
                            const label =
                              t.verified === true || (t.verified == null && hasEvidence)
                                ? "✓"
                                : t.verified === false
                                  ? "?"
                                  : "•";
                            return (
                              <span
                                key={`tr_${i}_${stableId(t.text)}`}
                                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-700"
                                title={hasEvidence ? "Evidence-linked" : "No evidence linked"}
                              >
                                {label} {t.text}
                              </span>
                            );
                          })}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <div className="text-xs font-semibold text-slate-700">Gentle suggestions</div>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
                        {(summary.gentleSuggestions?.length
                          ? summary.gentleSuggestions
                          : [{ text: "—", verified: null, evidence: [] }]
                        )
                          .slice(0, 8)
                          .map((s, i) => (
                            <li key={`gs_${i}_${stableId(s.text)}`}>
                              <span className="text-slate-900">{s.text}</span>
                            </li>
                          ))}
                      </ul>
                    </div>

                    {!!summary.questionsForVisit?.length ? (
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <div className="text-xs font-semibold text-slate-700">Questions for the visit</div>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
                          {summary.questionsForVisit.slice(0, 8).map((q, i) => (
                            <li key={`${q}-${i}`}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => copyToClipboard(preVisitText)}
                        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                      >
                        Copy pre-visit summary
                      </button>
                      <button
                        onClick={sendPreVisitToClinicianDemo}
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                        title="Stores summary as a synthetic “transcript” for Clinician mode"
                      >
                        Send → Clinician (demo)
                      </button>
                      <Link
                        href="/clinician"
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                      >
                        Open Clinician
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    Click <span className="font-medium">Generate summary</span> after you add diary entries.
                  </div>
                )}

                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                  Safety: informational only, not medical advice. Keep entries synthetic for demos.
                </div>
              </div>
            </section>

            {/* Add entry + list */}
            <section className="mt-6 grid gap-6 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
                <h2 className="text-lg font-semibold text-slate-900">Add diary entry</h2>
                <p className="mt-2 text-sm text-slate-700">
                  Keep it synthetic for demo. Use tags to help identify patterns (e.g., “dairy”, “stress”, “spicy”).
                </p>

                {/* Voice input */}
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">Voice note (optional)</div>
                      <div className="mt-1 text-xs text-slate-600">
                        Transcribe audio into the entry notes (uses{" "}
                        <code className="rounded bg-white px-1">/api/transcribe</code>).
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                        className="block text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-900 file:shadow-sm"
                      />
                      <button
                        onClick={transcribeDiaryAudioIntoNotes}
                        disabled={busy.transcribe || !audioFile}
                        className={`rounded-xl px-4 py-2 text-sm font-medium ${busy.transcribe || !audioFile
                          ? "cursor-not-allowed bg-slate-100 text-slate-400"
                          : "bg-slate-900 text-white hover:bg-slate-800"
                          }`}
                      >
                        {busy.transcribe ? "Transcribing…" : "Transcribe"}
                      </button>
                      <button
                        onClick={analyzeVocalBiomarkers}
                        disabled={busy.biomarkers || !audioFile}
                        className={`rounded-xl border px-4 py-2 text-sm font-medium ${busy.biomarkers || !audioFile
                          ? "cursor-not-allowed bg-slate-50 text-slate-400 border-slate-200"
                          : "border-rose-200 bg-rose-50 text-rose-900 hover:bg-rose-100"
                          }`}
                      >
                        {busy.biomarkers ? "Analyzing…" : "🩺 Analyze Biomarkers"}
                      </button>
                    </div>
                  </div>

                  {biomarkerSummary && (
                    <div className="mt-3 rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs text-rose-800">
                      <div className="font-semibold mb-1">Vocal Biomarker Analysis (Demo)</div>
                      <div>{biomarkerSummary}</div>
                    </div>
                  )}

                  {sttWarnings.length ? (
                    <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                      <div className="font-semibold">STT warnings</div>
                      <ul className="mt-1 list-disc pl-5">
                        {sttWarnings.map((w, i) => (
                          <li key={`${w}-${i}`}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-semibold text-slate-700">Date</span>
                    <input
                      type="date"
                      value={form.date}
                      onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-700">Symptom score: {form.symptomScore}/10</span>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={form.symptomScore}
                      onChange={(e) => setForm((f) => ({ ...f, symptomScore: Number(e.target.value) }))}
                      className="mt-2 w-full"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-700">Sleep hours</span>
                    <input
                      type="number"
                      min={0}
                      max={24}
                      step={0.1}
                      value={form.sleepHours}
                      onChange={(e) => setForm((f) => ({ ...f, sleepHours: Number(e.target.value) }))}
                      onBlur={() => setForm((f) => ({ ...f, sleepHours: clamp(Number(f.sleepHours), 0, 24) }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                    />
                    <div className="mt-1 text-[11px] text-slate-500">Current: {form.sleepHours.toFixed(1)}h</div>
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-700">Mood score: {form.moodScore}/10</span>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={form.moodScore}
                      onChange={(e) => setForm((f) => ({ ...f, moodScore: Number(e.target.value) }))}
                      className="mt-2 w-full"
                    />
                  </label>
                </div>

                <div className="mt-5 flex flex-wrap gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-200">
                  <button
                    onClick={() => setShowBodyMap(!showBodyMap)}
                    className="flex-1 rounded-xl bg-white border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 flex items-center justify-center gap-2 shadow-sm"
                  >
                    🧍‍♂️ {showBodyMap ? "Hide Body Map" : "3D Body Map"}
                  </button>
                  <button
                    onClick={simulateARScanner}
                    disabled={busy.scanning}
                    className="flex-1 rounded-xl bg-white border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 flex items-center justify-center gap-2 shadow-sm"
                  >
                    📸 {busy.scanning ? "Scanning..." : "AR Food/Med Scanner"}
                  </button>
                </div>

                {showScanner && (
                  <div className="mt-3 p-4 border border-emerald-200 bg-emerald-50 rounded-2xl flex flex-col items-center">
                    <div className="w-full max-w-[240px] h-40 bg-slate-800 rounded-xl relative overflow-hidden flex items-center justify-center">
                      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+PHBhdGggZD0iTTAgMGg0MHY0MEgwem0yMCAyMGEyMCAyMCAwIDEgMCAwLTQwIDIwIDIwIDAgMCAwIDAgNDB6IiBmaWxsPSIjZmZmIiBmaWxsLW9wYWNpdHk9Ii4wNSIvPjwvc3ZnPg==')] opacity-30" />
                      {!scannerResult ? (
                        <div className="w-full h-1 bg-emerald-400 absolute top-1/2 -translate-y-1/2 shadow-[0_0_15px_#34d399] animate-[ping_1.5s_ease-in-out_infinite]" />
                      ) : (
                        <div className="text-emerald-400 text-3xl">✓</div>
                      )}
                    </div>
                    {scannerResult && (
                      <div className="mt-3 text-emerald-900 text-sm whitespace-pre-wrap text-center font-medium">
                        {scannerResult}
                      </div>
                    )}
                  </div>
                )}

                {showBodyMap && (
                  <div className="mt-3 p-4 border border-blue-200 bg-blue-50 rounded-2xl flex flex-col items-center">
                    <div className="text-sm font-medium text-blue-900 mb-4">Click a body part to log a symptom</div>
                    <svg viewBox="0 0 200 400" className="w-48 h-96 drop-shadow-md">
                      <g className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => handleBodyMapClick("Head")}>
                        <circle cx="100" cy="40" r="30" fill="#cbd5e1" className="hover:fill-blue-400" />
                        <text x="100" y="45" textAnchor="middle" fontSize="10" fill="#334155" pointerEvents="none">Head</text>
                      </g>
                      <g className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => handleBodyMapClick("Right Arm")}>
                        <rect x="20" y="80" width="30" height="120" rx="15" fill="#cbd5e1" className="hover:fill-blue-400" />
                        <text x="35" y="140" textAnchor="middle" fontSize="10" fill="#334155" pointerEvents="none" transform="rotate(-90 35 140)">R. Arm</text>
                      </g>
                      <g className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => handleBodyMapClick("Chest")}>
                        <rect x="60" y="80" width="80" height="70" rx="10" fill="#cbd5e1" className="hover:fill-blue-400" />
                        <text x="100" y="120" textAnchor="middle" fontSize="10" fill="#334155" pointerEvents="none">Chest</text>
                      </g>
                      <g className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => handleBodyMapClick("Abdomen")}>
                        <rect x="60" y="155" width="80" height="80" rx="10" fill="#cbd5e1" className="hover:fill-blue-400" />
                        <text x="100" y="200" textAnchor="middle" fontSize="10" fill="#334155" pointerEvents="none">Abdomen</text>
                      </g>
                      <g className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => handleBodyMapClick("Left Arm")}>
                        <rect x="150" y="80" width="30" height="120" rx="15" fill="#cbd5e1" className="hover:fill-blue-400" />
                        <text x="165" y="140" textAnchor="middle" fontSize="10" fill="#334155" pointerEvents="none" transform="rotate(90 165 140)">L. Arm</text>
                      </g>
                      <g className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => handleBodyMapClick("Right Leg")}>
                        <rect x="60" y="240" width="35" height="140" rx="17.5" fill="#cbd5e1" className="hover:fill-blue-400" />
                        <text x="77.5" y="310" textAnchor="middle" fontSize="10" fill="#334155" pointerEvents="none" transform="rotate(-90 77.5 310)">R. Leg</text>
                      </g>
                      <g className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => handleBodyMapClick("Left Leg")}>
                        <rect x="105" y="240" width="35" height="140" rx="17.5" fill="#cbd5e1" className="hover:fill-blue-400" />
                        <text x="122.5" y="310" textAnchor="middle" fontSize="10" fill="#334155" pointerEvents="none" transform="rotate(90 122.5 310)">L. Leg</text>
                      </g>
                    </svg>
                  </div>
                )}

                <label className="mt-4 block">
                  <span className="text-xs font-semibold text-slate-700">Notes (synthetic)</span>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="e.g., 'Bloating after dairy. Better with hydration.'"
                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                    rows={4}
                  />
                  {redactionMode !== "none" && form.notes ? (
                    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                      <div className="text-[11px] font-semibold text-slate-700">Preview (best-effort redaction)</div>
                      <div className="mt-1">{localRedact(form.notes)}</div>
                    </div>
                  ) : null}
                </label>

                <div className="mt-4">
                  <span className="text-xs font-semibold text-slate-700">Tags</span>
                  <div className="mt-1 flex gap-2">
                    <input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === ",") {
                          e.preventDefault();
                          addTag(tagInput);
                          setTagInput("");
                        }
                      }}
                      placeholder="dairy, stress, spicy…"
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                    />
                    <button
                      onClick={() => {
                        addTag(tagInput);
                        setTagInput("");
                      }}
                      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      Add
                    </button>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(form.tags ?? []).map((t) => (
                      <button
                        key={t}
                        onClick={() => removeTag(t)}
                        className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-700 hover:bg-slate-100"
                        title="Click to remove"
                      >
                        {t} ×
                      </button>
                    ))}
                    {!form.tags?.length && <span className="text-xs text-slate-500">No tags</span>}
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    onClick={addEntry}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Add entry
                  </button>
                  <button
                    onClick={() => {
                      setForm((f) => ({
                        ...f,
                        notes:
                          f.notes ||
                          "Synthetic note: mild symptoms after a specific food; improved with hydration.",
                        tags: f.tags?.length ? f.tags : ["synthetic"],
                      }));
                    }}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                  >
                    Fill synthetic example
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-900">Diary entries</h2>
                <p className="mt-2 text-sm text-slate-700">
                  {diary.length ? `${diary.length} entries` : "No entries yet."}
                </p>

                {diary.length ? (
                  <div className="mt-4 space-y-2">
                    {diary
                      .slice()
                      .reverse()
                      .slice(0, 12)
                      .map((e) => (
                        <div key={e.date} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-slate-900">{e.date}</div>
                              <div className="mt-1 text-xs text-slate-600">
                                Symptom {e.symptomScore}/10 • Sleep {e.sleepHours.toFixed(1)}h • Mood {e.moodScore}/10
                              </div>
                            </div>
                            <button
                              onClick={() => deleteEntry(e.date)}
                              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                            >
                              Delete
                            </button>
                          </div>

                          {e.tags?.length ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {e.tags.map((t) => (
                                <span
                                  key={`${e.date}-${t}`}
                                  className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700"
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          ) : null}

                          {e.notes ? (
                            <div className="mt-2 text-xs text-slate-700">
                              {redactionMode === "local" ? localRedact(e.notes) : e.notes}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    {diary.length > 12 && (
                      <div className="text-xs text-slate-500">Showing last 12 entries (newest first).</div>
                    )}
                  </div>
                ) : (
                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    Add entries on the left, or load the synthetic demo from the Home page.
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {/* ============== WOW FEATURES SECTION ============== */}
        {tab === "diary" && diary.length >= 2 && (
          <section className="mt-8 space-y-6 animate-fade-in-up">
            {/* --- Proactive Alerts --- */}
            {alerts.length > 0 && (
              <div className="space-y-3">
                {alerts.map((a: any, i: number) => (
                  <div key={i} className={`rounded-2xl border p-4 shadow-sm flex items-start gap-3 ${a.level === "critical" ? "border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800" :
                    a.level === "warning" ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800" :
                      "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800"
                    }`}>
                    <span className="text-2xl">{a.icon}</span>
                    <div>
                      <div className="font-semibold text-sm text-slate-900 dark:text-white">{a.title}</div>
                      <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{a.message}</div>
                    </div>
                    <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${a.level === "critical" ? "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200" :
                      a.level === "warning" ? "bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200" :
                        "bg-emerald-200 text-emerald-800 dark:bg-emerald-800 dark:text-emerald-200"
                      }`}>{a.level}</span>
                  </div>
                ))}
              </div>
            )}

            {/* --- AI Health Twin --- */}
            {healthTwin && (
              <div className="card-glass p-6">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span className="text-2xl">🧬</span> AI Health Twin
                </h3>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  {/* Health Score Circle */}
                  <div className="flex flex-col items-center">
                    <div className={`relative w-32 h-32 rounded-full flex items-center justify-center animate-breathe ${healthTwin.status === "good" ? "bg-gradient-to-br from-emerald-400/20 to-teal-500/20 pulse-glow" :
                      healthTwin.status === "moderate" ? "bg-gradient-to-br from-amber-400/20 to-yellow-500/20" :
                        "bg-gradient-to-br from-red-400/20 to-rose-500/20"
                      }`}>
                      <div className="text-center">
                        <div className="text-3xl font-bold gradient-text">{healthTwin.healthScore}</div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">Health Score</div>
                      </div>
                      <div className="absolute inset-0 rounded-full border-4 border-transparent" style={{ borderColor: healthTwin.moodColor + '40' }} />
                    </div>
                    <div className="mt-2 text-sm font-medium" style={{ color: healthTwin.moodColor }}>{healthTwin.statusLabel}</div>
                  </div>

                  {/* Vitals */}
                  <div className="space-y-3">
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-3">
                      <div className="text-xs text-slate-500 dark:text-slate-400">❤️ Pulse (simulated)</div>
                      <div className="text-xl font-bold text-slate-900 dark:text-white">{healthTwin.pulseRate} <span className="text-xs font-normal">bpm</span></div>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-3">
                      <div className="text-xs text-slate-500 dark:text-slate-400">🫁 Breathing</div>
                      <div className="text-xl font-bold text-slate-900 dark:text-white">{healthTwin.breathRate} <span className="text-xs font-normal">/min</span></div>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-3">
                      <div className="text-xs text-slate-500 dark:text-slate-400">⚡ Energy</div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-emerald-400 to-teal-500 rounded-full transition-all" style={{ width: `${healthTwin.energyLevel}%` }} />
                        </div>
                        <span className="text-sm font-bold text-slate-900 dark:text-white">{healthTwin.energyLevel}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Body Zones */}
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">Active Zones</div>
                    <div className="space-y-2">
                      {healthTwin.zones?.map((z: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 p-2">
                          <div className={`w-3 h-3 rounded-full ${z.severity > 0.6 ? "bg-red-500" : z.severity > 0.3 ? "bg-amber-500" : "bg-emerald-500"
                            }`} />
                          <div>
                            <div className="text-xs font-medium text-slate-900 dark:text-white capitalize">{z.zone}</div>
                            <div className="text-[10px] text-slate-500 dark:text-slate-400">{z.label}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* --- Correlation Heatmap --- */}
            {correlations && correlations.matrix?.length > 0 && (
              <div className="card-glass p-6">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span className="text-2xl">📊</span> Correlation Matrix
                </h3>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full max-w-md">
                    <thead>
                      <tr>
                        <th className="text-xs text-slate-500 dark:text-slate-400 p-2"></th>
                        {correlations.labels?.map((l: string) => (
                          <th key={l} className="text-xs text-slate-700 dark:text-slate-300 p-2 font-medium">{l}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {correlations.matrix?.map((row: number[], ri: number) => (
                        <tr key={ri}>
                          <td className="text-xs text-slate-700 dark:text-slate-300 p-2 font-medium">{correlations.labels?.[ri]}</td>
                          {row.map((val: number, ci: number) => {
                            const cls = val >= 0.5 ? "heatmap-strong-pos" : val >= 0.2 ? "heatmap-mild-pos" : val <= -0.5 ? "heatmap-strong-neg" : val <= -0.2 ? "heatmap-mild-neg" : "heatmap-neutral";
                            return (
                              <td key={ci} className={`p-2 text-center rounded-lg ${cls}`}>
                                <span className="text-xs font-bold text-slate-900 dark:text-white">{val.toFixed(2)}</span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {correlations.tagCorrelations?.length > 0 && (
                  <div className="mt-4">
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">Tag Impact</div>
                    <div className="flex flex-wrap gap-2">
                      {correlations.tagCorrelations.map((tc: any) => (
                        <div key={tc.tag} className="rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 px-3 py-2">
                          <div className="text-xs font-semibold text-slate-900 dark:text-white">#{tc.tag}</div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400">
                            Sym: {tc.avgSymptom} • Mood: {tc.avgMood} • {tc.count}x
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* --- Gamification / Streaks --- */}
            {streaks && (
              <div className="card-glass p-6">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span className="text-2xl">🏅</span> Your Progress
                </h3>
                <div className="mt-4 grid gap-4 sm:grid-cols-4">
                  <div className="text-center rounded-xl bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/30 p-4">
                    <div className="text-3xl">🔥</div>
                    <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">{streaks.currentStreak}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Day Streak</div>
                  </div>
                  <div className="text-center rounded-xl bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/30 p-4">
                    <div className="text-3xl">⭐</div>
                    <div className="text-2xl font-bold text-violet-600 dark:text-violet-400">{streaks.longestStreak}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Best Streak</div>
                  </div>
                  <div className="text-center rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 p-4">
                    <div className="text-3xl">📝</div>
                    <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{streaks.totalEntries}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">Total Entries</div>
                  </div>
                  <div className="text-center rounded-xl bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-blue-950/30 dark:to-cyan-950/30 p-4">
                    <div className="text-3xl">🎮</div>
                    <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">Lv.{streaks.xp?.level}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">{streaks.xp?.total} XP</div>
                  </div>
                </div>

                {/* XP Progress bar */}
                {streaks.xp && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
                      <span>Level {streaks.xp.level}</span>
                      <span>{streaks.xp.xpToNext} XP to next</span>
                    </div>
                    <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 via-violet-500 to-purple-500 rounded-full transition-all duration-500" style={{ width: `${streaks.xp.progressPct}%` }} />
                    </div>
                  </div>
                )}

                {/* Badges */}
                <div className="mt-4 flex flex-wrap gap-3">
                  {streaks.badges?.map((b: any, i: number) => (
                    <div key={b.name} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs border transition-all ${b.earned
                      ? "bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 border-amber-200 dark:border-amber-800 animate-badge-pop"
                      : "bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 opacity-50"
                      }`} style={{ animationDelay: `${i * 100}ms` }}>
                      <span className="text-xl">{b.icon}</span>
                      <div>
                        <div className={`font-semibold ${b.earned ? "text-amber-700 dark:text-amber-300" : "text-slate-500 dark:text-slate-500"}`}>{b.name}</div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">{b.description}</div>
                      </div>
                      {b.earned && <span className="text-emerald-500 ml-1">✓</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* --- Predictive Insights (enhanced) --- */}
            {predictiveInsights && Array.isArray(predictiveInsights) && (
              <div className="card-glass p-6">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span className="text-2xl">📈</span> Predictive Insights
                </h3>
                <div className="mt-4 space-y-3">
                  {(predictiveInsights as any[]).map((ins: any, i: number) => (
                    <div key={i} className="flex items-start gap-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 p-3">
                      <span className="text-2xl">{ins.icon}</span>
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{ins.title}</div>
                        <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{ins.description}</div>
                        <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${ins.confidence === "high" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" :
                          ins.confidence === "medium" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" :
                            "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
                          }`}>{ins.confidence} confidence</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        <footer className="mt-8 text-xs text-slate-500 dark:text-slate-400">
          API calls go to <code className="rounded bg-slate-100 dark:bg-slate-800 px-1">/api/*</code> (proxy via{" "}
          <code className="rounded bg-slate-100 dark:bg-slate-800 px-1">API_PROXY_TARGET</code>). For demos, keep inputs synthetic.
        </footer>
      </div>
    </main>
  );
}

export default function PatientPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-slate-500">Loading Patient View...</div>}>
      <PatientPageContent />
    </Suspense>
  );
}
