// QuickFill AI – popup.js v4.3
// Fixes on top of v4.2:
//
//   BUG #1 — btn-save-profile now reads customAnswers from storage before
//             calling set(), so saving profile never wipes persistent memory.
//
//   BUG #2 — renderProfileHints now toggles the 'show' CSS class in addition
//             to style.display so the flexbox layout rule actually applies.
//
//   BUG #3 — btn-stop-fill is hidden via inline style at startup; applyFlowState
//             was already correct but the button was briefly visible before
//             restoreFlowState() resolved its async storage read.
//
//   BUG #4 — renderProfileHints() is now called inside loadFormData() after
//             form fields are populated, so warnings appear on popup open
//             rather than only after the user clicks Save.

'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeOllamaUrl(url) {
  let v = String(url || '').trim();
  if (!v) return 'http://127.0.0.1:11434';
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  v = v.replace(/\/+$/, '');
  v = v.replace(/\/v1\/chat\/completions$/i, '');
  v = v.replace(/\/api\/generate$/i,         '');
  v = v.replace(/\/api\/chat$/i,             '');
  v = v.replace(/\/v1$/i,                    '');
  if (v === 'http://localhost:11434') v = 'http://127.0.0.1:11434';
  return v;
}

function parseSkillsLocal(raw) {
  if (Array.isArray(raw)) return raw.filter(s => typeof s === 'string' && s.trim());
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed).filter(s => typeof s === 'string' && s.trim()); }
      catch (_) {}
    }
    if (trimmed) return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, type = 'ok', ms = 4000) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ─── State ────────────────────────────────────────────────────────────────────

let _skills = [];
let isStartingFlow = false;

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = $('tab-' + tab.dataset.tab);
      if (panel) panel.classList.add('active');
      if (tab.dataset.tab === 'memory') refreshMemory();
    });
  });
}

// ─── Activity log ─────────────────────────────────────────────────────────────

function classForLogEntry(text) {
  if (text.startsWith('✓') || text.startsWith('🏁')) return 'ok';
  if (text.startsWith('→') || text.startsWith('–'))  return 'nav';
  if (text.startsWith('⟳'))                          return 'info';
  if (text.startsWith('⚠'))                          return 'warn';
  if (text.startsWith('✗'))                          return 'err';
  if (text.startsWith('⊘') || text.startsWith('🛑')) return 'stop';
  return '';
}

function renderLog(lines = []) {
  const box = $('log-box');
  if (!box) return;
  box.innerHTML = '';
  lines.forEach(text => {
    const span = document.createElement('span');
    span.className = 'log-entry ' + classForLogEntry(text);
    span.textContent = text;
    box.appendChild(span);
  });
  box.scrollTop = box.scrollHeight;
}

function renderLogIfChanged(lines = []) {
  const box = $('log-box');
  if (!box) return;
  const currentCount = box.children.length;
  if (lines.length !== currentCount) { renderLog(lines); return; }
  const currentTexts = Array.from(box.children).map(n => n.textContent);
  if (lines.some((line, i) => currentTexts[i] !== line)) renderLog(lines);
}

// ─── Source stats pills ───────────────────────────────────────────────────────

function resolveStatSource(src) {
  if (!src) return 'skipped';
  const s = src.toLowerCase();
  if (s.includes('memory')) return 'memory';
  if (s.startsWith('profile')) return 'profile';
  if (s.startsWith('rule'))    return 'rule';
  if (s.startsWith('ai'))      return 'ai';
  if (s === 'timeout')         return 'timeout';
  if (s === 'error' || s === 'network_error') return 'error';
  return 'skipped';
}

function renderSourceStats(stats = {}) {
  const wrap = $('source-stats');
  if (!wrap) return;

  const total = Object.values(stats).reduce((sum, n) => sum + (Number(n) || 0), 0);
  wrap.style.display = total > 0 ? 'flex' : 'none';

  const set = (id, icon, label, count) => {
    const el = $(id);
    if (!el) return;
    el.textContent = `${icon} ${count} ${label}`;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
  };

  set('stat-profile', '✅', 'profile',  stats.profile  || 0);
  set('stat-rule',    '⚙️',  'rules',    stats.rule     || 0);
  set('stat-memory',  '💾', 'memory',   stats.memory   || 0);
  set('stat-ai',      '🤖', 'AI',       stats.ai       || 0);
  set('stat-skip',    '❌', 'skip',     stats.skipped  || 0);
  set('stat-timeout', '⏱',  'timeout',  stats.timeout  || 0);
  set('stat-error',   '🔴', 'error',    stats.error    || 0);
}

// ─── Status card ──────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  idle:    'Idle',
  running: 'Running',
  done:    'Done',
  error:   'Error',
  stopped: 'Stopped',
};

function applyFlowState(state) {
  if (!state) return;

  const {
    status   = 'idle',
    step     = 0,
    maxSteps = 12,
    filled   = 0,
    message  = '',
    log      = [],
    stats    = {},
  } = state;

  // Badge
  const badge     = $('flow-badge');
  const badgeText = $('flow-badge-text');
  if (badge)     badge.className       = 'status-badge ' + status;
  if (badgeText) badgeText.textContent = STATUS_LABELS[status] || status;

  // Message
  const msgEl = $('flow-msg');
  if (msgEl) {
    msgEl.textContent = message ||
      (status === 'idle' ? 'Ready — open a job application and click Fill Page.' : '');
  }

  // Filled counter
  const filledEl = $('flow-filled');
  if (filledEl) filledEl.textContent = filled;

  // Step counters
  const stepEl = $('flow-step');
  const maxEl  = $('flow-max');
  if (stepEl) stepEl.textContent = step;
  if (maxEl)  maxEl.textContent  = maxSteps;

  // Progress bar
  const progFill = $('flow-progress');
  if (progFill) {
    if (status === 'running') {
      const pct = maxSteps > 0 ? Math.min(100, Math.round((step / maxSteps) * 100)) : 0;
      progFill.style.width = pct + '%';
    } else if (status === 'done') {
      progFill.style.width = '100%';
    } else {
      progFill.style.width = '0%';
    }
  }

  // Log
  if (log && log.length) renderLogIfChanged(log);

  // Source stats
  renderSourceStats(stats);

  // Fill / stop buttons
  const fillBtn = $('btn-fill-page');
  const stopBtn = $('btn-stop-fill');
  if (fillBtn) {
    if (status === 'running') {
      fillBtn.disabled = true;
      fillBtn.textContent = 'Running…';
    } else {
      fillBtn.disabled = false;
      fillBtn.textContent = 'Fill Page';
    }
  }
  // BUG #3 FIX: always explicitly set display so there's no flash on open
  if (stopBtn) {
    stopBtn.style.display = status === 'running' ? '' : 'none';
  }
}

// ─── Restore flow state on popup open ────────────────────────────────────────

function restoreFlowState() {
  chrome.storage.local.get(['flowState'], data => {
    const state = data.flowState;
    if (!state) return;

    if (state.status === 'running') {
      const startedAt = typeof state.startedAt === 'number' ? state.startedAt : 0;
      const elapsed   = startedAt > 0 ? Date.now() - startedAt : Infinity;

      if (elapsed > 120_000) {
        const resetState = { ...state, status: 'idle', message: 'Previous run timed out.' };
        chrome.storage.local.set({ flowState: resetState });
        applyFlowState(resetState);
        return;
      }

      toast('Resuming previous session...', 'ok', 2500);
    }

    applyFlowState(state);
  });
}

// ─── Runtime live updates ─────────────────────────────────────────────────────

function initLiveListeners() {
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'FLOW_STATE_UPDATED' && msg.state) applyFlowState(msg.state);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.flowState) applyFlowState(changes.flowState.newValue);

    if (changes.ollamaWentOffline?.newValue === true) {
      const dot = $('ollama-dot');
      const txt = $('ollama-text');
      if (dot) dot.className   = 'dot yellow';
      if (txt) txt.textContent = 'Ollama went offline — switched to basic mode';
      toast('⚠ Ollama offline — AI fields skipped, profile+rules still working', 'warn', 7000);
      chrome.storage.local.remove(['ollamaWentOffline']);
    }
  });
}

// ─── Skills editor ────────────────────────────────────────────────────────────

function renderPopupSkills() {
  const wrap = $('popup-skills-wrap');
  const inp  = $('popup-skills-input');
  if (!wrap || !inp) return;

  Array.from(wrap.querySelectorAll('.skill-tag')).forEach(chip => chip.remove());

  _skills.forEach((skill, idx) => {
    const chip = document.createElement('div');
    chip.className = 'skill-tag';
    chip.innerHTML =
      `<span>${escHtml(skill)}</span>` +
      `<button type="button" data-idx="${idx}">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      _skills.splice(idx, 1);
      renderPopupSkills();
    });
    wrap.insertBefore(chip, inp);
  });
}

function addPopupSkill(raw) {
  String(raw)
    .split(/[,\n]+/)
    .map(s => s.trim().replace(/,$/, ''))
    .filter(s => s.length > 0 && s.length < 60)
    .forEach(skill => { if (!_skills.includes(skill)) _skills.push(skill); });
  renderPopupSkills();
}

function initPopupSkillsEditor() {
  const wrap = $('popup-skills-wrap');
  const inp  = $('popup-skills-input');
  if (!wrap || !inp) return;

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = inp.value.trim().replace(/,$/, '');
      if (v) { addPopupSkill(v); inp.value = ''; }
    } else if (e.key === 'Backspace' && !inp.value && _skills.length) {
      _skills.pop();
      renderPopupSkills();
    }
  });

  inp.addEventListener('blur', () => {
    const v = inp.value.trim().replace(/,$/, '');
    if (v) { addPopupSkill(v); inp.value = ''; }
  });

  wrap.addEventListener('click', () => inp.focus());
}

// ─── Profile form: load ───────────────────────────────────────────────────────

const PROFILE_KEYS = [
  'firstName', 'lastName', 'email', 'phone',
  'city', 'province', 'country', 'postal',
  'headline', 'experienceYears', 'salary',
  'summary', 'portfolio', 'linkedin',
  'education',
  'workAuth', 'sponsorship',
  'pref_remote', 'pref_relocate',
  'skills',
  'experience',
];

const SETTINGS_KEYS = ['ollamaUrl', 'ollamaModel', 'basicMode'];

function updateBasicModeBanner(on) {
  const banner = $('basic-mode-banner');
  if (banner) banner.classList.toggle('show', !!on);
}

function loadFormData() {
  chrome.storage.local.get([...PROFILE_KEYS, ...SETTINGS_KEYS], data => {
    if (data.experience && !data.experienceYears) data.experienceYears = data.experience;

    const textFields = [
      'firstName', 'lastName', 'email', 'phone',
      'city', 'province', 'country', 'postal',
      'headline', 'experienceYears', 'salary',
      'summary', 'portfolio', 'linkedin',
      'education',
    ];
    textFields.forEach(key => {
      const el = $(key);
      if (el && data[key] !== undefined && data[key] !== '') el.value = data[key];
    });

    const urlEl = $('ollamaUrl');
    if (urlEl) urlEl.value = normalizeOllamaUrl(data.ollamaUrl || '');
    const modelEl = $('ollamaModel');
    if (modelEl && data.ollamaModel) modelEl.value = data.ollamaModel;

    const boolDefaults = {
      workAuth:      true,
      sponsorship:   false,
      pref_remote:   true,
      pref_relocate: true,
      basicMode:     false,
    };
    Object.entries(boolDefaults).forEach(([key, fallback]) => {
      const el = $(key);
      if (!el) return;
      const stored = data[key];
      el.checked = stored !== undefined
        ? stored === true || stored === 'true'
        : fallback;
    });

    updateBasicModeBanner(data.basicMode === true || data.basicMode === 'true');

    _skills = parseSkillsLocal(data.skills);
    renderPopupSkills();

    // BUG #4 FIX: show profile warnings immediately on open, not only after Save
    renderProfileHints();
  });
}

// ─── Profile form: validation hints ──────────────────────────────────────────

function renderProfileHints() {
  const hintBox = $('profile-hints');
  if (!hintBox) return;

  const warnings = [];

  const required = [
    ['firstName', 'First name is missing'],
    ['lastName',  'Last name is missing'],
    ['email',     'Email is missing'],
    ['phone',     'Phone is missing'],
    ['city',      'City is missing'],
    ['salary',    'Desired salary is missing — salary fields will be skipped'],
    ['headline',  'Job title / headline is missing'],
  ];

  required.forEach(([id, msg]) => {
    const el = $(id);
    if (!el || !el.value.trim()) warnings.push(msg);
  });

  const expEl = $('experienceYears');
  if (!expEl || !expEl.value.trim() || expEl.value.trim() === '0')
    warnings.push('Years of experience is 0 or missing');

  const qualityFields = [
    ['summary',   'Professional summary is missing — "why applying" answers will be generic'],
    ['education', 'Education is missing — education fields will be skipped'],
  ];
  qualityFields.forEach(([id, msg]) => {
    const el = $(id);
    if (!el || !el.value.trim()) warnings.push(msg);
  });

  if (!_skills.length)
    warnings.push('Skills list is empty — skill-experience fields will use defaults');

  if (!warnings.length) {
    hintBox.innerHTML = '';
    // BUG #2 FIX: toggle both the class and inline style
    hintBox.classList.remove('show');
    hintBox.style.display = 'none';
    return;
  }

  // BUG #2 FIX: add 'show' class so the CSS flexbox rule applies
  hintBox.classList.add('show');
  hintBox.style.display = '';
  hintBox.innerHTML = warnings.map(w =>
    `<div class="profile-hint-row">${escHtml(w)}</div>`
  ).join('');
}

// ─── Ollama status ────────────────────────────────────────────────────────────

function checkOllama() {
  const dot = $('ollama-dot');
  const txt = $('ollama-text');
  if (!dot || !txt) return;

  const url     = normalizeOllamaUrl($('ollamaUrl')?.value || '');
  const model   = ($('ollamaModel')?.value || '').trim() || 'gemma3:1b';
  const basicOn = $('basicMode')?.checked === true;

  if (basicOn) {
    dot.className   = 'dot yellow';
    txt.textContent = 'Basic Mode — AI disabled';
    return;
  }

  dot.className   = 'dot pulse';
  txt.textContent = 'Checking Ollama…';

  chrome.storage.local.set({ ollamaUrl: url, ollamaModel: model }, () => {
    chrome.runtime.sendMessage({ action: 'PING_OLLAMA' }, res => {
      if (chrome.runtime.lastError || !res) {
        dot.className   = 'dot red';
        txt.textContent = 'Background script error — reload extension';
        return;
      }
      if (res.ok) {
        dot.className = 'dot green';
        const info = Array.isArray(res.models) && res.models.length
          ? res.models.slice(0, 3).join(', ')
          : 'connected';
        txt.textContent = 'Ollama ready · ' + info;
      } else {
        dot.className   = 'dot red';
        txt.textContent = 'Ollama offline — ' + (res.error || 'not reachable');
      }
    });
  });
}

// ─── Memory tab ───────────────────────────────────────────────────────────────

function resolveSourceDisplay(src) {
  const s = (src || '').toLowerCase();
  const hasMemory = s.includes('+memory') || s === 'memory';

  const base =
    s.startsWith('ai')      ? 'ai'      :
    s.startsWith('profile') ? 'profile' :
    s.startsWith('rule')    ? 'rule'    :
    'rule';

  const labels = { ai: '🤖 AI', profile: '✅ profile', rule: '⚙️ rule' };
  const label = labels[base] + (hasMemory ? ' (memory)' : '');
  return { label, cssClass: base };
}

function refreshMemory() {
  chrome.runtime.sendMessage({ action: 'GET_MEMORY_STATS' }, res => {
    if (res) {
      const persEl = $('mem-persistent');
      const sessEl = $('mem-session');
      if (persEl) persEl.textContent = res.persistent || 0;
      if (sessEl) sessEl.textContent = res.session    || 0;
    }
  });

  chrome.storage.local.get(['qf_memory'], data => {
    const mem  = data.qf_memory || {};
    const list = $('memory-list');
    if (!list) return;

    const entries = Object.entries(mem);
    if (!entries.length) {
      list.innerHTML = '<div class="memory-empty">No answers saved yet. Fill some forms first.</div>';
      return;
    }

    entries.sort((a, b) => ((b[1]?.ts || 0) - (a[1]?.ts || 0)));

    list.innerHTML = '';
    entries.slice(0, 50).forEach(([question, value]) => {
      const answer = value?.answer || '';
      const { label: srcLabel, cssClass: srcClass } = resolveSourceDisplay(value?.source || '');

      const item = document.createElement('div');
      item.className = 'memory-item';
      item.innerHTML =
        `<div class="memory-q">${escHtml(question.slice(0, 80))}</div>` +
        `<div class="memory-a">${escHtml(String(answer).slice(0, 80))}</div>` +
        `<div class="memory-meta"><span class="${srcClass}">${srcLabel}</span></div>`;
      list.appendChild(item);
    });
  });
}

// ─── Active tab helper ────────────────────────────────────────────────────────

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

function initButtons() {

  // ── Save profile ──
  // BUG #1 FIX: read customAnswers from storage first so we never overwrite
  // persistent memory with an empty object on save.
  $('btn-save-profile')?.addEventListener('click', () => {
    chrome.storage.local.get(['customAnswers'], existing => {
      const data = {
        firstName:       $('firstName')?.value.trim()       || '',
        lastName:        $('lastName')?.value.trim()        || '',
        email:           $('email')?.value.trim()           || '',
        phone:           $('phone')?.value.trim()           || '',
        city:            $('city')?.value.trim()            || '',
        province:        $('province')?.value.trim()        || '',
        country:         $('country')?.value.trim()         || '',
        postal:          $('postal')?.value.trim()          || '',
        headline:        $('headline')?.value.trim()        || '',
        experienceYears: $('experienceYears')?.value.trim() || '',
        salary:          $('salary')?.value.trim()          || '',
        summary:         $('summary')?.value.trim()         || '',
        portfolio:       $('portfolio')?.value.trim()       || '',
        linkedin:        $('linkedin')?.value.trim()        || '',
        education:       $('education')?.value.trim()       || '',
        workAuth:        $('workAuth')?.checked    !== false,
        sponsorship:     $('sponsorship')?.checked === true,
        pref_remote:     $('pref_remote')?.checked   !== false,
        pref_relocate:   $('pref_relocate')?.checked !== false,
        skills:          JSON.stringify(_skills),
        // Preserve existing customAnswers — never clobber memory
        customAnswers:   existing.customAnswers || {},
      };

      chrome.storage.local.set(data, () => {
        renderProfileHints();
        toast('Profile saved ✓');
      });
    });
  });

  // ── Save settings ──
  $('btn-save-settings')?.addEventListener('click', () => {
    const url   = normalizeOllamaUrl($('ollamaUrl')?.value || '');
    const model = ($('ollamaModel')?.value || '').trim() || 'gemma3:1b';
    const basic = $('basicMode')?.checked === true;

    if ($('ollamaUrl'))  $('ollamaUrl').value = url;
    if ($('ollamaModel') && !$('ollamaModel').value.trim()) $('ollamaModel').value = model;

    chrome.storage.local.set({ ollamaUrl: url, ollamaModel: model, basicMode: basic }, () => {
      toast('Settings saved ✓');
      updateBasicModeBanner(basic);
      checkOllama();
    });
  });

  // ── Test Ollama ──
  $('btn-test-ollama')?.addEventListener('click', () => {
    const url   = normalizeOllamaUrl($('ollamaUrl')?.value || '');
    const model = ($('ollamaModel')?.value || '').trim() || 'gemma3:1b';
    if ($('ollamaUrl')) $('ollamaUrl').value = url;

    const dot = $('ollama-dot');
    const txt = $('ollama-text');
    if (dot) dot.className   = 'dot pulse';
    if (txt) txt.textContent = 'Checking Ollama…';

    chrome.storage.local.set({ ollamaUrl: url, ollamaModel: model }, () => {
      chrome.runtime.sendMessage({ action: 'PING_OLLAMA' }, res => {
        const ml = $('model-list');
        if (res && res.ok) {
          const models = res.models || [];
          if (ml) {
            ml.innerHTML = models.length
              ? 'Available models:<br>' + models.map(m => `<span>${escHtml(m)}</span>`).join('  ')
              : 'Connected — no models listed.';
          }
          toast(`Ollama reachable · ${models.length} model(s)`);
          checkOllama();
        } else {
          if (ml) ml.textContent = 'Cannot reach Ollama: ' + (res?.error || 'unknown error');
          toast('Cannot connect to Ollama', 'warn');
          if (dot) dot.className   = 'dot red';
          if (txt) txt.textContent = 'Ollama offline — ' + (res?.error || 'not reachable');
        }
      });
    });
  });

  // ── Basic mode toggle ──
  $('basicMode')?.addEventListener('change', function () {
    updateBasicModeBanner(this.checked);
    checkOllama();
  });

  // ── Onboarding ──
  function openOnboarding() {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
  $('btn-open-onboarding')?.addEventListener('click', openOnboarding);
  $('btn-open-onboarding-2')?.addEventListener('click', openOnboarding);

  // ── Memory controls ──
  $('btn-refresh-memory')?.addEventListener('click', () => {
    refreshMemory();
    toast('Memory refreshed ✓');
  });

  $('btn-clear-memory')?.addEventListener('click', () => {
    if (!confirm('Clear all saved answers? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ action: 'CLEAR_MEMORY' }, () => {
      refreshMemory();
      toast('Memory cleared ✓');
    });
  });

  // ── Stop flow ──
  $('btn-stop-fill')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CANCEL_FLOW' }, () => {
      applyFlowState({
        status:   'stopped',
        step:     0,
        maxSteps: 12,
        filled:   parseInt($('flow-filled')?.textContent || '0', 10),
        message:  'Stop requested — waiting for current step to finish…',
        log:      [],
      });
      toast('Stop signal sent', 'warn', 3000);
    });
  });

  // ── Fill Page ──
  $('btn-fill-page')?.addEventListener('click', async () => {
    if (isStartingFlow) return;

    const current = await new Promise(resolve => {
      chrome.storage.local.get(['flowState'], d => resolve(d.flowState));
    });
    if (current && current.status === 'running') {
      toast('Already running — use Stop to cancel', 'warn', 3000);
      return;
    }

    isStartingFlow = true;

    applyFlowState({
      status:    'running',
      step:      0,
      maxSteps:  12,
      filled:    0,
      message:   'Connecting to page…',
      log:       [],
      startedAt: Date.now(),
      stats:     { profile: 0, rule: 0, ai: 0, memory: 0, skipped: 0 },
    });

    try {
      const url   = normalizeOllamaUrl($('ollamaUrl')?.value || '');
      const model = ($('ollamaModel')?.value || '').trim() || 'gemma3:1b';
      chrome.storage.local.set({ ollamaUrl: url, ollamaModel: model });

      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('No active tab found');

      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
        .catch(() => {});

      await delay(300);

      chrome.tabs.sendMessage(tab.id, { action: 'RUN_MULTI_STEP_FLOW', maxSteps: 12 }, result => {
        if (chrome.runtime.lastError) {
          applyFlowState({
            status:   'error',
            step:     0,
            maxSteps: 12,
            filled:   0,
            message:  'Could not reach page — try refreshing it first.',
            log:      ['✗ ' + (chrome.runtime.lastError.message || 'Connection error')],
          });
          toast('Could not reach page — try refreshing.', 'warn');
          return;
        }

        if (!result) return;

        if (result.stoppedAtSubmit) {
          toast(`✓ Ready to submit · ${result.totalFilled || 0} fields filled`);
        } else if (result.ok) {
          toast(`Flow finished · ${result.totalFilled || 0} fields filled`);
        } else if (result.error === 'Cancelled by user') {
          toast('Stopped.', 'warn', 2000);
        } else if (result.error) {
          toast(result.error, 'warn');
        }
      });
    } catch (err) {
      applyFlowState({
        status:   'error',
        step:     0,
        maxSteps: 12,
        filled:   0,
        message:  err.message || String(err),
        log:      ['✗ ' + (err.message || String(err))],
      });
      toast(err.message || String(err), 'warn');
    } finally {
      isStartingFlow = false;
    }
  });

  // ── Names Only ──
  $('btn-fill-names')?.addEventListener('click', async () => {
    const first = $('firstName')?.value.trim() || '';
    const last  = $('lastName')?.value.trim()  || '';

    if (!first && !last) {
      toast('Set your name in the Profile tab first', 'warn');
      return;
    }

    const profile = {
      firstName: first,
      lastName:  last,
      fullName:  [first, last].filter(Boolean).join(' '),
    };
    chrome.storage.local.set({ firstName: first, lastName: last });

    try {
      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('No active tab found');

      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
        .catch(() => {});

      chrome.tabs.sendMessage(tab.id, { action: 'FILL_NAME_ONLY', profile }, res => {
        if (chrome.runtime.lastError || !res) {
          toast('Could not reach page. Try refreshing.', 'warn');
          return;
        }
        if (res.status === 'ok' && res.filled > 0) {
          toast(`Filled ${res.filled} name field${res.filled !== 1 ? 's' : ''} ✓`);
        } else {
          toast('No name fields found.', 'warn');
        }
      });
    } catch (e) {
      toast(e.message || String(e), 'warn');
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // BUG #3 FIX: hide stop button immediately so it never flashes before
  // restoreFlowState() resolves its async storage read
  const stopBtn = $('btn-stop-fill');
  if (stopBtn) stopBtn.style.display = 'none';

  initTabs();
  initPopupSkillsEditor();
  initLiveListeners();
  initButtons();
  loadFormData();       // calls renderProfileHints() internally (BUG #4 FIX)
  restoreFlowState();
  checkOllama();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}