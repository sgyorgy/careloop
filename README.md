# CareLoop — AI Health Diary & Clinical Note Assistant (SOAP)

CareLoop is an AI-powered assistant that **summarizes, cleans, and structures health-related information for both patients and clinicians**—combining an **AI Health Diary Summarizer** with a **Clinical Note Cleaner (Voice → SOAP)** into one closed-loop prototype.

## What the Prototype Does

### Patient Mode — Health Diary Summarizer (Text/Voice)
- Log symptoms, food, mood, sleep via **text or voice**
- Get **temporal visual summaries**, trend highlights, and gentle, non-medical guidance prompts
- Generate a **Pre-Visit Summary** (last N days) for faster clinical context

### Clinician Mode — Clinical Note Cleaner (Voice → SOAP)
- Record clinician dictation → transcribe → generate **structured SOAP** notes:
  - **S**ubjective, **O**bjective, **A**ssessment, **P**lan
- Optional “evidence linking”: SOAP sentences can reference the relevant transcript spans for traceability

### Closed Loop — Plan Back to Patient
- Convert SOAP **Plan** into a simple patient checklist (follow-ups, measurements, reminders) to support continuity of care

---

## 2-Minute Demo Flow (What the Jury Should Try)
1. **Patient** enters or records a short diary entry (text/voice)
2. App displays **trend visualization** + a concise **summary**
3. Click **Generate Pre-Visit Summary**
4. **Clinician** records a short dictation
5. App outputs a clean **SOAP note**
6. Click **Send Plan to Patient** to generate a follow-up checklist
7. Open **Privacy Panel** to verify synthetic-data + PHI controls

---

## Architecture (High-Level)
- **Speech → Text** for diary entries and clinician dictation
- **Medical entity extraction** (symptoms/meds/durations) to improve structure
- **LLM structuring** into:
  - patient summaries + trend highlights
  - clinician-ready **SOAP** output (schema-based)

See: `docs/ARCHITECTURE.md`

---

## Azure Services Used
- **Azure Speech-to-Text** — transcription (patient + clinician)
- **Azure OpenAI / AI Foundry** — summarization + SOAP structuring
- **Text Analytics for Health** — medical concept extraction / NER
- (Optional) **Azure ML** — deployment of the API as a managed endpoint

---

## Privacy & Compliance (Hackathon Safe-by-Design)
- **No real personal data / no PHI** is used in this repository.
- All demos run on **synthetic or anonymized** content only.
- Optional PHI redaction is available for extra safety in demos.

