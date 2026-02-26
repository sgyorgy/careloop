# CareLoop – Architecture (Hackathon Prototype)

## Overview
CareLoop is a closed-loop prototype:
- Patient diary → trends + pre-visit summary
- Clinician dictation → structured SOAP (+ evidence linking)
- SOAP Plan → patient task list

## Frontend (apps/web)
- Next.js app with Patient / Clinician / Privacy pages.
- All API calls go through `/api/*` and are proxied via `API_PROXY_TARGET` rewrites.  
  (See Next config rewrites) :contentReference[oaicite:1]{index=1}

## Backend (apps/api)
Express API providing demo-safe endpoints:
- `POST /transcribe` – audio → transcript (Azure Speech, or mock fallback) :contentReference[oaicite:2]{index=2}
- `POST /clinician/soap` – transcript → strict JSON SOAP (Azure OpenAI, or mock) + evidence spans :contentReference[oaicite:3]{index=3}
- `POST /privacy/redact` – identifier masking (Text Analytics PII, or regex fallback) :contentReference[oaicite:4]{index=4}
- `POST /diary/trends` – diary → trend points :contentReference[oaicite:5]{index=5}
- `POST /diary/summarize` – diary → deterministic demo summary (server) :contentReference[oaicite:6]{index=6}

## Data Flow (high level)
```mermaid
flowchart LR
  P[Patient (text diary)] --> W[Web UI]
  C[Clinician (audio/text)] --> W
  W -->|/api/transcribe| A[API]
  W -->|/api/clinician/soap| A
  W -->|/api/diary/*| A
  A -->|Azure Speech STT| STT[Azure Speech-to-Text]
  A -->|Azure OpenAI| LLM[Azure OpenAI / AI Foundry]
  A -->|PII redaction| TA[Azure Text Analytics]
  A --> W
  W -->|Plan → tasks (demo localStorage)| P2[Patient tasks]
