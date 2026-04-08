# FormPilot AI — Job Application Autofill

A profile-first Chrome extension that autofills job application forms using a locally stored profile and a lightweight rule engine. Ollama (local LLM) is used only as an AI fallback for open-ended answers — all profile data stays on your machine.

---

## Quick Start

**Prerequisites**
- Chrome (desktop)
- Ollama installed locally — only needed for AI fallback (optional)
- Plain-text copy of your resume (recommended for fast profile extraction)

**Install**
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the folder that contains `manifest.json`

> No `npm install` or build step required.

---

## Profile Setup

1. Click the extension icon and select **Setup** to launch the onboarding wizard.
2. Paste your resume into the resume field and click **Extract with AI** — or click **Fill manually** to type everything yourself.
3. Review the extracted fields and correct any errors. Pay special attention to:
   - Work authorization and visa sponsorship (must be set manually)
   - City, Province, Country, Postal code
   - Desired salary and years of experience
   - Name, email, phone, LinkedIn/portfolio URLs, headline, summary, education, and skills
4. Click **Save Profile**.

Once saved, autofill order is: **profile → rules → AI fallback** (AI only runs if Ollama is active).

![Adobe Express - Screen Recording 2026-04-07 at 10 11 11 PM-5](https://github.com/user-attachments/assets/370c8e9c-2b51-41e6-a890-055f566c6464)

TEST IF OLLAMA ACTIVE
![Adobe Express - Screen Recording 2026-04-07 at 10 11 11 PM-6](https://github.com/user-attachments/assets/f37e4d24-efe8-4581-8884-866d15e05ca8)


---

## Usage

1. Open a supported job application page.
2. Click the extension icon.
3. Click **Fill Page** to autofill using your profile, rules, and AI (if enabled).
   - Use **Names Only** to fill name fields only.
   - Click **Stop** to abort if the page behaves unexpectedly.
---


## Ollama & Settings

- Default API URL: `http://localhost:11434`
- Default model: `gemma3:1b` (configurable)
- Go to the **Settings** tab to set the API base URL and model name, then click **Test** to verify connectivity.
- If Ollama is not running or CORS is not configured, AI features will be skipped — profile and rules still work.

---
![Adobe Express - Screen Recording 2026-04-07 at 2 07 00 PM copy-4](https://github.com/user-attachments/assets/0c1ec816-9cba-48ef-a97c-c5be619dba1c)


![Adobe Express - 88888-2](https://github.com/user-attachments/assets/f5422734-24a7-427e-a524-9c76ffe94c59)


![Adobe Express - 0000-4](https://github.com/user-attachments/assets/0e1a0ddd-7b1b-4ff1-856a-f73c0ba299e8)


## CORS Setup (Required for Ollama)

Chrome extensions run on a different origin, so Ollama must be started with CORS allowed.

### macOS
```bash
launchctl setenv OLLAMA_ORIGINS "*"
killall ollama
ollama serve
```

### Linux
```bash
export OLLAMA_ORIGINS="*"
ollama serve
```

### Windows (PowerShell)
```powershell
$env:OLLAMA_ORIGINS="*"
ollama serve
```

**Verify it's working:**
```bash
curl http://127.0.0.1:11434/api/tags
```

> This only affects local machine usage.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Extension won't load | Select the folder containing `manifest.json`, not a subfolder |
| Ollama not responding | Ensure Ollama is running and `OLLAMA_ORIGINS` is set; run the verify `curl` above |
| AI timeouts | Enable **Basic Mode** (rules-only) in Settings to skip AI entirely |
| Form fields not filled | The site may not be in `manifest.json`'s `host_permissions` — check and add it |

---

## Privacy & Security

- Profile data and question→answer memory are stored locally in Chrome extension storage — nothing is sent to the cloud by default.
- Work authorization and visa sponsorship fields are rule-protected and cannot be changed by AI.
- Ollama runs entirely on your machine — ensure any models you use are from trusted sources.

---

## File Reference

| File | Purpose |
|---|---|
| `manifest.json` | Extension config and host permissions |
| `popup.html` / `popup.js` | Extension popup UI |
| `onboarding.html` | Profile setup wizard |
| `background.js` | Service worker / background logic |
| `content.js` | Form detection and filling |
| `profile.js` | Profile storage and retrieval |
| `rules.js` | Rule engine for field matching |

To modify behavior, edit the relevant file and reload the extension at `chrome://extensions`.
