import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../server/store';
import { RadarReader } from '../server/radar';
import { Agent } from '../server/agent';
import { safeError } from '../server/config';
import { exportPdf, exportWord, reportHtml } from '../server/export';
import { PAGE_DEFS } from '../shared/types';
const root = resolve('.local/verification', `live-${Date.now()}`);
mkdirSync(root, { recursive: true });
const store = new Store(root), radar = new RadarReader();
let agent = new Agent(store, radar);
const report = store.create('검증용 보고서 작성 프로세스 개선', '기능 검증을 위한 가상의 교육용 과제다. 실제 기업 현황이 아니다. 보고서 초안 소요시간을 가정상 3일에서 1일로 줄이는 프로세스 개선을 검토한다. 독자는 가상의 기획팀장. 내부 보고서 작성 업무만 범위에 포함하며 외부 시스템 변경은 제외한다. 모든 수치는 검증용 가정이다.');
const logs: any[] = [];
function observe(a: Agent) {
  a.on(report.id, ({ event }: any) => {
    if (event.type === 'terminal') { console.log(event.data.method + ': ' + event.data.text); logs.push(event); }
  });
}
observe(agent);
async function waitForRun(a: Agent) {
  if (!a.active.has(report.id)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { a.off(report.id, listener); reject(new Error('Live check exceeded 10 minutes')); }, 600000);
    const listener = ({ event }: any) => {
      if (event.type !== 'state' || a.active.has(report.id)) return;
      clearTimeout(timeout); a.off(report.id, listener);
      const run = store.lastRun(report.id);
      if (run?.status !== 'completed') reject(new Error(run?.error || run?.status || 'unknown')); else resolve();
    };
    a.on(report.id, listener);
  });
}
const receipt: Record<string, any> = { startedAt: new Date().toISOString(), testData: 'synthetic', existingProjectMode: 'read-only', root };
try {
  agent.start(report.id, 'problem', 'questions'); await waitForRun(agent);
  const prepared = store.get(report.id);
  if (prepared.pages[0].questionSource !== 'codex') throw new Error('Model did not invoke question tool');
  receipt.questions = prepared.pages[0].questions.length;
  store.change(report.id, r => {
    r.pages[0].answers = Object.fromEntries(r.pages[0].questions.map(q => [q.id, '가상의 교육용 검증 과제. 기획팀장의 내부 보고서 초안 작성 시간을 가정상 3일에서 1일로 단축한다. 4주 내 절차를 시범 적용하며 기획팀이 주관한다. 기존 자료와 양식을 활용하고 외부 시스템 변경·추가 예산은 제외한다. 정량 자료는 실제 확인한 값이 아니며 가정이다.']));
  });
  agent.start(report.id, 'problem', 'draft'); await waitForRun(agent);
  let state = store.get(report.id);
  if (!state.pages[0].content.trim()) throw new Error('Model did not update draft');
  receipt.firstDraftVersion = state.pages[0].version;
  receipt.threadId = state.threadId;
  // A fresh transport and Agent must resume the original thread rather than start another.
  agent.bridge.stop(); agent = new Agent(store, radar); observe(agent);
  agent.start(report.id, 'problem', 'chat', '현재 초안의 기본 질문을 더 명확한 의사결정 질문으로 다듬어 실제 편집기에 반영해줘. 가상 교육용 검증 과제라는 점과 다른 내용을 보존해줘.');
  await waitForRun(agent);
  state = store.get(report.id);
  if (state.threadId !== receipt.threadId) throw new Error('Thread changed across restart');
  if (state.pages[0].version <= receipt.firstDraftVersion) throw new Error('Chat did not modify the editor');
  receipt.resumedSameThread = true; receipt.chatUpdatedDraft = true;
  // Export fixture uses explicit synthetic content for the six remaining outputs.
  const fixtures = [
    '',
    '## 핵심 질문\n가상의 보고서 작성 시간을 어떻게 줄일 수 있는가?\n\n## 이슈트리\n- 입력 자료 준비\n  - 자료 수집 시간을 줄일 수 있는가?\n  - 근거 확인 절차를 표준화할 수 있는가?\n- 작성과 검토\n  - 공통 양식을 적용할 수 있는가?\n  - 검토 순서를 정할 수 있는가?\n\n## 검토 기준\nMECE, 상위 질문과의 관련성, 동일 수준을 검토한다. 교육용 가정이다.',
    '| 이슈 | 초기가설 | 검증 방법 | 우선순위 |\n| --- | --- | --- | --- |\n| 자료 준비 | 공통 자료 목록이 준비 시간을 줄일 수 있다 | 시범 작성 전후 비교 | 높음 |\n| 초안 작성 | 공통 양식이 작성 시간을 줄일 수 있다 | 시범 작성 전후 비교 | 높음 |\n\n가설은 검증되지 않았다. 모든 내용은 기능 검증용이다.',
    '| 검증 가설 | 분석 방법 | 자료 | 담당 | 일정 | 산출물 |\n| --- | --- | --- | --- | --- | --- |\n| 양식 활용 효과 | 시범 전후 비교 | 가상 작업 기록 | 가상 기획팀 | 1~4주 | 비교표 |\n\n일정과 담당은 검증용 가정이다.',
    '## Governing Thought\n작성 절차를 표준화하고 시범 운영을 통해 효과를 검증한다.\n\n## 핵심 논거\n- 입력 자료의 일관성을 높인다.\n  - 자료 목록을 미리 정한다.\n- 검토 절차를 명확히 한다.\n  - 검토자와 검토 시점을 정한다.\n\n## 불확실성\n실제 측정 결과는 없으며 교육용 검증 가정이다.',
    '| 흐름 | 핵심 메시지 | 근거 |\n| --- | --- | --- |\n| 상황 | 보고서 작성 시간 개선 필요 | 가상 교육 과제 |\n| 질문 | 절차를 어떻게 개선할 것인가 | 문제정의서 |\n| 결론 | 표준화 후 시범 운영 | 미검증 가설 |\n| 실행 | 4주간 전후 비교 | 검증용 가정 |',
    '## 핵심 권고\n공통 자료 목록과 작성 양식을 시범 운영한다.\n\n## 실행 과제\n가상의 기획팀이 4주간 시범 적용하고 작성 시간을 비교한다.\n\n## 측정 지표\n작성 소요시간과 검토 반려 횟수를 기록한다.\n\n## 위험과 후속 결정\n효과가 확인되지 않으면 양식과 절차를 조정한다. 실제 결과가 없는 기능 검증용 예시다.',
  ];
  for (let i = 0; i < 7; i++) {
    state = store.get(report.id);
    if (i) store.updateDraft(report.id, PAGE_DEFS[i].id, fixtures[i], state.pages[i].version, 'human');
    state = store.get(report.id); store.confirm(report.id, PAGE_DEFS[i].id, state.pages[i].version);
  }
  state = store.get(report.id);
  writeFileSync(join(root, 'report.html'), reportHtml(state));
  writeFileSync(join(root, 'report.pdf'), await exportPdf(state));
  writeFileSync(join(root, 'report.docx'), await exportWord(state));
  receipt.exports = ['html', 'pdf', 'docx']; receipt.ok = true;
  console.log(JSON.stringify(receipt, null, 2));
} catch (e) {
  receipt.ok = false; receipt.error = safeError(e); console.error(receipt.error); process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); writeFileSync(join(root, 'events.json'), JSON.stringify(logs, null, 2));
  agent.bridge.stop(); await radar.close(); store.close();
}
