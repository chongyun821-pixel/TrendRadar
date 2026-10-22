import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../server/store';
import { Agent } from '../server/agent';
import { EphemeralChat } from '../server/ephemeral-chat';
import { RadarReader } from '../server/radar';
const root = resolve('.local/verification', `chat-live-${Date.now()}`); mkdirSync(root, { recursive: true });
const store = new Store(root), radar = new RadarReader(), agent = new Agent(store, radar), chat = new EphemeralChat(store, agent);
const conversation = store.createChat(), checks: string[] = [];
agent.on(conversation.id, ({ event }: any) => { if (event.type === 'terminal') console.log(event.data.method); });
async function settle() {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { agent.off(conversation.id, changed); reject(new Error('Live chat check exceeded 10 minutes')); }, 600000);
    const changed = () => {
      if (chat.active.has(conversation.id) || agent.active.has(conversation.id)) return;
      // Handoff schedules the next run in the same stack; let it become visible first.
      queueMicrotask(() => {
        if (chat.active.has(conversation.id) || agent.active.has(conversation.id)) return;
        clearTimeout(timer); agent.off(conversation.id, changed);
        const run = store.lastRun(conversation.id); run?.status === 'completed' ? resolve() : reject(new Error(run?.error || run?.status || 'No run'));
      });
    };
    agent.on(conversation.id, changed); changed();
  });
}
try {
  chat.start(conversation.id, '기능 검증용 가상 대화야. 확인 단어는 해오라기야. 우선 이 단어를 기억해두고 짧게 답해줘. 아직 보고서는 만들지 마.'); await settle();
  assert.equal(store.get(conversation.id).mode, 'chat'); assert.equal(store.lastRun(conversation.id)?.transport, 'exec'); checks.push('normal chat stays in chat mode with ephemeral execution');
  chat.start(conversation.id, '앞서 내가 알려준 확인 단어가 뭐였지? 그 단어만 답해줘.'); await settle();
  let current = store.get(conversation.id); assert.equal(current.mode, 'chat'); assert(current.messages.at(-1)?.text.includes('해오라기')); checks.push('new ephemeral process answers from saved conversation context');
  chat.start(conversation.id, '이제 가상의 내부 보고서 작성 시간을 3일에서 1일로 줄이는 개선 과제를 보고서로 작성해줘. 독자는 기획팀장이고 실제 현황이 아닌 교육용 가정이야.'); await settle();
  current = store.get(conversation.id); assert.equal(current.mode, 'report'); assert(current.threadId); assert.equal(current.pages[0].questionSource, 'codex');
  checks.push('report request opens the editor without registration and automatically prepares questions');
  const handoff = JSON.parse(readFileSync(join(store.workspace(conversation.id), 'chat-handoff.json'), 'utf8'));
  assert(handoff.messages.some((m: any) => m.text.includes('해오라기'))); assert.equal(current.id, conversation.id); checks.push('full chat history preserved and handed to the report workspace');
  const runs = readdirSync(join(store.workspace(conversation.id), 'runs')); assert.equal(runs.length, 3);
  for (const id of runs) assert(readFileSync(join(store.workspace(conversation.id), 'runs', id, 'reply.json'), 'utf8').includes('message'));
  checks.push('each CLI input, JSONL event log and final output stored in this workspace');
  const receipt = { ok: true, checks, reportId: current.id, threadId: current.threadId, root, at: new Date().toISOString() };
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} finally { await chat.stopAll(); agent.bridge.stop(); await radar.close(); store.close(); }
