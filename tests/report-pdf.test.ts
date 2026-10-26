import { describe, expect, it, vi } from 'vitest';
import { renderReportPdf } from '../server/report-pdf';

describe('report PDF renderer', () => {
  it('uses the installed browser channel and prints A4 with page numbers', async () => {
    const pdf = vi.fn(async () => Buffer.from('%PDF test'));
    const setContent = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({ setDefaultTimeout: vi.fn(), route: vi.fn().mockResolvedValue(undefined), setContent, pdf }));
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ newPage, close }));
    const browser = { launch } as any;
    const result = await renderReportPdf('<html><body>안내</body></html>', browser);
    expect(launch).toHaveBeenCalledWith({ channel: 'msedge', headless: true });
    expect(pdf).toHaveBeenCalledWith(expect.objectContaining({ format: 'A4', printBackground: true, displayHeaderFooter: true }));
    expect(Buffer.from(result).toString()).toContain('%PDF');
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns a useful error when both browser channels are missing', async () => {
    const browser = { launch: vi.fn().mockRejectedValue(new Error('missing')) } as any;
    await expect(renderReportPdf('<p>시험</p>', browser)).rejects.toThrow('Microsoft Edge 또는 Chrome');
    expect(browser.launch).toHaveBeenCalledTimes(2);
  });

  it('prints the ranking layout at the reference slide size', async () => {
    const pdf = vi.fn(async () => Buffer.from('%PDF landscape'));
    const browser = { launch: vi.fn(async () => ({ newPage: vi.fn(async () => ({ setDefaultTimeout: vi.fn(), route: vi.fn().mockResolvedValue(undefined), setContent: vi.fn(), pdf })), close: vi.fn() })) } as any;
    await renderReportPdf('<html><body>보고서</body></html>', browser, 'landscape');
    expect(pdf).toHaveBeenCalledWith(expect.objectContaining({ width: '10.833333in', height: '7.5in', preferCSSPageSize: true, printBackground: true }));
  });
});
