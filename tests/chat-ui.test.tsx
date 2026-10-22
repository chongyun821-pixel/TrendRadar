import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import { ChatLobby } from '../src/ChatLobby';
it('starts with a message composer and omits registration and implementation slogans', () => {
  const html = renderToStaticMarkup(<ChatLobby loading={false} busy={false} run={null} streaming="" conversations={[]} connectionLost={false} onSend={async () => true} onStop={async () => {}} onNew={() => {}} onOpen={() => {}} onSources={() => {}} onDelete={() => {}} onExample={async () => {}}/>);
  expect(html).toContain('aria-label="메시지"'); expect(html).toContain('무엇을 함께 정리할까요?');
  for (const text of ['새 컨설팅 보고서', '보고서 제목', '워크스페이스 만들기', '5단계', '7개 산출물', '코덱스 세션', 'Codex 세션', '--ephemeral']) expect(html).not.toContain(text);
  expect(html).toContain('월드은행 사례로 시작');
});
it('gives each conversation a separate delete action without nested buttons', () => {
  const html = renderToStaticMarkup(<ChatLobby loading={false} busy={false} run={null} streaming="" conversations={[{ id: 'example', title: '검토 대화', mode: 'chat', updatedAt: '', confirmed: 0 }]} connectionLost={false} onSend={async () => true} onStop={async () => {}} onNew={() => {}} onOpen={() => {}} onSources={() => {}} onDelete={() => {}} onExample={async () => {}} />);
  expect(html).toContain('aria-label="검토 대화 대화 삭제"');
  expect(html).toMatch(/class="conversation-link"[^>]*>[\s\S]*?<\/button><button class="conversation-delete"/);
});
