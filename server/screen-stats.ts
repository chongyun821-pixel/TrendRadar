/** 모델별 화면 도구 사용률: runs, events에서 실행마다 화면 도구를 불렀는지 센다(읽기 전용) */
import type { Repository } from './store';

export const SCREEN_TOOL_NAMES = ['set_map_state', 'write_report', 'set_mode', 'focus_country', 'toggle_map_mode'];
export interface ScreenStat { model: string; runs: number; withScreenTool: number; rate: number; calls: number; applied: number; notApplied: number }
type RunRow = { id: string; model: string };
type EventRow = { run_id: string; name: string; data: string };

export function screenToolStats(runs: RunRow[], events: EventRow[]): ScreenStat[] {
  const byRun = new Map<string, { calls: number; applied: number; notApplied: number }>();
  for (const e of events) {
    let data: any; try { data = JSON.parse(e.data); } catch { continue; }
    if (!SCREEN_TOOL_NAMES.includes(data?.name)) continue;
    const s = byRun.get(e.run_id) ?? { calls: 0, applied: 0, notApplied: 0 };
    if (e.name === 'tool.start' || e.name === 'tool.call') s.calls++;
    if (e.name === 'tool.complete' && data.result?.status) data.result.status === 'applied' ? s.applied++ : s.notApplied++;
    byRun.set(e.run_id, s);
  }
  const models = new Map<string, ScreenStat>();
  for (const r of runs) {
    const m = models.get(r.model) ?? { model: r.model, runs: 0, withScreenTool: 0, rate: 0, calls: 0, applied: 0, notApplied: 0 };
    const s = byRun.get(r.id);
    m.runs++; if (s?.calls) m.withScreenTool++;
    m.calls += s?.calls ?? 0; m.applied += s?.applied ?? 0; m.notApplied += s?.notApplied ?? 0;
    models.set(r.model, m);
  }
  return [...models.values()].map(m => ({ ...m, rate: m.runs ? Math.round(m.withScreenTool / m.runs * 1000) / 10 : 0 })).sort((a, b) => b.runs - a.runs);
}

/** since(ISO) 이후 시작한 채팅 실행만 센다. MCP 단독 실행(model=mcp)은 뺀다 */
export async function readScreenToolStats(repo: Repository, since: string) {
  const runs = await repo.all("SELECT id, model FROM runs WHERE started_at>=? AND model<>'mcp' AND conversation_id IS NOT NULL", since);
  const events = await repo.all("SELECT e.run_id, e.name, e.data FROM events e JOIN runs r ON r.id=e.run_id WHERE r.started_at>=? AND e.name IN ('tool.start','tool.call','tool.complete')", since);
  return screenToolStats(runs as RunRow[], events as EventRow[]);
}
