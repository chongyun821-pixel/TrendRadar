// 모델별 화면 도구 사용률(읽기 전용). 사용: npm run screen:stats -- [시작일, 기본 30일 전]
import { repository } from '../server/store';
import { readScreenToolStats } from '../server/screen-stats';

const since = process.argv[2] ? new Date(process.argv[2]).toISOString() : new Date(Date.now() - 30 * 86400_000).toISOString();
const repo = repository();
try {
  const rows = await readScreenToolStats(repo, since);
  console.log(`기준: ${since} 이후 시작한 채팅 실행`);
  console.table(rows.map(r => ({ 모델: r.model, 실행: r.runs, '화면 도구 사용 실행': r.withScreenTool, '사용률(%)': r.rate, 호출: r.calls, 적용: r.applied, 미적용: r.notApplied })));
} finally { await repo.close(); }
