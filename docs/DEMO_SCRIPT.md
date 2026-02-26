# CareLoop – Demo Script (2–3 minutes)

## Goal
Show a closed loop: Patient diary → trends + pre-visit → Clinician dictation → SOAP (+ evidence) → Plan → Patient tasks
Emphasize: synthetic data + redaction + no PHI.

## Setup (before presenting)
- Open app in a clean session / incognito
- Have 1 synthetic patient scenario preloaded
- Have one clinician dictation sample (text or audio) ready

## 0:00–0:15 — Problem (1 sentence)
Unstructured diary + dictation wastes time; hard to spot trends; documentation is slow.

## 0:15–0:55 — Patient mode (diary → trends)
1) Record / paste a 15–20 sec diary note (or click “Load synthetic demo”)
2) Show:
   - Daily summary (2–4 lines)
   - 7/30-day chart (symptom severity / sleep / mood)
   - Trend insight (improving/worsening, new symptom)

## 0:55–1:15 — Pre-visit summary
Click “Generate pre-visit summary”
Show 6–10 lines: top symptoms, time pattern, what helped, what worsened.

## 1:15–2:05 — Clinician mode (dictation → SOAP)
1) Paste transcript or upload audio
2) Click “Generate SOAP”
Show structured S/O/A/P clearly.

## 2:05–2:25 — Evidence link (wow moment)
Click 1 SOAP sentence → highlight / jump to the linked transcript snippet (timestamp or span).

## 2:25–2:45 — Closed loop (Plan → tasks)
Click “Send Plan to Patient”
Switch to Patient → see tasks checklist + next check-in template.

## 2:45–3:00 — Privacy & compliance story
- Toggle redaction
- Emphasize: synthetic data, no PHI, minimal logging, ephemeral demo storage

## Fallbacks (if Azure keys/network fail)
- Use synthetic transcript mode
- Use mock SOAP generation
- Still show evidence linking + tasks loop
