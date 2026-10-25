import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSetting, listSettings, writeSetting } from '../server/settings-secrets';
import { localOnly } from '../server/local-only';

const dirs: string[] = [];
async function tempFile(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), 'horus-settings-')); dirs.push(dir);
  const file = join(dir, '.secrets'); await writeFile(file, contents, 'utf8'); return file;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('settings secrets helper', () => {
  it('keeps comments, unrelated lines, and CRLF while updating and deleting an allowlisted entry', async () => {
    const file = await tempFile('# keep\r\nOTHER=value\r\nOPENAI_API_KEY=old\r\n');
    await writeSetting('OPENAI_API_KEY', 'new=value', file);
    expect(await readFile(file, 'utf8')).toBe('# keep\r\nOTHER=value\r\nOPENAI_API_KEY=new=value\r\n');
    await deleteSetting('OPENAI_API_KEY', file);
    expect(await readFile(file, 'utf8')).toBe('# keep\r\nOTHER=value\r\n');
  });

  it('preserves mixed line endings and inline comments on an updated line', async () => {
    const file = await tempFile('# keep\r\nOPENAI_API_KEY=old # comment\nOTHER=value\r');
    await writeSetting('OPENAI_API_KEY', 'new', file);
    expect(await readFile(file, 'utf8')).toBe('# keep\r\nOPENAI_API_KEY=new # comment\nOTHER=value\r');
  });

  it('rejects names outside the settings allowlist', async () => {
    const file = await tempFile('# untouched\n');
    await expect(writeSetting('PATH', 'unsafe', file)).rejects.toThrow();
    await expect(deleteSetting('PATH', file)).rejects.toThrow();
  });

  it('lists key status only and returns the device name as the sole plain value', async () => {
    const file = await tempFile('OPENAI_API_KEY=top-secret\r\nHORUS_DEVICE_NAME=내 컴퓨터\r\n');
    const response = await listSettings(file);
    expect(response.find(item => item.name === 'OPENAI_API_KEY')).toEqual({ name: 'OPENAI_API_KEY', set: true });
    expect(response.find(item => item.name === 'HORUS_DEVICE_NAME')).toEqual({ name: 'HORUS_DEVICE_NAME', set: true, value: '내 컴퓨터' });
    expect(JSON.stringify(response)).not.toContain('top-secret');
    expect(response.filter(item => 'value' in item)).toEqual([{ name: 'HORUS_DEVICE_NAME', set: true, value: '내 컴퓨터' }]);
  });
});

describe('settings endpoint guard', () => {
  it('requires a loopback peer, local host, and matching origin', () => {
    expect(localOnly({ remote: '127.0.0.1', host: 'localhost:62356', origin: 'http://localhost:62356' })).toBeNull();
    expect(localOnly({ remote: '::ffff:127.0.0.1', host: '127.0.0.1:62356', origin: 'http://127.0.0.1:62356' })).toBeNull();
    expect(localOnly({ remote: '192.168.1.8', host: 'localhost:62356' })).not.toBeNull();
    expect(localOnly({ remote: '127.0.0.1', host: 'example.com' })).not.toBeNull();
    expect(localOnly({ remote: '::1', host: '[::1]:62356', origin: 'http://localhost:62356' })).not.toBeNull();
  });
});
