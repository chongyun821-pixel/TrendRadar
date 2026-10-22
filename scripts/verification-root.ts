import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
export function verificationRoot(argument?: string) {
  if (argument) return resolve(argument);
  const root = resolve('.local/verification');
  const latest = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^live-\d+$/.test(e.name)).map(e => e.name).sort().at(-1);
  if (!latest) throw new Error('Run npm run check:live first, or provide a verification directory.');
  return join(root, latest);
}
