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
    // headers can carry tokens; never log them
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

// security headers
app.use(
  helmet({
    // keep defaults; demo-friendly
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// CORS: open by default for hackathon; can be locked down with CORS_ORIGINS
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / same-origin
      if (!allowedOrigins.length) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  })
);

// prevent caching sensitive-ish demo responses
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(express.json({ limit: "2mb" }));

app.use(
  pinoHttp({
    logger: log,
    genReqId: () => randomUUID(),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    // do not serialize body/query (PHI risk)
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
  // optional: separate deployment for diary
  AZURE_OPENAI_DIARY_DEPLOYMENT: z.string().min(1).optional(),
  // optional: separate deployment for reports
  AZURE_OPENAI_REPORT_DEPLOYMENT: z.string().min(1).optional(),

  AZURE_SPEECH_KEY: z.string().min(1).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),
  AZURE_SPEECH_LANG: z.string().min(2).optional(),

  AZURE_LANGUAGE_ENDPOINT: z.string().url().optional(),
  AZURE_LANGUAGE_KEY: z.string().min(1).optional(),

  // optional
  MAX_TRANSCRIPT_CHARS: z.string().optional(),
  MAX_REPORT_CHARS: z.string().optional(),
  REPORT_TERMS_MAX: z.string().optional(),
  REPORT_LABS_MAX: z.string().optional(),

  // Safety/quality knobs
  OUTPUT_PII_MODE: z.enum(["redact", "block", "off"]).optional(), // default: redact
  DEFAULT_ENFORCE_REDACTION: z.enum(["true", "false"]).optional(), // default: false
  DIARY_SUMMARY_MAX_ENTRIES: z.string().optional(), // default: 30
  DIARY_NOTES_MAX_CHARS: z.string().optional(), // default: 400
});

const SegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().min(1),
});

const EvidenceLinkSchema = z.object({
  section: z.enum(["subjective", "objective", "assessment", "plan"]),
  text: z.string().min(1), // soap line
  // either timestamp-based or char-span-based
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  snippet: z.string().optional(),
  verified: z.boolean().optional(), // quality gate: supported by evidence?
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
  // new (optional) UX boosters
  redFlags: z.array(z.string()).optional(),
  questionsForClinician: z.array(z.string()).optional(),
  // evidence + trust
  evidence: z.array(DiaryEvidenceItemSchema).optional(),
  trust: TrustSchema.optional(),
});

// ---------------- Report Interpreter schemas ----------------
const ReportTypeHintSchema = z.enum(["labs", "imaging", "discharge", "other"]).optional();

const SourceLinkSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
});

const EvidenceSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  snippet: z.string().min(1),
});

const ReportTermSchema = z.object({
  term: z.string().min(1),
  normalized: z.string().optional(),
  translation: z.string().optional(),
  category: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
  explanation: z.string().optional(), // minimal
  typicalContext: z.string().optional(), // labs / imaging / diagnosis
  whyItMatters: z.string().optional(), // one short sentence
  sources: z.array(SourceLinkSchema).optional(),
});

const LabReferenceRangeSchema = z.object({
  low: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
  text: z.string().optional(), // raw range text if present
  note: z.string().optional(), // caveats (age/sex/lab specific)
  source: z.string().url().optional(), // optional link
});

const LabValueSchema = z.object({
  name: z.string().min(1),
  nameNormalized: z.string().optional(),
  value: z.number().nullable().optional(),
  valueText: z.string().optional(), // for non-numeric values
  unit: z.string().optional(),
  flag: z.enum(["low", "normal", "high", "unknown"]).optional(),
  referenceRange: LabReferenceRangeSchema.optional(),
  evidence: EvidenceSpanSchema.optional(),
});

const ReportSectionSchema = z.object({
  title: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  snippet: z.string().min(1),
});

const ReportIngestResponseSchema = z.object({
  cleanedText: z.string().min(1),
  reportType: z.enum(["labs", "imaging", "discharge", "other"]),
  sections: z.array(ReportSectionSchema).default([]),
  terms: z.array(ReportTermSchema).default([]),
  labs: z.array(LabValueSchema).default([]),
  warnings: z.array(z.string()).optional(),
  trust: TrustSchema.optional(),
});

const ReportAnalyzeResponseSchema = z.object({
  clinicianSummary: z.object({
    abnormalFindings: z.array(z.string()).default([]),
    hypotheses: z.array(
      z.object({
        text: z.string().min(1),
        confidence: z.enum(["low", "medium", "high"]).default("low"),
        evidence: z.array(EvidenceSpanSchema).optional(),
      })
    ).default([]),
    nextSteps: z.array(z.string()).default([]),
    redFlags: z.array(z.string()).default([]),
    disclaimer: z.string().optional(),
  }),
  patientPlan: z.object({
    plainEnglish: z.array(z.string()).default([]),
    goalsToWatch: z.array(z.string()).default([]),
    actions: z.array(z.string()).default([]),
    whenToContactClinician: z.array(z.string()).default([]),
    disclaimer: z.string().optional(),
  }),
  derived: z.object({
    abnormalLabs: z.array(
      z.object({
        name: z.string(),
        valueText: z.string().optional(),
        unit: z.string().optional(),
        flag: z.enum(["low", "normal", "high", "unknown"]),
      })
    ).default([]),
  }),
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
type LabValue = z.infer<typeof LabValueSchema>;
type ReportIngestResponse = z.infer<typeof ReportIngestResponseSchema>;
type ReportAnalyzeResponse = z.infer<typeof ReportAnalyzeResponseSchema>;

// ---------------- helpers ----------------
const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  // safe: don't print env values
  log.warn(
    { issues: env.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    "env validation warning"
  );
}

const MAX_TRANSCRIPT_CHARS = Number(process.env.MAX_TRANSCRIPT_CHARS ?? 50_000);
const MAX_REPORT_CHARS = Number(process.env.MAX_REPORT_CHARS ?? 120_000);
const REPORT_TERMS_MAX = Math.max(1, Math.min(80, Number(process.env.REPORT_TERMS_MAX ?? 20)));
const REPORT_LABS_MAX = Math.max(1, Math.min(200, Number(process.env.REPORT_LABS_MAX ?? 60)));

const OUTPUT_PII_MODE = (process.env.OUTPUT_PII_MODE ?? "redact") as "redact" | "block" | "off";
const DEFAULT_ENFORCE_REDACTION = (process.env.DEFAULT_ENFORCE_REDACTION ?? "false") === "true";
const DIARY_SUMMARY_MAX_ENTRIES = Math.max(1, Math.min(365, Number(process.env.DIARY_SUMMARY_MAX_ENTRIES ?? 30)));
const DIARY_NOTES_MAX_CHARS = Math.max(0, Math.min(2000, Number(process.env.DIARY_NOTES_MAX_CHARS ?? 400)));

// Sentiment tracking knobs (optional)
const SENTIMENT_ENABLED = (process.env.SENTIMENT_ENABLED ?? "true") !== "false";
const SENTIMENT_DOC_MAX_CHARS = Math.max(200, Math.min(20_000, Number(process.env.SENTIMENT_MAX_CHARS ?? 4000)));
// Azure Text Analytics request doc limit can be strict; 10 is a safe default
const SENTIMENT_BATCH_SIZE = Math.max(1, Math.min(10, Number(process.env.SENTIMENT_BATCH_SIZE ?? 10)));

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function mean(nums: number[]) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function primaryLangTag(lang?: string) {
  const raw = String(lang ?? "").trim();
  if (!raw) return "en";
  // "hu-HU" -> "hu", "en-US" -> "en"
  const tag = raw.split(/[-_]/)[0]?.toLowerCase();
  return tag || "en";
}

// Memoize clients (cheap + avoids re-instantiation per request)
let _azureOpenAI: ReturnType<typeof makeAzureOpenAI> | null | undefined;
function makeAzureOpenAI() {
  if (_azureOpenAI !== undefined) return _azureOpenAI;

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-15-preview";
  if (!endpoint || !apiKey || !deployment) {
    _azureOpenAI = null;
    return _azureOpenAI;
  }

  const baseURL = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}`;
  _azureOpenAI = {
    client: new OpenAI({
      apiKey,
      baseURL,
      defaultQuery: { "api-version": apiVersion },
      defaultHeaders: { "api-key": apiKey },
    }),
    deployment,
  };

  return _azureOpenAI;
}

let _textAnalytics: TextAnalyticsClient | null | undefined;
function makeTextAnalytics() {
  if (_textAnalytics !== undefined) return _textAnalytics;

  const endpoint = process.env.AZURE_LANGUAGE_ENDPOINT;
  const key = process.env.AZURE_LANGUAGE_KEY;
  if (!endpoint || !key) {
    _textAnalytics = null;
    return _textAnalytics;
  }

  _textAnalytics = new TextAnalyticsClient(endpoint, new AzureKeyCredential(key));
  return _textAnalytics;
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

function truncateNote(note: string, maxChars: number) {
  const t = String(note ?? "").replace(/\s+/g, " ").trim();
  if (!maxChars) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "…";
}

function normalizeKey(s: string) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\/%μµ.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Sentiment (best effort) ----
type SentimentOut = {
  label: "positive" | "neutral" | "negative" | "mixed";
  scores: { positive: number; neutral: number; negative: number };
  // chart-friendly: ~[-1..+1]
  compound: number;
};

async function analyzeSentimentBatchBestEffort(texts: string[]): Promise<Array<SentimentOut | null>> {
  if (!SENTIMENT_ENABLED) return texts.map(() => null);

  const ta = makeTextAnalytics();
  if (!ta) return texts.map(() => null);

  const lang = primaryLangTag(process.env.SENTIMENT_LANGUAGE ?? process.env.AZURE_SPEECH_LANG);

  // Prebuild docs; keep track of indices; skip empty docs => null
  const docsAll: Array<{ id: string; text: string; language: string; idx: number }> = [];
  const out: Array<SentimentOut | null> = Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i] ?? "").trim();
    if (!t) continue;
    docsAll.push({
      id: String(docsAll.length), // local id per batch flow
      text: truncateForProcessing(t, SENTIMENT_DOC_MAX_CHARS),
      language: lang,
      idx: i,
    });
  }

  // Chunk to avoid service doc-count limits
  for (let start = 0; start < docsAll.length; start += SENTIMENT_BATCH_SIZE) {
    const chunk = docsAll.slice(start, start + SENTIMENT_BATCH_SIZE);
    try {
      const results = await ta.analyzeSentiment(
        chunk.map((d) => ({ id: d.id, text: d.text, language: d.language }))
      );

      const idxById = new Map(chunk.map((d) => [d.id, d.idx] as const));

      for (const r of results) {
        if ((r as any).error) continue;

        const s = r.confidenceScores;
        const compound = clamp((s.positive ?? 0) - (s.negative ?? 0), -1, 1);

        const i = idxById.get(String(r.id));
        if (i == null) continue;

        out[i] = {
          label: r.sentiment,
          scores: {
            positive: s.positive ?? 0,
            neutral: s.neutral ?? 0,
            negative: s.negative ?? 0,
          },
          compound,
        };
      }
    } catch {
      // best effort: keep nulls for this chunk
    }
  }

  return out;
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

// very simple keyword overlap score for evidence matching
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

      // quality gate: require at least some overlap
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

      // fallback: keyword search
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
 * Uses Detailed output JSON (NBest/W words offsets).
 *
 * Notes:
 * - WAV is the most stable format with the Node Speech SDK in hackathon settings.
 * - Returns best-effort segments (phrase-level). Frontend can ignore segments if not needed.
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

  // continuous recognition to capture more than a single phrase
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

      // parse detailed JSON result for offsets
      const jsonStr =
        e.result.properties?.getProperty(speechsdk.PropertyId.SpeechServiceResponse_JsonResult) ?? "";
      const json = jsonStr ? safeJsonParse(jsonStr) : null;

      // best effort: use NBest[0].Words to compute start/end
      try {
        const nbest = (json as any)?.NBest?.[0];
        const words = nbest?.Words as Array<{ Offset: number; Duration: number; Word: string }> | undefined;

        // Speech offsets are in 100-nanosecond units
        if (words && words.length) {
          const first = words[0];
          const last = words[words.length - 1];
          const startMs = Math.max(0, Math.round(first.Offset / 10_000));
          const endMs = Math.max(startMs, Math.round((last.Offset + last.Duration) / 10_000));
          if (text) segments.push({ startMs, endMs, text });
        } else if (text) {
          // fallback segment (no timestamps)
          segments.push({ startMs: 0, endMs: 0, text });
        }
      } catch {
        // ignore parse issues; keep transcript text only
      }
    };

    recognizer.canceled = (_s, e) => {
      const details = e?.errorDetails ? String(e.errorDetails).slice(0, 200) : "canceled";
      // do not log content, only error details
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

  // fallback regex (demo)
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

  // If the resource doesn't have the healthcare feature enabled, this can throw.
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
    return out.slice(0, 250);
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

// ---------------- Diary helpers ----------------
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
  // gentle, non-diagnostic heuristics
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
      ? [
          "Keep logging meals/sleep alongside symptoms.",
          "If symptoms worsen or feel unsafe, consider contacting a clinician.",
        ]
      : [],
    last7DaysAvgSymptom: avgSym,
    redFlags: diary.length ? redFlags.slice(0, 5) : [],
    questionsForClinician: diary.length ? questions.slice(0, 5) : [],
  };
}

async function llmDiarySummary(diary: ReturnType<typeof normalizeDiary>, azure: ReturnType<typeof makeAzureOpenAI>) {
  if (!azure) return null;

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
  "bullets": string[],                 // max 6, short bullet lines
  "possibleTriggers": string[],        // max 5, single words/short phrases
  "gentleSuggestions": string[],       // max 5, non-medical, supportive, non-urgent suggestions
  "last7DaysAvgSymptom": number|null,  // may be null
  "redFlags": string[],                // max 5, cautious and non-diagnostic
  "questionsForClinician": string[]    // max 5, helpful clarifying questions
}
Rules:
- DO NOT diagnose. Use cautious, informational phrasing.
- DO NOT include personally identifying info (names, addresses, emails, phone numbers).
- Prefer trends, correlations, and what to ask/track next.
- If unsure, write items as "for clinician review".
- Keep triggers to short phrases (e.g., "stress", "late meals", "poor sleep").`;

  const user = `Diary entries (synthetic/anonymized). JSON array:
${JSON.stringify(diaryForModel)}
Context:
- last7DaysAvgSymptom (computed server-side): ${avgSym == null ? "null" : avgSym.toFixed(2)}
Return the JSON schema exactly.`;

  const deployment = process.env.AZURE_OPENAI_DIARY_DEPLOYMENT || azure.deployment;

  const completion = await azure.client.chat.completions.create({
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

  // Validate (soft): require keys, but allow optional in our server schema
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
    questionsForClinician: candidate.data.questionsForClinician
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 5),
  };

  return s;
}

// ---------------- Report Interpreter helpers ----------------

// Curated, safe “learn more” links (no network calls; just references)
function buildTrustedLinks(term: string, context: "labs" | "imaging" | "discharge" | "other") {
  const q = encodeURIComponent(term);
  const links: Array<{ label: string; url: string }> = [
    { label: "MedlinePlus (NLM)", url: `https://medlineplus.gov/search.html?query=${q}` },
  ];

  if (context === "labs") {
    links.unshift({ label: "MedlinePlus Lab Tests", url: `https://medlineplus.gov/lab-tests/` });
  }
  if (context === "imaging") {
    links.unshift({ label: "RadiologyInfo.org (ACR/RSNA)", url: `https://www.radiologyinfo.org/en/info.cfm?pg=search&search=${q}` });
  }

  return links;
}

// Common Latin/medical phrases: fast “tap-to-explain” without calling the LLM.
const LATIN_TERM_MAP: Record<
  string,
  { translation: string; explanation: string; typicalContext: string; whyItMatters: string }
> = {
  "status post": {
    translation: "after (a procedure/event)",
    explanation: "Indicates a past surgery, injury, or medical event already happened.",
    typicalContext: "history / diagnosis",
    whyItMatters: "Past events can change what findings mean today.",
  },
  "s/p": {
    translation: "after (a procedure/event)",
    explanation: "Short form of 'status post'—something occurred in the past.",
    typicalContext: "history / diagnosis",
    whyItMatters: "Signals prior interventions that may explain current findings.",
  },
  "fractura": {
    translation: "fracture",
    explanation: "A break in a bone.",
    typicalContext: "imaging",
    whyItMatters: "May require immobilization or follow-up imaging depending on severity.",
  },
  "stenosis": {
    translation: "narrowing",
    explanation: "A narrowed area (often a blood vessel, valve, or spinal canal).",
    typicalContext: "imaging",
    whyItMatters: "Narrowing can reduce flow or compress structures, depending on location.",
  },
  "benignus": {
    translation: "benign (non-cancerous)",
    explanation: "Describes a finding that is not cancer.",
    typicalContext: "pathology / imaging",
    whyItMatters: "Usually changes urgency and follow-up compared to malignant findings.",
  },
  "malignus": {
    translation: "malignant (cancerous)",
    explanation: "Describes a cancerous finding.",
    typicalContext: "pathology / imaging",
    whyItMatters: "Often requires specialist follow-up and further work-up.",
  },
  "in situ": {
    translation: "in place",
    explanation: "Describes something located where it normally originates.",
    typicalContext: "pathology",
    whyItMatters: "May affect staging and treatment decisions (clinician-led).",
  },
};

function findAllOccurrences(haystack: string, needle: string) {
  const out: Array<{ start: number; end: number }> = [];
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let idx = 0;
  while (idx >= 0) {
    idx = h.indexOf(n, idx);
    if (idx < 0) break;
    out.push({ start: idx, end: idx + n.length });
    idx = idx + n.length;
  }
  return out;
}

function splitReportSections(text: string): Array<{ title: string; start: number; end: number; snippet: string }> {
  const t = text;
  const lines = t.split(/\r?\n/);

  // Heuristic headings: ALL CAPS or ends with ":" and short
  const headingRe = /^[A-Z][A-Z0-9\s\/()-]{2,60}:?$/;
  const candidates: Array<{ title: string; charIndex: number }> = [];

  let charPos = 0;
  for (const line of lines) {
    const raw = line;
    const trimmed = raw.trim();
    const isHeading = trimmed.length >= 3 && trimmed.length <= 60 && headingRe.test(trimmed.replace(/:+$/, ""));
    if (isHeading) {
      candidates.push({ title: trimmed.replace(/:+$/, ""), charIndex: charPos });
    }
    charPos += raw.length + 1; // + newline
  }

  if (!candidates.length) {
    return [
      {
        title: "Report",
        start: 0,
        end: Math.min(t.length, 800),
        snippet: t.slice(0, Math.min(t.length, 800)).trim() || "Report",
      },
    ];
  }

  const out: Array<{ title: string; start: number; end: number; snippet: string }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const cur = candidates[i];
    const next = candidates[i + 1];
    const start = cur.charIndex;
    const end = next ? next.charIndex : t.length;
    const snippet = t.slice(start, Math.min(end, start + 900)).trim();
    out.push({
      title: cur.title,
      start,
      end,
      snippet: snippet || cur.title,
    });
  }
  return out.slice(0, 12);
}

type RangeInfo = { low?: number | null; high?: number | null; unit?: string; note?: string };

// “Typical adult” reference ranges (demo-safe; not lab-specific)
const TYPICAL_LAB_RANGES: Record<string, RangeInfo> = {
  // Metabolic / glucose
  glucose: { low: 70, high: 99, unit: "mg/dL", note: "Typical fasting reference range; varies by lab and context." },
  hba1c: { low: 4.0, high: 5.6, unit: "%", note: "Typical non-diabetic range; targets vary by clinical context." },

  // Lipids
  ldl: { low: null, high: 100, unit: "mg/dL", note: "Targets depend on cardiovascular risk; clinician-guided." },
  hdl: { low: 40, high: null, unit: "mg/dL", note: "Higher is generally better; ranges vary by sex and lab." },
  triglycerides: { low: null, high: 150, unit: "mg/dL", note: "Fasting status affects results." },
  total: { low: null, high: 200, unit: "mg/dL", note: "Interpretation depends on overall risk profile." },

  // Inflammation
  crp: { low: 0, high: 10, unit: "mg/L", note: "Many labs use different cutoffs; clinical context matters." },

  // Thyroid
  tsh: { low: 0.4, high: 4.0, unit: "mIU/L", note: "Ranges vary by lab, age, pregnancy status." },

  // Liver
  alt: { low: 7, high: 56, unit: "U/L", note: "Ranges vary by lab and sex." },
  ast: { low: 10, high: 40, unit: "U/L", note: "Ranges vary by lab and sex." },

  // Kidney
  creatinine: { low: 0.6, high: 1.3, unit: "mg/dL", note: "Ranges vary by sex/muscle mass; eGFR preferred clinically." },

  // Blood count
  hemoglobin: { low: 12.0, high: 17.5, unit: "g/dL", note: "Ranges vary by sex, altitude, lab." },
  wbc: { low: 4.0, high: 11.0, unit: "×10^9/L", note: "Typical adult range; varies by lab." },
  platelets: { low: 150, high: 450, unit: "×10^9/L", note: "Typical adult range; varies by lab." },
};

function normalizeLabName(name: string) {
  const k = normalizeKey(name);
  // common aliases
  if (k.includes("hb a1c") || k.includes("hba1c") || k.includes("glycated hemoglobin")) return "hba1c";
  if (k === "ldl" || k.includes("ldl cholesterol")) return "ldl";
  if (k === "hdl" || k.includes("hdl cholesterol")) return "hdl";
  if (k.includes("triglycer")) return "triglycerides";
  if (k.includes("total cholesterol") || k === "cholesterol") return "total cholesterol";
  if (k === "crp" || k.includes("c-reactive")) return "crp";
  if (k === "tsh" || k.includes("thyroid stimulating")) return "tsh";
  if (k === "alt" || k.includes("alanine aminotransferase")) return "alt";
  if (k === "ast" || k.includes("aspartate aminotransferase")) return "ast";
  if (k.includes("creatinine")) return "creatinine";
  if (k.includes("hemoglobin") || k === "hgb" || k === "hb") return "hemoglobin";
  if (k === "wbc" || k.includes("white blood")) return "wbc";
  if (k.includes("platelet") || k === "plt") return "platelets";
  if (k.includes("glucose")) return "glucose";
  return k;
}

function computeLabFlag(value: number | null | undefined, range?: RangeInfo) {
  if (value == null || !range) return "unknown" as const;
  const lo = typeof range.low === "number" ? range.low : null;
  const hi = typeof range.high === "number" ? range.high : null;
  if (lo != null && value < lo) return "low" as const;
  if (hi != null && value > hi) return "high" as const;
  if (lo != null || hi != null) return "normal" as const;
  return "unknown" as const;
}

function extractLabsFromText(text: string, max: number): LabValue[] {
  const out: LabValue[] = [];

  // Split lines, but also catch inline “Name: value unit (range)”
  const lines = text.split(/\r?\n/);
  let charPos = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const start = charPos;
    const end = start + rawLine.length;
    charPos += rawLine.length + 1;

    if (!line) continue;
    if (line.length > 180) continue; // skip long narrative lines

    // Find first number-ish occurrence
    const numMatch = line.match(/([<>]?\s*-?\d+(?:\.\d+)?)/);
    if (!numMatch) continue;

    const numStr = numMatch[1].replace(/\s+/g, "");
    const value = Number(numStr.replace(/[<>]/g, ""));
    const valueIsNumber = Number.isFinite(value);

    // Name = left side before first number
    const idx = numMatch.index ?? -1;
    if (idx < 1) continue;
    let name = line.slice(0, idx).replace(/[:=]+$/, "").trim();
    name = name.replace(/\s{2,}/g, " ");
    if (name.length < 2) continue;

    // Unit = token right after the number (letters, %, /, μ/µ)
    const after = line.slice(idx + numMatch[0].length).trim();
    const unitMatch = after.match(/^([a-zA-Z/%μµ×\^0-9.\-]+)\b/);
    const unit = unitMatch?.[1];

    // Range: (low - high) or "ref: low-high"
    let low: number | null | undefined = undefined;
    let high: number | null | undefined = undefined;
    let rangeText: string | undefined;

    const parenRange = line.match(/\(([^)]+)\)/);
    if (parenRange?.[1]) {
      rangeText = parenRange[1].trim();
      const m = rangeText.match(/(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)/);
      if (m) {
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        if (Number.isFinite(lo)) low = lo;
        if (Number.isFinite(hi)) high = hi;
      }
    } else {
      const ref = line.match(/ref(?:erence)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)/i);
      if (ref) {
        rangeText = ref[0];
        const lo = Number(ref[1]);
        const hi = Number(ref[2]);
        if (Number.isFinite(lo)) low = lo;
        if (Number.isFinite(hi)) high = hi;
      }
    }

    const nameNormalized = normalizeLabName(name);
    const typical = TYPICAL_LAB_RANGES[nameNormalized];

    // If report didn't include a range, attach a typical range (demo-safe) when known
    const range: RangeInfo | undefined =
      low != null || high != null
        ? { low, high, unit: unit ?? typical?.unit, note: "Reference range from report (may be lab-specific)." }
        : typical
          ? typical
          : undefined;

    const flag = valueIsNumber ? computeLabFlag(value, range) : ("unknown" as const);

    out.push({
      name,
      nameNormalized,
      value: valueIsNumber ? value : null,
      valueText: valueIsNumber ? undefined : numStr,
      unit: unit ?? range?.unit,
      flag,
      referenceRange: range
        ? {
            low: range.low ?? null,
            high: range.high ?? null,
            text: rangeText,
            note: range.note,
            source:
              nameNormalized && TYPICAL_LAB_RANGES[nameNormalized] && !(low != null || high != null)
                ? "https://medlineplus.gov/lab-tests/"
                : undefined,
          }
        : undefined,
      evidence: {
        start,
        end: Math.min(text.length, end),
        snippet: text.slice(start, Math.min(text.length, end)).trim() || line,
      },
    });

    if (out.length >= max) break;
  }

  // De-duplicate by normalized key + keep first occurrence
  const seen = new Set<string>();
  const uniq: LabValue[] = [];
  for (const x of out) {
    const k = `${x.nameNormalized ?? normalizeLabName(x.name)}|${x.unit ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(x);
  }
  return uniq.slice(0, max);
}

function guessReportType(text: string, hint?: z.infer<typeof ReportTypeHintSchema>) {
  if (hint) return hint;

  const t = text.toLowerCase();
  const looksLikeLabs =
    /\b(hba1c|glucose|cholesterol|ldl|hdl|triglycer|tsh|crp|hemoglobin|wbc|platelet|creatinine|alt|ast)\b/i.test(
      text
    ) || /\b(reference range|ref range|units|mg\/dl|mmol\/l|u\/l)\b/i.test(t);

  const looksLikeImaging =
    /\b(impression|findings|contrast|ct|mri|ultrasound|x-?ray|radiograph|lesion|mass|fracture|stenosis)\b/i.test(t);

  if (looksLikeLabs && !looksLikeImaging) return "labs";
  if (looksLikeImaging && !looksLikeLabs) return "imaging";
  if (looksLikeLabs && looksLikeImaging) return "other";
  if (/\bdischarge\b|\bsummary\b|\bmedications?\b|\bfollow-?up\b/i.test(t)) return "discharge";
  return "other";
}

async function buildTermsForReport(
  text: string,
  reportType: "labs" | "imaging" | "discharge" | "other",
  azure: ReturnType<typeof makeAzureOpenAI>
): Promise<{ terms: ReportTerm[]; warnings: string[] }> {
  const warnings: string[] = [];
  const terms: ReportTerm[] = [];

  // 1) Fast Latin/common phrase detection
  const latinKeys = Object.keys(LATIN_TERM_MAP);
  for (const k of latinKeys) {
    const occ = findAllOccurrences(text, k);
    for (const o of occ.slice(0, 3)) {
      const meta = LATIN_TERM_MAP[k];
      terms.push({
        term: text.slice(o.start, o.end),
        normalized: k,
        translation: meta.translation,
        category: "MedicalTerm",
        offset: o.start,
        length: o.end - o.start,
        explanation: meta.explanation,
        typicalContext: meta.typicalContext,
        whyItMatters: meta.whyItMatters,
        sources: buildTrustedLinks(k, reportType).slice(0, 2),
      });
    }
  }

  // 2) Azure Text Analytics for Health entities (best effort)
  const entities = await extractHealthcareEntitiesBestEffort(truncateForProcessing(text, 20_000));
  if (!entities) warnings.push("Healthcare entity extraction unavailable or not configured.");

  if (entities?.length) {
    for (const ent of entities.slice(0, REPORT_TERMS_MAX * 3)) {
      const raw = String(ent.text ?? "").trim();
      if (!raw) continue;
      const norm = normalizeKey(raw);
      if (!norm || norm.length < 3) continue;

      // Keep only some categories for patient-facing “tap-to-explain”
      const cat = String(ent.category ?? "");
      const keep =
        cat === "Diagnosis" ||
        cat === "SymptomOrSign" ||
        cat === "MedicationName" ||
        cat === "TreatmentName" ||
        cat === "ExaminationName" ||
        cat === "ProcedureName" ||
        cat === "BodyStructure" ||
        cat === "ConditionQualifier" ||
        cat === "Age" ||
        cat === "LabTestName";

      if (!keep) continue;

      terms.push({
        term: raw,
        normalized: norm,
        category: cat,
        offset: typeof ent.offset === "number" ? ent.offset : undefined,
        length: typeof ent.length === "number" ? ent.length : undefined,
        sources: buildTrustedLinks(raw, reportType).slice(0, 2),
      });
    }
  }

  // De-dup by normalized + keep most informative
  const uniq = new Map<string, ReportTerm>();
  for (const t of terms) {
    const key = t.normalized ?? normalizeKey(t.term);
    const prev = uniq.get(key);
    if (!prev) {
      uniq.set(key, t);
      continue;
    }
    // prefer the one that already has an explanation
    const prevHas = Boolean(prev.explanation);
    const curHas = Boolean(t.explanation);
    if (!prevHas && curHas) uniq.set(key, t);
  }

  const picked = Array.from(uniq.values()).slice(0, REPORT_TERMS_MAX);

  // 3) LLM: fill missing explanation/whyItMatters minimally (best effort)
  if (!azure) {
    // no LLM; return what we have (latin already explained)
    if (!picked.length) warnings.push("No terms detected (or report too short).");
    return { terms: picked, warnings };
  }

  const need = picked.filter((x) => !x.explanation).slice(0, Math.min(12, REPORT_TERMS_MAX));
  if (!need.length) return { terms: picked, warnings };

  try {
    const deployment = process.env.AZURE_OPENAI_REPORT_DEPLOYMENT || azure.deployment;

    const system = `You explain medical terms to patients WITHOUT changing medical meaning.
Return STRICT JSON only (no markdown, no extra keys).
You MUST be cautious and non-diagnostic. Do not invent patient-specific facts.
For each term:
- explanation: minimal, clear (<= 18 words)
- typicalContext: one of: "lab", "imaging", "diagnosis", "treatment", "general"
- whyItMatters: one short sentence (<= 20 words), informational.
No PHI. No treatment advice.`;

    const user = `Context: reportType=${reportType}.
Terms (array):
${JSON.stringify(need.map((t) => ({ term: t.term, category: t.category ?? "" })))}.
Return:
{
  "items":[
    { "term": string, "explanation": string, "typicalContext": string, "whyItMatters": string }
  ]
}`;

    const completion = await azure.client.chat.completions.create({
      model: deployment,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    const parsed = safeJsonParse(content);

    const RespSchema = z.object({
      items: z
        .array(
          z.object({
            term: z.string().min(1),
            explanation: z.string().min(1),
            typicalContext: z.string().min(1),
            whyItMatters: z.string().min(1),
          })
        )
        .default([]),
    });

    const resp = RespSchema.safeParse(parsed);
    if (!resp.success) {
      warnings.push("Term explainer returned unexpected format; keeping partial terms.");
      return { terms: picked, warnings };
    }

    const byTerm = new Map(resp.data.items.map((i) => [normalizeKey(i.term), i]));
    const enriched = picked.map((t) => {
      if (t.explanation) return t;
      const x = byTerm.get(normalizeKey(t.term)) ?? byTerm.get(t.normalized ?? "");
      if (!x) return t;
      return {
        ...t,
        explanation: x.explanation,
        typicalContext: x.typicalContext,
        whyItMatters: x.whyItMatters,
      };
    });

    return { terms: enriched, warnings };
  } catch {
    warnings.push("Term explainer failed; keeping partial terms.");
    return { terms: picked, warnings };
  }
}

function formatLabLine(l: LabValue) {
  const v = l.value != null ? String(l.value) : (l.valueText ?? "");
  const u = l.unit ? ` ${l.unit}` : "";
  const f = l.flag ? ` (${l.flag})` : "";
  return `${l.name}: ${v}${u}${f}`.trim();
}

async function llmAnalyzeReport(
  text: string,
  reportType: "labs" | "imaging" | "discharge" | "other",
  labs: LabValue[],
  azure: ReturnType<typeof makeAzureOpenAI>
): Promise<{ result: ReportAnalyzeResponse | null; warnings: string[] }> {
  const warnings: string[] = [];
  if (!azure) return { result: null, warnings: ["Azure OpenAI not configured; using deterministic analysis."] };

  const deployment = process.env.AZURE_OPENAI_REPORT_DEPLOYMENT || azure.deployment;

  // Keep prompts short; never include PHI; assume synthetic/anonymized input
  const labsCompact = labs.slice(0, 40).map((l) => ({
    name: l.name,
    value: l.value ?? null,
    valueText: l.valueText ?? "",
    unit: l.unit ?? "",
    flag: l.flag ?? "unknown",
    referenceRange: l.referenceRange ? { low: l.referenceRange.low ?? null, high: l.referenceRange.high ?? null } : null,
  }));

  const system = `You are a clinical assistant generating TWO outputs:
1) Physician support summary (clinical-style)
2) Patient-friendly plan (plain language)
Return STRICT JSON only (no markdown, no extra keys).

Critical rules:
- DO NOT diagnose; use cautious language and "for clinician review".
- Do not add new facts beyond the input.
- No PHI. No medication dosing. No emergency instructions beyond generic "seek urgent care if severe symptoms".

Schema:
{
  "clinicianSummary": {
    "abnormalFindings": string[],
    "hypotheses": [{"text": string, "confidence": "low"|"medium"|"high"}],
    "nextSteps": string[],
    "redFlags": string[],
    "disclaimer": string
  },
  "patientPlan": {
    "plainEnglish": string[],
    "goalsToWatch": string[],
    "actions": string[],
    "whenToContactClinician": string[],
    "disclaimer": string
  }
}`;

  const user = `Report type: ${reportType}
Report text (truncated):
${truncateForProcessing(text, 7000)}

Extracted labs (truncated):
${JSON.stringify(labsCompact)}

Make the outputs short and useful. Prefer: abnormal list, what to ask next, what to track.`;

  try {
    const completion = await azure.client.chat.completions.create({
      model: deployment,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content ?? "{}";
    const parsed = safeJsonParse(content);

    const CandidateSchema = z.object({
      clinicianSummary: z.object({
        abnormalFindings: z.array(z.string()).default([]),
        hypotheses: z
          .array(z.object({ text: z.string().min(1), confidence: z.enum(["low", "medium", "high"]).default("low") }))
          .default([]),
        nextSteps: z.array(z.string()).default([]),
        redFlags: z.array(z.string()).default([]),
        disclaimer: z.string().default("Informational only — clinician review required."),
      }),
      patientPlan: z.object({
        plainEnglish: z.array(z.string()).default([]),
        goalsToWatch: z.array(z.string()).default([]),
        actions: z.array(z.string()).default([]),
        whenToContactClinician: z.array(z.string()).default([]),
        disclaimer: z.string().default("Informational only — not medical advice."),
      }),
    });

    const cand = CandidateSchema.safeParse(parsed);
    if (!cand.success) {
      warnings.push("Report analysis returned unexpected format; using deterministic analysis.");
      return { result: null, warnings };
    }

    // Wrap into our full response shape (derived/trust filled elsewhere)
    const result: ReportAnalyzeResponse = {
      clinicianSummary: {
        abnormalFindings: cand.data.clinicianSummary.abnormalFindings.slice(0, 12),
        hypotheses: cand.data.clinicianSummary.hypotheses.slice(0, 8),
        nextSteps: cand.data.clinicianSummary.nextSteps.slice(0, 10),
        redFlags: cand.data.clinicianSummary.redFlags.slice(0, 8),
        disclaimer: cand.data.clinicianSummary.disclaimer,
      },
      patientPlan: {
        plainEnglish: cand.data.patientPlan.plainEnglish.slice(0, 10),
        goalsToWatch: cand.data.patientPlan.goalsToWatch.slice(0, 8),
        actions: cand.data.patientPlan.actions.slice(0, 10),
        whenToContactClinician: cand.data.patientPlan.whenToContactClinician.slice(0, 8),
        disclaimer: cand.data.patientPlan.disclaimer,
      },
      derived: { abnormalLabs: [] },
      warnings: warnings.length ? warnings : undefined,
    };

    return { result, warnings };
  } catch {
    warnings.push("Report analysis failed; using deterministic analysis.");
    return { result: null, warnings };
  }
}

function deterministicReportAnalysis(
  reportType: "labs" | "imaging" | "discharge" | "other",
  labs: LabValue[]
): ReportAnalyzeResponse {
  const abnormal = labs
    .filter((l) => (l.flag ?? "unknown") === "high" || (l.flag ?? "unknown") === "low")
    .slice(0, 12);

  const abnormalLines = abnormal.map(formatLabLine);

  return {
    clinicianSummary: {
      abnormalFindings: abnormalLines.length
        ? abnormalLines
        : ["No clearly out-of-range numeric lab values detected (or report contains non-lab findings)."],
      hypotheses: abnormalLines.length
        ? [
            { text: "Abnormal values may reflect multiple causes; interpret with symptoms/history.", confidence: "low" },
          ]
        : [{ text: "Consider clinical context; imaging/discharge reports often need clinician interpretation.", confidence: "low" }],
      nextSteps: [
        "Review report in full and correlate with symptoms, history, and medications.",
        "If values are unexpected, consider repeat testing or confirm units/reference ranges.",
        "Discuss with clinician any persistent abnormalities or worsening trends.",
      ],
      redFlags: [
        "If severe or rapidly worsening symptoms occur, seek urgent medical evaluation.",
        "If report states 'urgent'/'critical'/'call physician immediately', follow that guidance.",
      ],
      disclaimer: "Informational only — clinician review required.",
    },
    patientPlan: {
      plainEnglish: abnormalLines.length
        ? [
            "Some results are outside typical ranges. This can happen for many reasons.",
            "The meaning depends on symptoms, medical history, and how the test was done.",
          ]
        : ["This report may not include numeric labs, or values may be within typical ranges."],
      goalsToWatch: abnormalLines.length
        ? abnormal.slice(0, 6).map((l) => `Track ${l.name} toward the reference range (clinician-guided).`)
        : ["Ask your clinician which values matter most to track over time."],
      actions: [
        "Bring this report to your next appointment (or send it to your clinician).",
        "Write down any symptoms and questions you want answered.",
        "If you have multiple reports, compare trends over time.",
      ],
      whenToContactClinician: [
        "If you feel worse, develop new concerning symptoms, or the report mentions urgent follow-up.",
        "If you’re unsure what any flagged result means for you personally.",
      ],
      disclaimer: "Informational only — not medical advice.",
    },
    derived: {
      abnormalLabs: abnormal.map((l) => ({
        name: l.name,
        valueText: l.value != null ? String(l.value) : l.valueText ?? "",
        unit: l.unit,
        flag: l.flag ?? "unknown",
      })),
    },
    warnings: reportType === "imaging" ? ["Imaging reports often require clinician context; numbers may be absent."] : undefined,
  };
}

// ---------------- routes ----------------
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Privacy: POST /privacy/redact  { text }
 * Returns redacted text + whether PII was detected (best effort).
 */
app.post(
  "/privacy/redact",
  asyncHandler(async (req, res) => {
    const Body = z.object({ text: z.string().min(1).max(20_000) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const { text } = parsed.data;

    // no-PII logging: only length
    req.log.info({ route: "/privacy/redact", textLen: text.length }, "redact");

    const { redacted, piiDetected } = await redactTextBestEffort(text);
    return res.json({ redacted, piiDetected });
  })
);

/**
 * Transcribe: POST /transcribe  (multipart: audio)
 * Returns transcript + segments (startMs/endMs/text) when available.
 */
app.post(
  "/transcribe",
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing audio file (field: audio)" });

    req.log.info({ route: "/transcribe", bytes: file.size, mime: file.mimetype }, "transcribe");

    // Hackathon-simple: WAV is most stable. If you upload non-WAV, consider converting client-side.
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
 * Body:
 *  {
 *    transcript: string,
 *    segments?: {startMs,endMs,text}[],
 *    enforceRedaction?: boolean,
 *    enforceOutputSafety?: boolean
 *  }
 *
 * Returns: { subjective, objective, assessment, plan, evidence, entities?, warnings? }
 */
app.post(
  "/clinician/soap",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      transcript: z.string().min(1).max(200_000),
      segments: z.array(SegmentSchema).optional(),
      // Optional: enforce redaction gate before cloud calls
      enforceRedaction: z.boolean().optional(),
      // Optional: enforce output safety gate (PII detection on LLM output)
      enforceOutputSafety: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    let { transcript, segments } = parsed.data;
    const enforceRedaction = parsed.data.enforceRedaction ?? DEFAULT_ENFORCE_REDACTION;
    const enforceOutputSafety = parsed.data.enforceOutputSafety ?? true;

    transcript = truncateForProcessing(transcript.trim(), MAX_TRANSCRIPT_CHARS);

    // no-PII logging: only length
    req.log.info({ route: "/clinician/soap", textLen: transcript.length }, "soap");

    // Optional PHI gate (best effort)
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

    const azure = makeAzureOpenAI();

    // 1) generate SOAP (LLM or mock)
    let soapObj: unknown;
    let warnings: string[] = [];

    if (!azure) {
      warnings.push("Azure OpenAI not configured; using mock SOAP generator.");
      soapObj = mockSoap(transcript);
    } else {
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

      const completion = await azure.client.chat.completions.create({
        model: azure.deployment,
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
      // do NOT return model content; could contain PHI
      return res.status(502).json({ error: "SOAP schema mismatch from generator" });
    }

    const soap = soapParsed.data;

    // 2) evidence linking (timestamp if segments available)
    const safeSegments = segments?.length ? z.array(SegmentSchema).safeParse(segments).data : undefined;
    const evidence =
      soap.evidence?.length
        ? soap.evidence
        : safeSegments?.length
          ? buildEvidenceFromSegments(soap, safeSegments)
          : buildEvidenceFromSearch(transcript, soap);

    // 3) optional healthcare entities (Azure Text Analytics for Health)
    const entities = await extractHealthcareEntitiesBestEffort(truncateForProcessing(transcript, 20_000));
    if (!entities) warnings.push("Healthcare entity extraction unavailable or not configured.");

    // 4) output safety gate (PII on response) – redact or block
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
 * Patient diary: POST /diary/trends  { diary: DiaryEntry[] }
 */
app.post(
  "/diary/trends",
  asyncHandler(async (req, res) => {
    const Body = z.object({ diary: z.array(DiaryEntrySchema).max(365) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const diary = normalizeDiary(parsed.data.diary);

    // alap trend mezők
    const baseTrend = diary.map((e) => ({
      date: e.date,
      symptomScore: e.symptomScore,
      sleepHours: e.sleepHours,
      moodScore: e.moodScore,
    }));

    // sentiment input: notes + tags (nem logoljuk)
    const texts = diary.map((e) => diaryEntryText(e));

    // üres bejegyzéseket kihagyjuk (Azure TA nem szereti az üres stringet)
    const idxMap: number[] = [];
    const docs: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = (texts[i] ?? "").trim();
      if (!t) continue;
      idxMap.push(i);
      docs.push(t);
    }

    const analyzed = docs.length ? await analyzeSentimentBatchBestEffort(docs) : [];
    const sentiments: Array<Awaited<ReturnType<typeof analyzeSentimentBatchBestEffort>>[number]> = Array(
      diary.length
    ).fill(null);

    for (let j = 0; j < idxMap.length; j++) {
      sentiments[idxMap[j]] = analyzed[j] ?? null;
    }

    const trend = baseTrend.map((row, i) => ({
      ...row,
      sentiment: sentiments[i], // {label,scores,compound} | null
    }));

    // no content logging
    req.log.info({ route: "/diary/trends", count: trend.length }, "trends");

    return res.json({ trend });
  })
);

/**
 * Patient diary: POST /diary/summarize
 * Body:
 *  {
 *    diary: DiaryEntry[],
 *    enforceRedaction?: boolean,
 *    enforceOutputSafety?: boolean
 *  }
 *
 * Returns:
 *  { summary: DiarySummary, warnings?: string[] }
 *
 * Upgrades:
 * - Uses Azure OpenAI when configured (fallback deterministic).
 * - Adds evidence links + Trust score.
 * - Optional PHI gates (input + output). Output mode controlled by OUTPUT_PII_MODE.
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

    // no content logging
    req.log.info({ route: "/diary/summarize", count: diary.length }, "summarize");

    if (!diary.length) {
      const empty = deterministicDiarySummary(diary);
      return res.json({ summary: empty });
    }

    // Optional input PHI gate (best effort)
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

    const azure = makeAzureOpenAI();
    let warnings: string[] = [];
    let mode: "llm" | "deterministic" = "deterministic";

    // 1) generate summary (LLM if configured; else deterministic)
    let summary: DiarySummary | null = null;

    if (azure) {
      try {
        const s = await llmDiarySummary(diary, azure);
        if (s) {
          summary = s;
          mode = "llm";
        } else {
          warnings.push("Model summary unavailable; falling back to deterministic summary.");
        }
      } catch {
        warnings.push("Model summary failed; falling back to deterministic summary.");
      }
    } else {
      warnings.push("Azure OpenAI not configured; using deterministic summary.");
    }

    if (!summary) summary = deterministicDiarySummary(diary);

    // 2) evidence linking + trust
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

    // 3) output safety gate (PII on response) – redact or block
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

    // 4) validate final shape (sanity)
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

/**
 * Report Interpreter: POST /report/ingest
 * Body:
 *  {
 *    text: string,
 *    reportTypeHint?: "labs"|"imaging"|"discharge"|"other",
 *    enforceRedaction?: boolean,
 *    enforceOutputSafety?: boolean
 *  }
 *
 * Returns:
 *  { cleanedText, reportType, sections, terms, labs, warnings?, trust? }
 */
app.post(
  "/report/ingest",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      text: z.string().min(1).max(400_000),
      reportTypeHint: ReportTypeHintSchema,
      enforceRedaction: z.boolean().optional(),
      enforceOutputSafety: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const enforceRedaction = parsed.data.enforceRedaction ?? DEFAULT_ENFORCE_REDACTION;
    const enforceOutputSafety = parsed.data.enforceOutputSafety ?? true;

    let text = String(parsed.data.text).replace(/\r\n/g, "\n").trim();
    text = truncateForProcessing(text, MAX_REPORT_CHARS);

    // no content logging
    req.log.info({ route: "/report/ingest", textLen: text.length }, "report ingest");

    // Optional input PHI gate (best effort)
    let piiDetectedInput = false;
    if (enforceRedaction) {
      const { piiDetected } = await redactTextBestEffort(text.slice(0, 20_000));
      piiDetectedInput = piiDetected;
      if (piiDetected) {
        return res.status(400).json({
          error: "PII detected. Please redact before processing a report.",
          code: "PII_DETECTED",
        });
      }
    }

    const reportType = guessReportType(text, parsed.data.reportTypeHint);
    const sections = splitReportSections(text).map((s) => ({
      title: s.title,
      start: s.start,
      end: s.end,
      snippet: s.snippet,
    }));

    const labs = extractLabsFromText(text, REPORT_LABS_MAX);

    const azure = makeAzureOpenAI();
    const { terms, warnings } = await buildTermsForReport(text, reportType, azure);

    // Evidence/trust: for ingest we treat terms and labs as “verified” if they have evidence spans/offsets
    const evidenceLike = [
      ...terms.map((t) => ({ verified: Boolean(typeof t.offset === "number") })),
      ...labs.map((l) => ({ verified: Boolean(l.evidence) })),
    ];
    const trustCore = computeTrustFromEvidence(evidenceLike);

    let payload: ReportIngestResponse = {
      cleanedText: text,
      reportType,
      sections,
      terms,
      labs,
      warnings: warnings.length ? warnings : undefined,
      trust: {
        scorePct: trustCore.scorePct,
        verified: trustCore.verified,
        unverified: trustCore.unverified,
        piiDetectedInput,
        mode: azure ? "llm" : "deterministic",
      },
    };

    // Output safety gate (PII on response) – redact or block
    if (enforceOutputSafety && OUTPUT_PII_MODE !== "off") {
      const { redacted, piiDetected } = await redactStringsBestEffort(payload as any);
      if (piiDetected && OUTPUT_PII_MODE === "block") {
        return res.status(400).json({
          error: "PII detected in output. Please adjust input and try again.",
          code: "PII_DETECTED_OUTPUT",
        });
      }
      payload = redacted as ReportIngestResponse;
      payload.trust = {
        ...(payload.trust ?? trustCore),
        piiDetectedOutput: piiDetected,
        piiDetectedInput,
      };
    }

    const finalParsed = ReportIngestResponseSchema.safeParse(payload);
    if (!finalParsed.success) return res.status(502).json({ error: "Report ingest schema mismatch" });

    return res.json(finalParsed.data);
  })
);

/**
 * Report Interpreter: POST /report/analyze
 * Body:
 *  {
 *    text: string,
 *    reportTypeHint?: "labs"|"imaging"|"discharge"|"other",
 *    labs?: LabValue[],                 // optional: from /report/ingest
 *    enforceRedaction?: boolean,
 *    enforceOutputSafety?: boolean
 *  }
 *
 * Returns:
 *  { clinicianSummary, patientPlan, derived, warnings?, trust? }
 */
app.post(
  "/report/analyze",
  asyncHandler(async (req, res) => {
    const Body = z.object({
      text: z.string().min(1).max(400_000),
      reportTypeHint: ReportTypeHintSchema,
      labs: z.array(LabValueSchema).optional(),
      enforceRedaction: z.boolean().optional(),
      enforceOutputSafety: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const enforceRedaction = parsed.data.enforceRedaction ?? DEFAULT_ENFORCE_REDACTION;
    const enforceOutputSafety = parsed.data.enforceOutputSafety ?? true;

    let text = String(parsed.data.text).replace(/\r\n/g, "\n").trim();
    text = truncateForProcessing(text, MAX_REPORT_CHARS);

    // no content logging
    req.log.info(
      { route: "/report/analyze", textLen: text.length, labsProvided: Boolean(parsed.data.labs?.length) },
      "report analyze"
    );

    // Optional input PHI gate (best effort)
    let piiDetectedInput = false;
    if (enforceRedaction) {
      const { piiDetected } = await redactTextBestEffort(text.slice(0, 20_000));
      piiDetectedInput = piiDetected;
      if (piiDetected) {
        return res.status(400).json({
          error: "PII detected. Please redact before analyzing a report.",
          code: "PII_DETECTED",
        });
      }
    }

    const reportType = guessReportType(text, parsed.data.reportTypeHint);
    const labs = parsed.data.labs?.length ? parsed.data.labs.slice(0, REPORT_LABS_MAX) : extractLabsFromText(text, REPORT_LABS_MAX);

    const azure = makeAzureOpenAI();
    let warnings: string[] = [];

    // LLM analysis (fallback deterministic)
    const llm = await llmAnalyzeReport(text, reportType, labs, azure);
    warnings.push(...llm.warnings);

    const base: ReportAnalyzeResponse =
      llm.result ??
      deterministicReportAnalysis(reportType, labs);

    // Derived: abnormal labs list
    const abnormalLabs = labs
      .filter((l) => (l.flag ?? "unknown") === "high" || (l.flag ?? "unknown") === "low")
      .slice(0, 24)
      .map((l) => ({
        name: l.name,
        valueText: l.value != null ? String(l.value) : l.valueText ?? "",
        unit: l.unit,
        flag: (l.flag ?? "unknown") as "low" | "normal" | "high" | "unknown",
      }));

    // Trust: treat “derived abnormal labs” as verified if they have evidence spans
    const trustCore = computeTrustFromEvidence(labs.map((l) => ({ verified: Boolean(l.evidence) })));

    let payload: ReportAnalyzeResponse = {
      ...base,
      derived: { abnormalLabs },
      warnings: warnings.length ? Array.from(new Set(warnings)).slice(0, 10) : undefined,
      trust: {
        scorePct: trustCore.scorePct,
        verified: trustCore.verified,
        unverified: trustCore.unverified,
        piiDetectedInput,
        mode: azure ? "llm" : "deterministic",
      },
    };

    // Output safety gate (PII on response) – redact or block
    if (enforceOutputSafety && OUTPUT_PII_MODE !== "off") {
      const { redacted, piiDetected } = await redactStringsBestEffort(payload as any);
      if (piiDetected && OUTPUT_PII_MODE === "block") {
        return res.status(400).json({
          error: "PII detected in generated output. Please adjust input and try again.",
          code: "PII_DETECTED_OUTPUT",
        });
      }
      payload = redacted as ReportAnalyzeResponse;
      payload.trust = {
        ...(payload.trust ?? trustCore),
        piiDetectedOutput: piiDetected,
        piiDetectedInput,
      };
    }

    const finalParsed = ReportAnalyzeResponseSchema.safeParse(payload);
    if (!finalParsed.success) return res.status(502).json({ error: "Report analysis schema mismatch" });

    return res.json(finalParsed.data);
  })
);

// ---------------- error handler (sanitized) ----------------
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err?.statusCode ?? err?.status ?? 500);

  // log technical info, never user content
  req.log.error(
    {
      route: req.path,
      status,
      errName: err?.name,
      errMessage: typeof err?.message === "string" ? err.message.slice(0, 200) : "error",
    },
    "request failed"
  );

  // avoid leaking internal details
  const publicMsg = status >= 500 ? "Internal error" : "Request failed";
  res.status(status).json({ error: publicMsg });
});

// ---------------- start ----------------
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  log.info(
    {
      port,
      openai: Boolean(
        process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY && process.env.AZURE_OPENAI_DEPLOYMENT
      ),
      speech: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
      textAnalytics: Boolean(process.env.AZURE_LANGUAGE_ENDPOINT && process.env.AZURE_LANGUAGE_KEY),
      outputPiiMode: OUTPUT_PII_MODE,
      defaultEnforceRedaction: DEFAULT_ENFORCE_REDACTION,
      diaryMaxEntries: DIARY_SUMMARY_MAX_ENTRIES,
      reportMaxChars: MAX_REPORT_CHARS,
      reportTermsMax: REPORT_TERMS_MAX,
      reportLabsMax: REPORT_LABS_MAX,
    },
    "careloop api listening"
  );
});
