type Activity = { message: string; startedAt?: string };

export function toolActivity(name: string): string {
  const tool = name.toLowerCase().split(/__|\//).at(-1) || '';
  if (/find_country/.test(tool)) return '국가 확인 중';
  if (/add_country/.test(tool)) return '국가 등록 중';
  if (/list_ingest_sources|run_ingest|get_ingest_run/.test(tool)) return '공개 자료 수집 중';
  if (/search_sources|firecrawl_search|web_search|x_search|xsearch/.test(tool)) return '자료 검색 중';
  if (/collect_source|firecrawl_scrape|read_source|source_read/.test(tool)) return '원문 확인 중';
  if (/save_source/.test(tool)) return '근거 보관 중';
  if (/research_procurement/.test(tool)) return '조사 준비 중';
  if (/normalize_procurement_data/.test(tool)) return '데이터 정리 중';
  if (/validate_research/.test(tool)) return '조사 결과 검토 중';
  if (/apply_research|submit_research|update_assumptions/.test(tool)) return '데이터 반영 중';
  if (/calculate_forecast|get_forecast|list_forecasts|get_lifespan/.test(tool)) return '예상 시기와 규모 계산 중';
  if (/write_report|prepare_report|get_report_template/.test(tool)) return '보고서 준비 중';
  if (/publish_artifact/.test(tool)) return '보고서 보관 중';
  if (/get_app_context|get_map_state|get_app_command|set_map_state|set_mode|toggle_map_mode|focus_country/.test(tool)) return '화면 상태 확인 중';
  if (/conversation|chat_model|run_status|cancel_run/.test(tool)) return '대화와 작업 상태 확인 중';
  if (/workspace_read|workspace_list/.test(tool)) return '보관 자료 확인 중';
  if (/workspace_write|file_change/.test(tool)) return '작업 파일 정리 중';
  if (/query_procurement|get_country_analysis|search_programs|get_inventory|search_mro|research_history/.test(tool)) return '조달 자료 조회 중';
  return '작업 진행 중';
}

export function createChatStatus(root: HTMLElement) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt: number | undefined, signature = '';
  let clock: HTMLElement | undefined;
  let activity: Activity | undefined;
  function tick() {
    if (!clock || startedAt === undefined || !activity) return;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    clock.textContent = seconds < 60 ? `${seconds}초 경과` : `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, '0')}초 경과`;
  }
  function set(message: string) {
    clearInterval(timer); timer = undefined; startedAt = undefined; activity = undefined; signature = '';
    root.classList.remove('is-active'); root.removeAttribute('title'); root.removeAttribute('aria-label');
    root.textContent = message;
  }
  function start(next: Activity) {
    activity = next;
    const timestamp = next.startedAt ? Date.parse(next.startedAt) : NaN;
    if (Number.isFinite(timestamp)) startedAt = timestamp;
    startedAt ??= Date.now();
    const key = next.message;
    if (key !== signature || !root.classList.contains('is-active')) {
      signature = key; root.classList.add('is-active');
      const title = document.createElement('span'); title.className = 'status-message'; title.textContent = next.message;
      clock = document.createElement('span'); clock.className = 'status-clock'; clock.setAttribute('aria-hidden', 'true');
      root.replaceChildren(title, clock);
    }
    tick(); timer ??= setInterval(tick, 1000);
  }
  return { set, start };
}
