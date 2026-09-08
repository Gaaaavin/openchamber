import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  asObject,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';

export const providerId = 'cline-pass';
export const providerName = 'ClinePass';
const aliases = ['cline-pass'];
const CLINE_USAGE_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits';

// Cline reports a rolling five-hour window, a rolling weekly window, and a
// calendar-month limit. Each window carries its duration so consumers can rank
// limits by how soon they run out; the calendar month has no fixed duration.
const WINDOW_KINDS = {
  five_hour: { key: '5h', windowSeconds: 5 * 60 * 60 },
  weekly: { key: 'weekly', windowSeconds: 7 * 24 * 60 * 60 },
  monthly: { key: 'monthly', windowSeconds: null }
};

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(CLINE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired — please re-authenticate with ClinePass'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];

    const windows = {};
    for (const item of limits) {
      const limit = asObject(item);
      if (!limit) continue;
      const kind = WINDOW_KINDS[limit.type];
      if (!kind) continue;
      const usedPercent = toNumber(limit.percentUsed);
      if (usedPercent === null) continue;
      windows[kind.key] = toUsageWindow({
        usedPercent,
        windowSeconds: kind.windowSeconds,
        resetAt: toTimestamp(limit.resetsAt)
      });
    }

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};
