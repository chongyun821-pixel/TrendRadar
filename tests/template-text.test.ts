import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('template Korean typography', () => {
  it('contains no middle dot in template text', () => {
    const dir = join(process.cwd(), 'templates');
    for (const name of readdirSync(dir).filter(name => /\.(md|json)$/.test(name))) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain('\u00b7');
    }
  });
});
