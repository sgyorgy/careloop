import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import pino from "pino";
import pinoHttp from "pino-http";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";

import * as speechsdk from "microsoft-cognitiveservices-speech-sdk";
import OpenAI from "openai";
import { TextAnalyticsClient, AzureKeyCredential } from "@azure/ai-text-analytics";

// ---------------- logging (no PHI) ----------------
const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "res.headers['set-cookie']",
    ],
    censor: "[REDACTED]",
  },
});

// ---------------- app ----------------
const app = express();
app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!allowedOrigins.length) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  })
);

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Reports can be larger than short transcripts
app.use(express.json({ limit: "4mb" }));

app.use(
  pinoHttp({
    logger: log,
    genReqId: () => randomUUID(),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    serializers: {
      req(req) {
        return {
          id: (req as any).id,
          method: req.method,
          url: req.url,
          remoteAddress: req.socket?.remoteAddress,
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------------- types & schemas ----------------
const EnvSchema = z.object({
  PORT: z.string().optional(),

  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_KEY: z.string().min(1).optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().min(1).optional(),
  AZURE_OPENAI_API_VERSION: z.string().min(1).optional(),
  AZURE_OPENAI_DIARY_DEPLOYMENT: z.string().min(1).optional(),
  AZURE_OPENAI_REPORT_DEPLOYMENT: z.string().min(1).optional(),

  AZURE_SPEECH_KEY: z.string().min(1).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),
  AZURE_SPEECH_LANG: z.string().min(2).optional(),

  AZURE_LANGUAGE_ENDPOINT: z.string().url().optional(),
  AZURE_LANGUAGE_KEY: z.string().min(1).optional(),

  MAX_TRANSCRIPT_CHARS: z.string().optional(),
  REPORT_MAX_CHARS: z.string().optional(),

  OUTPUT_PII_MODE: z.enum(["redact", "block", "off"]).optional(),
  DEFAULT_ENFORCE_REDACTION: z.enum(["true", "false"]).optional(),
  DIARY_SUMMARY_MAX_ENTRIES: z.string().optional(),
  DIARY_NOTES_MAX_CHARS: z.string().optional(),
});

const SegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().min(1),
});

const EvidenceLinkSchema = z.object({
  section: z.enum(["subjective", "objective", "assessment", "plan"]),
  text: z.string().min(1),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
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
  evidence: z.array(EvidenceLinkSchema).optional(),
});

const DiaryEntrySchema = z.object({
  date: z.string().min(8),
  symptomScore: z.number().min(0).max(10),
  sleepHours: z.number().min(0).max(24),
  moodScore: z.number().min(0).max(10),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const DiaryEvidenceRefSchema = z.object({
  entryIndex: z.number().int().nonnegative(),
  date: z.string(),
  snippet: z.string().optional(),
  score: z.number().int().nonnegative().optional(),
});

const DiaryEvidenceItemSchema = z.object({
  kind: z.enum(["bullet", "trigger", "suggestion", "redFlag", "question"]),
  text: z.string().min(1),
  references: z.array(DiaryEvidenceRefSchema).optional(),
  verified: z.boolean(),
});

const TrustSchema = z.object({
  scorePct: z.number().min(0).max(100),
  verified: z.number().int().nonnegative(),
  unverified: z.number().int().nonnegative(),
  piiDetectedInput: z.boolean().optional(),
  piiDetectedOutput: z.boolean().optional(),
  mode: z.enum(["llm", "deterministic"]).optional(),
});

const DiarySummarySchema = z.object({
  headline: z.string(),
  bullets: z.array(z.string()),
  possibleTriggers: z.array(z.string()),
  gentleSuggestions: z.array(z.string()),
  last7DaysAvgSymptom: z.number().nullable().optional(),
  redFlags: z.array(z.string()).optional(),
  questionsForClinician: z.array(z.string()).optional(),
  evidence: z.array(DiaryEvidenceItemSchema).optional(),
  trust: TrustSchema.optional(),
});

// --------- NEW: Report Interpreter schemas ----------
const ReferenceLinkSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
});

const ReportTermSchema = z.object({
  term: z.string().min(1),
  normalized: z.string().min(1),
  translation: z.string().min(1),
  explanation: z.string().min(1), // minimal, clear
  typicalContext: z.enum(["lab", "imaging", "diagnosis", "general"]).default("general"),
  whyItMatters: z.string().min(1),
  references: z.array(ReferenceLinkSchema).default([]),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
  verified: z.boolean().optional(),
});

const LabFlagSchema = z.enum(["low", "normal", "high", "unknown"]);

const ReportLabSchema = z.object({
  name: z.string().min(1),
  normalized: z.string().min(1),
  value: z.number(),
  unit: z.string().optional(),
  refLow: z.number().optional(),
  refHigh: z.number().optional(),
  refText: z.string().optional(),
  flag: LabFlagSchema,
  deltaToNearest: z.number().optional(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
  verified: z.boolean().optional(),
});

const ReportSectionSchema = z.object({
  title: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const ReportIngestResponseSchema = z.object({
  cleanedText: z.string(),
  sections: z.array(ReportSectionSchema).default([]),
  terms: z.array(ReportTermSchema).default([]),
  labs: z.array(ReportLabSchema).default([]),
  warnings: z.array(z.string()).optional(),
  trust: TrustSchema.optional(),
});

const FindingItemSchema = z.object({
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z
    .array(
      z.object({
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
        snippet: z.string().optional(),
        verified: z.boolean().optional(),
      })
    )
    .default([]),
});

const PhysicianSupportSummarySchema = z.object({
  abnormalFindings: z.array(FindingItemSchema).default([]),
  hypotheses: z.array(FindingItemSchema).default([]),
  nextSteps: z.array(FindingItemSchema).default([]),
  redFlags: z.array(FindingItemSchema).default([]),
  disclaimer: z.string().default("Draft for clinician review; not a medical decision."),
});

const PatientPlanSchema = z.object({
  plainSummary: z.string().min(1),
  goals: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  followUp: z.array(z.string()).default([]),
  urgentRedFlags: z.array(z.string()).default([]),
  disclaimer: z.string().default("Informational only — not medical advice. Follow clinician guidance."),
});

const DiseaseProgressRowSchema = z.object({
  metric: z.string().min(1),
  unit: z.string().optional(),
  before: z.string().min(1),
  during: z.string().min(1),
  after: z.string().min(1),
  note: z.string().optional(),
});

const ReportAnalyzeResponseSchema = z.object({
  clinicianSummary: PhysicianSupportSummarySchema,
  patientPlanDraft: PatientPlanSchema,
  labsTable: z.array(ReportLabSchema).default([]),
  diseaseProgress: z.array(DiseaseProgressRowSchema).optional(),
  warnings: z.array(z.string()).optional(),
  trust: TrustSchema.optional(),
});

type Soap = z.infer<typeof SoapSchema>;
type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;
type Segment = z.infer<typeof SegmentSchema>;
type DiaryEntry = z.infer<typeof DiaryEntrySchema>;
type DiarySummary = z.infer<typeof DiarySummarySchema>;
type DiaryEvidenceItem = z.infer<typeof DiaryEvidenceItemSchema>;

type ReportTerm = z.infer<typeof ReportTermSchema>;
type ReportLab = z.infer<typeof ReportLabSchema>;

// ---------------- helpers ----------------
const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  log.warn(
    { issues: env.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    "env validation warning"
  );
}

const MAX_TRANSCRIPT_CHARS = Number(process.env.MAX_TRANSCRIPT_CHARS ?? 50_000);
const REPORT_MAX_CHARS = Number(process.env.REPORT_MAX_CHARS ?? 120_000);

const OUTPUT_PII_MODE = (process.env.OUTPUT_PII_MODE ?? "redact") as "redact" | "block" | "off";
const DEFAULT_ENFORCE_REDACTION = (process.env.DEFAULT_ENFORCE_REDACTION ?? "false") === "true";
const DIARY_SUMMARY_MAX_ENTRIES = Math.max(1, Math.min(365, Number(process.env.DIARY_SUMMARY_MAX_ENTRIES ?? 30)));
const DIARY_NOTES_MAX_CHARS = Math.max(0, Math.min(2000, Number(process.env.DIARY_NOTES_MAX_CHARS ?? 400)));

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function mean(nums: number[]) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

type AzureOpenAIConfig = { endpoint: string; apiKey: string; apiVersion: string };

function getAzureOpenAIConfig(): AzureOpenAIConfig | null {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-15-preview";
  if (!endpoint || !apiKey) return null;
  return { endpoint, apiKey, apiVersion };
}

function makeAzureOpenAIClient(config: AzureOpenAIConfig, deployment: string) {
  const baseURL = `${config.endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}`;
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    defaultQuery: { "api-version": config.apiVersion },
    defaultHeaders: { "api-key": config.apiKey },
  });
}

function makeTextAnalytics() {
  const endpoint = process.env.AZURE_LANGUAGE_ENDPOINT;
  const key = process.env.AZURE_LANGUAGE_KEY;
  if (!endpoint || !key) return null;
  return new TextAnalyticsClient(endpoint, new AzureKeyCredential(key));
}

function asLines(v: string[] | string): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  return s
    .split(/\n|•|\u2022|-/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function truncateForProcessing(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function normalizeWhitespace(text: string) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateNote(note: string, maxChars: number) {
  const t = String(note ?? "").replace(/\s+/g, " ").trim();
  if (!maxChars) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "…";
}

function mockSoap(transcript: string) {
  const planMatch = transcript.match(/plan:\s*(.+)$/i);
  const plan = planMatch
    ? planMatch[1].split(/,|;|\./).map((s) => s.trim()).filter(Boolean)
    : ["Follow-up as discussed."];

  return {
    subjective: ["Patient reports symptoms as described in transcript."],
    objective: ["No objective measurements provided in transcript."],
    assessment: ["Assessment based on transcript (informational only)."],
    plan,
  };
}

function scoreOverlap(a: string, b: string) {
  const aw = a
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const bw = new Set(
    b
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4)
  );
  let score = 0;
  for (const w of aw) if (bw.has(w)) score++;
  return score;
}

function buildEvidenceFromSegments(soap: Soap, segments: Segment[]) {
  const out: EvidenceLink[] = [];
  const sections: Array<[EvidenceLink["section"], string[]]> = [
    ["subjective", asLines(soap.subjective)],
    ["objective", asLines(soap.objective)],
    ["assessment", asLines(soap.assessment)],
    ["plan", asLines(soap.plan)],
  ];

  for (const [section, lines] of sections) {
    for (const line of lines.slice(0, 12)) {
      let best: { seg: Segment; score: number } | null = null;
      for (const seg of segments) {
        const s = scoreOverlap(line, seg.text);
        if (!best || s > best.score) best = { seg, score: s };
      }

      if (best && best.score >= 2) {
        out.push({
          section,
          text: line,
          startMs: best.seg.startMs,
          endMs: best.seg.endMs,
          snippet: best.seg.text,
          verified: true,
        });
      } else {
        out.push({ section, text: line, verified: false });
      }
    }
  }
  return out.slice(0, 40);
}

function buildEvidenceFromSearch(transcript: string, soap: Soap) {
  const t = transcript;
  const tl = t.toLowerCase();

  const out: EvidenceLink[] = [];
  const sections: Array<[EvidenceLink["section"], string[]]> = [
    ["subjective", asLines(soap.subjective)],
    ["objective", asLines(soap.objective)],
    ["assessment", asLines(soap.assessment)],
    ["plan", asLines(soap.plan)],
  ];

  for (const [section, lines] of sections) {
    for (const line of lines.slice(0, 12)) {
      const needle = line.toLowerCase().replace(/\s+/g, " ").trim();
      let idx = needle.length >= 12 ? tl.indexOf(needle) : -1;

      if (idx < 0) {
        const words = needle.split(/\s+/).filter((w) => w.length >= 5).slice(0, 4);
        for (const w of words) {
          const j = tl.indexOf(w);
          if (j >= 0) {
            idx = j;
            break;
          }
        }
      }

      if (idx >= 0) {
        const start = Math.max(0, idx - 10);
        const end = Math.min(t.length, idx + Math.min(240, Math.max(30, line.length + 40)));
        out.push({
          section,
          text: line,
          start,
          end,
          snippet: t.slice(start, end),
          verified: true,
        });
      } else {
        out.push({ section, text: line, verified: false });
      }
    }
  }
  return out.slice(0, 40);
}

function computeTrustFromEvidence(items: Array<{ verified?: boolean }>) {
  const total = items.length;
  const verified = items.filter((x) => x.verified).length;
  const unverified = Math.max(0, total - verified);
  const scorePct = total ? Math.round((verified / total) * 100) : 0;
  return { verified, unverified, scorePct };
}

/**
 * Speech-to-Text with segments + timestamps.
 */
async function transcribeWithSegmentsWav(filePath: string): Promise<{ transcript: string; segments: Segment[] }> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    return {
      transcript: "Mock transcript (set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION to enable real STT).",
      segments: [
        { startMs: 0, endMs: 2000, text: "Mock transcript segment." },
        { startMs: 2000, endMs: 5000, text: "Add Azure Speech credentials for real timestamps." },
      ],
    };
  }

  const speechConfig = speechsdk.SpeechConfig.fromSubscription(key, region);
  speechConfig.speechRecognitionLanguage = process.env.AZURE_SPEECH_LANG ?? "en-US";
  speechConfig.outputFormat = speechsdk.OutputFormat.Detailed;

  const audioConfig = speechsdk.AudioConfig.fromWavFileInput(filePath);
  const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

  const segments: Segment[] = [];
  const texts: string[] = [];

  await new Promise<void>((resolve, reject) => {
    let done = false;

    const stop = () => {
      if (done) return;
      done = true;
      try {
        recognizer.stopContinuousRecognitionAsync(
          () => {
            recognizer.close();
            resolve();
          },
          (err) => {
            recognizer.close();
            reject(err);
          }
        );
      } catch (e) {
        recognizer.close();
        reject(e);
      }
    };

    recognizer.recognized = (_s, e) => {
      if (!e?.result) return;

      const text = (e.result.text ?? "").trim();
      if (text) texts.push(text);

      const jsonStr =
        e.result.properties?.getProperty(speechsdk.PropertyId.SpeechServiceResponse_JsonResult) ?? "";
      const json = jsonStr ? safeJsonParse(jsonStr) : null;

      try {
        const nbest = (json as any)?.NBest?.[0];
        const words = nbest?.Words as Array<{ Offset: number; Duration: number; Word: string }> | undefined;

        if (words && words.length) {
          const first = words[0];
          const last = words[words.length - 1];
          const startMs = Math.max(0, Math.round(first.Offset / 10_000));
          const endMs = Math.max(startMs, Math.round((last.Offset + last.Duration) / 10_000));
          if (text) segments.push({ startMs, endMs, text });
        } else if (text) {
          segments.push({ startMs: 0, endMs: 0, text });
        }
      } catch {
        // ignore
      }
    };

    recognizer.canceled = (_s, e) => {
      const details = e?.errorDetails ? String(e.errorDetails).slice(0, 200) : "canceled";
      log.warn({ where: "stt", reason: e?.reason, details }, "speech canceled");
      stop();
    };

    recognizer.sessionStopped = () => stop();

    try {
      recognizer.startContinuousRecognitionAsync(
        () => {
          /* started */
        },
        (err) => reject(err)
      );
    } catch (e) {
      reject(e);
    }
  });

  const transcript = texts.join(" ").replace(/\s+/g, " ").trim();
  return { transcript, segments: segments.filter((s) => s.text.trim()) };
}

async function redactTextBestEffort(text: string): Promise<{ redacted: string; piiDetected: boolean }> {
  const ta = makeTextAnalytics();

  const regexFallback = () => {
    const redacted = text
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
      .replace(
        /(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g,
        "[REDACTED_PHONE]"
      );
    return { redacted, piiDetected: redacted !== text };
  };

  if (!ta) return regexFallback();

  try {
    const [result] = await ta.recognizePiiEntities([text]);
    const redactedText = result?.redactedText ?? text;
    const piiDetected = (result?.entities?.length ?? 0) > 0;
    return { redacted: redactedText, piiDetected };
  } catch {
    return regexFallback();
  }
}

async function redactStringsBestEffort<T extends Record<string, any>>(
  obj: T
): Promise<{ redacted: T; piiDetected: boolean }> {
  if (OUTPUT_PII_MODE === "off") return { redacted: obj, piiDetected: false };

  let piiDetected = false;

  const redactOne = async (s: string) => {
    const r = await redactTextBestEffort(s);
    piiDetected = piiDetected || r.piiDetected;
    return r.redacted;
  };

  const walk = async (v: any): Promise<any> => {
    if (typeof v === "string") return redactOne(v);
    if (Array.isArray(v)) {
      const out = [];
      for (const item of v) out.push(await walk(item));
      return out;
    }
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = await walk(val);
      return out;
    }
    return v;
  };

  const redacted = (await walk(obj)) as T;
  return { redacted, piiDetected };
}

async function extractHealthcareEntitiesBestEffort(text: string) {
  const ta = makeTextAnalytics();
  if (!ta) return null;

  try {
    const poller = await ta.beginAnalyzeHealthcareEntities([text]);
    const results = await poller.pollUntilDone();

    const out: Array<{
      text: string;
      category: string;
      subCategory?: string;
      confidence?: number;
      offset?: number;
      length?: number;
    }> = [];

    for await (const doc of results) {
      if (doc.error) continue;
      for (const ent of doc.entities) {
        out.push({
          text: ent.text,
          category: ent.category,
          subCategory: (ent as any).subCategory,
          confidence: ent.confidenceScore,
          offset: ent.offset,
          length: ent.length,
        });
      }
    }
    return out.slice(0, 200);
  } catch {
    return null;
  }
}

function asyncHandler<TReq extends Request, TRes extends Response>(
  fn: (req: TReq, res: TRes, next: NextFunction) => Promise<any>
) {
  return (req: TReq, res: TRes, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------------- diary helpers ----------------
function normalizeDiary(diary: DiaryEntry[]) {
  return diary
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({
      ...e,
      date: e.date.slice(0, 10),
      notes: e.notes ? truncateNote(e.notes, DIARY_NOTES_MAX_CHARS) : undefined,
      tags: (e.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
    }));
}

function diaryEntryText(e: { notes?: string; tags?: string[] }) {
  const parts = [
    (e.notes ?? "").trim(),
    ...(e.tags ?? []).map((t) => String(t ?? "").trim()).filter(Boolean),
  ].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function pickBestDiaryEvidence(text: string, diary: ReturnType<typeof normalizeDiary>) {
  let best: { i: number; score: number } | null = null;
  for (let i = 0; i < diary.length; i++) {
    const entry = diary[i];
    const corpus = diaryEntryText(entry);
    if (!corpus) continue;
    const s = scoreOverlap(text, corpus);
    if (!best || s > best.score) best = { i, score: s };
  }
  if (!best) return null;
  const entry = diary[best.i];
  return {
    entryIndex: best.i,
    date: entry.date,
    snippet: entry.notes ? truncateNote(entry.notes, 180) : undefined,
    score: best.score,
  };
}

function buildDiaryEvidence(summary: DiarySummary, diary: ReturnType<typeof normalizeDiary>): DiaryEvidenceItem[] {
  const out: DiaryEvidenceItem[] = [];

  const addMany = (kind: DiaryEvidenceItem["kind"], items?: string[]) => {
    for (const text of (items ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 12)) {
      const ref = pickBestDiaryEvidence(text, diary);
      const verified = Boolean(ref && (ref.score ?? 0) >= 2);
      out.push({
        kind,
        text,
        references: ref ? [ref] : [],
        verified,
      });
    }
  };

  addMany("bullet", summary.bullets);
  addMany("trigger", summary.possibleTriggers);
  addMany("suggestion", summary.gentleSuggestions);
  addMany("redFlag", summary.redFlags);
  addMany("question", summary.questionsForClinician);

  return out.slice(0, 60);
}

function deterministicDiarySummary(diary: ReturnType<typeof normalizeDiary>): DiarySummary {
  const last7 = diary.slice(-7);
  const avgSym = mean(last7.map((e) => e.symptomScore));
  const avgSleep = mean(last7.map((e) => e.sleepHours));
  const avgMood = mean(last7.map((e) => e.moodScore));

  const triggers = Array.from(
    new Set(last7.flatMap((e) => (e.tags ?? []).map((t) => t.toLowerCase())).filter(Boolean))
  ).slice(0, 5);

  const bullets: string[] = [];
  if (avgSym != null) bullets.push(`Last 7 days avg symptom score: ${avgSym.toFixed(1)} / 10`);
  if (avgSleep != null) bullets.push(`Last 7 days avg sleep: ${avgSleep.toFixed(1)} hours`);
  if (avgMood != null) bullets.push(`Last 7 days avg mood: ${avgMood.toFixed(1)} / 10`);
  bullets.push("Patterns are hints only (not a diagnosis).");

  const redFlags: string[] = [];
  const mostRecent = last7[last7.length - 1];
  if (mostRecent && mostRecent.symptomScore >= 8)
    redFlags.push("Very high symptom score recently (consider timely check-in).");
  if (avgSleep != null && avgSleep < 5) redFlags.push("Low average sleep over the last week.");

  const questions: string[] = [];
  if (triggers.length) questions.push(`Do symptoms correlate with: ${triggers.join(", ")}?`);
  questions.push("Any recent medication changes or missed doses?");
  questions.push("What improves or worsens symptoms (activity, meals, stress, sleep)?");

  return {
    headline: diary.length ? "Pre-visit summary (server)" : "Add diary entries to generate a summary",
    bullets: diary.length ? bullets.slice(0, 6) : [],
    possibleTriggers: diary.length ? triggers : [],
    gentleSuggestions: diary.length
      ? ["Keep logging meals/sleep alongside symptoms.", "If symptoms worsen or feel unsafe, consider contacting a clinician."]
      : [],
    last7DaysAvgSymptom: avgSym,
    redFlags: diary.length ? redFlags.slice(0, 5) : [],
    questionsForClinician: diary.length ? questions.slice(0, 5) : [],
  };
}

async function llmDiarySummary(diary: ReturnType<typeof normalizeDiary>) {
  const config = getAzureOpenAIConfig();
  const deployment =
    process.env.AZURE_OPENAI_DIARY_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || "";
  if (!config || !deployment) return null;

  const client = makeAzureOpenAIClient(config, deployment);

  const diaryForModel = diary
    .slice(-DIARY_SUMMARY_MAX_ENTRIES)
    .map((e) => ({
      date: e.date,
      symptomScore: e.symptomScore,
      sleepHours: e.sleepHours,
      moodScore: e.moodScore,
      notes: e.notes ?? "",
      tags: e.tags ?? [],
    }));

  const last7 = diary.slice(-7);
  const avgSym = mean(last7.map((e) => e.symptomScore));

  const system = `You are an AI health diary summarizer.
Return a STRICT JSON object only (no markdown, no extra keys).
Schema:
{
  "headline": string,
  "bullets": string[],
  "possibleTriggers": string[],
  "gentleSuggestions": string[],
  "last7DaysAvgSymptom": number|null,
  "redFlags": string[],
  "questionsForClinician": string[]
}
Rules:
- DO NOT diagnose. Use cautious, informational phrasing.
- DO NOT include personally identifying info (names, addresses, emails, phone numbers).
- Prefer trends/correlations and what to ask/track next.
- If unsure, write items as "for clinician review".`;

  const user = `Diary entries (synthetic/anonymized). JSON array:
${JSON.stringify(diaryForModel)}
Context:
- last7DaysAvgSymptom (computed server-side): ${avgSym == null ? "null" : avgSym.toFixed(2)}
Return the JSON schema exactly.`;

  const completion = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content ?? "{}";
  const parsedJson = safeJsonParse(content);
  if (!parsedJson) return null;

  const CandidateSchema = z.object({
    headline: z.string().min(1),
    bullets: z.array(z.string()).default([]),
    possibleTriggers: z.array(z.string()).default([]),
    gentleSuggestions: z.array(z.string()).default([]),
    last7DaysAvgSymptom: z.number().nullable().optional(),
    redFlags: z.array(z.string()).default([]),
    questionsForClinician: z.array(z.string()).default([]),
  });

  const candidate = CandidateSchema.safeParse(parsedJson);
  if (!candidate.success) return null;

  const s: DiarySummary = {
    headline: candidate.data.headline,
    bullets: candidate.data.bullets.map((x) => String(x).trim()).filter(Boolean).slice(0, 6),
    possibleTriggers: candidate.data.possibleTriggers.map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
    gentleSuggestions: candidate.data.gentleSuggestions.map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
    last7DaysAvgSymptom: candidate.data.last7DaysAvgSymptom ?? null,
    redFlags: candidate.data.redFlags.map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
    questionsForClinician: candidate.data.questionsForClinician.map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
  };

  return s;
}

// ---------------- NEW: Report Interpreter helpers ----------------

// Small curated references (stable, “authoritative enough” for demo)
const AUTHORITATIVE_SOURCES: Record<string, { label: string; url: string }[]> = {
  // general
  general: [
    { label: "MedlinePlus (NIH)", url: "https://medlineplus.gov/" },
    { label: "NHS (UK)", url: "https://www.nhs.uk/" },
  ],
  // cancer terms
  malignancy: [{ label: "NCI Dictionary of Cancer Terms", url: "https://www.cancer.gov/publications/dictionaries/cancer-terms" }],
  // imaging terms
  imaging: [{ label: "Radiopaedia (educational)", url: "https://radiopaedia.org/" }],
};

// A tiny deterministic dictionary for demo fallback (LLM preferred)
const TERM_FALLBACK: Record<
  string,
  { translation: string; explanation: string; typicalContext: ReportTerm["typicalContext"]; whyItMatters: string; refsKey?: keyof typeof AUTHORITATIVE_SOURCES }
> = {
  "status post": {
    translation: "after (a prior procedure/event)",
    explanation: "Indicates something happened in the past (e.g., surgery) and the report describes the current state after it.",
    typicalContext: "general",
    whyItMatters: "Provides medical context for interpreting current findings.",
    refsKey: "general",
  },
  fractura: {
    translation: "fracture",
    explanation: "A break in a bone.",
    typicalContext: "imaging",
    whyItMatters: "May require immobilization, follow-up imaging, or other treatment depending on severity/location.",
    refsKey: "imaging",
  },
  stenosis: {
    translation: "narrowing (of a vessel/duct/valve)",
    explanation: "A structure is narrower than normal, which can limit flow.",
    typicalContext: "imaging",
    whyItMatters: "Severity and symptoms determine whether monitoring or intervention is needed.",
    refsKey: "general",
  },
  benignus: {
    translation: "benign (non-cancerous)",
    explanation: "A finding that is not cancer.",
    typicalContext: "diagnosis",
    whyItMatters: "Usually lower risk than malignant findings but may still need monitoring.",
    refsKey: "general",
  },
  malignus: {
    translation: "malignant (cancerous)",
    explanation: "A finding concerning for cancer.",
    typicalContext: "diagnosis",
    whyItMatters: "Typically requires clinician-led evaluation and a treatment plan.",
    refsKey: "malignancy",
  },
};

function normalizeTermKey(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findAllOccurrences(haystack: string, needle: string, maxHits = 12) {
  const out: Array<{ offset: number; length: number }> = [];
  if (!needle) return out;
  const hl = haystack.toLowerCase();
  const nl = needle.toLowerCase();
  let idx = 0;
  while (out.length < maxHits) {
    const j = hl.indexOf(nl, idx);
    if (j < 0) break;
    out.push({ offset: j, length: needle.length });
    idx = j + Math.max(1, needle.length);
  }
  return out;
}

function splitReportSections(text: string): Array<{ title: string; start: number; end: number }> {
  // very hackathon-friendly heuristic: detect lines like "IMPRESSION", "FINDINGS", "RESULTS", etc.
  const lines = text.split("\n");
  const anchors: Array<{ title: string; startLine: number }> = [];

  const isHeading = (line: string) => {
    const t = line.trim();
    if (!t) return false;
    if (t.length > 60) return false;
    // all caps or ends with colon
    const caps = t === t.toUpperCase() && /[A-Z]/.test(t);
    const colon = t.endsWith(":");
    return caps || colon;
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (isHeading(t)) anchors.push({ title: t.replace(/:$/, ""), startLine: i });
  }

  if (!anchors.length) return [];

  // map line index -> char offset
  const lineOffsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1; // + newline
  }

  const sections: Array<{ title: string; start: number; end: number }> = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const start = lineOffsets[a.startLine] ?? 0;
    const next = anchors[i + 1];
    const end = next ? (lineOffsets[next.startLine] ?? text.length) : text.length;
    // avoid micro sections
    if (end - start >= 60) sections.push({ title: a.title, start, end });
  }
  return sections.slice(0, 12);
}

// Very small lab reference ranges for demo (NOT personalized; adult typical ranges)
const LAB_RANGES: Record<string, { unit?: string; low?: number; high?: number; refText?: string }> = {
  glucose: { unit: "mmol/L", low: 3.9, high: 5.5, refText: "Typical fasting adult reference range (demo)" },
  hba1c: { unit: "%", low: 4.0, high: 5.6, refText: "Typical adult reference range (demo)" },
  ldl: { unit: "mmol/L", low: 0.0, high: 3.0, refText: "Common target reference (demo)" },
  crp: { unit: "mg/L", low: 0.0, high: 5.0, refText: "Typical reference range (demo)" },
  tsh: { unit: "mIU/L", low: 0.4, high: 4.0, refText: "Typical adult reference range (demo)" },
  alt: { unit: "U/L", low: 0.0, high: 40.0, refText: "Typical adult reference range (demo)" },
  ast: { unit: "U/L", low: 0.0, high: 40.0, refText: "Typical adult reference range (demo)" },
  creatinine: { unit: "µmol/L", low: 50.0, high: 110.0, refText: "Typical adult reference range (demo)" },
};

function normalizeLabName(name: string) {
  const t = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // a few aliases
  if (t.includes("hb a1c") || t.includes("hba1c")) return "hba1c";
  if (t === "ldl cholesterol" || t.includes("ldl")) return "ldl";
  if (t === "c reactive protein" || t === "crp") return "crp";
  if (t === "thyroid stimulating hormone" || t === "tsh") return "tsh";
  if (t === "alanine aminotransferase" || t === "sgpt" || t === "alt") return "alt";
  if (t === "aspartate aminotransferase" || t === "sgot" || t === "ast") return "ast";
  if (t.includes("creatinine")) return "creatinine";
  if (t.includes("glucose")) return "glucose";
  return t;
}

function flagLab(v: number, low?: number, high?: number) {
  if (typeof low !== "number" || typeof high !== "number") return { flag: "unknown" as const, deltaToNearest: undefined as number | undefined };
  if (v < low) return { flag: "low" as const, deltaToNearest: Number((low - v).toFixed(3)) };
  if (v > high) return { flag: "high" as const, deltaToNearest: Number((v - high).toFixed(3)) };
  return { flag: "normal" as const, deltaToNearest: 0 };
}

function parseLabsFromText(text: string): ReportLab[] {
  // Heuristic regex for lines like:
  // "HbA1c 7.2 % (ref 4.0-5.6)" or "CRP: 12 mg/L  (0-5)"
  const out: ReportLab[] = [];

  const lines = text.split("\n");
  const patterns: RegExp[] = [
    // Name : value unit (ref low-high)
    /^([A-Za-z][A-Za-z0-9 \/%().-]{1,40})\s*[:\-]\s*([0-9]+(?:[.,][0-9]+)?)\s*([^\d\s]{0,6}[A-Za-z/%µμ]+)?\s*(?:\(|\[)?\s*(?:ref|reference|range)?\s*([0-9]+(?:[.,][0-9]+)?)\s*[-–]\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:\)|\])?/i,
    // Name value unit low-high
    /^([A-Za-z][A-Za-z0-9 \/%().-]{1,40})\s+([0-9]+(?:[.,][0-9]+)?)\s*([^\d\s]{0,6}[A-Za-z/%µμ]+)?\s+([0-9]+(?:[.,][0-9]+)?)\s*[-–]\s*([0-9]+(?:[.,][0-9]+)?)/i,
  ];

  let charOffset = 0;
  for (const line of lines) {
    const raw = line;
    const trimmed = raw.trim();
    const lineStart = charOffset;

    for (const re of patterns) {
      const m = trimmed.match(re);
      if (!m) continue;

      const name = String(m[1] ?? "").trim();
      const value = Number(String(m[2] ?? "").replace(",", "."));
      const unit = m[3] ? String(m[3]).trim() : undefined;

      const refLow = m[4] ? Number(String(m[4]).replace(",", ".")) : undefined;
      const refHigh = m[5] ? Number(String(m[5]).replace(",", ".")) : undefined;

      const normalized = normalizeLabName(name);
      const fallback = LAB_RANGES[normalized];

      const low = typeof refLow === "number" ? refLow : fallback?.low;
      const high = typeof refHigh === "number" ? refHigh : fallback?.high;

      const { flag, deltaToNearest } = flagLab(value, low, high);

      out.push({
        name,
        normalized,
        value,
        unit: unit || fallback?.unit,
        refLow: low,
        refHigh: high,
        refText: (refLow != null && refHigh != null)
          ? `Reference range from report: ${refLow}-${refHigh}${unit ? " " + unit : ""}`
          : fallback?.refText,
        flag,
        deltaToNearest,
        offset: lineStart + Math.max(0, raw.toLowerCase().indexOf(name.toLowerCase())),
        length: Math.min(raw.length, Math.max(8, name.length + 20)),
        verified: true,
      });

      break;
    }

    charOffset += raw.length + 1;
  }

  // Dedup by normalized+value+unit (keep first)
  const seen = new Set<string>();
  const dedup: ReportLab[] = [];
  for (const x of out) {
    const k = `${x.normalized}|${x.value}|${x.unit ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(x);
  }

  return dedup.slice(0, 60);
}

async function explainTermsWithLLM(terms: Array<{ term: string; normalized: string }>) {
  const config = getAzureOpenAIConfig();
  const deployment =
    process.env.AZURE_OPENAI_REPORT_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || "";
  if (!config || !deployment) return null;

  const client = makeAzureOpenAIClient(config, deployment);

  const system = `You are a medical report interpreter for patients.
Return STRICT JSON only. Do not add keys.
Goal: explain terms WITHOUT changing medical meaning.
Rules:
- No diagnosis.
- No personal identifiers.
- Keep explanation minimal and clear (1-2 sentences).
- "whyItMatters" must be ONE short sentence.
- typicalContext must be one of: "lab", "imaging", "diagnosis", "general".
Schema:
{
  "items": [
    {
      "normalized": string,
      "translation": string,
      "explanation": string,
      "typicalContext": "lab"|"imaging"|"diagnosis"|"general",
      "whyItMatters": string
    }
  ]
}`;

  const user = `Terms to explain (normalized keys):
${JSON.stringify(terms)}
Return the JSON schema exactly.`;

  const completion = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content ?? "{}";
  const parsedJson = safeJsonParse(content);
  if (!parsedJson) return null;

  const Schema = z.object({
    items: z
      .array(
        z.object({
          normalized: z.string().min(1),
          translation: z.string().min(1),
          explanation: z.string().min(1),
          typicalContext: z.enum(["lab", "imaging", "diagnosis", "general"]),
          whyItMatters: z.string().min(1),
        })
      )
      .default([]),
  });

  const parsed = Schema.safeParse(parsedJson);
  if (!parsed.success) return null;

  const map = new Map<string, z.infer<typeof parsed.data.items>[number]>();
  for (const it of parsed.data.items) map.set(normalizeTermKey(it.normalized), it);
  return map;
}

function detectCandidateTerms(text: string, healthEntities: any[] | null) {
  // candidates: from fallback dict + from healthcare entities (unique)
  const candidates = new Map<string, { term: string; normalized: string }>();

  // from dictionary: only if appears in text
  for (const rawKey of Object.keys(TERM_FALLBACK)) {
    const k = normalizeTermKey(rawKey);
    if (text.toLowerCase().includes(k)) {
      candidates.set(k, { term: rawKey, normalized: k });
    }
  }

  // from TA for Health entities: use entity text directly
  for (const ent of (healthEntities ?? [])) {
    const t = String(ent?.text ?? "").trim();
    if (!t) continue;
    const normalized = normalizeTermKey(t);
    if (normalized.length < 4) continue;
    // keep it from exploding
    if (normalized.split(" ").length > 6) continue;
    // require it appears in text
    if (!text.toLowerCase().includes(normalized)) continue;
    if (!candidates.has(normalized)) candidates.set(normalized, { term: t, normalized });
    if (candidates.size >= 30) break;
  }

  return Array.from(candidates.values()).slice(0, 30);
}

function attachOffsetsForTerms(cleanedText: string, terms: ReportTerm[]) {
  // attach the first occurrence offset/length (UI can still highlight multiple via client)
  return terms.map((t) => {
    const hits = findAllOccurrences(cleanedText, t.term, 1);
    const hit = hits[0];
    if (!hit) return t;
    return { ...t, offset: hit.offset, length: hit.length, verified: true };
  });
}

function diseaseProgressTable(conditionHint?: string) {
  const hint = normalizeTermKey(conditionHint ?? "");
  // Demo-only, intentionally conservative: show "target direction" rather than claiming real population averages.
  if (hint.includes("diabetes") || hint.includes("hba1c")) {
    return [
      {
        metric: "HbA1c",
        unit: "%",
        before: "Often elevated (example: > 7.0)",
        during: "Trending downward with treatment + adherence",
        after: "Closer to individualized target (commonly around 6.5–7.0)",
        note: "Demo visualization. Targets vary by patient and clinician plan.",
      },
    ];
  }
  if (hint.includes("lipid") || hint.includes("ldl") || hint.includes("cholesterol")) {
    return [
      {
        metric: "LDL cholesterol",
        unit: "mmol/L",
        before: "Elevated vs target",
        during: "Decreasing with therapy + lifestyle support",
        after: "Closer to clinician-defined target",
        note: "Demo visualization. Targets depend on cardiovascular risk.",
      },
    ];
  }
  if (hint.includes("inflammation") || hint.includes("crp")) {
    return [
      {
        metric: "CRP",
        unit: "mg/L",
        before: "Higher during active inflammation",
        during: "Decreasing if inflammation resolves",
        after: "Near baseline reference range",
        note: "Demo visualization. Interpretation depends on context (infection, autoimmune, etc.).",
      },
    ];
  }
  return undefined;
}

function evidenceFromSearch(reportText: string, itemText: string) {
  const t = reportText;
  const tl = t.toLowerCase();
  const needle = String(itemText ?? "").toLowerCase().replace(/\s+/g, " ").trim();

  let idx = needle.length >= 10 ? tl.indexOf(needle) : -1;
  if (idx < 0) {
    const words = needle.split(/\s+/).filter((w) => w.length >= 5).slice(0, 4);
    for (const w of words) {
      const j = tl.indexOf(w);
      if (j >= 0) {
        idx = j;
        break;
      }
    }
  }

  if (idx >= 0) {
    const start = Math.max(0, idx - 10);
    const end = Math.min(t.length, idx + Math.min(260, Math.max(40, itemText.length + 50)));
    return [{ start, end, snippet: t.slice(start, end), verified: true }];
  }
  return [{ verified: false }];
}

async function deterministicReportAnalyze(cleanedText: string, labs: ReportLab[]) {
  const abnormal = labs.filter((l) => l.flag === "high" || l.flag === "low");
  const abnormalTexts = abnormal.slice(0, 8).map((l) => {
    const range =
      typeof l.refLow === "number" && typeof l.refHigh === "number"
        ? ` (ref ${l.refLow}-${l.refHigh}${l.unit ? " " + l.unit : ""})`
        : "";
    return `${l.name}: ${l.value}${l.unit ? " " + l.unit : ""} — ${l.flag}${range}`;
  });

  const clinicianSummary = {
    abnormalFindings: abnormalTexts.map((t) => ({ text: t, evidence: evidenceFromSearch(cleanedText, t) })),
    hypotheses: [
      {
        text: "Interpretation depends on clinical context; consider correlating abnormal values with symptoms and history.",
        confidence: 0.3,
        evidence: [],
      },
    ],
    nextSteps: [
      { text: "Review results with clinician; consider repeat testing if clinically indicated.", confidence: 0.4, evidence: [] },
      { text: "Track trends over time rather than single values.", confidence: 0.5, evidence: [] },
    ],
    redFlags: [
      { text: "If severe symptoms occur (e.g., chest pain, difficulty breathing, fainting), seek urgent care.", confidence: 0.2, evidence: [] },
    ],
    disclaimer: "Draft for clinician review; not a medical decision.",
  };

  const patientPlanDraft = {
    plainSummary: abnormal.length
      ? "Some measured values are outside typical reference ranges. This does not diagnose a condition by itself, but it can guide what to discuss with your clinician."
      : "No obvious lab values were flagged as outside typical reference ranges in this extraction. Discuss full context with your clinician.",
    goals: abnormal.slice(0, 5).map((l) => `Discuss ${l.name} trend and target range with your clinician.`),
    actions: [
      "Keep a record of symptoms and medications around the time of testing.",
      "Bring prior results to compare trends.",
    ],
    followUp: ["Schedule follow-up based on clinician guidance."],
    urgentRedFlags: ["Seek urgent care if you feel severely unwell or have alarming symptoms."],
    disclaimer: "Informational only — not medical advice. Follow clinician guidance.",
  };

  return { clinicianSummary, patientPlanDraft };
}

async function llmReportAnalyze(cleanedText: string, terms: ReportTerm[], labs: ReportLab[], conditionHint?: string) {
  const config = getAzureOpenAIConfig();
  const deployment =
    process.env.AZURE_OPENAI_REPORT_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || "";
  if (!config || !deployment) return null;

  const client = makeAzureOpenAIClient(config, deployment);

  const system = `You are a clinician-assist + patient-explain AI for medical reports.
Return STRICT JSON only. No markdown. No extra keys.
Do NOT diagnose. Do NOT claim certainty. Use ranked hypotheses with cautious language and confidence 0..1.
Avoid personal identifiers. Do not invent patient details.

Schema:
{
  "clinicianSummary": {
    "abnormalFindings": [{"text": string, "confidence": number|null}],
    "hypotheses": [{"text": string, "confidence": number|null}],
    "nextSteps": [{"text": string, "confidence": number|null}],
    "redFlags": [{"text": string, "confidence": number|null}],
    "disclaimer": string
  },
  "patientPlanDraft": {
    "plainSummary": string,
    "goals": string[],
    "actions": string[],
    "followUp": string[],
    "urgentRedFlags": string[],
    "disclaimer": string
  }
}

Constraints:
- Keep texts short and actionable.
- nextSteps can include tests/monitoring frequency suggestions as "consider" items, guideline-aligned when possible.
- Patient plan must be plain English and non-alarming unless clearly a red flag.
- If you are unsure, say "for clinician review".`;

  const user = `Medical report text (synthetic/anonymized):
${truncateForProcessing(cleanedText, 20_000)}

Extracted terms (for context):
${JSON.stringify(terms.slice(0, 18).map((t) => ({ term: t.term, translation: t.translation, typicalContext: t.typicalContext })))}

Extracted labs (for context):
${JSON.stringify(labs.slice(0, 30).map((l) => ({
  name: l.name,
  value: l.value,
  unit: l.unit,
  refLow: l.refLow,
  refHigh: l.refHigh,
  flag: l.flag
})))}

Condition hint (optional, may be empty): ${String(conditionHint ?? "")}

Return the JSON schema exactly.`;

  const completion = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content ?? "{}";
  const parsedJson = safeJsonParse(content);
  if (!parsedJson) return null;

  // Validate and then attach evidence from report text on server-side
  const Candidate = z.object({
    clinicianSummary: z.object({
      abnormalFindings: z.array(z.object({ text: z.string().min(1), confidence: z.number().min(0).max(1).nullable().optional() })).default([]),
      hypotheses: z.array(z.object({ text: z.string().min(1), confidence: z.number().min(0).max(1).nullable().optional() })).default([]),
      nextSteps: z.array(z.object({ text: z.string().min(1), confidence: z.number().min(0).max(1).nullable().optional() })).default([]),
      redFlags: z.array(z.object({ text: z.string().min(1), confidence: z.number().min(0).max(1).nullable().optional() })).default([]),
      disclaimer: z.string().default("Draft for clinician review; not a medical decision."),
    }),
    patientPlanDraft: z.object({
      plainSummary: z.string().min(1),
      goals: z.array(z.string()).default([]),
      actions: z.array(z.string()).default([]),
      followUp: z.array(z.string()).default([]),
      urgentRedFlags: z.array(z.string()).default([]),
      disclaimer: z.string().default("Informational only — not medical advice. Follow clinician guidance."),
    }),
  });

  const cand = Candidate.safeParse(parsedJson);
  if (!cand.success) return null;

  // attach evidence spans to clinician items
  const toFinding = (x: { text: string; confidence?: number | null }) => ({
    text: x.text,
    confidence: x.confidence ?? undefined,
    evidence: evidenceFromSearch(cleanedText, x.text),
  });

  const result = {
    clinicianSummary: {
      abnormalFindings: cand.data.clinicianSummary.abnormalFindings.slice(0, 10).map(toFinding),
      hypotheses: cand.data.clinicianSummary.hypotheses.slice(0, 8).map(toFinding),
      nextSteps: cand.data.clinicianSummary.nextSteps.slice(0, 10).map(toFinding),
      redFlags: cand.data.clinicianSummary.redFlags.slice(0, 8).map(toFinding),
      disclaimer: cand.data.clinicianSummary.disclaimer,
    },
    patientPlanDraft: {
      plainSummary: cand.data.patientPlanDraft.plainSummary,
      goals: cand.data.patientPlanDraft.goals.map((s) => String(s).trim()).filter(Boolean).slice(0, 8),
      actions: cand.data.patientPlanDraft.actions.map((s) => String(s).trim()).filter(Boolean).slice(0, 8),
      followUp: cand.data.patientPlanDraft.followUp.map((s) => String(s).trim()).filter(Boolean).slice(0, 6),
      urgentRedFlags: cand.data.patientPlanDraft.urgentRedFlags.map((s) => String(s).trim()).filter(Boolean).slice(0, 6),
      disclaimer: cand.data.patientPlanDraft.disclaimer,
    },
  };

  // Ensure final schemas
  const final = ReportAnalyzeResponseSchema.safeParse({
    ...result,
    labsTable: labs,
    diseaseProgress: diseaseProgressTable(conditionHint),
  });

  if (!final.success) return null;
  return final.data;
}

// ---------------- routes ----------------
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Privacy: POST /privacy/redact  { text }
 */
app.post(
  "/privacy/redact",
  asyncHandler(async (req, res) => {
    const Body = z.object({ text: z.string().min(1).max(20_000) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const { text } = parsed.data;
    req.log.info({ route: "/privacy/redact", textLen: text.length }, "redact");

    const { redacted, piiDetected } = await redactTextBestEffort(text);
    return res.json({ redacted, piiDetected });
  })
);

/**
 * Transcribe: POST /transcribe  (multipart: audio)
 */
app.post(
  "/transcribe",
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing audio file (field: audio)" });

    req.log.info({ route: "/transcribe", bytes: file.size, mime: file.mimetype }, "transcribe");

    const tmp = join(tmpdir(), `careloop-${randomUUID()}.wav`);
    await writeFile(tmp, file.buffer);

    try {
      const { transcript, segments } = await transcribeWithSegmentsWav(tmp);
      const trimmed = truncateForProcessing(transcript.trim(), MAX_TRANSCRIPT_CHARS);

      return res.json({
        transcript: trimmed,
        segments,
        warnings: transcript.length > MAX_TRANSCRIPT_CHARS ? ["Transcript truncated for processing."] : [],
      });
    } finally {
      await unlink(tmp).catch(() => {});
    }
  })
);

/**
 * Clinician: POST /clinician/soap
 */
app.post(
  "/clinician/soap",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      transcript: z.string().min(1).max(200_000),
      segments: z.array(SegmentSchema).optional(),
      enforceRedaction: z.boolean().optional(),
      enforceOutputSafety: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    let { transcript, segments } = parsed.data;
    const enforceRedaction = parsed.data.enforceRedaction ?? DEFAULT_ENFORCE_REDACTION;
    const enforceOutputSafety = parsed.data.enforceOutputSafety ?? true;

    transcript = truncateForProcessing(transcript.trim(), MAX_TRANSCRIPT_CHARS);

    req.log.info({ route: "/clinician/soap", textLen: transcript.length }, "soap");

    let piiDetectedInput = false;
    if (enforceRedaction) {
      const { piiDetected } = await redactTextBestEffort(transcript);
      piiDetectedInput = piiDetected;
      if (piiDetected) {
        return res.status(400).json({
          error: "PII detected. Please redact before generating SOAP.",
          code: "PII_DETECTED",
        });
      }
    }

    const config = getAzureOpenAIConfig();
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "";
    let soapObj: unknown;
    let warnings: string[] = [];

    if (!config || !deployment) {
      warnings.push("Azure OpenAI not configured; using mock SOAP generator.");
      soapObj = mockSoap(transcript);
    } else {
      const client = makeAzureOpenAIClient(config, deployment);

      const system = `You are a clinical documentation assistant.
Return a STRICT JSON object only (no markdown, no extra keys).
Schema:
{
  "subjective": string[]|string,
  "objective": string[]|string,
  "assessment": string[]|string,
  "plan": string[]|string
}
Rules:
- Use cautious language (informational, not definitive diagnosis).
- Prefer concise bullet-like lines.
- Do NOT include any personally identifying info.
- If unsure, include it as a note for clinician review in the appropriate section.`;

      const user = `Transcript (synthetic/anonymized):\n${transcript}`;

      const completion = await client.chat.completions.create({
        model: deployment,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const content = completion.choices[0]?.message?.content ?? "{}";
      const parsedJson = safeJsonParse(content);
      if (!parsedJson) {
        warnings.push("Model returned non-JSON output; falling back to mock SOAP.");
        soapObj = mockSoap(transcript);
      } else {
        soapObj = parsedJson;
      }
    }

    const soapParsed = SoapSchema.safeParse(soapObj);
    if (!soapParsed.success) {
      return res.status(502).json({ error: "SOAP schema mismatch from generator" });
    }

    const soap = soapParsed.data;

    const safeSegments = segments?.length ? z.array(SegmentSchema).safeParse(segments).data : undefined;
    const evidence =
      soap.evidence?.length
        ? soap.evidence
        : safeSegments?.length
          ? buildEvidenceFromSegments(soap, safeSegments)
          : buildEvidenceFromSearch(transcript, soap);

    const entities = await extractHealthcareEntitiesBestEffort(transcript);
    if (!entities) warnings.push("Healthcare entity extraction unavailable or not configured.");

    let piiDetectedOutput = false;
    let responsePayload: any = {
      ...soap,
      evidence,
      entities,
      warnings: warnings.length ? warnings : undefined,
      trust: {
        ...computeTrustFromEvidence(evidence),
        piiDetectedInput,
      },
    };

    if (enforceOutputSafety && OUTPUT_PII_MODE !== "off") {
      const { redacted, piiDetected } = await redactStringsBestEffort(responsePayload);
      piiDetectedOutput = piiDetected;

      if (piiDetectedOutput && OUTPUT_PII_MODE === "block") {
        return res.status(400).json({
          error: "PII detected in generated output. Please adjust input and try again.",
          code: "PII_DETECTED_OUTPUT",
        });
      }

      responsePayload = redacted;
      responsePayload.trust = {
        ...(responsePayload.trust ?? {}),
        piiDetectedOutput,
      };
    }

    return res.json(responsePayload);
  })
);

/**
 * Patient diary: POST /diary/trends
 */
app.post(
  "/diary/trends",
  asyncHandler(async (req, res) => {
    const Body = z.object({ diary: z.array(DiaryEntrySchema).max(365) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const diary = normalizeDiary(parsed.data.diary);

    const trend = diary.map((e) => ({
      date: e.date,
      symptomScore: e.symptomScore,
      sleepHours: e.sleepHours,
      moodScore: e.moodScore,
    }));

    req.log.info({ route: "/diary/trends", count: trend.length }, "trends");
    return res.json({ trend });
  })
);

/**
 * Patient diary: POST /diary/summarize
 */
app.post(
  "/diary/summarize",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      diary: z.array(DiaryEntrySchema).max(365),
      enforceRedaction: z.boolean().optional(),
      enforceOutputSafety: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const enforceRedaction = parsed.data.enforceRedaction ?? DEFAULT_ENFORCE_REDACTION;
    const enforceOutputSafety = parsed.data.enforceOutputSafety ?? true;

    const diary = normalizeDiary(parsed.data.diary);
    req.log.info({ route: "/diary/summarize", count: diary.length }, "summarize");

    if (!diary.length) {
      const empty = deterministicDiarySummary(diary);
      return res.json({ summary: empty });
    }

    let piiDetectedInput = false;
    if (enforceRedaction) {
      const allNotes = diary
        .map((e) => e.notes ?? "")
        .filter(Boolean)
        .join("\n")
        .slice(0, 20_000);

      if (allNotes) {
        const { piiDetected } = await redactTextBestEffort(allNotes);
        piiDetectedInput = piiDetected;
        if (piiDetected) {
          return res.status(400).json({
            error: "PII detected in diary notes. Please redact before generating a summary.",
            code: "PII_DETECTED",
          });
        }
      }
    }

    let warnings: string[] = [];
    let mode: "llm" | "deterministic" = "deterministic";

    let summary: DiarySummary | null = null;

    try {
      const s = await llmDiarySummary(diary);
      if (s) {
        summary = s;
        mode = "llm";
      } else {
        warnings.push("Model summary unavailable; falling back to deterministic summary.");
      }
    } catch {
      warnings.push("Model summary failed; falling back to deterministic summary.");
    }

    if (!summary) summary = deterministicDiarySummary(diary);

    const evidence = buildDiaryEvidence(summary, diary);
    const trustCore = computeTrustFromEvidence(evidence);

    summary.evidence = evidence;
    summary.trust = {
      scorePct: trustCore.scorePct,
      verified: trustCore.verified,
      unverified: trustCore.unverified,
      piiDetectedInput,
      mode,
    };

    let piiDetectedOutput = false;

    if (enforceOutputSafety && OUTPUT_PII_MODE !== "off") {
      const { redacted, piiDetected } = await redactStringsBestEffort(summary as any);
      piiDetectedOutput = piiDetected;

      if (piiDetectedOutput && OUTPUT_PII_MODE === "block") {
        return res.status(400).json({
          error: "PII detected in generated output. Please adjust diary content and try again.",
          code: "PII_DETECTED_OUTPUT",
        });
      }

      summary = redacted as DiarySummary;
      summary.trust = {
        ...(summary.trust ?? trustCore),
        piiDetectedOutput,
        mode,
        piiDetectedInput,
      };
    }

    const finalParsed = DiarySummarySchema.safeParse(summary);
    if (!finalParsed.success) {
      return res.status(502).json({ error: "Diary summary schema mismatch" });
    }

    return res.json({
      summary: finalParsed.data,
      warnings: warnings.length ? warnings : undefined,
    });
  })
);

// ---------------- NEW: Medical Report Interpreter routes ----------------

/**
 * Report ingest: POST /report/ingest
 * Body:
 *  {
 *    text: string,
 *    enforceRedaction?: boolean,
 *    enforceOutputSafety?: boolean
 *  }
 *
 * Returns:
 *  { cleanedText, sections, terms, labs, warnings?, trust? }
 */
app.post(
  "/report/ingest",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      text: z.string().min(1).max(500_000),
      enforceRedaction: z.boolean().optional(),
      enforceOutputSafety: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const enforceRedaction = parsed.data.enforceRedaction ?? DEFAULT_ENFORCE_REDACTION;
    const enforceOutputSafety = parsed.data.enforceOutputSafety ?? true;

    let text = truncateForProcessing(String(parsed.data.text ?? ""), REPORT_MAX_CHARS);
    text = normalizeWhitespace(text);

    req.log.info({ route: "/report/ingest", textLen: text.length }, "report_ingest");

    let piiDetectedInput = false;
    if (enforceRedaction) {
      const { piiDetected } = await redactTextBestEffort(text.slice(0, 20_000));
      piiDetectedInput = piiDetected;
      if (piiDetected) {
        return res.status(400).json({
          error: "PII detected in report text. Please redact before ingesting.",
          code: "PII_DETECTED",
        });
      }
    }

    const warnings: string[] = [];
    if (String(parsed.data.text ?? "").length > REPORT_MAX_CHARS) warnings.push("Report text truncated for processing.");

    // Entities can help term detection
    const entities = await extractHealthcareEntitiesBestEffort(text);
    if (!entities) warnings.push("Healthcare entity extraction unavailable or not configured.");

    const candidates = detectCandidateTerms(text, entities);
    const llmMap = await explainTermsWithLLM(candidates).catch(() => null);

    const terms: ReportTerm[] = candidates.map((c) => {
      const norm = normalizeTermKey(c.normalized);
      const fb = TERM_FALLBACK[norm] ?? TERM_FALLBACK[normalizeTermKey(c.term)];
      const llm = llmMap?.get(norm);

      const translation = llm?.translation ?? fb?.translation ?? "medical term";
      const explanation = llm?.explanation ?? fb?.explanation ?? "A medical term used in clinical reports.";
      const typicalContext = llm?.typicalContext ?? fb?.typicalContext ?? "general";
      const whyItMatters = llm?.whyItMatters ?? fb?.whyItMatters ?? "Helps interpret findings in context.";

      const refsKey =
        fb?.refsKey ??
        (typicalContext === "imaging" ? "imaging" : typicalContext === "diagnosis" ? "general" : "general");

      const references = AUTHORITATIVE_SOURCES[refsKey]?.slice(0, 2) ?? AUTHORITATIVE_SOURCES.general;

      return {
        term: c.term,
        normalized: norm,
        translation,
        explanation,
        typicalContext,
        whyItMatters,
        references,
        verified: Boolean(llm || fb),
      };
    });

    const termsWithOffsets = attachOffsetsForTerms(text, terms);

    const labs = parseLabsFromText(text);

    const sections = splitReportSections(text);

    let payload: any = {
      cleanedText: text,
      sections,
      terms: termsWithOffsets,
      labs,
      warnings: warnings.length ? warnings : undefined,
      trust: {
        ...computeTrustFromEvidence([
          ...termsWithOffsets.map((t) => ({ verified: t.verified })),
          ...labs.map((l) => ({ verified: l.verified })),
        ]),
        piiDetectedInput,
        mode: llmMap ? "llm" : "deterministic",
      },
    };

    // Output safety (redact/block)
    if (enforceOutputSafety && OUTPUT_PII_MODE !== "off") {
      const { redacted, piiDetected } = await redactStringsBestEffort(payload);
      if (piiDetected && OUTPUT_PII_MODE === "block") {
        return res.status(400).json({
          error: "PII detected in generated output. Please adjust input and try again.",
          code: "PII_DETECTED_OUTPUT",
        });
      }
      payload = redacted;
      payload.trust = { ...(payload.trust ?? {}), piiDetectedOutput: piiDetected };
    }

    const finalParsed = ReportIngestResponseSchema.safeParse(payload);
    if (!finalParsed.success) return res.status(502).json({ error: "Report ingest schema mismatch" });

    return res.json(finalParsed.data);
  })
);

/**
 * Report analyze: POST /report/analyze
 * Body:
 *  {
 *    cleanedText: string,
 *    terms?: ReportTerm[],
 *    labs?: ReportLab[],
 *    conditionHint?: string,
 *    enforceOutputSafety?: boolean
 *  }
 *
 * Returns:
 *  { clinicianSummary, patientPlanDraft, labsTable, diseaseProgress?, warnings?, trust? }
 */
app.post(
  "/report/analyze",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      cleanedText: z.string().min(1).max(500_000),
      terms: z.array(ReportTermSchema).optional(),
      labs: z.array(ReportLabSchema).optional(),
      conditionHint: z.string().optional(),
      enforceOutputSafety: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const enforceOutputSafety = parsed.data.enforceOutputSafety ?? true;

    const cleanedText = truncateForProcessing(normalizeWhitespace(parsed.data.cleanedText), REPORT_MAX_CHARS);
    const terms = (parsed.data.terms ?? []).slice(0, 60);
    const labs = (parsed.data.labs ?? parseLabsFromText(cleanedText)).slice(0, 80);
    const conditionHint = parsed.data.conditionHint;

    req.log.info({ route: "/report/analyze", textLen: cleanedText.length, labs: labs.length, terms: terms.length }, "report_analyze");

    const warnings: string[] = [];
    if (parsed.data.cleanedText.length > REPORT_MAX_CHARS) warnings.push("Report text truncated for analysis.");

    // Prefer LLM, fallback deterministic
    let analyzed: z.infer<typeof ReportAnalyzeResponseSchema> | null = null;

    try {
      analyzed = await llmReportAnalyze(cleanedText, terms, labs, conditionHint);
      if (!analyzed) warnings.push("Model analysis unavailable; used deterministic analysis.");
    } catch {
      warnings.push("Model analysis failed; used deterministic analysis.");
    }

    if (!analyzed) {
      const det = await deterministicReportAnalyze(cleanedText, labs);
      analyzed = {
        clinicianSummary: PhysicianSupportSummarySchema.parse(det.clinicianSummary),
        patientPlanDraft: PatientPlanSchema.parse(det.patientPlanDraft),
        labsTable: labs,
        diseaseProgress: diseaseProgressTable(conditionHint),
        warnings: undefined,
        trust: undefined,
      };
    }

    // Trust: percent of clinician items with verified evidence spans
    const evidenceItems = [
      ...analyzed.clinicianSummary.abnormalFindings,
      ...analyzed.clinicianSummary.hypotheses,
      ...analyzed.clinicianSummary.nextSteps,
      ...analyzed.clinicianSummary.redFlags,
    ];
    const evidenceFlat = evidenceItems.flatMap((x) => (x.evidence ?? []).map((e) => ({ verified: e.verified })));
    const trustCore = computeTrustFromEvidence(evidenceFlat.length ? evidenceFlat : [{ verified: false }]);

    let payload: any = {
      ...analyzed,
      warnings: warnings.length ? warnings : analyzed.warnings,
      trust: {
        ...trustCore,
        mode: getAzureOpenAIConfig() ? "llm" : "deterministic",
      },
    };

    if (enforceOutputSafety && OUTPUT_PII_MODE !== "off") {
      const { redacted, piiDetected } = await redactStringsBestEffort(payload);
      if (piiDetected && OUTPUT_PII_MODE === "block") {
        return res.status(400).json({
          error: "PII detected in generated output. Please adjust input and try again.",
          code: "PII_DETECTED_OUTPUT",
        });
      }
      payload = redacted;
      payload.trust = { ...(payload.trust ?? {}), piiDetectedOutput: piiDetected };
    }

    const finalParsed = ReportAnalyzeResponseSchema.safeParse(payload);
    if (!finalParsed.success) return res.status(502).json({ error: "Report analyze schema mismatch" });

    return res.json(finalParsed.data);
  })
);

/**
 * Report approve: POST /report/approve
 * Minimal server-side “approval gate”.
 * Body:
 *  {
 *    patientPlanDraft: PatientPlan,
 *    clinicianEdits?: PatientPlan,
 *    approved: boolean
 *  }
 *
 * Returns:
 *  { patientPlanApproved, approvedAt }
 */
app.post(
  "/report/approve",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      patientPlanDraft: PatientPlanSchema,
      clinicianEdits: PatientPlanSchema.optional(),
      approved: z.boolean(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    req.log.info({ route: "/report/approve", approved: parsed.data.approved }, "report_approve");

    if (!parsed.data.approved) {
      return res.status(400).json({ error: "Plan not approved.", code: "NOT_APPROVED" });
    }

    const plan = parsed.data.clinicianEdits ?? parsed.data.patientPlanDraft;

    // Optional output redaction
    let payload: any = { patientPlanApproved: plan, approvedAt: new Date().toISOString() };
    if (OUTPUT_PII_MODE !== "off") {
      const { redacted } = await redactStringsBestEffort(payload);
      payload = redacted;
    }

    return res.json(payload);
  })
);

// ---------------- error handler (sanitized) ----------------
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err?.statusCode ?? err?.status ?? 500);

  req.log.error(
    {
      route: req.path,
      status,
      errName: err?.name,
      errMessage: typeof err?.message === "string" ? err.message.slice(0, 200) : "error",
    },
    "request failed"
  );

  const publicMsg = status >= 500 ? "Internal error" : "Request failed";
  res.status(status).json({ error: publicMsg });
});

// ---------------- start ----------------
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  log.info(
    {
      port,
      openai: Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY),
      speech: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
      textAnalytics: Boolean(process.env.AZURE_LANGUAGE_ENDPOINT && process.env.AZURE_LANGUAGE_KEY),
      outputPiiMode: OUTPUT_PII_MODE,
      defaultEnforceRedaction: DEFAULT_ENFORCE_REDACTION,
      diaryMaxEntries: DIARY_SUMMARY_MAX_ENTRIES,
      reportMaxChars: REPORT_MAX_CHARS,
    },
    "careloop api listening"
  );
});
