"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type DiaryEntry = {
  date: string;
  symptomScore: number;
  sleepHours: number;
  moodScore: number;
  notes: string;
  tags?: string[];
};

type DemoPayload = {
  diary: DiaryEntry[];
  clinicianTranscript: string;
  reportText: string;
};

const DEMO_KEYS = {
  diary: "careloop.demoDiary.v1",
  transcript: "careloop.demoTranscript.v1",
  reportText: "careloop.demoReportText.v1",
  loadedAt: "careloop.demoLoadedAt.v1",
} as const;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function makeDemo(): DemoPayload {
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

  const reportText = [
    "SYNTHETIC MEDICAL REPORT (DEMO — NO PHI)",
    "",
    "LABORATORY RESULTS — 2026-02-20",
    "HbA1c: 7.8 % (ref: 4.0–5.6)  [H]",
    "Fasting glucose: 9.2 mmol/L (ref: 3.9–5.5)  [H]",
    "LDL cholesterol: 3.6 mmol/L (ref: <3.0)  [H]",
    "HDL cholesterol: 1.0 mmol/L (ref: >1.0)  [L/N borderline]",
    "Triglycerides: 2.1 mmol/L (ref: <1.7)  [H]",
    "CRP: 12 mg/L (ref: <5)  [H]",
    "ALT: 58 U/L (ref: <45)  [H]",
    "Creatinine: 78 µmol/L (ref: 62–106)  [N]",
    "",
    "IMAGING (SUMMARY)",
    "Abdominal ultrasound: hepatic steatosis (mild). Renal cyst (benignus-appearing), no hydronephrosis.",
    "",
    "CLINICAL WORDING / TERMS",
    "status post dietary change; suspected metabolic syndrome. No acute distress. Rule out secondary causes if persistent.",
    "",
    "IMPRESSION",
    "Findings consistent with elevated glycemic markers and dyslipidemia. Inflammatory marker (CRP) mildly elevated.",
    "This document is informational only. A clinician should interpret in context.",
  ].join("\n");

  return { diary, clinicianTranscript, reportText };
}

export default function HomePage() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loaded" | "error">("idle");
  const [dark, setDark] = useState(false);
  const demo = useMemo(() => makeDemo(), []);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("careloop.theme", next ? "dark" : "light"); } catch { }
  }

  function loadDemoAndGo(path: "/patient" | "/clinician" | "/report" | "/timeline") {
    try {
      localStorage.setItem(DEMO_KEYS.diary, JSON.stringify(demo.diary));
      localStorage.setItem(DEMO_KEYS.transcript, demo.clinicianTranscript);
      localStorage.setItem(DEMO_KEYS.reportText, demo.reportText);
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
      localStorage.removeItem(DEMO_KEYS.reportText);
      localStorage.removeItem(DEMO_KEYS.loadedAt);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  const cards = [
    {
      title: "Patient mode",
      desc: "Log symptoms, sleep, mood. See trends, AI Health Twin, gamification + pre-visit summary.",
      icon: "🧬",
      href: "/patient",
      gradient: "from-emerald-500 to-teal-600",
    },
    {
      title: "Clinician mode",
      desc: "Ambient scribe, voice→SOAP notes, medical copilot, doctor-patient chat.",
      icon: "🩺",
      href: "/clinician",
      gradient: "from-blue-500 to-indigo-600",
    },
    {
      title: "Report interpreter",
      desc: "Tap-to-explain, lab trend tracker, multi-language translation, values table.",
      icon: "📋",
      href: "/report",
      gradient: "from-violet-500 to-purple-600",
    },
    {
      title: "Timeline",
      desc: "Full patient journey — diary, visits, labs, alerts — on one interactive timeline.",
      icon: "⏱️",
      href: "/timeline",
      gradient: "from-amber-500 to-orange-600",
    },
  ];

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80 backdrop-blur px-3 py-1 text-xs text-slate-700 dark:text-slate-300 shadow-sm">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Hackathon Prototype • No PHI • Synthetic demo
            </div>

            <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
              <span className="gradient-text">CareLoop</span>
            </h1>

            <p className="mt-3 max-w-2xl text-base text-slate-600 dark:text-slate-400 sm:text-lg">
              AI-powered closed-loop health platform — diary insights, voice-to-SOAP notes, report interpretation, predictive analytics & more.
            </p>
          </div>

          <div className="flex flex-col items-end gap-3">
            <button
              onClick={toggleTheme}
              className="group relative inline-flex items-center gap-2 rounded-full bg-slate-900 dark:bg-white px-4 py-2 text-sm font-medium text-white dark:text-slate-900 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105"
              title="Toggle dark/light mode"
            >
              <span className="text-lg transition-transform duration-300 group-hover:rotate-180">{dark ? "☀️" : "🌙"}</span>
              {dark ? "Light" : "Dark"}
            </button>
            <Link href="/privacy" className="text-sm text-slate-600 dark:text-slate-400 underline underline-offset-4 hover:text-slate-900 dark:hover:text-white transition-colors">
              Privacy & Safety
            </Link>
          </div>
        </header>

        {/* Feature cards */}
        <section className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {cards.map((card) => (
            <div
              key={card.href}
              className="group card-glass p-6 hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 cursor-pointer"
            >
              <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br ${card.gradient} text-white text-2xl shadow-lg mb-4 group-hover:scale-110 transition-transform`}>
                {card.icon}
              </div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{card.title}</h2>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{card.desc}</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  href={card.href}
                  className={`rounded-xl bg-gradient-to-r ${card.gradient} px-4 py-2 text-sm font-medium text-white shadow-md hover:shadow-lg transition-all`}
                >
                  Open
                </Link>
                <button
                  onClick={() => loadDemoAndGo(card.href as any)}
                  className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80 px-4 py-2 text-sm font-medium text-slate-900 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                  Demo →
                </button>
              </div>
            </div>
          ))}
        </section>

        {/* WOW Features showcase */}
        <section className="mt-8 card-glass p-6">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4">✨ WOW Features</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { icon: "🧬", name: "AI Health Twin", desc: "Animated digital avatar reflecting your health" },
              { icon: "📊", name: "Correlation Matrix", desc: "Interactive symptom-sleep-mood heatmap" },
              { icon: "🔔", name: "Proactive Alerts", desc: "AI-driven health warnings & encouragement" },
              { icon: "🏅", name: "Gamification", desc: "Streaks, badges, XP & levels" },
              { icon: "📈", name: "Predictive Insights", desc: "AI finds patterns in your data" },
              { icon: "⏱️", name: "Timeline View", desc: "Your complete health journey" },
              { icon: "🌍", name: "Multi-language", desc: "Instant translation of summaries" },
              { icon: "📸", name: "Medication Scanner", desc: "AR-like medication recognition" },
              { icon: "🗣️", name: "Ambient Scribe", desc: "Real-time SOAP note generation" },
              { icon: "🤖", name: "Medical Copilot", desc: "AI answers about patient data" },
              { icon: "💬", name: "Smart Chat", desc: "Doctor-patient messaging with AI" },
              { icon: "🎤", name: "Vocal Biomarkers", desc: "Stress & emotion from voice" },
            ].map((f) => (
              <div key={f.name} className="flex items-center gap-3 rounded-xl p-3 bg-slate-50/50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors">
                <span className="text-2xl">{f.icon}</span>
                <div>
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">{f.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Demo controls */}
        <section className="mt-8 card-glass p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">Demo controls</h3>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Synthetic-only demo data. No personal identifiers are stored or required.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={clearDemo}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/80 px-4 py-2 text-sm font-medium text-slate-900 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                Clear demo data
              </button>
            </div>
          </div>

          {status !== "idle" && (
            <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-3 text-sm text-slate-800 dark:text-slate-200">
              {status === "loaded" && (
                <span>✅ Demo data loaded. Open any page to explore WOW features.</span>
              )}
              {status === "error" && (
                <span>⚠️ Couldn&apos;t access localStorage (private mode / policy).</span>
              )}
            </div>
          )}
        </section>

        <footer className="mt-10 flex flex-col gap-2 text-xs text-slate-500 dark:text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <div>
            API calls via <code className="rounded bg-slate-100 dark:bg-slate-800 px-1">/api/*</code> (proxy via{" "}
            <code className="rounded bg-slate-100 dark:bg-slate-800 px-1">API_PROXY_TARGET</code>).
          </div>
          <div>
            <span className="gradient-text font-semibold">CareLoop</span> • AI-powered • schema-validated • informational only
          </div>
        </footer>
      </div>
    </main>
  );
}
