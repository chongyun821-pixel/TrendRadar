import type { ChatIn, ChatOut, ModelId } from './agent';
import type { Env } from './env';
import { chatOpenAI } from './openai';
import { chatOpenRouter } from './openrouter';
import { localAvailability, chatGrok, chatCodex } from './cli';
import { PROVIDERS, hasSubOptions } from '../shared/model-options';

/** 표시 순서: 그록 빌드, 코덱스, 지피티, 네모트론(shared/model-options.ts). CLI 모델은 로컬 설치 여부로 사용 가능을 판단한다 */
export const MODELS: { id: ModelId; name: string; local?: boolean }[] = PROVIDERS.map(p => ({ ...p, ...(hasSubOptions(p.id) ? { local: true } : {}) }));
export const DEFAULT_MODEL: ModelId = 'gpt';

export async function listModels(env: Env) {
  const loc = await localAvailability(env);
  return MODELS.map(m => ({ id: m.id, name: m.name, available: m.local ? loc[m.id as 'grok' | 'codex'] : true }));
}
/** 기본 모델: 사용 가능한 Codex CLI를 우선하고, 없으면 기존 키와 사용 가능 여부로 선택 */
export function defaultModel(env: Env, models: { id: ModelId; available: boolean }[]): ModelId {
  if (models.some(m => m.id === 'codex' && m.available)) return 'codex';
  if (env.OPENAI_API_KEY?.trim()) return 'gpt';
  const ready = (id: ModelId) => id === 'gpt' ? false : id === 'nemotron' ? !!env.OPENROUTER_API_KEY?.trim() : true;
  return models.find(m => m.available && ready(m.id))?.id || DEFAULT_MODEL;
}

export async function chatWith(input: ChatIn, env: Env): Promise<ChatOut> {
  const id = (input.model || DEFAULT_MODEL) as ModelId;
  switch (id) {
    case 'gpt': return chatOpenAI(input, env);
    case 'nemotron': return chatOpenRouter(input, env);
    case 'grok': return chatGrok(input, env);
    case 'codex': return chatCodex(input, env);
    default: return { reply: '', actions: [], reports: [], tools: [], error: '모르는 모델' };
  }
}
