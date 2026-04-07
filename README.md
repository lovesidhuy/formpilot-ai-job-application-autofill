## Readme (ready-to-paste)

# FormPilot AI — Job Application Autofill (Chrome extension)

Profile-first Chrome extension that autofills job application forms using a locally stored profile and a lightweight rule engine. Ollama (local) is used only as an AI fallback for open-ended answers — all profile data stays on your machine.

---

## Quick start (3 steps — no build)

Prerequisites
- Chrome (desktop)
- Ollama installed locally only if you want AI help (optional)
- Plain-text copy of your resume (recommended for fast extraction)

Install and run
1. Load extension in Chrome
   - Open chrome://extensions
   - Enable Developer mode
   - Click **Load unpacked** and select this repository folder (the folder that contains `manifest.json`)
2. (Optional) Start Ollama with CORS allowed (required only for AI features) — see CORS section below
3. Click the extension icon → run the onboarding wizard → Save your profile

Note: This is a plain Chrome extension — there is no `npm install` or other build step required.

---

## 🔐 CORS Setup (Required for Ollama)

Chrome extensions run on a different origin, so Ollama must allow CORS.

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

---

### 🔍 Verify

```bash
curl http://127.0.0.1:11434/api/tags
```

---

### ⚠️ Note

* Required for Chrome extension → Ollama communication  
* Only affects local machine usage

---

Here’s a **clean, short, ready-to-paste README section** 👇

````md
## 🔐 CORS Setup (Required for Ollama)

Chrome extensions run on a different origin, so Ollama must allow CORS.

### macOS
```bash
launchctl setenv OLLAMA_ORIGINS "*"
killall ollama
ollama serve
````

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

---

### 🔍 Verify

```bash
curl http://127.0.0.1:11434/api/tags
```

---

### ⚠️ Note

* Required for Chrome extension → Ollama communication
* Only affects local machine usage

```
````

---

## Profile setup (DRY — exact steps)

1. Open the extension and click **setup** to start the onboarding wizard.  
2. Paste your resume into the resume field and click **Extract with AI** (or click **Fill manually** to type everything).  
3. Verify and edit extracted fields, then save:
   - Required checks: Work authorization (manually set), Visa sponsorship (manually set), City/Province/Country/Postal, Desired salary, Years of experience.
   - Review: Name, email, phone, LinkedIn/portfolio URLs, headline, summary, education, skills.
4. Click **Save Profile**. Profile is stored locally and used to fill forms.

Behavior after save: Filling order is profile → rules → AI fallback (if Ollama is running and enabled).

---

## How to use

- Open a supported job application page.
- Click the extension icon.
- Click **Fill Page** to autofill using profile and rules (AI used only when needed).
- Use **Names Only** to only fill name fields.
- Click **Stop** to abort if the page behaves unexpectedly.

---

## Ollama / Settings

- Default API URL: `http://localhost:11434`
- Default model example: `gemma3:1b`
- In Settings tab set API base URL and model name, click **Test** to list models and confirm connectivity.
- If Ollama is not running or CORS not set, AI features will fail but profile+rules still work.

---

## Troubleshooting (concise)

- Extension won’t load: When using **Load unpacked**, select the folder that contains `manifest.json`.
- Ollama not responding: ensure Ollama is running and OLLAMA_ORIGINS is set (use the Verify curl).
- AI timeouts: enable Basic Mode (rules-only) in Settings to skip AI.
- Form fields not filled: site might not match manifest host_permissions — check `manifest.json` host list.

---

## Privacy & security

- Profile and question→answer memory are stored locally in Chrome extension storage (no cloud by default).  
- Work authorization & sponsorship fields are rule-protected and never changed by AI.  
- If you use Ollama, it runs locally — ensure models you run are trusted.

---

## Files & editing (dev quick notes)

- Key files: `manifest.json`, `popup.html`, `onboarding.html`, `background.js`, `content.js`, `popup.js`, `profile.js`, `rules.js`.  
- To modify behavior: edit these files and reload the extension in chrome://extensions.

---

If you want, I can produce a strictly minimal "Release" README (2–3 lines) or a one-page troubleshooting checklist. Which would you prefer?
