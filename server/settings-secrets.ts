import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const SECRET_NAMES = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'FIRECRAWL_API_KEY'] as const;
export const DEVICE_NAME = 'HORUS_DEVICE_NAME';
export const CONNECTION_KEY = 'HORUS_CONNECTION_KEY';
export const SETTINGS_NAMES = [...SECRET_NAMES, DEVICE_NAME] as const;
const WRITABLE_SETTINGS = [...SETTINGS_NAMES, CONNECTION_KEY] as const;

export function readSettings(file = resolve(process.cwd(), '.secrets')) {
  return readFile(file, 'utf8').catch(() => '');
}

function keyOf(line: string) {
  const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
  return match?.[1];
}

function valueOf(line: string) {
  const index = line.indexOf('=');
  let value = line.slice(index + 1).trim();
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
  return value;
}

function splitLines(text: string) {
  return (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || []).filter(Boolean).map(raw => {
    const ending = /(?:\r\n|\n|\r)$/.exec(raw)?.[0] || '';
    return { content: ending ? raw.slice(0, -ending.length) : raw, ending };
  });
}

export async function listSettings(file = resolve(process.cwd(), '.secrets')) {
  const text = await readSettings(file);
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const key = keyOf(line);
    if (key && SETTINGS_NAMES.includes(key as typeof SETTINGS_NAMES[number])) values.set(key, valueOf(line));
  }
  return SETTINGS_NAMES.map(name => name === DEVICE_NAME
    ? { name, set: !!values.get(name), value: values.get(name) || '' }
    : { name, set: !!values.get(name) });
}

export async function writeSetting(name: string, value: string, file = resolve(process.cwd(), '.secrets')) {
  if (!WRITABLE_SETTINGS.includes(name as typeof WRITABLE_SETTINGS[number])) throw new Error('허용하지 않는 설정 이름입니다.');
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('설정 값에 줄바꿈을 넣을 수 없습니다.');
  const text = await readSettings(file);
  const lines = splitLines(text);
  const newline = lines.find(line => line.ending)?.ending || '\n';
  let found = false;
  const updated = lines.map(({ content, ending }) => {
    if (keyOf(content) !== name) return `${content}${ending}`;
    found = true;
    const equal = content.indexOf('=');
    const prefix = content.slice(0, equal + 1);
    const original = content.slice(equal + 1);
    const comment = /(\s+#.*)$/.exec(original)?.[1] || '';
    const oldValue = original.slice(0, original.length - comment.length).trim();
    const quote = oldValue.length >= 2 && oldValue[0] === oldValue.at(-1) && (oldValue[0] === '"' || oldValue[0] === "'") ? oldValue[0] : '';
    return `${prefix}${quote}${value}${quote}${comment}${ending}`;
  });
  if (!found) {
    if (updated.length && !lines.at(-1)?.ending) updated[updated.length - 1] += newline;
    updated.push(`${name}=${value}${newline}`);
  }
  const output = updated.join('');
  const temp = resolve(dirname(file), `.${Date.now()}-${Math.random().toString(16).slice(2)}.secrets.tmp`);
  await writeFile(temp, output, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

export async function deleteSetting(name: string, file = resolve(process.cwd(), '.secrets')) {
  if (!WRITABLE_SETTINGS.includes(name as typeof WRITABLE_SETTINGS[number])) throw new Error('허용하지 않는 설정 이름입니다.');
  const text = await readSettings(file);
  const output = splitLines(text).filter(line => keyOf(line.content) !== name).map(line => `${line.content}${line.ending}`).join('');
  const temp = resolve(dirname(file), `.${Date.now()}-${Math.random().toString(16).slice(2)}.secrets.tmp`);
  await writeFile(temp, output, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

let reloadHandler: (() => void) | undefined;
export const setSettingsReloadHandler = (handler?: () => void) => { reloadHandler = handler; };
export const reloadSettingsConfig = () => reloadHandler?.();
