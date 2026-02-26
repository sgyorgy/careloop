"use client";

import { useEffect, useMemo, useState } from "react";
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

// ---------------- types ----------------
type DiaryEntry = {
  date: string; // YYYY-MM-DD
  symptomScore: number; // 0-10
  sleepHours: number; // 0-24
  moodScore: number; // 0-10
  notes: string;
  tags?: string[];
};

type TrendPoint = {
  date: string;
  symptomScore: number;
  sleepHours: number;
  moodScore: number;
};

type DiarySummary = {
  headline: string;
  bullets: string[];
  possibleTriggers: string[];
  gentleSuggestions: string[];
  last7DaysAvgSymptom: number | null;
};

type TaskItem = {
  id: string;
  text: string;
  done: boolean;
  updatedAt?: number;
};

// ---------------- storage keys ----------------
const LS_KEYS = {
  diary: "careloop.demoDiary.v1",
  tasks: "careloop.planTasks.v1", // currently string[]
  tasksState: "careloop.planTasksState.v1", // { [taskId]: { done, updatedAt } }
  preVisitSummary: "careloop.preVisitSummary.v1",
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

const TrendResponseSchema = z.object({
  trend: z.array(
    z.object({
      date: z.string(),
      symptomScore: z.number(),
      sleepHours: z.number(),
      moodScore: z.number(),
    })
  ),
});

const SummaryResponseSchema = z.object({
  summary: z.object({
    headline: z.string(),
    bullets: z.array(z.string()),
    possibleTriggers: z.array(z.string()),
    gentleSuggestions: z.array(z.string()),
    last7DaysAvgSymptom: z.number().nullable(),
  }),
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

function normalizeDiary(entries: DiaryEntry[]): DiaryEntry[] {
  const cleaned = entries
    .filter((e) => !!e?.date)
    .map((e) => ({
      date: String(e.date).slice(0, 10),
      symptomScore: clamp(Number(e.symptomScore ?? 0), 0, 10),
      sleepHours: clamp(Number(e.sleepHours ?? 0), 0, 24),
      moodScore: clamp(Number(e.moodScore ?? 0), 0, 10),
      notes: String(e.notes ?? "").slice(0, 4000),
      tags: Array.isArray(e.tags)
        ? e.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
        : [],
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Deduplicate by date (keep last)
  const byDate = new Map<string, DiaryEntry>();
  for (const e of cleaned) byDate.set(e.date, e);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function computeLocalTrends(diary: DiaryEntry[]): TrendPoint[] {
  return diary.map((e) => ({
    date: e.date,
    symptomScore: e.symptomScore,
    sleepHours: e.sleepHours,
    moodScore: e.moodScore,
  }));
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
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  t = t.replace(
    /(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g,
    "[REDACTED_PHONE]"
  );
  t = t.replace(
    /\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/gi,
    "[REDACTED_ADDR]"
  );
  return t;
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
    const err = new Error(msg) as Error & { status?: number; payload?: any };
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
    const err = new Error(msg) as Error & { status?: number; payload?: any };
    err.status = res.status;
    err.payload = json;
    throw err;
  }

  return json as T;
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

function stableId(text: string) {
  // tiny stable hash (not crypto)
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `t_${(h >>> 0).toString(16)}`;
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
    (worst?.symptomScore ?? 0) >= 9 || (avg7Sym != null && avg14Sym != null && avg7Sym - avg14Sym >= 2);

  return {
    avg7Sym,
    avg7Sleep,
    avg7Mood,
    direction,
    worst,
    redFlag,
  };
}

type RedactionMode = "local" | "api" | "none";

// best-effort: redact only notes; numbers/tags are safe-ish synthetic fields
async function prepareDiaryForApi(diary: DiaryEntry[], mode: RedactionMode) {
  if (mode === "none") return { diary, piiDetected: false };

  if (mode === "local") {
    return {
      diary: diary.map((e) => ({ ...e, notes: localRedact(e.notes) })),
      piiDetected: false,
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
    // avoid sending huge notes
    const payloadText = note.slice(0, 20000);
    const resp = await apiPost<{ redacted: string; piiDetected?: boolean }>("/privacy/redact", { text: payloadText });
    const parsed = RedactResponseSchema.safeParse(resp);
    const redacted = parsed.success ? parsed.data.redacted : localRedact(payloadText);
    piiDetectedAny = piiDetectedAny || Boolean(parsed.success && parsed.data.piiDetected);
    redactedNotes.push(redacted);
  }

  const merged = diary.slice(0, Math.max(0, diary.length - limited.length)).concat(
    limited.map((e, i) => ({ ...e, notes: redactedNotes[i] ?? "" }))
  );

  return { diary: merged, piiDetected: piiDetectedAny };
}

// ---------------- component ----------------
export default function PatientPage() {
  const searchParams = useSearchParams();
  const tab = (searchParams.get("tab") || "diary") as "diary" | "tasks";
  const demo = searchParams.get("demo") === "1";

  const [diary, setDiary] = useState<DiaryEntry[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [summary, setSummary] = useState<DiarySummary | null>(null);

  const [busy, setBusy] = useState<{ trends: boolean; summary: boolean; transcribe: boolean; redact: boolean }>({
    trends: false,
    summary: false,
    transcribe: false,
    redact: false,
  });

  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const [redactionMode, setRedactionMode] = useState<RedactionMode>("local");
  const [windowDays, setWindowDays] = useState<7 | 30>(7);

  // Voice diary (optional)
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [sttWarnings, setSttWarnings] = useState<string[]>([]);

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

  // Tasks + adherence state
  const tasksRaw = useMemo(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEYS.tasks) : null;
      const parsed = raw ? safeJsonParse<string[]>(raw) : null;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }, [tab]);

  const tasksStateRaw = useMemo(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEYS.tasksState) : null;
      const parsed = raw ? safeJsonParse<Record<string, { done: boolean; updatedAt?: number }>>(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }, [tab]);

  const tasks: TaskItem[] = useMemo(() => {
    return tasksRaw.slice(0, 50).map((t) => {
      const id = stableId(t);
      const state = tasksStateRaw[id];
      return {
        id,
        text: t,
        done: Boolean(state?.done),
        updatedAt: state?.updatedAt,
      };
    });
  }, [tasksRaw, tasksStateRaw]);

  const adherence = useMemo(() => {
    if (!tasks.length) return null;
    const done = tasks.filter((t) => t.done).length;
    const pct = Math.round((done / tasks.length) * 100);
    return { done, total: tasks.length, pct };
  }, [tasks]);

  useEffect(() => {
    // Load diary from localStorage if present
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
  }, [demo]);

  useEffect(() => {
    setTrend(computeLocalTrends(diary));
  }, [diary]);

  function persistDiary(next: DiaryEntry[]) {
    setDiary(next);
    try {
      localStorage.setItem(LS_KEYS.diary, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  function addTag(tag: string) {
    const t = tag.trim();
    if (!t) return;
    const nextTags = Array.from(new Set([...(form.tags ?? []), t])).slice(0, 12);
    setForm((f) => ({ ...f, tags: nextTags }));
  }

  function removeTag(tag: string) {
    setForm((f) => ({ ...f, tags: (f.tags ?? []).filter((x) => x !== tag) }));
  }

  function addEntry() {
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
  }

  function deleteEntry(date: string) {
    const next = diary.filter((e) => e.date !== date);
    persistDiary(next);
  }

  function clearDiaryOnly() {
    setErr(null);
    setNotes([]);
    setSummary(null);
    persistDiary([]);
    try {
      localStorage.removeItem(LS_KEYS.diary);
    } catch {
      // ignore
    }
  }

  function clearAllDemoData() {
    setErr(null);
    setNotes([]);
    setSummary(null);
    setDiary([]);
    setTrend([]);
    try {
      localStorage.removeItem(LS_KEYS.diary);
      localStorage.removeItem(LS_KEYS.tasks);
      localStorage.removeItem(LS_KEYS.tasksState);
      localStorage.removeItem(LS_KEYS.preVisitSummary);
      // keep transcript if you want; but for hard reset, remove it:
      // localStorage.removeItem(LS_KEYS.transcript);
    } catch {
      // ignore
    }
  }

  async function refreshTrends() {
    setErr(null);
    setNotes([]);
    setBusy((b) => ({ ...b, trends: true }));

    try {
      const { diary: payloadDiary, piiDetected } = await prepareDiaryForApi(diary, redactionMode);
      if (piiDetected) setNotes((n) => [...n, "PII detected and redacted (best-effort) before processing."]);

      const resp = await apiPost<unknown>("/diary/trends", { diary: payloadDiary });
      const parsed = TrendResponseSchema.safeParse(resp);

      if (parsed.success) setTrend(parsed.data.trend);
      else setTrend(computeLocalTrends(diary));
    } catch {
      setTrend(computeLocalTrends(diary));
      setNotes((n) => [...n, "API unavailable — trends computed locally (demo fallback)."]);
    } finally {
      setBusy((b) => ({ ...b, trends: false }));
    }
  }

  async function generateSummary() {
    setErr(null);
    setNotes([]);
    setBusy((b) => ({ ...b, summary: true }));

    try {
      const { diary: payloadDiary, piiDetected } = await prepareDiaryForApi(diary, redactionMode);
      if (piiDetected) setNotes((n) => [...n, "PII detected and redacted (best-effort) before processing."]);

      const resp = await apiPost<unknown>("/diary/summarize", { diary: payloadDiary });
      const parsed = SummaryResponseSchema.safeParse(resp);

      if (parsed.success) {
        setSummary(parsed.data.summary);
        try {
          localStorage.setItem(LS_KEYS.preVisitSummary, JSON.stringify(parsed.data.summary));
        } catch {
          // ignore
        }
        return;
      }

      throw new Error("No summary from API.");
    } catch {
      // Local fallback (simple heuristics)
      const last7 = lastNDays(diary, 7);
      const avgSym = avg(last7.map((e) => e.symptomScore));
      const worst = last7.reduce(
        (acc, e) => (!acc || e.symptomScore > acc.symptomScore ? e : acc),
        null as DiaryEntry | null
      );

      const tagStats = extractTagStats(last7);
      const triggers = Array.from(tagStats.entries())
        .filter(([, v]) => v.count >= 2)
        .sort((a, b) => b[1].avgSymptom - a[1].avgSymptom)
        .slice(0, 3)
        .map(([k]) => k);

      setSummary({
        headline: diary.length ? "Pre-visit summary (quick, local)" : "Add a few diary entries to generate a summary",
        bullets: diary.length
          ? [
              avgSym != null ? `Last 7 days avg symptom score: ${avgSym.toFixed(1)} / 10` : "Not enough data for a 7-day average",
              worst ? `Worst day (last 7 days): ${worst.date} (symptom ${worst.symptomScore}/10)` : "No worst day available",
              "Patterns are hints only (not a diagnosis).",
            ]
          : [],
        possibleTriggers: triggers,
        gentleSuggestions: diary.length
          ? [
              "Keep logging meals/sleep alongside symptoms for clearer patterns.",
              "If symptoms worsen or new red flags appear, consider contacting a clinician.",
            ]
          : [],
        last7DaysAvgSymptom: avgSym,
      });

      setNotes((n) => [...n, "API unavailable — summary generated locally (demo fallback)."]);
    } finally {
      setBusy((b) => ({ ...b, summary: false }));
    }
  }

  async function transcribeDiaryAudioIntoNotes() {
    setErr(null);
    setNotes([]);
    setSttWarnings([]);

    if (!audioFile) {
      setErr("Choose an audio file first.");
      return;
    }

    setBusy((b) => ({ ...b, transcribe: true }));
    try {
      const formData = new FormData();
      formData.append("audio", audioFile);

      const resp = await apiPostForm<unknown>("/transcribe", formData);
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
    } catch {
      setErr("Transcription failed (or API not running). You can still type notes manually.");
    } finally {
      setBusy((b) => ({ ...b, transcribe: false }));
    }
  }

  function toggleTaskDone(taskId: string) {
    try {
      const raw = localStorage.getItem(LS_KEYS.tasksState);
      const parsed = raw ? safeJsonParse<Record<string, { done: boolean; updatedAt?: number }>>(raw) : null;
      const next = parsed && typeof parsed === "object" ? { ...parsed } : {};
      const current = next[taskId]?.done ?? false;
      next[taskId] = { done: !current, updatedAt: Date.now() };
      localStorage.setItem(LS_KEYS.tasksState, JSON.stringify(next));
      // force re-render by touching state via searchParams dependency is not enough; simplest: update notes
      setNotes((n) => (n.length ? [...n] : []));
    } catch {
      setErr("Could not save task state (browser policy/private mode).");
    }
  }

  const canAnalyze = diary.length >= 2;
  const windowedDiary = useMemo(() => {
    const d = lastNDays(diary, windowDays);
    return d;
  }, [diary, windowDays]);

  const windowedTrend = useMemo(() => {
    const set = new Set(windowedDiary.map((e) => e.date));
    return trend.filter((p) => set.has(p.date));
  }, [trend, windowedDiary]);

  const insights = useMemo(() => computeInsights(diary), [diary]);

  const preVisitText = useMemo(() => {
    const lines: string[] = [];
    lines.push("PATIENT PRE-VISIT SUMMARY (synthetic / demo)");
    lines.push(`Window: last ${windowDays} days`);
    if (insights.avg7Sym != null) lines.push(`Avg symptom (7d): ${insights.avg7Sym.toFixed(1)}/10`);
    if (insights.avg7Sleep != null) lines.push(`Avg sleep (7d): ${insights.avg7Sleep.toFixed(1)}h`);
    if (insights.avg7Mood != null) lines.push(`Avg mood (7d): ${insights.avg7Mood.toFixed(1)}/10`);
    lines.push(`Trend: ${insights.direction}`);
    if (insights.worst) lines.push(`Worst day (7d): ${insights.worst.date} • symptom ${insights.worst.symptomScore}/10`);

    if (summary?.bullets?.length) {
      lines.push("");
      lines.push("Highlights:");
      for (const b of summary.bullets.slice(0, 8)) lines.push(`- ${b}`);
    }

    if (summary?.possibleTriggers?.length) {
      lines.push("");
      lines.push(`Possible triggers: ${summary.possibleTriggers.slice(0, 6).join(", ")}`);
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
  }, [summary, insights, adherence, tasks, windowDays]);

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotes((n) => [...n, "Copied to clipboard."]);
    } catch {
      setErr("Clipboard not available in this browser context.");
    }
  }

  function sendPreVisitToClinicianDemo() {
    try {
      localStorage.setItem(LS_KEYS.transcript, preVisitText);
      setNotes((n) => [...n, "Sent to Clinician mode (demo): transcript stored locally."]);
    } catch {
      setErr("Could not write to localStorage.");
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Patient mode</h1>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                Closed-loop • Synthetic-first
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-slate-700">
              Log symptoms/sleep/mood and generate trends + a pre-visit summary. Tasks come from the clinician SOAP Plan.
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
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === "diary" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
              }`}
            >
              Diary
            </Link>
            <Link
              href="/patient?tab=tasks"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === "tasks" ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
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
              title="Clears diary + tasks + adherence (demo reset)"
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
                This is a prototype. Tasks and suggestions are informational only and not medical advice.
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
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                          windowDays === 7 ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
                        }`}
                      >
                        7d
                      </button>
                      <button
                        onClick={() => setWindowDays(30)}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                          windowDays === 30 ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-50"
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
                  </div>
                </div>

                <p className="mt-2 text-sm text-slate-700">
                  {canAnalyze ? "Visualize symptoms, sleep, and mood over time." : "Add at least 2 entries to see trends."}
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
                      <YAxis tickMargin={8} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="symptomScore" name="Symptom (0-10)" dot={false} />
                      <Line type="monotone" dataKey="sleepHours" name="Sleep (hours)" dot={false} />
                      <Line type="monotone" dataKey="moodScore" name="Mood (0-10)" dot={false} />
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
                <h2 className="text-lg font-semibold text-slate-900">Pre-visit summary</h2>
                <p className="mt-2 text-sm text-slate-700">
                  A short, clinician-friendly summary (patterns only, not diagnosis).
                </p>

                {summary ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-sm font-medium text-slate-900">{summary.headline}</div>
                      {summary.last7DaysAvgSymptom != null && (
                        <div className="mt-1 text-xs text-slate-600">
                          Last 7 days avg symptom: {summary.last7DaysAvgSymptom.toFixed(1)}/10
                        </div>
                      )}
                    </div>

                    {!!summary.bullets?.length && (
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <div className="text-xs font-semibold text-slate-700">Highlights</div>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
                          {summary.bullets.map((b, i) => (
                            <li key={`${b}-${i}`}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <div className="text-xs font-semibold text-slate-700">Possible triggers</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(summary.possibleTriggers?.length ? summary.possibleTriggers : ["—"]).map((t, i) => (
                          <span
                            key={`${t}-${i}`}
                            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-700"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <div className="text-xs font-semibold text-slate-700">Gentle suggestions</div>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
                        {(summary.gentleSuggestions?.length ? summary.gentleSuggestions : ["—"]).map((s, i) => (
                          <li key={`${s}-${i}`}>{s}</li>
                        ))}
                      </ul>
                    </div>

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
                  Safety: This prototype is informational and not medical advice.
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
                        Transcribe audio into the entry notes (uses <code className="rounded bg-white px-1">/api/transcribe</code>).
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
                        className={`rounded-xl px-4 py-2 text-sm font-medium ${
                          busy.transcribe || !audioFile
                            ? "cursor-not-allowed bg-slate-100 text-slate-400"
                            : "bg-slate-900 text-white hover:bg-slate-800"
                        }`}
                      >
                        {busy.transcribe ? "Transcribing…" : "Transcribe"}
                      </button>
                    </div>
                  </div>

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
                    <span className="text-xs font-semibold text-slate-700">Sleep hours: {form.sleepHours.toFixed(1)}</span>
                    <input
                      type="number"
                      min={0}
                      max={24}
                      step={0.1}
                      value={form.sleepHours}
                      onChange={(e) => setForm((f) => ({ ...f, sleepHours: Number(e.target.value) }))}
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                    />
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

                <label className="mt-4 block">
                  <span className="text-xs font-semibold text-slate-700">Notes (synthetic)</span>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="e.g., 'Bloating after dairy. Better with hydration.'"
                    className="mt-1 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                    rows={4}
                  />
                </label>

                <div className="mt-4">
                  <span className="text-xs font-semibold text-slate-700">Tags</span>
                  <div className="mt-1 flex gap-2">
                    <input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
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
                <p className="mt-2 text-sm text-slate-700">{diary.length ? `${diary.length} entries` : "No entries yet."}</p>

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
                    {diary.length > 12 && <div className="text-xs text-slate-500">Showing last 12 entries (newest first).</div>}
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

        <footer className="mt-8 text-xs text-slate-500">
          API calls go to <code className="rounded bg-slate-100 px-1">/api/*</code> (proxy via{" "}
          <code className="rounded bg-slate-100 px-1">API_PROXY_TARGET</code>). For demos, keep inputs synthetic.
        </footer>
      </div>
    </main>
  );
}
