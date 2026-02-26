# Privacy & Data Handling 

> **Important:** CareLoop is a hackathon prototype intended for demonstration and developer testing only.  
> **Do not use with real patient data.** Use **synthetic** or properly **anonymized** text/audio only.

## 1) What this document covers

This document explains how CareLoop handles data during a demo or local development run:
- What data enters the system (text/audio)
- What is stored (and where)
- What is sent to external services (Azure)
- What is logged
- What “redaction” does
- What you should do to keep the demo PHI-safe

## 2) Core principles

CareLoop is designed around these privacy principles:

1. **No real PHI in demo**  
   The demo is built to work with synthetic scenarios. Real personal health information must not be used.

2. **Data minimization**  
   Only the minimum required data is processed to generate summaries/SOAP/tasks.

3. **Ephemeral by default (demo-first)**  
   The app supports a “don’t keep anything” approach. If local persistence exists (e.g., for convenience), it is limited and easily cleared.

4. **No content logging**  
   Logs should not contain raw diary text, transcripts, or generated clinical notes—only technical metadata.

5. **Explainable output**  
   Clinician notes can link to “evidence” snippets in the transcript so the user can verify what the model used.

## 3) Data types the app can process

### Patient mode inputs
- Diary entry text
- Optional voice note (transcribed to text)
- Optional structured fields (symptom severity, mood, sleep hours, meds taken)

### Clinician mode inputs
- Dictation audio or raw transcript text

### Outputs
- Daily summary (short text)
- Trend insights (text) + charts (numbers)
- Pre-visit summary (short text)
- SOAP note (structured fields: Subjective / Objective / Assessment / Plan)
- Plan-to-tasks checklist (structured list)
- Evidence links (snippet references that point back to transcript segments)

## 4) Synthetic-first policy (mandatory for demos)

CareLoop demos must use:
- **Synthetic patient stories** (generated scenarios)
- **Non-identifying content**: no real names, emails, phone numbers, addresses, ID numbers, dates of birth, etc.

If you’re preparing sample content, use placeholders like:
- Name: “Patient A”
- Phone: “+36 00 000 0000”
- Email: “patient@example.com”
- Address: “Example Street 1”

## 5) Redaction (PHI masking)

CareLoop includes a **redaction** capability intended to demonstrate how a production system could reduce PHI risk.

### What gets redacted (examples)
- Names (e.g., “John Smith” → “[REDACTED_NAME]”)
- Emails (e.g., “a@b.com” → “[REDACTED_EMAIL]”)
- Phone numbers (e.g., “+36 30 123 4567” → “[REDACTED_PHONE]”)
- Addresses (e.g., “Budapest, …” → “[REDACTED_ADDRESS]”)

### Important limitations
- Redaction is **best-effort** in a prototype.
- Redaction is not a guarantee that all identifiers are removed.
- The correct approach is still: **do not input real PHI**.

## 6) Storage & retention

### Demo / local development expectation
- The app should run in a way that does **not require permanent storage**.
- If the UI stores demo state (e.g., in the browser for convenience), treat it as **temporary** and clearable.

### Recommended demo practices
- Present in **incognito/private browsing** mode.
- Use “Clear demo data” / reset controls (or clear site data in the browser).
- Do not commit any real or sensitive data into the repository.

### Retention
- Default expectation: **no long-term retention**.
- Any persisted demo data should be treated as non-sensitive synthetic content only.

## 7) Logging policy

CareLoop aims to be “audit-friendly” without logging content.

### Allowed logs (technical only)
- Timestamp of request
- Endpoint name (e.g., `/transcribe`, `/clinician/soap`)
- Response status (success/failure)
- Duration/latency
- Payload size (bytes) or character count

### Not allowed in logs
- Raw diary text
- Raw transcripts
- Generated SOAP notes
- Any extracted entities that could identify a person

## 8) External services (Azure)

CareLoop may call Azure services if configured:

- **Azure Speech-to-Text**: audio → transcript
- **Azure OpenAI / AI Foundry**: summaries, structuring, SOAP generation
- **Azure Text Analytics (PII / Health)**: entity extraction and/or redaction support

### What is sent to Azure
Only the minimum required input:
- Audio for transcription (if using STT)
- Transcript/text for summarization/SOAP
- Text for redaction/entity extraction

### Developer responsibility
- Use **your own** Azure resources/keys in `.env` (never commit keys).
- Follow your Azure tenant policies and region constraints.
- Treat cloud calls as **out-of-process processing** and never send real PHI.

## 9) Access control

This prototype does not implement full production identity/security controls. For demos:
- Assume **single-user** local usage.
- Do not expose public endpoints that accept arbitrary uploads unless protected.

Production-ready access control would include:
- Auth (patient vs clinician roles)
- Session isolation
- Tenant separation
- Encryption at rest and in transit
- Per-user retention policies

## 10) Clinical safety note

CareLoop outputs:
- Are **not medical advice**
- Are **not diagnoses**
- Are intended to assist documentation and reflection only

Always include “consult a clinician” language in patient-facing suggestions.

## 11) Contributor rules (repo hygiene)

If you contribute to this codebase:
- Do **not** add real patient data to:
  - repo files
  - issues
  - PR descriptions
  - screenshots
  - test fixtures
- Keep example content synthetic.
- Never commit credentials:
  - `.env` files must be gitignored
  - provide `.env.example` only

## 12) Security checklist for demos

Before presenting:
- ✅ Incognito window
- ✅ Synthetic scenario loaded
- ✅ Redaction toggle available (optional but recommended)
- ✅ Clear/reset works
- ✅ No PHI in sample audio/text
- ✅ No keys shown on screen

## 13) Contact / ownership

If this is used in a team setting, define:
- Maintainer(s)
- Security contact
- Where to report issues privately

(For hackathon: add your team email/handle here.)

---

_Last updated: 2006 02 27_
