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

  AZURE_SPEECH_KEY: z.string().min(1).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),
  AZURE_SPEECH_LANG: z.string().min(2).optional(),

  AZURE_LANGUAGE_ENDPOINT: z.string().url().optional(),
  AZURE_LANGUAGE_KEY: z.string().min(1).optional(),

  // optional
  MAX_TRANSCRIPT_CHARS: z.string().optional(),
});

type Soap = z.infer<typeof SoapSchema>;
type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;
type Segment = z.infer<typeof SegmentSchema>;

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

// ---------------- helpers ----------------
const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  // safe: don't print env values
  log.warn({ issues: env.error.issues.map((i) => ({ path: i.path, message: i.message })) }, "env validation warning");
}
const MAX_TRANSCRIPT_CHARS = Number(process.env.MAX_TRANSCRIPT_CHARS ?? 50_000);

function makeAzureOpenAI() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-15-preview";
  if (!endpoint || !apiKey || !deployment) return null;

  const baseURL = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}`;
  return {
    client: new OpenAI({
      apiKey,
      baseURL,
      defaultQuery: { "api-version": apiVersion },
      defaultHeaders: { "api-key": apiKey },
    }),
    deployment,
  };
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

async function extractHealthcareEntitiesBestEffort(transcript: string) {
  const ta = makeTextAnalytics();
  if (!ta) return null;

  // If the resource doesn't have the healthcare feature enabled, this can throw.
  try {
    const poller = await ta.beginAnalyzeHealthcareEntities([transcript]);
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
        warnings:
          transcript.length > MAX_TRANSCRIPT_CHARS
            ? ["Transcript truncated for processing."]
            : [],
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
 *    segments?: {startMs,endMs,text}[]  // optional for timestamp evidence linking
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
      // Optional: demo setting to enforce redaction gate before cloud calls
      enforceRedaction: z.boolean().optional(),
    });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    let { transcript, segments, enforceRedaction } = parsed.data;
    transcript = truncateForProcessing(transcript.trim(), MAX_TRANSCRIPT_CHARS);

    // no-PII logging: only length
    req.log.info({ route: "/clinician/soap", textLen: transcript.length }, "soap");

    // Optional PHI gate (best effort)
    if (enforceRedaction) {
      const { piiDetected } = await redactTextBestEffort(transcript);
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
    const entities = await extractHealthcareEntitiesBestEffort(transcript);
    if (!entities) warnings.push("Healthcare entity extraction unavailable or not configured.");

    return res.json({
      ...soap,
      evidence,
      entities,
      warnings: warnings.length ? warnings : undefined,
    });
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

    const trend = parsed.data.diary
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => ({
        date: e.date.slice(0, 10),
        symptomScore: e.symptomScore,
        sleepHours: e.sleepHours,
        moodScore: e.moodScore,
      }));

    // no content logging
    req.log.info({ route: "/diary/trends", count: trend.length }, "trends");

    return res.json({ trend });
  })
);

/**
 * Patient diary: POST /diary/summarize  { diary: DiaryEntry[] }
 * Deterministic summary for hackathon stability.
 * (You can later swap to Azure OpenAI while keeping the response shape.)
 */
app.post(
  "/diary/summarize",
  asyncHandler(async (req, res) => {
    const Body = z.object({ diary: z.array(DiaryEntrySchema).max(365) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const diary = parsed.data.diary.slice().sort((a, b) => a.date.localeCompare(b.date));
    const last7 = diary.slice(-7);
    const avg = last7.length ? last7.reduce((s, e) => s + e.symptomScore, 0) / last7.length : null;

    // no content logging
    req.log.info({ route: "/diary/summarize", count: diary.length }, "summarize");

    const summary = {
      headline: diary.length ? "Pre-visit summary (server)" : "Add diary entries to generate a summary",
      bullets: diary.length
        ? [
            avg != null ? `Last 7 days avg symptom score: ${avg.toFixed(1)} / 10` : "Not enough data for a 7-day average",
            "Patterns are hints only (not a diagnosis).",
          ]
        : [],
      possibleTriggers: Array.from(
        new Set(last7.flatMap((e) => (e.tags ?? []).map((t) => t.toLowerCase())).filter(Boolean))
      ).slice(0, 5),
      gentleSuggestions: diary.length
        ? ["Keep logging meals/sleep alongside symptoms.", "If symptoms worsen, consider contacting a clinician."]
        : [],
      last7DaysAvgSymptom: avg,
    };

    return res.json({ summary });
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
      openai: Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY && process.env.AZURE_OPENAI_DEPLOYMENT),
      speech: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
      textAnalytics: Boolean(process.env.AZURE_LANGUAGE_ENDPOINT && process.env.AZURE_LANGUAGE_KEY),
    },
    "careloop api listening"
  );
});
