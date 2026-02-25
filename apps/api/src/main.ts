import "dotenv/config";
import express from "express";
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

const log = pino({
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    censor: "[REDACTED]",
  },
});

const app = express();
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use(
  pinoHttp({
    logger: log,
    customLogLevel: () => "info",
  })
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- helpers ----------
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

const SoapSchema = z.object({
  subjective: z.union([z.array(z.string()), z.string()]),
  objective: z.union([z.array(z.string()), z.string()]),
  assessment: z.union([z.array(z.string()), z.string()]),
  plan: z.union([z.array(z.string()), z.string()]),
  evidence: z
    .array(
      z.object({
        section: z.string().optional(),
        text: z.string().optional(),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
      })
    )
    .optional(),
});

function asLines(v: string[] | string): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  return s
    .split(/\n|•|\u2022|-/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildEvidenceFromSearch(transcript: string, soap: z.infer<typeof SoapSchema>) {
  const t = transcript;
  const tl = t.toLowerCase();

  const out: { section: string; text: string; start?: number; end?: number }[] = [];
  const sections: Array<[string, string[]]> = [
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
        out.push({ section, text: line, start, end });
      } else {
        out.push({ section, text: line });
      }
    }
  }
  return out.slice(0, 40);
}

function mockSoap(transcript: string) {
  // nagyon egyszerű, de a demo transcriptben tipikusan van "Plan:" rész
  const planMatch = transcript.match(/plan:\s*(.+)$/i);
  const plan = planMatch ? planMatch[1].split(/,|;|\./).map((s) => s.trim()).filter(Boolean) : ["Follow-up as discussed."];
  return {
    subjective: ["Patient reports symptoms as described in transcript."],
    objective: ["No objective measurements provided in transcript."],
    assessment: ["Assessment based on transcript (informational only)."],
    plan,
  };
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// Privacy: POST /privacy/redact  { text }
app.post("/privacy/redact", async (req, res) => {
  const Body = z.object({ text: z.string().min(1).max(20000) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const { text } = parsed.data;
  const ta = makeTextAnalytics();

  // no-PII logging: only length
  req.log.info({ route: "/privacy/redact", textLen: text.length }, "redact");

  if (!ta) {
    // fallback regex (demo)
    const redacted = text
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
      .replace(/(\+?\d{1,3}[\s-]?)?(\(?\d{2,3}\)?[\s-]?)?\d{3}[\s-]?\d{3,4}\b/g, "[REDACTED_PHONE]");
    return res.json({ redacted });
  }

  const [result] = await ta.recognizePiiEntities([text]);
  return res.json({ redacted: result.redactedText ?? text });
});

// Transcribe: POST /transcribe  (multipart: audio)
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Missing audio file (field: audio)" });

  req.log.info({ route: "/transcribe", bytes: file.size, mime: file.mimetype }, "transcribe");

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return res.json({ transcript: "Mock transcript (set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION to enable real STT)." });
  }

  // Hackathon-simple: WAV fájl a legstabilabb a Node Speech SDK-val.
  const tmp = join(tmpdir(), `careloop-${randomUUID()}.wav`);
  await writeFile(tmp, file.buffer);

  try {
    const speechConfig = speechsdk.SpeechConfig.fromSubscription(key, region);
    speechConfig.speechRecognitionLanguage = process.env.AZURE_SPEECH_LANG ?? "en-US";

    const audioConfig = speechsdk.AudioConfig.fromWavFileInput(tmp);
    const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

    const transcript = await new Promise<string>((resolve, reject) => {
      recognizer.recognizeOnceAsync(
        (r) => {
          recognizer.close();
          resolve(r?.text ?? "");
        },
        (err) => {
          recognizer.close();
          reject(err);
        }
      );
    });

    return res.json({ transcript: transcript.trim() });
  } finally {
    await unlink(tmp).catch(() => {});
  }
});

// Clinician: POST /clinician/soap  { transcript }
app.post("/clinician/soap", async (req, res) => {
  const Body = z.object({ transcript: z.string().min(1).max(50000), output: z.string().optional() });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const { transcript } = parsed.data;
  req.log.info({ route: "/clinician/soap", textLen: transcript.length }, "soap");

  const azure = makeAzureOpenAI();

  // 1) alap SOAP (LLM vagy mock)
  let soapObj: unknown;
  if (!azure) {
    soapObj = mockSoap(transcript);
  } else {
    const system = `You generate a STRICT JSON SOAP note for a clinician. Output MUST be valid JSON only.
Schema:
{
  "subjective": string[]|string,
  "objective": string[]|string,
  "assessment": string[]|string,
  "plan": string[]|string
}
No extra keys. No markdown.`;
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
    soapObj = JSON.parse(content);
  }

  const soapParsed = SoapSchema.safeParse(soapObj);
  if (!soapParsed.success) return res.status(502).json({ error: "SOAP schema mismatch from generator" });

  const soap = soapParsed.data;

  // 2) “evidence link” wow: egyszerű index-alapú span-képzés (kereséssel)
  const evidence = soap.evidence?.length ? soap.evidence : buildEvidenceFromSearch(transcript, soap);

  return res.json({ ...soap, evidence });
});

// Patient diary: POST /diary/trends  { diary: DiaryEntry[] }
app.post("/diary/trends", async (req, res) => {
  const Entry = z.object({
    date: z.string().min(8),
    symptomScore: z.number().min(0).max(10),
    sleepHours: z.number().min(0).max(24),
    moodScore: z.number().min(0).max(10),
    notes: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });
  const Body = z.object({ diary: z.array(Entry).max(365) });
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

  return res.json({ trend });
});

// Patient diary: POST /diary/summarize  { diary: DiaryEntry[] }
app.post("/diary/summarize", async (req, res) => {
  const Entry = z.object({
    date: z.string().min(8),
    symptomScore: z.number().min(0).max(10),
    sleepHours: z.number().min(0).max(24),
    moodScore: z.number().min(0).max(10),
    notes: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });
  const Body = z.object({ diary: z.array(Entry).max(365) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const diary = parsed.data.diary.slice().sort((a, b) => a.date.localeCompare(b.date));
  const last7 = diary.slice(-7);
  const avg = last7.length ? last7.reduce((s, e) => s + e.symptomScore, 0) / last7.length : null;

  // minimal, deterministic summary (LLM-re később cserélhető)
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
});

// ---------- start ----------
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  log.info({ port }, "careloop api listening");
});
