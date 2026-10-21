import type { ChatIn, ChatOut, ModelId } from './agent';
import type { Env } from './env';
import { chatOpenAI } from './openai';
import { chatOpenRouter } from './openrouter';
import { localAvailability, chatGrok, chatCodex } from './cli';

export const MODELS: { id: ModelId; name: string; local?: boolean }[] = [
  { id: 'grok', name: '그록 빌드', local: true },
  { id: 'codex', name: '코덱스', local: true },
  { id: 'gpt', name: '지피티' },
  { id: 'nemotron', name: '네모트론' },
];
export const DEFAULT_MODEL: ModelId = 'gpt';

export async function listModels(env: Env) {
  const loc = await localAvailability(env);
  return MODELS.map(m => ({ id: m.id, name: m.name, available: m.local ? loc[m.id as 'grok' | 'codex'] : true }));
}
/** 기본 모델: OpenAI 키가 있으면 지피티, 없으면 쓸 수 있는(로컬 CLI 설치 또는 키 설정) 첫 모델 */
export function defaultModel(env: Env, models: { id: ModelId; available: boolean }[]): ModelId {
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
