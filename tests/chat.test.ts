import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { Agent } from '../server/agent';
import type { RadarReader } from '../server/radar';
import { EphemeralChat, ephemeralArgs, type ChatReply } from '../server/ephemeral-chat';
const stores: Store[] = [], roots: string[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function fixture(output: ChatReply) {
  const root = mkdtempSync(join(tmpdir(), 'h5s-chat-test-')); roots.push(root);
  const store = new Store(root); stores.push(store);
  const agent = new Agent(store, {} as RadarReader);
  const startReport = vi.spyOn(agent, 'start').mockImplementation(() => ({}) as any);
  const launch = vi.fn(() => {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    child.stdin.on('finish', () => queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }) + '\n');
      child.stdout.end(); child.emit('close', 0);
    }));
    return child;
  });
  const chat = new EphemeralChat(store, agent, launch as unknown as typeof spawn), conversation = store.createChat();
  return { store, agent, chat, conversation, launch, startReport };
}
const reply: ChatReply = { message: '어떤 내용을 살펴볼까요?', openReport: false, title: '검증 대화', context: '사용자는 검토를 요청했다.', radarConversationId: null };
describe('chat first workflow', () => {
  it('runs ordinary chat ephemerally and persists the transcript without opening a report', async () => {
    const { store, chat, conversation, launch, startReport } = fixture(reply);
    chat.start(conversation.id, '자료를 같이 검토해줘.');
    await chat.active.get(conversation.id)!.done;
    const current = store.get(conversation.id);
    expect(current.mode).toBe('chat'); expect(current.threadId).toBeNull(); expect(startReport).not.toHaveBeenCalled();
    expect(current.messages.map(m => m.text)).toEqual(['자료를 같이 검토해줘.', reply.message]);
    expect(JSON.parse(readFileSync(join(store.workspace(conversation.id), 'conversation.json'), 'utf8')).messages).toHaveLength(2);
    const args = launch.mock.calls[0] as unknown as [string, string[]];
    expect(args[1]).toContain('--ephemeral'); expect(args[1]).toContain('exec'); expect(args[1]).not.toContain('resume');
  });
  it('hands the same workspace and full chat to the report runner when the model opens it', async () => {
    const { store, chat, conversation, startReport } = fixture({ ...reply, openReport: true, title: '검토 보고서', context: '이전 대화에서 확인한 가상 과제 맥락' });
    store.message(conversation.id, 'user', '먼저 알려둔 배경 정보');
    chat.start(conversation.id, '이 내용을 보고서로 정리해줘.');
    await chat.active.get(conversation.id)!.done;
    const current = store.get(conversation.id);
    expect(current.mode).toBe('report'); expect(current.id).toBe(conversation.id); expect(current.title).toBe('검토 보고서');
    const handoff = JSON.parse(readFileSync(join(store.workspace(conversation.id), 'chat-handoff.json'), 'utf8'));
    expect(handoff.messages[0].text).toBe('먼저 알려둔 배경 정보'); expect(handoff.messages).toHaveLength(3);
    expect(startReport).toHaveBeenCalledExactlyOnceWith(conversation.id, 'problem', 'questions');
  });
  it('does not open the editor when a stopped process returns a late report action', async () => {
    const { store, chat, conversation, startReport } = fixture({ ...reply, openReport: true });
    chat.start(conversation.id, '보고서 작성해줘.');
    await chat.cancel(conversation.id); await new Promise(r => setImmediate(r));
    expect(store.get(conversation.id).mode).toBe('chat'); expect(store.lastRun(conversation.id)?.status).toBe('interrupted');
    expect(startReport).not.toHaveBeenCalled();
    expect(store.get(conversation.id).messages.filter(m => m.role === 'assistant')).toHaveLength(0);
  });
  it('keeps source access read-only and directs the CLI into the local conversation folder', () => {
    const args = ephemeralArgs('/own/workspace', '/own/workspace/runs/test', '/own/data', 'own-chat');
    expect(args).toContain('read-only'); expect(args).toContain('/own/workspace');
    expect(args.some(a => a.includes('procurement={enabled=false'))).toBe(true);
    expect(args.some(a => a.includes('H5S_DATA_DIR="/own/data"'))).toBe(true);
  });
});
