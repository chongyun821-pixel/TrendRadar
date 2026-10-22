export const MODEL = 'gpt-6.1-sol';
export const EFFORT = 'xhigh';
export const STEPS = [
  { title: '문제 구조화', english: 'Define the problem', pages: ['problem', 'issue-tree'] },
  { title: '가설 수립', english: 'Build hypotheses', pages: ['hypothesis'] },
  { title: '작업 계획', english: 'Plan the work', pages: ['workplan'] },
  { title: '분석', english: 'Find the insight', pages: ['pyramid'] },
  { title: '권고안 개발', english: 'Shape the recommendation', pages: ['storyboard', 'recommendation'] },
];
export const PAGE_DEFS = [
  { id: 'problem', title: '문제정의서', english: 'Problem definition', step: 0, description: '해결해야 할 문제와 성공의 기준을 명확하게 정의합니다.', fields: ['해결해야 할 기본 질문', '문제의 배경', '성공 측정 기준', '의사결정자', '주요 이해관계자', '해결 방안의 제약사항', '해결 방안의 범위'] },
  { id: 'issue-tree', title: '이슈트리', english: 'Issue tree', step: 0, description: '핵심 질문을 중복과 누락 없이 나누어 분석할 이슈를 도출합니다.', fields: [] },
  { id: 'hypothesis', title: '초기가설', english: 'Initial hypotheses', step: 1, description: '핵심 이슈에 대한 잠정적 답을 세우고 검증 우선순위를 정합니다.', fields: [] },
  { id: 'workplan', title: '작업계획서', english: 'Work plan', step: 2, description: '가설을 검증할 분석과 담당자, 일정, 예상 산출물을 구체화합니다.', fields: [] },
  { id: 'pyramid', title: 'Governing Thought Pyramid', english: 'Governing thought pyramid', step: 3, description: '검증된 근거에서 시사점을 도출하고 핵심 메시지를 구조화합니다.', fields: [] },
  { id: 'storyboard', title: '스토리보드', english: 'Storyboard', step: 4, description: '결론과 근거가 자연스럽게 이어지도록 보고서의 흐름을 설계합니다.', fields: [] },
  { id: 'recommendation', title: '권고안', english: 'Recommendations', step: 4, description: '실행 과제, 기대 효과, 위험과 후속 의사결정을 제안합니다.', fields: [] },
];
export type PageId = typeof PAGE_DEFS[number]['id'];
export interface Question { id: string; label: string; hint: string; required: boolean; recommendedAnswer?: string }
export interface Draft { id: PageId; content: string; version: number; status: 'empty' | 'draft' | 'confirmed'; questions: Question[]; questionSource: 'template' | 'codex'; answers: Record<string, string>; updatedAt: string; }
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string; action?: string; }
export interface DraftProposal { id: string; pageId: string; content: string; reason: string; baseVersion: number; createdAt: string; }
export interface Attachment { id: string; name: string; mime: string; bytes: number; textPath?: string; path: string; extracted: boolean; error?: string; }
export interface Report { id: string; title: string; mode?: 'chat' | 'report'; reportOpenedAt?: string; createdAt: string; updatedAt: string; currentPage: string; threadId: string | null; radarConversationId: string | null; context: string; pages: Draft[]; messages: Message[]; attachments: Attachment[]; proposals: DraftProposal[]; }
export interface Run { id: string; reportId: string; pageId: string; action: string; transport?: 'exec' | 'app-server'; status: 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted'; turnId: string | null; text: string; items: Record<string, string>; startedAt: string; error?: string; }
export interface ReportState { report: Report; run: Run | null; }
export interface ConnectionStatus { codex: { connected: boolean; installed: boolean; authenticated: boolean; modelAvailable: boolean; error?: string; }; radar: { connected: boolean; configured: boolean; counts?: Record<string, number>; error?: string; }; model: string; effort: string; }
