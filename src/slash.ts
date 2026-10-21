/** 채팅 입력의 / 명령과 모델 선택 단계(순수 함수, 테스트 대상) */
import { CLI_OPTIONS, PROVIDERS, checkChoice, effortsFor, hasSubOptions, isProvider, type ModelChoice, type ProviderId } from '../shared/model-options';

export type Slash = { cmd: 'sessions' } | { cmd: 'models' };
/** 정확히 /sessions·/models(별칭 포함)만 명령으로 본다. 그 밖의 / 문장은 일반 메시지다 */
export function parseSlash(text: string): Slash | null {
  const m = /^[/／]\s*([a-z가-힣]+)\s*$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (['sessions', 'session', '세션', '대화'].includes(name)) return { cmd: 'sessions' };
  if (['models', 'model', '모델'].includes(name)) return { cmd: 'models' };
  return null;
}

export interface PickItem { id: string; label: string; hint?: string; current?: boolean; disabled?: boolean; deletable?: boolean }
export type ModelStep = { title: string; items: PickItem[] } | { done: ModelChoice };
/**
 * 모델 선택 단계. path: [제공자, CLI 모델, 추론 강도]까지 고른 값.
 * 지피티·네모트론은 제공자만 고르면 끝난다. available은 서버가 알려준 사용 가능 제공자.
 */
export function modelStep(path: string[], current: ModelChoice, available: ReadonlySet<string> = new Set(PROVIDERS.map(p => p.id))): ModelStep {
  const [provider, model, effort] = path;
  if (!provider) return { title: '모델', items: PROVIDERS.map(p => ({ id: p.id, label: p.name, current: p.id === current.provider, disabled: !available.has(p.id), hint: available.has(p.id) ? (hasSubOptions(p.id) ? '›' : undefined) : '사용 불가' })) };
  if (!isProvider(provider)) return { title: '모델', items: [] };
  if (!hasSubOptions(provider)) return { done: { provider } };
  const opts = CLI_OPTIONS[provider], same = current.provider === provider;
  if (!model) return { title: PROVIDERS.find(p => p.id === provider)!.name, items: opts.models.map(m => ({ id: m.id, label: m.id, current: same && (current.model || opts.defaultModel) === m.id, hint: m.id === opts.defaultModel ? '기본' : undefined })) };
  if (!effort) {
    const efforts = effortsFor(provider, model);
    return { title: `${PROVIDERS.find(p => p.id === provider)!.name} · ${model}`, items: efforts.map(e => ({ id: e, label: e, current: same && (current.model || opts.defaultModel) === model && (current.effort || opts.defaultEffort) === e, hint: e === opts.defaultEffort ? '기본' : undefined })) };
  }
  const r = checkChoice({ provider, model, effort });
  return r.ok ? { done: r.choice } : { title: r.error, items: [] };
}
/** 저장된 선택 읽기(예전 형식: 제공자 ID 문자열) */
export function readChoice(raw: string | null): ModelChoice | null {
  if (!raw) return null;
  if (isProvider(raw)) return { provider: raw as ProviderId };
  try { const v = JSON.parse(raw); const r = checkChoice(v || {}); return r.ok ? r.choice : null; } catch { return null; }
}
