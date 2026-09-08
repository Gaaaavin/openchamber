import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ 'cline-pass': { key: 'test-token' } }),
}));

import { fetchQuota } from './cline-pass.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Live-verified response shape of
// GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
const documentedPayload = {
  data: {
    limits: [
      { type: 'five_hour', percentUsed: 43, resetsAt: '2026-09-08T17:00:44.598174595Z' },
      { type: 'weekly', percentUsed: 17, resetsAt: '2026-09-13T17:00:44.598174595Z' },
      { type: 'monthly', percentUsed: 8, resetsAt: '2026-10-01T00:00:00Z' },
    ],
  },
  success: true,
};

describe('ClinePass quota provider', () => {
  it('maps documented limit kinds to 5h/weekly/monthly windows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(documentedPayload)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('cline-pass');
    expect(Object.keys(result.usage.windows)).toEqual(['5h', 'weekly', 'monthly']);
    expect(result.usage.windows['5h'].usedPercent).toBe(43);
    expect(result.usage.windows['5h'].remainingPercent).toBe(57);
    expect(result.usage.windows['5h'].windowSeconds).toBe(18_000);
    expect(result.usage.windows['5h'].resetAt).toBe(Date.parse('2026-09-08T17:00:44.598174595Z'));
    expect(result.usage.windows.weekly.usedPercent).toBe(17);
    expect(result.usage.windows.weekly.windowSeconds).toBe(604_800);
    expect(result.usage.windows.monthly.usedPercent).toBe(8);
    expect(result.usage.windows.monthly.windowSeconds).toBeNull();
  });

  it('ignores unknown limit types', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({ data: { limits: [{ type: 'quarterly', percentUsed: 5, resetsAt: '2026-10-01T00:00:00Z' }] } }),
    ));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('No quota data in response');
  });

  it('parses numeric-string percentUsed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({ data: { limits: [{ type: 'weekly', percentUsed: '51' }] } }),
    ));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(51);
  });

  for (const payload of [{ data: { limits: [] } }, { data: {} }, {}]) {
    it(`rejects ${JSON.stringify(payload)} without quota data`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

      const result = await fetchQuota();

      expect(result.ok).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.usage).toBeNull();
      expect(result.error).toBe('No quota data in response');
    });
  }

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Session expired — please re-authenticate with ClinePass');
  });

  it('surfaces non-401 API errors with status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 503');
  });

  it('reports invalid-response on JSON parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid response from provider');
  });
});
