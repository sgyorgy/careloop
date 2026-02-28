"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type TimelineEvent = {
    date: string;
    type: string;
    title: string;
    description: string;
    icon: string;
    severity?: number;
};

type DiaryEntry = {
    date: string;
    symptomScore: number;
    sleepHours: number;
    moodScore: number;
    notes: string;
    tags?: string[];
};

async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
}

export default function TimelinePage() {
    const [events, setEvents] = useState<TimelineEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState<string>("all");
    const [dark, setDark] = useState(false);

    useEffect(() => {
        setDark(document.documentElement.classList.contains("dark"));
    }, []);

    useEffect(() => {
        const raw = localStorage.getItem("careloop.demoDiary.v1");
        if (!raw) return;
        try {
            const diary: DiaryEntry[] = JSON.parse(raw);
            if (diary.length) loadTimeline(diary);
        } catch { }
    }, []);

    async function loadTimeline(diary: DiaryEntry[]) {
        setLoading(true);
        try {
            const res = await apiPost<{ events: TimelineEvent[] }>("/patient/timeline", { diary });
            setEvents(res.events);
        } catch {
            // Fallback: generate locally
            const fallback: TimelineEvent[] = diary.map(d => ({
                date: d.date,
                type: "diary",
                title: "Diary Entry",
                description: d.notes || `Symptom: ${d.symptomScore}/10`,
                icon: "📝",
                severity: d.symptomScore,
            }));
            setEvents(fallback);
        }
        setLoading(false);
    }

    const filtered = filter === "all" ? events : events.filter(e => e.type === filter);
    const types = [...new Set(events.map(e => e.type))];

    function severityColor(severity?: number) {
        if (!severity) return "border-slate-300 dark:border-slate-600";
        if (severity >= 7) return "border-red-400 dark:border-red-500";
        if (severity >= 5) return "border-amber-400 dark:border-amber-500";
        return "border-emerald-400 dark:border-emerald-500";
    }

    function typeBadge(type: string) {
        const colors: Record<string, string> = {
            diary: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
            alert: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
            visit: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
            report: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
        };
        return colors[type] || "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
    }

    return (
        <main className="min-h-screen">
            <div className="mx-auto max-w-4xl px-6 py-10">
                <header className="flex items-center justify-between mb-8">
                    <div>
                        <Link href="/" className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">← Home</Link>
                        <h1 className="mt-2 text-3xl font-bold tracking-tight">
                            <span className="gradient-text">⏱️ Timeline</span>
                        </h1>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Your complete health journey at a glance</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {types.length > 0 && (
                            <select
                                value={filter}
                                onChange={e => setFilter(e.target.value)}
                                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-slate-200"
                            >
                                <option value="all">All events</option>
                                {types.map(t => (
                                    <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                                ))}
                            </select>
                        )}
                    </div>
                </header>

                {loading && (
                    <div className="flex items-center justify-center py-20">
                        <div className="h-8 w-8 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
                    </div>
                )}

                {!loading && events.length === 0 && (
                    <div className="card-glass p-12 text-center">
                        <p className="text-4xl mb-4">📭</p>
                        <p className="text-lg font-semibold text-slate-700 dark:text-slate-300">No timeline events yet</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">Load demo data from the home page, or start logging diary entries.</p>
                        <Link href="/?demo=1" className="mt-4 inline-block rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 px-6 py-2 text-sm font-medium text-white shadow-md hover:shadow-lg transition-all">
                            Load Demo Data
                        </Link>
                    </div>
                )}

                {/* Timeline */}
                {filtered.length > 0 && (
                    <div className="relative">
                        {/* Vertical line */}
                        <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-gradient-to-b from-emerald-400 via-teal-400 to-cyan-400 dark:from-emerald-600 dark:via-teal-600 dark:to-cyan-600" />

                        <div className="space-y-6">
                            {filtered.map((event, i) => (
                                <div
                                    key={`${event.date}-${event.type}-${i}`}
                                    className="relative flex gap-4 animate-fade-in-up"
                                    style={{ animationDelay: `${i * 80}ms` }}
                                >
                                    {/* Dot on line */}
                                    <div className={`relative z-10 flex items-center justify-center w-12 h-12 rounded-full bg-white dark:bg-slate-800 border-2 ${severityColor(event.severity)} shadow-md text-xl`}>
                                        {event.icon}
                                    </div>

                                    {/* Card */}
                                    <div className="flex-1 card-glass p-4 hover:shadow-xl transition-shadow">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${typeBadge(event.type)}`}>
                                                {event.type}
                                            </span>
                                            <span className="text-xs text-slate-500 dark:text-slate-400">{event.date}</span>
                                            {event.severity !== undefined && (
                                                <span className={`ml-auto text-xs font-bold ${event.severity >= 7 ? "text-red-500" : event.severity >= 5 ? "text-amber-500" : "text-emerald-500"}`}>
                                                    {event.severity}/10
                                                </span>
                                            )}
                                        </div>
                                        <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{event.title}</h3>
                                        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{event.description}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Stats */}
                {events.length > 0 && (
                    <section className="mt-10 grid gap-4 sm:grid-cols-4">
                        {[
                            { label: "Total Events", value: events.length, icon: "📊" },
                            { label: "Diary Entries", value: events.filter(e => e.type === "diary").length, icon: "📝" },
                            { label: "Alerts", value: events.filter(e => e.type === "alert").length, icon: "⚠️" },
                            { label: "Visits", value: events.filter(e => e.type === "visit").length, icon: "🏥" },
                        ].map(s => (
                            <div key={s.label} className="card-glass p-4 text-center">
                                <div className="text-2xl mb-1">{s.icon}</div>
                                <div className="text-2xl font-bold gradient-text">{s.value}</div>
                                <div className="text-xs text-slate-500 dark:text-slate-400">{s.label}</div>
                            </div>
                        ))}
                    </section>
                )}
            </div>
        </main>
    );
}
