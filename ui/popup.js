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
const DEFAULT_OLLAMA_MODEL = 'phi3:mini';
const CONTENT_SCRIPT_FILES = [
  'core/stepRouter.js',
  'core/runtimeDom.js',
  'core/pageClassifier.js',
  'core/questionText.js',
  'core/questionRegistry.js',
  'core/jobContext.js',
  'core/flowState.js',
  'rules.js',
  'harvesters/generic.js',
  'harvesters/greenhouse.js',
  'harvesters/workday.js',
  'harvesters/lever.js',
  'harvesters/smartapply.js',
  'core/logger.js',
  'core/answerPipeline.js',
  'core/applyAndVerify.js',
  'core/flowRunner.js',
  'content.js',
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Connection error'));
        return;
      }
      resolve(response);
    });
  });
}

async function inspectQfRuntime(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        qfLoaded: !!globalThis.__qfLoaded,
        flowRunnerLoaded: !!globalThis.__qfFlowRunnerLoaded,
        isIndeedPageLoaded: typeof globalThis.isIndeedPage === 'function',
        classifyCurrentPageLoaded: typeof globalThis.classifyCurrentPage === 'function',
        href: location.href,
      }),
    });
    return result?.result || {
      qfLoaded: false,
      flowRunnerLoaded: false,
      isIndeedPageLoaded: false,
      classifyCurrentPageLoaded: false,
      href: '',
    };
  } catch (_) {
    return {
      qfLoaded: false,
      flowRunnerLoaded: false,
      isIndeedPageLoaded: false,
      classifyCurrentPageLoaded: false,
      href: '',
    };
  }
}

async function ensureQfReady(tabId) {
  const runtime = await inspectQfRuntime(tabId);
  const missingCoreRuntime =
    !runtime.qfLoaded ||
    !runtime.flowRunnerLoaded ||
    !runtime.isIndeedPageLoaded ||
    !runtime.classifyCurrentPageLoaded;

  if (missingCoreRuntime) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES,
    });
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await sendTabMessage(tabId, { action: 'PING_QF' });
      if (response?.ok) return response;
    } catch (_) {}
    await delay(150);
  }

  throw new Error('Could not reach page — try refreshing it first.');
}

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

function getCurrentOllamaSettings() {
  const url = normalizeOllamaUrl($('ollamaUrl')?.value || '');
  const model = ($('ollamaModel')?.value || '').trim() || DEFAULT_OLLAMA_MODEL;
  const basicMode = $('basicMode')?.checked === true;
  return { url, model, basicMode };
}

function persistCurrentOllamaSettings() {
  const { url, model, basicMode } = getCurrentOllamaSettings();
  if ($('ollamaUrl')) $('ollamaUrl').value = url;
  if ($('ollamaModel') && !$('ollamaModel').value.trim()) $('ollamaModel').value = model;
  return new Promise(resolve => {
    chrome.storage.local.set({ ollamaUrl: url, ollamaModel: model, basicMode }, () => resolve({ url, model, basicMode }));
  });
}

function formatCountryLabel(value) {
  const country = String(value || '').trim();
  return country || 'your main country';
}

function updateEligibilityLabels(countryValue) {
  const country = formatCountryLabel(countryValue);
  const workAuthLabel = $('workAuth-label');
  const workAuthSub = $('workAuth-sub');
  const sponsorshipLabel = $('sponsorship-label');
  const sponsorshipSub = $('sponsorship-sub');

  if (workAuthLabel) workAuthLabel.textContent = `Authorized to work in ${country}`;
  if (workAuthSub) workAuthSub.textContent = `Used for work authorization questions for ${country}. Other countries default to No.`;
  if (sponsorshipLabel) sponsorshipLabel.textContent = `Needs visa sponsorship in ${country}`;
  if (sponsorshipSub) sponsorshipSub.textContent = `Used for sponsorship questions for ${country}.`;
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
      if (tab.dataset.tab === 'logs')   loadSessionLogs();
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
  if (text.startsWith('[Questions]'))                return 'info';
  if (text.startsWith('[AI]'))                       return 'nav';
  if (text.startsWith('[Rule]') || text.startsWith('[Profile]') || text.startsWith('[Default]') || text.startsWith('[Memory]')) return 'ok';
  if (text.startsWith('[Skip]'))                     return 'warn';
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

function stripRequiredMark(text) {
  return String(text || '').replace(/\s+\*+$/, '').trim();
}

function truncateText(text, max = 140) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return '';
  return cleanText.length > max ? `${cleanText.slice(0, max - 1)}…` : cleanText;
}

function parseBoolLine(text, prefix) {
  const raw = String(text || '');
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw.trim();
  const match = rest.match(/^(true|false)\s*(?:\((.*)\))?$/i);
  return {
    value: /^true$/i.test(match?.[1] || ''),
    details: (match?.[2] || '').trim(),
  };
}

function parseFlowReview(lines = []) {
  const questions = new Map();
  const generalIssues = [];
  const blockerWarnings = [];
  const navIssues = [];
  let current = null;

  const ensureQuestion = label => {
    const key = stripRequiredMark(label);
    if (!questions.has(key)) {
      questions.set(key, {
        label: key,
        required: false,
        chosenAnswer: '',
        applied: false,
        source: '',
        status: 'pending',
        reason: '',
      });
    }
    return questions.get(key);
  };

  const extractQuoted = text => {
    const match = String(text || '').match(/'([^']+)'/);
    return match ? match[1].trim() : '';
  };

  const parseQuestionLine = text => {
    const match = String(text || '').match(/^\[Questions\]\s+([^:]+):\s+'([^']+)'(?:\s+opts=\[(.*)\])?/);
    if (!match) return null;
    const [, type, label, optionsRaw] = match;
    return {
      type: String(type || '').trim(),
      label: String(label || '').trim(),
      options: String(optionsRaw || '').trim(),
    };
  };

  const findQuestionByPrefix = (label, createIfMissing = false) => {
    const cleanLabel = stripRequiredMark(label);
    if (!cleanLabel) return null;
    if (questions.has(cleanLabel)) return questions.get(cleanLabel);
    for (const [key, value] of questions.entries()) {
      if (key.startsWith(cleanLabel) || cleanLabel.startsWith(key)) return value;
    }
    return createIfMissing ? ensureQuestion(cleanLabel) : null;
  };

  const reasonMatchesQuestionType = (item, reason) => {
    const type = String(item?.type || '').toLowerCase();
    const text = String(reason || '').toLowerCase();
    if (!type || !text) return true;

    if (text.includes('textarea')) return type === 'textarea';
    if (text.includes('checkbox')) return type === 'checkbox_group' || type === 'checkbox-group' || type === 'consent_checkbox_group';
    if (text.includes('radio')) return type === 'radio' || type === 'aria-radio';
    if (text.includes('numeric')) return type === 'number';
    if (text.includes('select')) return type === 'select';

    return true;
  };

  for (const line of lines) {
    const questionInfo = parseQuestionLine(line);
    if (questionInfo) {
      current = ensureQuestion(questionInfo.label);
      current.type = questionInfo.type;
      current.options = questionInfo.options;
      continue;
    }

    if (line.startsWith('[Rule]') && current) {
      current.chosenAnswer = extractQuoted(line);
      current.source = 'rule';
      continue;
    }

    if (line.startsWith('[Default]') && current) {
      current.chosenAnswer = extractQuoted(line);
      current.source = 'default';
      continue;
    }

    if (line.startsWith('[Profile]') && current) {
      current.chosenAnswer = extractQuoted(line);
      current.source = 'profile';
      continue;
    }

    if (line.startsWith('[Memory]') && current) {
      current.chosenAnswer = extractQuoted(line);
      current.source = 'memory';
      continue;
    }

    if (line.startsWith('[AI]') && current) {
      const answerMatch = String(line).match(/→\s*(.+)$/);
      current.chosenAnswer = answerMatch ? answerMatch[1].trim() : extractQuoted(line);
      current.source = 'ai';
      continue;
    }

    if (line.startsWith('[Skip] no answer found for: ')) {
      const label = extractQuoted(line);
      const item = findQuestionByPrefix(label, true);
      if (item) {
        item.status = 'skipped';
        item.reason = 'No usable answer was found';
        item.chosenAnswer = '__SKIP__';
      }
      current = item;
      continue;
    }

    if (line.startsWith('[Skip] ')) {
      const label = extractQuoted(line);
      const item = findQuestionByPrefix(label, true);
      if (item) {
        item.status = 'skipped';
        item.reason = item.reason || 'Skipped by the runner';
        if (!item.chosenAnswer) item.chosenAnswer = '__SKIP__';
      }
      current = item;
      continue;
    }

    if (line.startsWith('✓ Selected (retry): ') && current) {
      current.applied = true;
      current.status = 'ok';
      current.reason = '';
      continue;
    }

    if (line.startsWith('✓ Selected: ') && current) {
      current.applied = true;
      current.status = 'ok';
      current.reason = '';
      continue;
    }

    if (line.startsWith('⚠ Applied but verification failed: ')) {
      const failureMatch = String(line).match(/:\s*'([^']+)'\s*→\s*'([^']+)'/);
      const item = findQuestionByPrefix(failureMatch?.[1] || '', true);
      if (item) {
        item.status = 'blocked';
        item.reason = 'Applied answer did not verify on the page';
        item.chosenAnswer = failureMatch?.[2] || item.chosenAnswer;
      }
      current = item || current;
      continue;
    }

    if (line.startsWith('✗ Failed: ')) {
      const failureMatch = String(line).match(/^✗ Failed:\s*(.*?)\s+—\s+(.*)$/);
      const label = failureMatch?.[1] || '';
      const reason = failureMatch?.[2] || 'Failed';
      const item = findQuestionByPrefix(label, false);
      if (item && reasonMatchesQuestionType(item, reason)) {
        item.status = 'blocked';
        item.reason = reason;
      } else {
        generalIssues.push(`Failed: ${label ? `${label} — ` : ''}${reason}`);
      }
      current = item || current;
      continue;
    }

    if (line.startsWith('⚠ Blocking fields remain: ')) {
      blockerWarnings.push(line.replace(/^⚠\s*/, '').trim());
      continue;
    }

    if (line.startsWith('✗ Skipping — ')) {
      generalIssues.push(line.replace(/^✗\s*/, '').trim());
      continue;
    }

    if (line.includes('Navigation stuck after clicking Continue')) {
      navIssues.push('Continue did not advance the page');
      continue;
    }

    if (line.startsWith('✗ No Continue button') || line.includes('No Continue button found')) {
      navIssues.push(line.replace(/^✗\s*/, '').trim());
    }
  }

  const items = [...questions.values()];
  const needsInput = items
    .filter(item => item.status === 'blocked' || item.status === 'skipped' || (!item.applied && item.chosenAnswer === '__SKIP__'))
    .map(item => {
      const status = item.status === 'blocked' ? 'blocked' : 'skipped';
      const reason = item.reason || (status === 'blocked'
        ? 'Still blocked on the page'
        : 'No usable answer was generated');
      return { ...item, status, reason };
    })
    .sort((a, b) => {
      const rank = { blocked: 0, skipped: 1, ok: 2 };
      return (rank[a.status] || 9) - (rank[b.status] || 9);
    });

  return {
    needsInput,
    successCount: items.filter(item => item.applied && item.status !== 'blocked').length,
    blockedCount: needsInput.filter(item => item.status === 'blocked').length,
    skippedCount: needsInput.filter(item => item.status === 'skipped').length,
    navBlock: navIssues[0] || '',
    blockerWarning: blockerWarnings[0] || '',
    generalIssue: generalIssues[0] || '',
  };
}

function renderReviewPanel(state = {}) {
  const card = $('review-card');
  const title = $('review-title');
  const subtitle = $('review-subtitle');
  const summary = $('review-summary');
  const list = $('review-list');
  const restartBtn = $('btn-restart-fill');
  if (!card || !title || !subtitle || !summary || !list || !restartBtn) return;

  const { status = 'idle', log = [] } = state;
  const review = parseFlowReview(log);
  const hasRun = Array.isArray(log) && log.length > 0;
  const hasIssues = review.needsInput.length > 0 || !!review.navBlock || !!review.blockerWarning || !!review.generalIssue;

  card.classList.toggle('show', hasRun);
  restartBtn.disabled = status === 'running';

  if (!hasRun) {
    summary.innerHTML = '';
    list.innerHTML = '';
    return;
  }

  if (status === 'running') {
    title.textContent = 'Current run';
    subtitle.textContent = hasIssues
      ? 'Watching for questions that still need your input.'
      : 'We’ll surface anything that needs a manual answer here.';
  } else if (hasIssues) {
    title.textContent = 'Needs your input';
    subtitle.textContent = 'Answer these on the page, then click Restart Fill to continue from there.';
  } else {
    title.textContent = 'Everything looked clear';
    subtitle.textContent = 'No skipped or blocked questions were detected in the latest run.';
  }

  const pills = [];
  if (review.blockedCount) pills.push({ cls: 'is-danger', text: `${review.blockedCount} blocked` });
  if (review.skippedCount) pills.push({ cls: 'is-warn', text: `${review.skippedCount} needs answer` });
  if (review.successCount) pills.push({ cls: 'is-ok', text: `${review.successCount} applied` });
  if (!pills.length) pills.push({ cls: '', text: 'Waiting for field results' });

  summary.innerHTML = pills
    .map(pill => `<span class="review-pill ${pill.cls}">${escHtml(pill.text)}</span>`)
    .join('');

  const fragments = [];
  if (review.navBlock) {
    fragments.push(
      `<div class="review-item">` +
        `<div class="review-item-top">` +
          `<div class="review-question">Continue was blocked</div>` +
          `<span class="review-status is-blocked">blocked</span>` +
        `</div>` +
        `<div class="review-meta">${escHtml(truncateText(review.navBlock, 240))}</div>` +
      `</div>`
    );
  }

  if (!review.navBlock && review.blockerWarning) {
    fragments.push(
      `<div class="review-item">` +
        `<div class="review-item-top">` +
          `<div class="review-question">Some questions may still need attention</div>` +
          `<span class="review-status is-skipped">check page</span>` +
        `</div>` +
        `<div class="review-meta">${escHtml(truncateText(review.blockerWarning, 240))}</div>` +
      `</div>`
    );
  }

  if (!review.navBlock && !review.blockerWarning && review.generalIssue) {
    fragments.push(
      `<div class="review-item">` +
        `<div class="review-item-top">` +
          `<div class="review-question">Run note</div>` +
          `<span class="review-status is-skipped">note</span>` +
        `</div>` +
        `<div class="review-meta">${escHtml(truncateText(review.generalIssue, 240))}</div>` +
      `</div>`
    );
  }

  if (review.needsInput.length) {
    fragments.push(...review.needsInput.slice(0, 6).map(item => {
      const answer = item.chosenAnswer && item.chosenAnswer !== '__SKIP__'
        ? `<div class="review-answer"><span class="review-answer-label">Tried</span> ${escHtml(truncateText(item.chosenAnswer, 180))}</div>`
        : '';
      const statusText = item.status === 'blocked' ? 'blocked' : 'needs answer';
      const statusClass = item.status === 'blocked' ? 'is-blocked' : 'is-skipped';
      return (
        `<div class="review-item">` +
          `<div class="review-item-top">` +
            `<div class="review-question">${escHtml(truncateText(item.label, 220))}</div>` +
            `<span class="review-status ${statusClass}">${statusText}</span>` +
          `</div>` +
          `<div class="review-meta">${escHtml(truncateText(item.reason || 'Needs a manual answer', 220))}</div>` +
          answer +
        `</div>`
      );
    }));
  } else {
    fragments.push('<div class="review-empty">Nothing is waiting on you right now. If the page is ready, you can keep going or run Fill again.</div>');
  }

  list.innerHTML = fragments.join('');
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

  const modeEl = $('flow-mode');
  if (modeEl && !modeEl.textContent.trim()) {
    modeEl.textContent = $('basicMode')?.checked ? 'Basic' : 'AI';
  }

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
  else renderLog([]);
  renderReviewPanel(state);

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
  $('country')?.addEventListener('input', e => updateEligibilityLabels(e.target.value));
  [
    'firstName', 'lastName', 'email', 'phone',
    'city', 'province', 'country', 'postal',
    'headline', 'experienceYears', 'salary',
    'summary', 'portfolio', 'linkedin', 'education', 'educationLevel'
  ].forEach(id => {
    $(id)?.addEventListener('input', () => renderProfileHints());
    $(id)?.addEventListener('change', () => renderProfileHints());
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
      renderProfileHints();
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
  renderProfileHints();
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
      renderProfileHints();
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
  'education', 'educationLevel',
  'workAuth', 'sponsorship',
  'pref_remote', 'pref_relocate',
  'skills',
  'experience',
];

const SETTINGS_KEYS = ['ollamaUrl', 'ollamaModel', 'basicMode'];

function updateBasicModeBanner(on) {
  const banner = $('basic-mode-banner');
  if (banner) banner.classList.toggle('show', !!on);

  const modeEl = $('flow-mode');
  if (modeEl) modeEl.textContent = on ? 'Basic' : 'AI';
}

function loadFormData() {
  chrome.storage.local.get([...PROFILE_KEYS, ...SETTINGS_KEYS], data => {
    if (data.experience && !data.experienceYears) data.experienceYears = data.experience;

    const textFields = [
      'firstName', 'lastName', 'email', 'phone',
      'city', 'province', 'country', 'postal',
      'headline', 'experienceYears', 'salary',
      'summary', 'portfolio', 'linkedin',
      'education', 'educationLevel',
    ];
    textFields.forEach(key => {
      const el = $(key);
      if (el && data[key] !== undefined && data[key] !== '') el.value = data[key];
    });
    updateEligibilityLabels(data.country || '');

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

  const readinessEl = $('profile-readiness-text');
  const scoreEl = $('profile-score-num');
  const checkpoints = [
    $('firstName')?.value.trim(),
    $('lastName')?.value.trim(),
    $('email')?.value.trim(),
    $('phone')?.value.trim(),
    $('city')?.value.trim(),
    $('headline')?.value.trim(),
    $('experienceYears')?.value.trim() && $('experienceYears')?.value.trim() !== '0',
    $('salary')?.value.trim(),
    $('summary')?.value.trim(),
    $('education')?.value.trim(),
    _skills.length > 0,
  ];
  const score = Math.round((checkpoints.filter(Boolean).length / checkpoints.length) * 100);
  if (scoreEl) scoreEl.textContent = `${score}%`;

  if (!warnings.length) {
    if (readinessEl) readinessEl.textContent = 'Profile looks strong. You should get better first-pass fills.';
    hintBox.innerHTML = '';
    // BUG #2 FIX: toggle both the class and inline style
    hintBox.classList.remove('show');
    hintBox.style.display = 'none';
    return;
  }

  if (readinessEl) {
    readinessEl.textContent = warnings.length <= 2
      ? `${warnings.length} small gap${warnings.length === 1 ? '' : 's'} left.`
      : `${warnings.length} fields could still weaken answers.`;
  }

  // BUG #2 FIX: add 'show' class so the CSS flexbox rule applies
  hintBox.classList.add('show');
  hintBox.style.display = '';
  hintBox.innerHTML = warnings.slice(0, 4).map(w =>
    `<div class="profile-hint-row">${escHtml(w)}</div>`
  ).join('');
}

// ─── Ollama status ────────────────────────────────────────────────────────────

function checkOllama() {
  const dot = $('ollama-dot');
  const txt = $('ollama-text');
  if (!dot || !txt) return;

  const { url, model, basicMode: basicOn } = getCurrentOllamaSettings();
  const ml = $('model-list');

  if (basicOn) {
    dot.className   = 'dot yellow';
    txt.textContent = 'Basic Mode — AI disabled';
    if (ml) ml.textContent = 'AI is off in Basic Mode.';
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
        const models = Array.isArray(res.models) ? res.models : [];
        if (res.modelAvailable === false) {
          dot.className = 'dot yellow';
          txt.textContent = `Ollama reachable — selected model missing: ${model}`;
          if (ml) {
            ml.innerHTML = models.length
              ? `Available models:<br>${models.map(m => `<span>${escHtml(m)}</span>`).join('  ')}`
              : 'Connected — no models listed.';
          }
          return;
        }
        dot.className = 'dot green';
        txt.textContent = `Ollama ready · model ${model}`;
        if (ml && models.length) {
          ml.innerHTML = 'Available models:<br>' + models.map(m => `<span>${escHtml(m)}</span>`).join('  ');
        }
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
  chrome.storage.local.get(['qf_memory'], data => {
    const mem  = data.qf_memory || {};
    const list = $('memory-list');
    const persEl = $('mem-persistent');
    const sessEl = $('mem-session');
    if (persEl) persEl.textContent = Object.keys(mem).length;
    if (sessEl) sessEl.textContent = 0;
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
      const displayQuestion = value?.questionKey || question;

      const item = document.createElement('div');
      item.className = 'memory-item';
      item.innerHTML =
        `<div class="memory-q">${escHtml(String(displayQuestion).slice(0, 80))}</div>` +
        `<div class="memory-a">${escHtml(String(answer).slice(0, 80))}</div>` +
        `<div class="memory-meta"><span class="${srcClass}">${srcLabel}</span></div>`;
      list.appendChild(item);
    });
  });
}

// ─── Logs tab ─────────────────────────────────────────────────────────────────

let _logsSessions        = [];
let _logsSelectedSession = null;
let _logsErrOnly         = false;

function _relTime(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60000)          return 'just now';
  if (d < 3600000)        return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000)       return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function _dlClass(text) {
  if (!text) return '';
  if (text.startsWith('✗') || text.startsWith('🛑')) return 'is-error';
  if (text.startsWith('⚠')) return 'is-warn';
  if (text.startsWith('✓') || text.startsWith('🏁')) return 'is-ok';
  if (text.startsWith('→') || text.startsWith('–'))  return 'is-nav';
  if (text.startsWith('⊘')) return 'is-stop';
  return '';
}

function renderSessionList(sessions) {
  const listEl    = $('session-list');
  const emptyEl   = $('logs-empty-msg');
  const detailWrap = $('logs-detail-wrap');
  const exportBtn  = $('btn-export-logs');

  if (detailWrap) detailWrap.style.display = 'none';
  if (exportBtn)  exportBtn.style.display  = 'none';

  if (!sessions.length) {
    if (emptyEl)  emptyEl.style.display  = '';
    if (listEl)   listEl.style.display   = 'none';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  if (!listEl) return;
  listEl.style.display = '';
  listEl.innerHTML = '';

  sessions.forEach(session => {
    const card = document.createElement('div');
    const cls  = session.hasErrors ? 'has-errors' : `status-${session.status || 'done'}`;
    card.className = `session-card ${cls}`;

    const dur = (session.endTime && session.startTime)
      ? Math.round((session.endTime - session.startTime) / 1000) + 's'
      : '—';

    card.innerHTML =
      `<div class="session-row">` +
        `<span class="session-site">${escHtml(session.site || 'unknown')}</span>` +
        `<span class="session-badge ${escHtml(session.status || 'done')}">${escHtml(session.status || 'done')}</span>` +
      `</div>` +
      `<div class="session-meta">` +
        `${_relTime(session.startTime)} · ${escHtml(String(session.filled || 0))} filled · ` +
        `${escHtml(String(session.steps || 0))} steps · ${dur}` +
        (session.hasErrors ? ' · <span style="color:var(--danger)">⚠ errors</span>' : '') +
      `</div>`;

    card.addEventListener('click', () => showSessionDetail(session));
    listEl.appendChild(card);
  });
}

function renderLogEntries(log, errorsOnly) {
  const box = $('logs-detail-box');
  if (!box) return;

  const entries = errorsOnly
    ? (log || []).filter(t => _dlClass(t).includes('error') || _dlClass(t).includes('warn'))
    : (log || []);

  box.innerHTML = '';
  if (!entries.length) {
    const span = document.createElement('span');
    span.style.color = 'var(--muted)';
    span.textContent = errorsOnly ? 'No errors in this session.' : 'No log entries.';
    box.appendChild(span);
    return;
  }
  entries.forEach(text => {
    const span = document.createElement('span');
    span.className = 'dl-entry ' + _dlClass(text);
    span.textContent = text;
    box.appendChild(span);
  });
  box.scrollTop = box.scrollHeight;
}

function _renderDetail(session, errorsOnly) {
  if (session.fieldEntries && session.fieldEntries.length) {
    renderRichDetail(session, errorsOnly);
  } else {
    renderLogEntries(session.log || [], errorsOnly);
  }
}

function renderRichDetail(session, errorsOnly) {
  const box = $('logs-detail-box');
  if (!box) return;
  box.innerHTML = '';

  // ── Profile snapshot ──────────────────────────────────────────────────
  const snap = session.profileSnapshot;
  if (snap) {
    const section = document.createElement('div');
    section.className = 'snap-section';

    const title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = 'profile used';
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'snap-grid';

    const rows = [
      ['name',    snap.name],
      ['email',   snap.email],
      ['phone',   snap.phone],
      ['loc',     snap.location],
      ['title',   snap.headline],
      ['exp',     snap.experienceYears != null ? snap.experienceYears + ' yr' : null],
      ['auth',    snap.workAuth != null ? (snap.workAuth ? 'yes' : 'no') : null],
      ['sponsor', snap.sponsorship != null ? (snap.sponsorship ? 'yes (needs)' : 'no') : null],
      ['salary',  snap.salary || null],
      ['skills',  snap.skills ? String(snap.skills).slice(0, 90) : null],
    ].filter(([, v]) => v);

    rows.forEach(([k, v]) => {
      const keyEl = document.createElement('span');
      keyEl.className = 'snap-key';
      keyEl.textContent = k;
      const valEl = document.createElement('span');
      valEl.className = 'snap-val';
      valEl.textContent = String(v);
      grid.appendChild(keyEl);
      grid.appendChild(valEl);
    });

    section.appendChild(grid);
    box.appendChild(section);
  }

  // ── Field entries grouped by step ─────────────────────────────────────
  const entries = session.fieldEntries || [];
  const filtered = errorsOnly
    ? entries.filter(e => {
        const s = (e.source || '').toLowerCase();
        return s === 'error' || s === 'timeout' || s === 'network_error' || e.answer === '__SKIP__';
      })
    : entries;

  if (!filtered.length) {
    const span = document.createElement('span');
    span.style.color = 'var(--muted)';
    span.textContent = errorsOnly ? 'No errors in this session.' : 'No field entries recorded.';
    box.appendChild(span);
    box.scrollTop = 0;
    return;
  }

  // Group by step number
  const byStep = new Map();
  filtered.forEach(e => {
    const s = e.step ?? 0;
    if (!byStep.has(s)) byStep.set(s, []);
    byStep.get(s).push(e);
  });

  [...byStep.entries()].sort(([a], [b]) => a - b).forEach(([stepNum, stepEntries]) => {
    const grp = document.createElement('div');
    grp.className = 'step-group';

    const stepTitle = document.createElement('div');
    stepTitle.className = 'step-title';
    stepTitle.textContent = `Step ${stepNum + 1} — ${stepEntries.length} field${stepEntries.length !== 1 ? 's' : ''}`;
    grp.appendChild(stepTitle);

    stepEntries.forEach(e => {
      const rawSrc = (e.source || 'skipped').toLowerCase().replace('+memory', '');
      const srcKey = rawSrc === 'network_error' ? 'error' : rawSrc;
      const isSkip = e.answer === '__SKIP__' || rawSrc === 'skipped';
      const isErr  = rawSrc === 'error' || rawSrc === 'timeout' || rawSrc === 'network_error';
      const ansClass = isErr ? 'is-error' : isSkip ? 'skipped' : 'answered';
      const shortSrc = srcKey.length > 7 ? srcKey.slice(0, 7) : srcKey;

      const item = document.createElement('div');
      item.className = 'fe-item';

      const srcSpan = document.createElement('span');
      srcSpan.className = `fe-source ${srcKey}`;
      srcSpan.textContent = shortSrc;
      item.appendChild(srcSpan);

      const body = document.createElement('div');
      body.className = 'fe-body';

      const labelEl = document.createElement('div');
      labelEl.className = 'fe-label';
      labelEl.textContent = e.label || `(${e.type || 'field'})`;
      body.appendChild(labelEl);

      // Show options for select/radio types (helps debug why no match)
      if (e.options && e.options.length && ['select','radio','checkbox_group','number'].includes(e.type)) {
        const optsEl = document.createElement('div');
        optsEl.className = 'fe-opts';
        optsEl.textContent = 'opts: ' + e.options.join(' | ').slice(0, 80);
        body.appendChild(optsEl);
      }

      const valEl = document.createElement('div');
      valEl.className = `fe-value ${ansClass}`;
      valEl.textContent = isSkip ? '— skipped' : String(e.answer || '').slice(0, 80);
      body.appendChild(valEl);

      item.appendChild(body);
      grp.appendChild(item);
    });

    box.appendChild(grp);
  });

  box.scrollTop = 0;
}

function showSessionDetail(session) {
  _logsSelectedSession = session;
  _logsErrOnly = false;

  const listEl    = $('session-list');
  const detailWrap = $('logs-detail-wrap');
  const exportBtn  = $('btn-export-logs');

  if (listEl)    listEl.style.display    = 'none';
  if (detailWrap) detailWrap.style.display = '';
  if (exportBtn)  exportBtn.style.display  = '';

  $('filter-all')?.classList.add('active');
  $('filter-errors')?.classList.remove('active');

  _renderDetail(session, false);
}

function exportCurrentSession() {
  if (!_logsSelectedSession) return;
  try {
    const json = JSON.stringify({
      ..._logsSelectedSession,
      exportedAt: new Date().toISOString(),
      extension:  'FormPilot AI',
    }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `formpilot-${_logsSelectedSession.id || Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Session exported ✓');
  } catch (e) {
    toast('Export failed: ' + String(e.message || e), 'warn');
  }
}

function loadSessionLogs() {
  chrome.storage.local.get(['fp_sessions'], data => {
    _logsSessions = Object.values(data.fp_sessions || {})
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    renderSessionList(_logsSessions);
  });
}

function initLogsTab() {
  $('btn-refresh-logs')?.addEventListener('click', () => {
    loadSessionLogs();
    toast('Logs refreshed ✓');
  });

  $('btn-export-logs')?.addEventListener('click', exportCurrentSession);

  $('btn-clear-logs')?.addEventListener('click', () => {
    if (!confirm('Clear all debug logs? This cannot be undone.')) return;
    chrome.storage.local.remove(['fp_sessions'], () => {
      _logsSessions = [];
      _logsSelectedSession = null;
      renderSessionList([]);
      const dw = $('logs-detail-wrap');
      const eb = $('btn-export-logs');
      if (dw) dw.style.display = 'none';
      if (eb) eb.style.display = 'none';
      toast('Logs cleared ✓');
    });
  });

  $('btn-logs-back')?.addEventListener('click', () => {
    _logsSelectedSession = null;
    const listEl    = $('session-list');
    const detailWrap = $('logs-detail-wrap');
    const exportBtn  = $('btn-export-logs');
    const emptyEl   = $('logs-empty-msg');
    if (detailWrap) detailWrap.style.display = 'none';
    if (exportBtn)  exportBtn.style.display  = 'none';
    if (_logsSessions.length) {
      if (listEl)  listEl.style.display  = '';
      if (emptyEl) emptyEl.style.display = 'none';
    } else {
      if (listEl)  listEl.style.display  = 'none';
      if (emptyEl) emptyEl.style.display = '';
    }
  });

  $('filter-all')?.addEventListener('click', () => {
    _logsErrOnly = false;
    $('filter-all')?.classList.add('active');
    $('filter-errors')?.classList.remove('active');
    if (_logsSelectedSession) _renderDetail(_logsSelectedSession, false);
  });

  $('filter-errors')?.addEventListener('click', () => {
    _logsErrOnly = true;
    $('filter-errors')?.classList.add('active');
    $('filter-all')?.classList.remove('active');
    if (_logsSelectedSession) _renderDetail(_logsSelectedSession, true);
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
        educationLevel:  $('educationLevel')?.value.trim()  || '',
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
    persistCurrentOllamaSettings().then(({ basicMode }) => {
      toast('Settings saved ✓');
      updateBasicModeBanner(basicMode);
      checkOllama();
    });
  });

  // ── Test Ollama ──
  $('btn-test-ollama')?.addEventListener('click', () => {
    const dot = $('ollama-dot');
    const txt = $('ollama-text');
    if (dot) dot.className   = 'dot pulse';
    if (txt) txt.textContent = 'Checking Ollama…';

    persistCurrentOllamaSettings().then(({ model }) => {
      chrome.runtime.sendMessage({ action: 'PING_OLLAMA' }, res => {
        const ml = $('model-list');
        if (res && res.ok) {
          const models = res.models || [];
          const warning = res.warning || '';
          if (ml) {
            const modelText = models.length
              ? 'Available models:<br>' + models.map(m => `<span>${escHtml(m)}</span>`).join('  ')
              : 'Connected — no models listed.';
            ml.innerHTML = warning
              ? `${modelText}<br><span style="color:#ffaa33">${escHtml(warning)}</span>`
              : modelText;
          }
          if (res.modelAvailable === false) {
            toast(`Ollama reachable, but model "${model}" was not found`, 'warn');
          } else {
            toast(warning ? 'Backend reachable, but generation endpoints look unsupported' : `Ollama reachable · ${models.length} model(s)`, warning ? 'warn' : 'ok');
          }
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
    persistCurrentOllamaSettings().then(({ basicMode }) => {
      updateBasicModeBanner(basicMode);
      checkOllama();
      renderProfileHints();
    });
  });

  ['ollamaUrl', 'ollamaModel'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      persistCurrentOllamaSettings().then(() => checkOllama());
    });
    $(id)?.addEventListener('blur', () => {
      persistCurrentOllamaSettings().then(() => checkOllama());
    });
  });

  // ── Onboarding ──
  function openOnboarding() {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/onboarding.html') });
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
    chrome.storage.local.remove(['qf_memory'], () => {
      refreshMemory();
      toast('Memory cleared ✓');
    });
  });

  // ── Stop flow ──
  $('btn-stop-fill')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CANCEL_FLOW' }, () => {
      void chrome.runtime.lastError;
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
      await persistCurrentOllamaSettings();

      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('No active tab found');

      await ensureQfReady(tab.id);

      const result = await sendTabMessage(tab.id, { action: 'RUN_MULTI_STEP_FLOW', maxSteps: 12 });
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

  $('btn-restart-fill')?.addEventListener('click', () => {
    $('btn-fill-page')?.click();
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

      await ensureQfReady(tab.id);

      const res = await sendTabMessage(tab.id, { action: 'FILL_NAME_ONLY', profile });
      if (!res) {
        toast('Could not reach page. Try refreshing.', 'warn');
        return;
      }
      if (res.status === 'ok' && res.filled > 0) {
        toast(`Filled ${res.filled} name field${res.filled !== 1 ? 's' : ''} ✓`);
      } else {
        toast('No name fields found.', 'warn');
      }
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
  initLogsTab();
  loadFormData();       // calls renderProfileHints() internally (BUG #4 FIX)
  restoreFlowState();
  checkOllama();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
