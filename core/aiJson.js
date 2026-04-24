'use strict';

(function initAiJson(globalScope) {
  function stripMarkdownCodeFences(text) {
    return String(text || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  function extractJsonObject(text) {
    const cleaned = stripMarkdownCodeFences(text);
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
        continue;
      }

      if (ch === '}') {
        if (depth > 0) depth--;
        if (depth === 0 && start !== -1) {
          return cleaned.slice(start, i + 1);
        }
      }
    }

    throw new Error('No JSON object found in AI response');
  }

  function buildParseError(error, rawText, cleanedText, jsonText) {
    const err = error instanceof Error ? error : new Error(String(error || 'Unknown AI JSON parse error'));
    err.rawResponse = rawText;
    err.cleanedResponse = cleanedText;
    err.jsonText = jsonText;
    return err;
  }

  function parseJsonObject(rawText) {
    const raw = String(rawText || '');
    const cleaned = stripMarkdownCodeFences(raw);
    let jsonText = '';

    try {
      jsonText = extractJsonObject(cleaned);
      return {
        rawText: raw,
        cleanedText: cleaned,
        jsonText,
        parsed: JSON.parse(jsonText),
      };
    } catch (error) {
      throw buildParseError(error, raw, cleaned, jsonText);
    }
  }

  function parseJsonObjectSequence(rawText) {
    const raw = String(rawText || '');
    const lines = raw.split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
    const parsedItems = [];

    for (const line of lines) {
      try {
        parsedItems.push(JSON.parse(line));
      } catch (_) {}
    }

    if (parsedItems.length) {
      return {
        rawText: raw,
        cleanedText: raw.trim(),
        jsonText: '',
        parsedItems,
      };
    }

    const single = parseJsonObject(raw);
    return {
      rawText: single.rawText,
      cleanedText: single.cleanedText,
      jsonText: single.jsonText,
      parsedItems: [single.parsed],
    };
  }

  globalScope.AiJson = {
    stripMarkdownCodeFences,
    extractJsonObject,
    parseJsonObject,
    parseJsonObjectSequence,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
