type View = 'map' | 'report' | 'settings';
type SecretStatus = { name: string; set: boolean; value?: string };

export function initSettings(o: { setView(view: View): void }) {
  let previousView: 'map' | 'report' = 'map';
  let poll: ReturnType<typeof setInterval> | undefined;
  const statusEl = document.querySelector<HTMLElement>('#remoteStatus')!;
  const action = document.querySelector<HTMLButtonElement>('#remoteAction')!;
  const fallback = document.querySelector<HTMLElement>('#remoteLinkFallback')!;
  const fallbackLink = fallback.querySelector<HTMLAnchorElement>('a')!;
  async function refreshRemote() {
    try {
      const response = await fetch('/api/remote/status', { cache: 'no-store' });
      const s = await response.json();
      statusEl.textContent = s.state === 'connected' ? `원격 연결: 연결됨${s.account ? ` (${s.account})` : ''}` : s.state === 'login_required' ? '원격 연결: 로그인이 필요합니다' : s.state === 'linking' || s.state === 'connecting' ? '원격 연결: 연결하는 중입니다' : `원격 연결: ${s.message || '연결되지 않았습니다'}`;
      action.hidden = false;
      action.textContent = s.state === 'connected' ? '연결 해제' : s.state === 'login_required' || s.state === 'error' || s.state === 'off' ? '로그인해서 연결' : '다시 연결';
      action.dataset.action = s.state === 'connected' ? 'unlink' : 'link';
      if (s.state === 'connected') fallback.hidden = true;
    } catch { statusEl.textContent = '원격 연결 상태를 확인하지 못했습니다.'; }
  }
  function pollRemote() { if (poll) clearInterval(poll); poll = setInterval(() => { if (document.body.classList.contains('settings-view-active')) void refreshRemote(); }, 4000); }
  const host = document.querySelector<HTMLElement>('#secretFields')!;
  const open = () => {
    if (!document.body.classList.contains('settings-view-active')) previousView = document.body.classList.contains('report-view') ? 'report' : 'map';
    o.setView('settings');
    void loadSecrets();
    void refreshRemote(); pollRemote();
  };
  const close = () => { o.setView(previousView); if (poll) clearInterval(poll); poll = undefined; };
  window.addEventListener('radar:open-settings', event => {
    const detail = (event as CustomEvent<{ toggle?: boolean }>).detail || {};
    if (detail.toggle && document.body.classList.contains('settings-view-active')) close(); else open();
  });
  document.addEventListener('keydown', event => {
    if (document.body.classList.contains('settings-view-active') && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    }
  }, true);

  const labels: Record<string, string> = {
    DATABASE_URL: 'Supabase 데이터베이스 주소', SUPABASE_URL: 'Supabase 주소',
    SUPABASE_SECRET_KEY: 'Supabase 비밀 키', OPENAI_API_KEY: 'OpenAI API 키',
    OPENROUTER_API_KEY: 'OpenRouter API 키', FIRECRAWL_API_KEY: 'Firecrawl API 키',
  };
  async function loadSecrets() {
    host.textContent = '설정 상태를 불러오는 중입니다.';
    try {
      const response = await fetch('/api/settings/secrets', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const entries = await response.json() as SecretStatus[];
      const device = entries.find(entry => entry.name === 'HORUS_DEVICE_NAME');
      document.querySelector<HTMLInputElement>('#deviceName')!.value = device?.value || '';
      host.replaceChildren();
      for (const entry of entries.filter(item => item.name !== 'HORUS_DEVICE_NAME')) {
        const row = document.createElement('div'); row.className = 'secret-row';
        const label = document.createElement('label'); label.htmlFor = `secret-${entry.name}`; label.textContent = labels[entry.name] || entry.name;
        const input = document.createElement('input'); input.id = `secret-${entry.name}`; input.type = 'password'; input.autocomplete = 'new-password'; input.value = '';
        const status = document.createElement('span'); status.className = 'secret-status'; status.textContent = entry.set ? '설정됨' : '비어 있음';
        const save = document.createElement('button'); save.type = 'button'; save.textContent = '저장';
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '지우기';
        save.addEventListener('click', async () => {
          const hasValue = input.value.length > 0;
          try {
            const result = await fetch('/api/settings/secrets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: entry.name, value: input.value }) });
            if (!result.ok) throw new Error();
            input.value = ''; status.textContent = hasValue ? '설정됨' : '비어 있음';
          } catch { status.textContent = '저장하지 못했습니다.'; }
        });
        remove.addEventListener('click', async () => {
          try {
            const result = await fetch('/api/settings/secrets', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: entry.name }) });
            if (!result.ok) throw new Error();
            input.value = ''; status.textContent = '비어 있음';
          } catch { status.textContent = '지우지 못했습니다.'; }
        });
        row.append(label, input, status, save, remove); host.append(row);
      }
    } catch {
      host.textContent = '설정 상태를 불러오지 못했습니다. 다시 시도하려면 설정 화면을 다시 열어 주세요.';
    }
  }
  document.querySelector('#saveDeviceName')!.addEventListener('click', async () => {
    const input = document.querySelector<HTMLInputElement>('#deviceName')!;
    try {
      const response = await fetch('/api/settings/secrets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HORUS_DEVICE_NAME', value: input.value.trim() }) });
      if (!response.ok) throw new Error();
      input.setCustomValidity('');
      const linkResponse = await fetch('/api/remote/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: input.value.trim() }) });
      if (!linkResponse.ok) throw new Error();
      const { url } = await linkResponse.json(); fallback.hidden = false; fallbackLink.href = url; fallbackLink.textContent = url;
      void refreshRemote();
    } catch { input.setCustomValidity('기기 이름을 저장하지 못했습니다.'); input.reportValidity(); }
  });
  action.addEventListener('click', async () => {
    if (action.dataset.action === 'unlink') { await fetch('/api/remote/unlink', { method: 'POST' }); fallback.hidden = true; void refreshRemote(); return; }
    const device = document.querySelector<HTMLInputElement>('#deviceName')!.value.trim();
    if (!device) { statusEl.textContent = '기기 이름을 입력해 주세요.'; return; }
    try { const r = await fetch('/api/remote/link', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({device}) }); if (!r.ok) throw new Error(); const {url} = await r.json(); fallback.hidden = false; fallbackLink.href=url; fallbackLink.textContent=url; void refreshRemote(); } catch { statusEl.textContent = '원격 연결을 시작하지 못했습니다.'; }
  });
  document.querySelector('#settingsButton')!.addEventListener('click', open);
  return { open, close, isOpen: () => document.body.classList.contains('settings-view-active') };
}
