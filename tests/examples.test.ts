import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { createExample, WORLD_BANK_CASE } from '../server/examples';
it('creates the image-based case with its source photo, constraints and explicit unknowns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'h5s-example-')), store = new Store(root);
  try {
    const report = await createExample(store, WORLD_BANK_CASE.id);
    expect(report.mode).toBe('chat'); expect(report.threadId).toBeNull();
    expect(report.context).toContain('1억 달러'); expect(report.context).toContain('국내시장과 소매금융시장');
    expect(report.context).toContain('미확인'); expect(report.context).toContain('2010년 NIM 실측값');
    expect(report.attachments).toHaveLength(2);
    const photo = report.attachments.find(a => a.mime === 'image/jpeg')!;
    expect(readFileSync(join(store.workspace(report.id), photo.path)).length).toBeGreaterThan(1000);
    const text = report.attachments.find(a => a.extracted)!;
    expect(readFileSync(join(store.workspace(report.id), text.textPath!), 'utf8')).toBe(WORLD_BANK_CASE.story);
    await expect(createExample(store, 'missing-case')).rejects.toThrow(/예시/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
