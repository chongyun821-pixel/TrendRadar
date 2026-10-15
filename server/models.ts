import type { ChatIn, ChatOut, ModelId } from './agent';
import { chat as chatGemma, type Env } from './gemma';
import { chatOpenRouter } from './openrouter';
import { localAvailability, chatGrok, chatCodex } from './cli';

export const MODELS: { id: ModelId; name: string; local?: boolean }[] = [
  { id: 'grok', name: '그록 빌드', local: true },
  { id: 'codex', name: '코덱스', local: true },
  { id: 'gemma', name: '젬마' },
  { id: 'nemotron', name: '네모트론' },
];
export const DEFAULT_MODEL: ModelId = 'gemma';

export async function listModels(env: Env) {
  const loc = await localAvailability(env);
  return MODELS.map(m => ({ id: m.id, name: m.name, available: m.local ? loc[m.id as 'grok' | 'codex'] : true }));
}

export async function chatWith(input: ChatIn, env: Env): Promise<ChatOut> {
  const id = (input.model || DEFAULT_MODEL) as ModelId;
  switch (id) {
    case 'gemma': return chatGemma(input, env);
    case 'nemotron': return chatOpenRouter(input, env);
    case 'grok': return chatGrok(input, env);
    case 'codex': return chatCodex(input, env);
    default: return { reply: '', actions: [], reports: [], tools: [], error: '모르는 모델' };
  }
}
