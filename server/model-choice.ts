/** 서버 측 모델 선택 검증(zod). 허용 값은 shared/model-options.ts 표를 따른다. */
import { z } from 'zod';
import { checkChoice, type ModelChoice } from '../shared/model-options';

const id = z.string().trim().max(64);
export const modelChoiceSchema = z.object({ provider: id, model: id.optional(), effort: id.optional() }).strict()
  .superRefine((v, ctx) => { const r = checkChoice(v); if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error }); })
  .transform(v => (checkChoice(v) as { ok: true; choice: ModelChoice }).choice);
export const modelOptionsSchema = z.object({ model: id.optional(), effort: id.optional() }).strict();

/** /api/chat 본문의 model(제공자)과 options(CLI 모델·추론 강도)를 검증한다. 모델이 없으면 그대로 둔다 */
export function parseModelChoice(provider: unknown, options: unknown): ModelChoice | undefined {
  if (provider == null || provider === '') { if (options) throw new Error('모델 선택 오류: 모델 없이 세부 선택'); return undefined; }
  const opts = modelOptionsSchema.safeParse(options ?? {});
  if (!opts.success) throw new Error(`모델 선택 오류: ${opts.error.issues.map(i => i.message).join('; ')}`);
  const r = modelChoiceSchema.safeParse({ provider, ...opts.data });
  if (!r.success) throw new Error(`모델 선택 오류: ${r.error.issues.map(i => i.message).join('; ')}`);
  return r.data;
}
