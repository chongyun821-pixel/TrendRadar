import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserLaunch = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({ chromium: { launch: browserLaunch } }));

import { app } from '../server/app';

describe('PDF export route', () => {
  beforeEach(() => {
    browserLaunch.mockReset();
    const page = { route: vi.fn().mockResolvedValue(undefined), setDefaultTimeout: vi.fn(), setContent: vi.fn().mockResolvedValue(undefined), pdf: vi.fn().mockResolvedValue(Buffer.from('%PDF route test')) };
    browserLaunch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) });
  });

  it('returns PDF bytes from the mocked Edge browser', async () => {
    const response = await app.request('/api/report-export/pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html: '<!doctype html><html lang="ko"><body>보고서</body></html>' }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/pdf');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toContain('%PDF');
    expect(browserLaunch).toHaveBeenCalledWith({ channel: 'msedge', headless: true });
  });

  it('rejects active or remote content before launching a browser', async () => {
    const response = await app.request('/api/report-export/pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html: '<script>alert(1)</script>' }) });
    expect(response.status).toBe(400);
    expect(browserLaunch).not.toHaveBeenCalled();
  });

  it('rejects external CSS URLs and unquoted external src attributes', async () => {
    for (const html of ['<style>.x{background:url(https://example.com/a)}</style>', '<img src=https://example.com/a>', '<source src=ftp://example.com/a>', '<div style="background:url(//example.com/a)"></div>']) {
      const response = await app.request('/api/report-export/pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html }) });
      expect(response.status).toBe(400);
    }
    expect(browserLaunch).not.toHaveBeenCalled();
  });
});
