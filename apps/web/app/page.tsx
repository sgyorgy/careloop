"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type DiaryEntry = {
  date: string; // YYYY-MM-DD
  symptomScore: number; // 0-10
  sleepHours: number;
  moodScore: number; // 0-10
  notes: string;
  tags?: string[];
};

type DemoPayload = {
  diary: DiaryEntry[];
  clinicianTranscript: string;
};

const DEMO_KEYS = {
  diary: "careloop.demoDiary.v1",
  transcript: "careloop.demoTranscript.v1",
  loadedAt: "careloop.demoLoadedAt.v1",
} as const;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function makeDemo(): DemoPayload {
  // Small-but-rich synthetic dataset (no PHI)
  const base = [
    { d: "2026-02-10", s: 3, sl: 7.2, m: 7, t: ["ok"], n: "Felt mostly fine. Light headache in the afternoon." },
    { d: "2026-02-11", s: 4, sl: 6.1, m: 6, t: ["stress"], n: "Busy day. Mild stomach discomfort after lunch." },
    { d: "2026-02-12", s: 6, sl: 5.4, m: 5, t: ["dairy?"], n: "Bloating + cramps after dairy. Slept poorly." },
    { d: "2026-02-13", s: 5, sl: 6.0, m: 6, t: ["hydration"], n: "More water helped. Symptoms eased in the evening." },
    { d: "2026-02-14", s: 7, sl: 4.8, m: 4, t: ["spike", "dairy"], n: "Stronger cramps, nausea. Had pizza/cheese earlier." },
    { d: "2026-02-15", s: 4, sl: 7.5, m: 7, t: ["better"], n: "Avoided dairy. Noticeably better." },
    { d: "2026-02-16", s: 3, sl: 7.8, m: 8, t: ["stable"], n: "Good sleep. Minimal symptoms." },
    { d: "2026-02-17", s: 5, sl: 6.2, m: 6, t: ["stress"], n: "Stressful meeting. Mild recurrence mid-day." },
    { d: "2026-02-18", s: 6, sl: 5.6, m: 5, t: ["spicy"], n: "Spicy food → heartburn + cramps." },
    { d: "2026-02-19", s: 4, sl: 7.0, m: 7, t: ["better"], n: "Ate bland foods; improved." },
  ];

  const diary: DiaryEntry[] = base.map((x) => ({
    date: x.d,
    symptomScore: clamp(x.s, 0, 10),
    sleepHours: clamp(x.sl, 0, 24),
    moodScore: clamp(x.m, 0, 10),
    tags: x.t,
    notes: x.n,
  }));

  const clinicianTranscript =
    "Patient reports intermittent abdominal cramping and bloating for ~2 weeks, worse after dairy and occasionally spicy foods. " +
    "No fever. No blood in stool. Nausea on one day. Sleep has been reduced during symptom spikes. " +
    "Tried avoiding dairy which seemed to improve symptoms. Discussed possible lactose intolerance vs. IBS triggers. " +
    "Plan: trial lactose-free diet for 2 weeks, keep symptom diary, consider OTC lactase as needed, follow up in 2–3 weeks, " +
    "return sooner if worsening pain, fever, or blood in stool.";

  return { diary, clinicianTranscript };
}

export default function HomePage() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loaded" | "error">("idle");

  const demo = useMemo(() => makeDemo(), []);

  function loadDemoAndGo(path: "/patient" | "/clinician") {
    try {
      localStorage.setItem(DEMO_KEYS.diary, JSON.stringify(demo.diary));
      localStorage.setItem(DEMO_KEYS.transcript, demo.clinicianTranscript);
      localStorage.setItem(DEMO_KEYS.loadedAt, new Date().toISOString());
      setStatus("loaded");
      router.push(`${path}?demo=1`);
    } catch {
      setStatus("error");
    }
  }

  function clearDemo() {
    try {
      localStorage.removeItem(DEMO_KEYS.diary);
      localStorage.removeItem(DEMO_KEYS.transcript);
      localStorage.removeItem(DEMO_KEYS.loadedAt);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
              Hackathon Prototype • No PHI • Synthetic demo
            </div>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              CareLoop
            </h1>
            <p className="mt-3 max-w-2xl text-base text-slate-700 sm:text-lg">
              Patient diary insights + clinician voice-to-SOAP notes — connected in one closed loop so the plan becomes
              actionable tracking.
            </p>
          </div>

          <div className="hidden sm:flex flex-col items-end gap-2">
            <Link
              href="/privacy"
              className="text-sm text-slate-700 underline underline-offset-4 hover:text-slate-900"
            >
              Privacy & Safety
            </Link>
            <div className="text-xs text-slate-500">
              Tip: set <code className="rounded bg-slate-100 px-1">API_PROXY_TARGET</code> to use <code className="rounded bg-slate-100 px-1">/api/*</code>
            </div>
          </div>
        </header>

        <section className="mt-10 grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Patient mode</h2>
            <p className="mt-2 text-sm text-slate-700">
              Log symptoms, sleep, mood. See trends + a pre-visit summary in seconds.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/patient"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Open Patient
              </Link>
              <button
                onClick={() => loadDemoAndGo("/patient")}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                Load demo → Patient
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Clinician mode</h2>
            <p className="mt-2 text-sm text-slate-700">
              Dictate a visit. Generate a clean SOAP note (S/O/A/P) ready to review and export.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/clinician"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Open Clinician
              </Link>
              <button
                onClick={() => loadDemoAndGo("/clinician")}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                Load demo → Clinician
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Closed-loop plan</h2>
            <p className="mt-2 text-sm text-slate-700">
              Turn the SOAP “Plan” into patient tasks and reminders — the plan becomes trackable.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/patient?tab=tasks"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                View Tasks
              </Link>
              <Link
                href="/privacy"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                Privacy panel
              </Link>
            </div>
          </div>
        </section>

        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Demo controls</h3>
              <p className="mt-1 text-sm text-slate-700">
                This repo ships with synthetic-only demo data. No personal identifiers are stored or required.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={clearDemo}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                Clear demo data
              </button>
              <Link
                href="/patient?demo=1"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                Continue demo
              </Link>
            </div>
          </div>

          {status !== "idle" && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
              {status === "loaded" && (
                <span>
                  ✅ Demo data loaded into localStorage. Open Patient/Clinician pages to see it.
                </span>
              )}
              {status === "error" && (
                <span>
                  ⚠️ Couldn’t access localStorage (private mode / policy). You can still use the app without demo loading.
                </span>
              )}
            </div>
          )}
        </section>

        <footer className="mt-10 flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <div>
            API calls are made to <code className="rounded bg-slate-100 px-1">/api/*</code> (proxy via{" "}
            <code className="rounded bg-slate-100 px-1">API_PROXY_TARGET</code>).
          </div>
          <div>
            <span className="text-slate-400">CareLoop</span> • demo-first • schema-validated outputs
          </div>
        </footer>
      </div>
    </main>
  );
}
