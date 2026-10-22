/** 채팅 화면의 API 호출과 서버 응답 형식 */
import type { ReportRef } from '../shared/app-context';
import type { ModelChoice } from '../shared/model-options';

export type Download = { id: string; name: string; url: string };
export type Message = { role: string; text: string; reports?: string[]; reportRefs?: (ReportRef | null)[]; created_at?: string; files?: Download[]; model?: string; error?: string };
/** viewed: 지도에서 직접 연 보고서(메시지 없이 대화 목록에 그린다) */
export type ReportEntry = ReportRef & { markdown: string; createdAt: string; viewed?: boolean };
export type QueuedMessage = { id: string; text: string };
export type RunInfo = { id: string; status: string; error?: string; started_at?: string; ended_at?: string };
export type Conversation = { id: string; title: string; messages: Message[]; queued?: QueuedMessage[]; reportEntries?: ReportEntry[]; files: { id: string; name: string; kind: string; error?: string }[]; runs: RunInfo[] };
export type ModelInfo = { id: string; name: string; available: boolean };

/**
 * ＋ 메뉴 「대화 자료」 목록: 사용자가 올린 파일(kind=attachment)만 보인다.
 * 추출 텍스트·수집 원문·보고서·생성 문서·기록은 숨길 뿐 지우지 않으며, 모델의 작업 폴더 도구는 그대로 모두 본다.
 */
export const uploadedFiles = <T extends { kind: string }>(files: T[]) => files.filter(f => f.kind === 'attachment');
/** 저장 이름 attachments/<UUID>-원래이름 → 원래 이름 */
export const uploadedName = (name: string) => name.split('/').at(-1)!.replace(/^[0-9a-f]{8}-[0-9a-f-]{27}-/i, '');

export async function api(path: string, options?: RequestInit): Promise<any> {
  const r = await fetch(`/api${path}`, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `요청 실패 ${r.status}`);
  return data;
}
export const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

/** 진행 중(대기·실행·중지 중) 상태 */
export const isActiveStatus = (status: string) => ['queued', 'running', 'stopping'].includes(status);
export const latestRun = (c: Conversation) => [...c.runs].sort((a, b) => (b.ended_at || b.started_at || '').localeCompare(a.ended_at || a.started_at || ''))[0];
/** 끝난 실행의 상태 줄 문구 */
export const runStatusText = (run: { status: string; error?: string | null }) => run.error || (run.status === 'completed' ? '완료' : run.status === 'cancelled' ? '작업 중지됨' : run.status);

/** /api/chat 본문: 선택한 제공자(model)와 CLI 모델·추론 강도(options)를 요청마다 보낸다 */
export function chatBody(choice: ModelChoice, conversationId: string, text: string, state: unknown, appContext: unknown, reportIds: string[] = []) {
  return {
    conversationId, model: choice.provider,
    ...(choice.model || choice.effort ? { options: { model: choice.model, effort: choice.effort } } : {}),
    messages: [{ role: 'user', text }], state, appContext,
    ...(reportIds.length ? { reportIds } : {}),
  };
}

const MODEL_ALIAS: Record<string, string> = { 그록: 'grok', 그록빌드: 'grok', grok: 'grok', 코덱스: 'codex', codex: 'codex', 지피티: 'gpt', gpt: 'gpt', 쥐피티: 'gpt', chatgpt: 'gpt', 네모트론: 'nemotron', nemotron: 'nemotron' };
/** !모델 명령의 이름을 제공자 ID로 바꾼다 */
export function pickModel(name: string, models: ModelInfo[]): string | null {
  const key = name.replace(/\s+/g, '').toLowerCase();
  return MODEL_ALIAS[key] || models.find(m => m.name.replace(/\s+/g, '').toLowerCase() === key || m.id === key)?.id || null;
}
