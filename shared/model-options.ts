/** 채팅 모델 선택표: 제공자 → (CLI 모델 → 추론 강도). 화면 선택기, 서버 검증, 모델 목록이 같은 표(같은 순서)를 쓴다. */
export type ProviderId = 'codex' | 'grok' | 'gpt' | 'nemotron';
export interface ModelChoice { provider: ProviderId; model?: string; effort?: string }
export const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: 'grok', name: '그록 빌드' }, { id: 'codex', name: '코덱스' }, { id: 'gpt', name: '지피티' }, { id: 'nemotron', name: '네모트론' },
];
/**
 * CLI 모델과 허용 추론 강도.
 * - 코덱스: `-c model_reasoning_effort=…`. Codex CLI 모델 목록(2026-09-29 기준) low~max, Sol, Astra는 ultra도 허용.
 * - 그록 빌드: `-m`, `--reasoning-effort low|medium|high|xhigh`. 모델은 Grok Build CLI `grok models`에 나온 이름만 둔다.
 */
export const CLI_OPTIONS: Record<'codex' | 'grok', { models: { id: string; efforts: string[] }[]; defaultModel: string; defaultEffort: string }> = {
  codex: {
    models: [
      { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    ],
    defaultModel: 'gpt-6-luna', defaultEffort: 'high',
  },
  grok: {
    models: [
      { id: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'grok-4.7-build-fast', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'grok-4.6', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'grok-4.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ],
    defaultModel: 'grok-4.7', defaultEffort: 'xhigh',
  },
};
export const isProvider = (v: unknown): v is ProviderId => PROVIDERS.some(p => p.id === v);
export const hasSubOptions = (p: ProviderId): p is 'codex' | 'grok' => p === 'codex' || p === 'grok';
export const modelsFor = (p: ProviderId) => hasSubOptions(p) ? CLI_OPTIONS[p].models.map(m => m.id) : [];
export const effortsFor = (p: ProviderId, model?: string) => hasSubOptions(p) ? CLI_OPTIONS[p].models.find(m => m.id === (model || CLI_OPTIONS[p].defaultModel))?.efforts || [] : [];

/** 선택 검증 결과: 오류 문구 또는 정리된 선택(지피티, 네모트론은 하위 선택을 버린다) */
export function checkChoice(raw: { provider?: unknown; model?: unknown; effort?: unknown }): { ok: true; choice: ModelChoice } | { ok: false; error: string } {
  if (!isProvider(raw.provider)) return { ok: false, error: `모르는 모델: ${String(raw.provider ?? '')}` };
  const provider = raw.provider;
  if (!hasSubOptions(provider)) {
    if (raw.model || raw.effort) return { ok: false, error: `${PROVIDERS.find(p => p.id === provider)!.name}는 세부 모델과 추론 강도를 고르지 않습니다` };
    return { ok: true, choice: { provider } };
  }
  const model = raw.model == null || raw.model === '' ? undefined : String(raw.model);
  if (model && !modelsFor(provider).includes(model)) return { ok: false, error: `허용하지 않는 모델: ${model} (가능: ${modelsFor(provider).join(', ')})` };
  const effort = raw.effort == null || raw.effort === '' ? undefined : String(raw.effort);
  if (effort && !effortsFor(provider, model).includes(effort)) return { ok: false, error: `허용하지 않는 추론 강도: ${effort} (가능: ${effortsFor(provider, model).join(', ')})` };
  return { ok: true, choice: { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } };
}
/** 한 줄 표시: 코덱스 | gpt-6-luna | high */
export const LABEL_SEP = ' | ';
export function choiceLabel(c: ModelChoice, defaults?: { model?: string; effort?: string }) {
  const name = PROVIDERS.find(p => p.id === c.provider)?.name || c.provider;
  if (!hasSubOptions(c.provider)) return name;
  const model = c.model || defaults?.model || CLI_OPTIONS[c.provider].defaultModel;
  const effort = c.effort || defaults?.effort || CLI_OPTIONS[c.provider].defaultEffort;
  return [name, model, effort].join(LABEL_SEP);
}
