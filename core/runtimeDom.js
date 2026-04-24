'use strict';

function isElement(value) {
  return value instanceof Element;
}

function isFakeCombo(el) {
  if (!isElement(el)) return false;
  const role = (el.getAttribute('role') || '').toLowerCase();
  const hasPopup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
  return role === 'combobox' || hasPopup === 'listbox';
}

function getOptionText(el) {
  return (
    el.getAttribute('aria-label') ||
    el.innerText ||
    el.textContent ||
    el.value ||
    el.getAttribute('data-testid') ||
    ''
  ).replace(/\s+/g, ' ').trim();
}

function getRadioLikeOptions(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(
    'input[type="radio"], [role="radio"], button, label, [data-testid*="radio"], ' +
    '[class*="radio"], [class*="Radio"], [class*="option"], [class*="Option"], ' +
    '[class*="card"], [class*="Card"]'
  )).filter(isVisible).map(el => {
    let text = '';
    if (el.matches('input[type="radio"]')) {
      const rid = el.id;
      const lbl = rid ? document.querySelector(`label[for="${CSS.escape(rid)}"]`) : null;
      text = (lbl ? lbl.innerText : el.value || '').trim();
    } else {
      text = getOptionText(el);
    }
    return { el, text };
  }).filter(x => x.text && x.text.length < 200);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getPageText() {
  return (document.body?.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isVisible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function getBtnText(btn) {
  return (
    (btn.innerText || btn.textContent || btn.value || btn.getAttribute('aria-label') || '')
      .trim()
      .toLowerCase()
  );
}

function getVisibleButtons() {
  return Array.from(
    document.querySelectorAll('button, input[type="button"], input[type="submit"]')
  ).filter(el => isVisible(el));
}

function isSubmitButton(btn) {
  if (btn.dataset?.testid === 'submit-application-button') return true;
  const text = getBtnText(btn);
  return (
    text.includes('submit your application') ||
    text === 'submit' ||
    text.includes('submit application')
  );
}

function isContinueButton(btn) {
  const testId = btn.dataset?.testid || '';
  if (testId === 'continue-button' || /^hp-continue-button/.test(testId)) return true;
  const text = getBtnText(btn);
  return (
    text === 'continue' ||
    text === 'next' ||
    text.includes('continue') ||
    text.includes('next') ||
    text.includes('apply anyway') ||
    text.includes('continue applying') ||
    text.includes('review application') ||
    text === 'review'
  );
}

function findSubmitButton() {
  const smartApplyButton = document.querySelector("button[data-testid='submit-application-button']");
  if (smartApplyButton && isVisible(smartApplyButton)) return smartApplyButton;
  return getVisibleButtons().find(isSubmitButton) || null;
}

function findContinueButton() {
  for (const selector of [
    "button[data-testid='continue-button']",
    "button[data-testid*='hp-continue-button']",
    "div[data-testid='resume-selection-footer'] button",
  ]) {
    const el = document.querySelector(selector);
    if (el && isVisible(el)) return el;
  }

  const buttons = getVisibleButtons();
  for (const btn of buttons) {
    if (isSubmitButton(btn)) continue;
    if (isContinueButton(btn)) return btn;
  }

  return null;
}

function findAnyNavigationButton() {
  const navPattern = /\b(continue|next|proceed|apply|forward|review|submit|go)\b/;
  const skipPattern = /\b(back|previous|cancel|close|sign\s*in|log\s*in|save\s*draft|delete|remove)\b/;
  const candidates = Array.from(document.querySelectorAll(
    'button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]'
  ));

  for (const btn of candidates) {
    const style = window.getComputedStyle(btn);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (btn.disabled) continue;
    const text = getBtnText(btn);
    if (!text) continue;
    if (skipPattern.test(text)) continue;
    if (navPattern.test(text)) return btn;
  }

  return null;
}

async function findAnyNavigationButtonWithRetry(timeout = 800, interval = 250) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const btn = findContinueButton() || findAnyNavigationButton();
    if (btn) return btn;
    await sleep(interval);
  }
  return null;
}

function findApplyAnywayButton() {
  return getVisibleButtons().find(btn => getBtnText(btn).includes('apply anyway')) || null;
}

function clickElement(el) {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  } catch (_) {}
  try {
    el.click();
    return true;
  } catch (_) {}
  try {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  } catch (_) {}
  return false;
}

function waitForDomChange(previousSnapshot, timeout = 2500) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeout);
    const observer = new MutationObserver(() => {
      const now = (document.body?.innerText || '').slice(0, 2000).replace(/\s+/g, ' ').toLowerCase();
      if (now !== previousSnapshot) finish(true);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function safeNavigate(btn, beforeSnapshot) {
  if (!btn) return false;
  clickElement(btn);
  await sleep(250);
  await waitForDomChange(beforeSnapshot, 1800);
  await sleep(100);
  return true;
}

Object.assign(globalThis, {
  isElement,
  isFakeCombo,
  getOptionText,
  getRadioLikeOptions,
  sleep,
  getPageText,
  isVisible,
  getBtnText,
  getVisibleButtons,
  isSubmitButton,
  isContinueButton,
  findSubmitButton,
  findContinueButton,
  findAnyNavigationButton,
  findAnyNavigationButtonWithRetry,
  findApplyAnywayButton,
  clickElement,
  waitForDomChange,
  safeNavigate,
});
