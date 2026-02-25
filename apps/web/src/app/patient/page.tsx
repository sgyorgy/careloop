"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

const LS_KEYS = {
  diary: "careloop.demoDiary.v1",
  transcript: "careloop.demoTranscript.v1",
  loadedAt: "careloop.demoLoadedAt.v1",
  tasks: "careloop.planTasks.v1",
} as const;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function todayISO(): string {
  // Keep it simple and stable in client
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
  // Lightweight redaction for demo. (Do NOT treat as full PHI redaction.)
  let t = text;

  // email
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  // phone-ish
  t = t.replace(
    /(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g,
    "[REDACTED_PHONE]"
  );
  // addresses-ish (very rough)
  t = t.replace(/\b(\d{1,4}\s+)?[A-Za-zÀ-ž.'-]+\s+(street|st|road|rd|ave|avenue|utca|u\.|út|krt\.|körút)\b/gi, "[REDACTED_ADDR]");

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

export default function PatientPage() {
  const searchParams = useSearchParams();
  const tab = (searchParams.get("tab") || "diary") as "diary" | "tasks";
  const demo = searchParams.get("demo") === "1";

  const [diary, setDiary] = useState<DiaryEntry[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [summary, setSummary] = useState<DiarySummary | null>(null);

  const [busy, setBusy] = useState<{ trends: boolean; summary: boolean }>({
    trends: false,
    summary: false,
  });
  const [err, setErr] = useState<string | null>(null);

  const [redactBeforeProcessing, setRedactBeforeProcessing] = useState(true);

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

  const tasks = useMemo(() => {
    const raw = typeof window !== "undefined" ? localStorage.getItem(LS_KEYS.tasks) : null;
    const parsed = raw ? safeJsonParse<string[]>(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  }, [tab]);

  useEffect(() => {
    // Load diary from localStorage if present (demo or persisted)
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
        // If user lands here with demo=1 but storage empty, do nothing (home page loads demo)
      }
    } catch {
      // ignore
    }
  }, [demo]);

  useEffect(() => {
    // Keep trend in sync locally
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
    const entry: DiaryEntry = {
      date: String(form.date).slice(0, 10),
      symptomScore: clamp(Number(form.symptomScore), 0, 10),
      sleepHours: clamp(Number(form.sleepHours), 0, 24),
      moodScore: clamp(Number(form.moodScore), 0, 10),
      notes: String(form.notes ?? "").slice(0, 4000),
      tags: (form.tags ?? []).slice(0, 12),
    };

    const next = normalizeDiary([...diary, entry]);
    persistDiary(next);
    // keep date moving forward
    setForm((f) => ({ ...f, date: todayISO(), notes: "" }));
  }

  function deleteEntry(date: string) {
    const next = diary.filter((e) => e.date !== date);
    persistDiary(next);
  }

  function clearAll() {
    setErr(null);
    setSummary(null);
    persistDiary([]);
    try {
      localStorage.removeItem(LS_KEYS.diary);
    } catch {
      // ignore
    }
  }

  async function refreshTrends() {
    setErr(null);
    setBusy((b) => ({ ...b, trends: true }));
    try {
      const payloadDiary = redactBeforeProcessing
        ? diary.map((e) => ({ ...e, notes: localRedact(e.notes) }))
        : diary;

      // If backend has /diary/trends, use it; else fallback
      const resp = await apiPost<{ trend: TrendPoint[] }>("/diary/trends", {
        diary: payloadDiary,
      });
      if (Array.isArray(resp?.trend)) setTrend(resp.trend);
      else setTrend(computeLocalTrends(diary));
    } catch {
      // Fallback to local computation
      setTrend(computeLocalTrends(diary));
    } finally {
      setBusy((b) => ({ ...b, trends: false }));
    }
  }

  async function generateSummary() {
    setErr(null);
    setBusy((b) => ({ ...b, summary: true }));
    try {
      const payloadDiary = redactBeforeProcessing
        ? diary.map((e) => ({ ...e, notes: localRedact(e.notes) }))
        : diary;

      // If backend has /diary/summarize, use it; else local
      const resp = await apiPost<{ summary: DiarySummary }>("/diary/summarize", {
        diary: payloadDiary,
      });
      if (resp?.summary) {
        setSummary(resp.summary);
        return;
      }
      throw new Error("No summary from API");
    } catch {
      // Local fallback (simple heuristics)
      const last7 = lastNDays(diary, 7);
      const avgSym = avg(last7.map((e) => e.symptomScore));
      const worst = last7.reduce(
        (acc, e) => (e.symptomScore > acc.symptomScore ? e : acc),
        last7[0] ?? null
      );

      const tagStats = extractTagStats(last7);
      const triggers = Array.from(tagStats.entries())
        .filter(([, v]) => v.count >= 2)
        .sort((a, b) => b[1].avgSymptom - a[1].avgSymptom)
        .slice(0, 3)
        .map(([k]) => k);

      setSummary({
        headline: diary.length
          ? "Pre-visit summary (quick)"
          : "Add a few diary entries to generate a summary",
        bullets: diary.length
          ? [
              avgSym != null
                ? `Last 7 days avg symptom score: ${avgSym.toFixed(1)} / 10`
                : "Not enough data for a 7-day average",
              worst
                ? `Worst day (last 7 days): ${worst.date} (symptom ${worst.symptomScore}/10)`
                : "No worst day available",
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
    } finally {
      setBusy((b) => ({ ...b, summary: false }));
    }
  }

  const canAnalyze = diary.length >= 2;

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
                Patient mode
              </h1>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                No PHI • Synthetic-first
              </span>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-slate-700">
              Log daily symptoms/sleep/mood and generate trends + a pre-visit summary.
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

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={redactBeforeProcessing}
              onChange={(e) => setRedactBeforeProcessing(e.target.checked)}
            />
            Redact identifiers before processing
          </label>

          <div className="ml-auto flex flex-wrap gap-2">
            <button
              onClick={() => downloadJson("diary.json", diary)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Export JSON
            </button>
            <button
              onClick={clearAll}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Clear diary
            </button>
          </div>
        </div>

        {err && (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            {err}
          </div>
        )}

        {tab === "tasks" ? (
          <section className="mt-6 grid gap-6 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
              <h2 className="text-lg font-semibold text-slate-900">Plan tasks</h2>
              <p className="mt-2 text-sm text-slate-700">
                Tasks are generated from the clinician SOAP “Plan” and saved locally for the demo.
              </p>

              {tasks.length ? (
                <ul className="mt-4 space-y-2">
                  {tasks.map((t, i) => (
                    <li
                      key={`${t}-${i}`}
                      className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                    >
                      <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300" />
                      <span className="text-sm text-slate-900">{t}</span>
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
            <section className="mt-6 grid gap-6 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-lg font-semibold text-slate-900">Trends</h2>

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
                  {canAnalyze
                    ? "Visualize symptoms, sleep, and mood over time."
                    : "Add at least 2 entries to see trends."}
                </p>

                <div className="mt-5 h-[320px] w-full rounded-2xl border border-slate-200 bg-white p-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trend}>
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

                <div className="mt-4 text-xs text-slate-500">
                  Note: If the API is not running, trends are computed locally for the demo.
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

            <section className="mt-6 grid gap-6 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:col-span-2">
                <h2 className="text-lg font-semibold text-slate-900">Add diary entry</h2>
                <p className="mt-2 text-sm text-slate-700">
                  Keep it synthetic for demo. Use tags to help identify patterns (e.g., “dairy”, “stress”, “spicy”).
                </p>

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
                    <span className="text-xs font-semibold text-slate-700">
                      Symptom score: {form.symptomScore}/10
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={form.symptomScore}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, symptomScore: Number(e.target.value) }))
                      }
                      className="mt-2 w-full"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-700">
                      Sleep hours: {form.sleepHours.toFixed(1)}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={24}
                      step={0.1}
                      value={form.sleepHours}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, sleepHours: Number(e.target.value) }))
                      }
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-semibold text-slate-700">
                      Mood score: {form.moodScore}/10
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={form.moodScore}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, moodScore: Number(e.target.value) }))
                      }
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
                    rows={3}
                  />
                </label>

                <div className="mt-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex-1">
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
                    </div>
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
                    {!form.tags?.length && (
                      <span className="text-xs text-slate-500">No tags</span>
                    )}
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
                      // quick synthetic entry helper
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
                      .slice(0, 10)
                      .map((e) => (
                        <div
                          key={e.date}
                          className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-slate-900">{e.date}</div>
                              <div className="mt-1 text-xs text-slate-600">
                                Symptom {e.symptomScore}/10 • Sleep {e.sleepHours.toFixed(1)}h •
                                Mood {e.moodScore}/10
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
                              {redactBeforeProcessing ? localRedact(e.notes) : e.notes}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    {diary.length > 10 && (
                      <div className="text-xs text-slate-500">
                        Showing last 10 entries (newest first).
                      </div>
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
      </div>
    </main>
  );
}
