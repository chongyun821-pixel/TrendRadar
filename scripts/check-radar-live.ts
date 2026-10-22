import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Store } from '../server/store';
import { RadarReader } from '../server/radar';
import { Agent } from '../server/agent';
import { verificationRoot } from './verification-root';
const root = verificationRoot(process.argv[2]);
const store = new Store(root), radar = new RadarReader(), agent = new Agent(store, radar);
const report = store.list()[0];
let called = false;
agent.on(report.id, ({ event }: any) => { if (event.type === 'terminal') { console.log(event.data.method); if (event.data.method === 'h5s_search_radar') called = true; } });
try {
  agent.start(report.id, 'recommendation', 'chat', '기능 검증 요청. h5s_search_radar 도구로 기존 procurement-radar 조달 기록을 빈 검색어로 읽기 전용 조회해줘. 실제 도구를 호출한 뒤 반환된 건수와 사용한 도구 이름만 짧게 답해줘. 초안과 원본 데이터는 수정하지 마.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Live Radar check timed out')), 600000);
    agent.on(report.id, ({ event }: any) => { if (event.type === 'state' && !agent.active.has(report.id)) { clearTimeout(timer); const run = store.lastRun(report.id); run?.status === 'completed' ? resolve() : reject(new Error(run?.error || 'Failed')); } });
  });
  if (!called) throw new Error('Model did not call Radar search');
  const result = { ok: true, modelInvokedReadOnlyRadarTool: called, threadId: store.get(report.id).threadId, at: new Date().toISOString() };
  writeFileSync(join(root, 'radar-live-receipt.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { agent.bridge.stop(); await radar.close(); store.close(); }
