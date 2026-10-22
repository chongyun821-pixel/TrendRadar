import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../server/store';
import { Agent } from '../server/agent';
import { EphemeralChat } from '../server/ephemeral-chat';
import { RadarReader } from '../server/radar';
const root = resolve('.local/verification', `chat-radar-${Date.now()}`); mkdirSync(root, { recursive: true });
const store = new Store(root), radar = new RadarReader(), agent = new Agent(store, radar), chat = new EphemeralChat(store, agent);
try {
  const conversation = store.createChat();
  const run = chat.start(conversation.id, '기능 검증 요청이야. 연결된 h5s MCP의 search_radar 도구를 실제로 호출해서 query를 빈 문자열, kind를 records로 조회해줘. 반환된 기록 개수와 사용한 도구 이름만 답해줘. DB와 파일은 수정하지 말고 보고서는 열지 마.');
  await chat.active.get(conversation.id)!.done;
  assert.equal(store.lastRun(conversation.id)?.status, 'completed');
  assert.equal(store.get(conversation.id).mode, 'chat');
  const events = readFileSync(join(store.workspace(conversation.id), 'runs', run.id, 'events.jsonl'), 'utf8');
  assert(events.includes('search_radar'), 'Model did not invoke read-only Radar MCP');
  const receipt = { ok: true, actualEphemeralMcpSearch: true, mode: store.get(conversation.id).mode, root, at: new Date().toISOString() };
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} finally { await chat.stopAll(); agent.bridge.stop(); await radar.close(); store.close(); }
