import time
"""앱 내 AI 챗봇. 제공자: Arli AI(기본, OpenAI 호환) → 실패 시 Google AI Studio(Gemini API, Gemma 4 26B)로 자동 전환.

토큰 예산 (제공자별, 모두 .secrets/환경변수로 변경 가능)
- Arli 무료 플랜: 컨텍스트 12K(입력+출력), 동시 1요청, 모델당 2일 5요청.
  12288 - 출력 1536 - 여유 1200 → 입력 예산 ≈ 9552.
- Google(Gemma 4 26B): 모델 컨텍스트 256K지만 무료 등급 한도는 공개 수치가 없어 보수적으로
  32768 - 출력 2048 - 여유 2000 → 입력 예산 ≈ 28720 (GOOGLE_CONTEXT_TOKENS 등으로 조절).
- 추정기 est_tokens(): 한글/한자/기타 비ASCII 1글자=1토큰, ASCII는 3글자=1토큰, 메시지당 +6 (보수적 과대 추정).
- 구성요소별 상한은 CAP_DEFAULTS. 예산을 넘으면 오래된 대화 → 화면 정보 → 도구 결과 순으로 줄인다.
  대체 제공자로 넘어갈 때는 그 제공자 예산으로 메시지를 다시 조립한다.
"""
import os, re, json, logging, threading
from pathlib import Path
import httpx, yaml
from . import db

log = logging.getLogger("chat")
ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / ".secrets"
KNOW = Path(__file__).resolve().parent / "knowledge"
CATS = {"company": "기업", "media": "언론", "military": "군/국방부", "academic": "학술/연구"}
CAT_ALIASES = {"기업": "company", "언론": "media", "매체": "media", "군": "military", "국방부": "military", "군/국방부": "military",
               "군·국방부": "military", "학술": "academic", "연구": "academic", "학술/연구": "academic", "학술·연구": "academic"}

# ---------------- 설정 / 비밀값 ----------------
def load_secrets(path=SECRETS):
    """간단한 dotenv 파서 (KEY=VALUE, # 주석, 따옴표 허용). 매 요청마다 읽으므로 수정 후 바로 반영된다."""
    out = {}
    try:
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line: continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if k.startswith("export "): k = k[7:].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"": v = v[1:-1]
            elif " #" in v: v = v.split(" #", 1)[0].strip()
            out[k] = v
    except FileNotFoundError:
        pass
    return out

def cfg(name, default=None, sec=None):
    sec = load_secrets() if sec is None else sec
    v = sec.get(name) or os.environ.get(name)
    return v if v not in (None, "") else default

def icfg(name, default, sec=None):
    try: return int(cfg(name, default, sec))
    except (TypeError, ValueError): return default

PROVIDERS = {
    # 이름: (표시 이름, 기본 모델, 기본 URL, 기본 컨텍스트, 기본 출력, 기본 여유)
    "arli": ("Arli AI", "Qwen3.5-27B-Derestricted", "https://api.arliai.com/v1", 12288, 1536, 1200),
    "google": ("Google AI Studio", "gemma-4-26b-a4b-it", "https://generativelanguage.googleapis.com/v1beta", 32768, 2048, 2000),
}
# 구성요소별 상한 기본값 (추정 토큰). google은 컨텍스트가 커서 더 넉넉하게.
CAP_DEFAULTS = {
    "arli":   dict(global_=1000, page_prompt=300, page_ctx=2000, article_ctx=3500, user=1200, hist_msgs=6, hist_msg=600, tool=2500, titles=20, tool_items=12),
    "google": dict(global_=1000, page_prompt=300, page_ctx=4000, article_ctx=12000, user=2000, hist_msgs=12, hist_msg=1500, tool=6000, titles=20, tool_items=20),
}
CAP_ENV = dict(global_="CHAT_CAP_GLOBAL", page_prompt="CHAT_CAP_PAGE_PROMPT", page_ctx="CHAT_CAP_PAGE_CONTEXT", article_ctx="CHAT_CAP_ARTICLE",
               user="CHAT_CAP_USER", hist_msgs="CHAT_HISTORY_MESSAGES", hist_msg="CHAT_CAP_HISTORY_MSG", tool="CHAT_CAP_TOOL",
               titles="CHAT_CONTEXT_TITLES", tool_items="CHAT_TOOL_ITEMS")

class Settings:
    """제공자별 설정. 키 이름은 ARLIAI_* / GOOGLE_* 접두어. 상한은 <접두어>_CHAT_CAP_* 가 있으면 우선, 없으면 CHAT_CAP_*."""
    def __init__(self, provider="arli", sec=None):
        s = load_secrets() if sec is None else sec
        if provider not in PROVIDERS: provider = "arli"
        P = "ARLIAI" if provider == "arli" else "GOOGLE"
        label, model, url, ctx, out, safety = PROVIDERS[provider]
        self.provider, self.label = provider, label
        self.key = cfg(f"{P}_API_KEY", "", s) or (cfg("GEMINI_API_KEY", "", s) if provider == "google" else "")
        self.model = cfg(f"{P}_MODEL", model, s)
        self.base_url = cfg(f"{P}_BASE_URL", url, s).rstrip("/")
        self.timeout = icfg(f"{P}_TIMEOUT", 120 if provider == "arli" else 90, s)
        self.context = icfg(f"{P}_CONTEXT_TOKENS", ctx, s)
        self.max_output = icfg(f"{P}_MAX_OUTPUT_TOKENS", out, s)
        self.safety = icfg(f"{P}_SAFETY_TOKENS", safety, s)
        self.input_budget = icfg(f"{P}_INPUT_BUDGET", icfg("CHAT_INPUT_BUDGET", 0, s) if provider == "arli" else 0, s) \
            or (self.context - self.max_output - self.safety)
        self.temperature = float(cfg(f"{P}_TEMPERATURE", 0.4, s))
        # 생각(thinking) 끄기: arli=reasoning_effort("none"), google=thinkingLevel("minimal"). "default"면 보내지 않음
        self.reasoning_effort = cfg("ARLIAI_REASONING_EFFORT", "none", s)
        self.thinking_level = cfg("GOOGLE_THINKING_LEVEL", "minimal", s)
        self.system_mode = (cfg("GOOGLE_SYSTEM_MODE", "instruction", s) or "instruction").lower()  # instruction | fold
        self.agent_rounds = icfg("CHAT_AGENT_ROUNDS", 3, s)  # 도구 호출 왕복 최대 횟수 (0=도구 끔, 답만)
        self.caps = {k: icfg(f"{P}_{env}", icfg(env, CAP_DEFAULTS[provider][k], s), s) for k, env in CAP_ENV.items()}

    @property
    def model_label(self):
        return f"{self.label} · {self.model}"

def provider_order(sec=None):
    """CHAT_PROVIDER = auto(기본) | arli | google. auto: Arli 키가 있으면 Arli → 실패 시 Google, 없으면 Google."""
    s = load_secrets() if sec is None else sec
    mode = (cfg("CHAT_PROVIDER", "auto", s) or "auto").strip().lower()
    names = {"arli": ["arli"], "google": ["google"], "gemma": ["google"], "gemini": ["google"]}.get(mode, ["arli", "google"])
    sts = [Settings(n, s) for n in names]
    return mode if mode in ("arli", "google") else "auto", [st for st in sts if st.key], sts

# ---------------- 토큰 추정 ----------------
_WIDE = re.compile(r"[^\x00-\x7f]")
MSG_OVERHEAD = 6

def est_tokens(s):
    s = s or ""
    wide = len(_WIDE.findall(s))
    return wide + (len(s) - wide + 2) // 3


def truncate_tokens(s, n, mark="…(생략)"):
    s = s or ""
    if est_tokens(s) <= n: return s
    if n <= 0: return ""
    budget, acc = n - est_tokens(mark), 0.0
    for i, ch in enumerate(s):
        acc += 1 if ord(ch) > 127 else 1 / 3
        if acc > budget: return s[:i].rstrip() + mark
    return s

# ---------------- 지식 / 프롬프트 ----------------
def global_knowledge(st=None):
    try: t = (KNOW / "global.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError: t = "너는 「글로벌 방산 동향 검색」 앱의 한국어 AI 도우미다. 지금은 {MODEL} 모델로 동작한다."
    return t.replace("{MODEL}", st.model_label if st else "Arli AI · Qwen3.5-27B-Derestricted")

def page_prompts():
    try: return yaml.safe_load((KNOW / "pages.yaml").read_text(encoding="utf-8")) or {}
    except FileNotFoundError: return {}

def source_names():
    try: return [r["source"] for r in db.sources_summary()]
    except Exception: return []

def action_spec(sources):
    from . import commands
    return commands.action_spec(sources)

def _s(v, n=300):
    return str(v if v is not None else "").replace("\n", " ").strip()[:n]

def format_page_context(page, st):
    """클라이언트가 보낸 화면 정보를 간단한 텍스트로. (반환: 페이지유형, 텍스트)"""
    page = page if isinstance(page, dict) else {}
    t = page.get("type") or "default"
    L = []
    if t == "home_raw":
        L.append(f"검색어: {_s(page.get('q')) or '(없음)'} | 분류: {CATS.get(page.get('category'), '전체')} | 출처: {_s(page.get('source')) or '전체'}"
                 + (f" | 기간: {_s(page.get('date_from'), 10) or '…'}~{_s(page.get('date_to'), 10) or '…'}" if page.get('date_from') or page.get('date_to') else "")
                 + (f" | 정렬: {_s(page.get('sort'), 10)}" if page.get('sort') else ""))
        if page.get("info"): L.append(f"결과: {_s(page.get('info'), 200)}")
        items = page.get("items") or []
        if isinstance(items, list) and items:
            L.append(f"보이는 기사 (상위 {min(len(items), st.caps['titles'])}개, id | 출처 | 날짜 | 제목):")
            for it in items[: st.caps["titles"]]:
                if isinstance(it, dict):
                    L.append(f"#{_s(it.get('id'), 12)} | {_s(it.get('source'), 60)} | {_s(it.get('date'), 20)} | {_s(it.get('title'), 160)}")
        else:
            L.append("보이는 기사 없음")
    elif t == "home_digest":
        L.append(f"기간: 최근 {_s(page.get('days'), 5)}일 {_s(page.get('meta'), 120)}")
        for i, tp in enumerate((page.get("topics") or [])[:4], 1):
            if isinstance(tp, dict):
                L.append(f"{i}. {_s(tp.get('headline'), 160)}\n   {_s(tp.get('summary'), 600)}")
        if len(L) == 1: L.append("뉴스레터가 아직 없음(생성 중일 수 있음)")
    elif t == "article":
        art = _article_for_context(page)
        L.append(f"기사 id: {_s(art.get('id'), 12)}\n제목: {_s(art.get('title'), 300)}\n출처: {_s(art.get('source'), 80)} | 날짜: {_s(art.get('published') or art.get('date'), 30)}\nURL: {_s(art.get('url'), 300)}")
        src = "원문 본문" if art.get("text_source") == "original" else "본문 없음 → 피드 요약만 있음"
        L.append(f"[본문 ({src})]\n" + (art.get("text") or "(내용 없음)"))
    else:
        L.append(_s(json.dumps(page, ensure_ascii=False), 1500))
    return t, "\n".join(L)

def _article_for_context(page):
    """기사 본문은 서버 캐시(DB)에서 직접 읽는다(클라이언트가 보낸 text는 대체값)."""
    try:
        from . import article
        iid = int(page.get("id"))
        it = article.get_item(iid)
        if it:
            c = article._cached(iid) or {}
            ok = c.get("status") == "ok" and c.get("text")
            return dict(it, text=c["text"] if ok else (it.get("summary") or ""), text_source="original" if ok else "summary")
    except Exception:
        pass
    return {k: page.get(k) for k in ("id", "title", "source", "date", "url", "text", "text_source")}

def _msg_tokens(m):
    t = est_tokens(m.get("content") or "") + MSG_OVERHEAD
    if m.get("tool_calls"): t += est_tokens(json.dumps(m["tool_calls"], ensure_ascii=False))
    return t

def msgs_tokens(msgs):
    return sum(_msg_tokens(m) for m in msgs)

def tool_rules(sources, today=None):
    """도구(네이티브 tool calling) 모드용 짧은 규칙. 긴 텍스트 동작 규칙 대신 사용."""
    from datetime import date
    today = today or date.today()
    return ("# 앱 조작 (도구)\n"
            f"오늘: {today.isoformat()}({'월화수목금토일'[today.weekday()]}). '지난주'·'최근 3일'은 date_from/date_to(YYYY-MM-DD)로 바꾼다.\n"
            "사용자가 찾기·검색·필터·열기·이동·내보내기·북마크·수집·요약 등을 요청하면 설명하지 말고 반드시 해당 도구를 호출한다. "
            "도구를 호출하지 않으면 아무것도 실행되지 않는다. 도구 결과를 받은 뒤 한국어로 짧게 답한다.\n"
            "확인이 필요한 도구(collect·source_*)는 호출하면 화면에 실행 버튼이 뜬다. 실행됐다고 말하지 말고 버튼을 누르라고 안내한다.\n"
            "search 의 q 는 영어 키워드가 가장 잘 맞는다(예: frigate OR destroyer). 출처 이름: " + ", ".join(sources))

FINAL_RULE = "# 지금은 도구를 쓸 수 없다\n위 도구 결과를 근거로 사용자 질문에 한국어로 최종 답만 쓴다. 동작 블록·도구 호출을 쓰지 마라."

def build_messages(messages, page, st, sources=None, extra=None, mode="text", extra_msgs=None, reserve=0):
    """system(전역 지식 + 페이지 지침 + 조작 규칙 + 화면 정보) + 이전 대화 + 사용자 메시지 + extra_msgs(도구 왕복).
    mode: 'tools'(짧은 도구 규칙) | 'text'(```action 블록 규칙) | 'final'(도구 금지).
    reserve: 도구 스키마 등 messages 밖에서 쓰는 토큰 (예산에서 뺀다). 반환: (messages, stats)"""
    caps = st.caps
    sources = source_names() if sources is None else sources
    hist = [m for m in (messages or []) if isinstance(m, dict) and m.get("role") in ("user", "assistant") and str(m.get("content") or "").strip()]
    if not hist or hist[-1]["role"] != "user":
        raise ValueError("마지막 메시지는 user 여야 합니다")
    user = truncate_tokens(str(hist[-1]["content"]), caps["user"])
    hist = [{"role": m["role"], "content": truncate_tokens(str(m["content"]), caps["hist_msg"])} for m in hist[:-1]][-caps["hist_msgs"]:]
    while hist and hist[0]["role"] != "user": hist.pop(0)  # user로 시작하도록
    ptype, pctx = format_page_context(page, st)
    gk = truncate_tokens(global_knowledge(st), caps["global_"])
    pp = truncate_tokens((page_prompts().get(ptype) or page_prompts().get("default") or "").strip(), caps["page_prompt"])
    spec = tool_rules(sources) if mode == "tools" else (FINAL_RULE if mode == "final" else action_spec(sources))
    ctx_cap = caps["article_ctx"] if ptype == "article" else caps["page_ctx"]
    tool_cap = caps["tool"]
    xm = [dict(m) for m in (extra_msgs or [])]
    if extra:  # (이전 형식) 1차 답변 + 도구 결과 텍스트
        first, tool = extra
        xm = [{"role": "assistant", "content": first or "(검색을 실행합니다)"},
              {"role": "user", "content": "[시스템: 도구 실행 결과]\n" + tool, "_tool_text": True}]
    budget = st.input_budget - reserve

    def assemble(ctx_cap, tool_cap, hist):
        sys = f"{gk}\n\n# 현재 페이지 지침\n{pp}\n\n{spec}\n\n[현재 화면]\n{truncate_tokens(pctx, ctx_cap)}"
        msgs = [{"role": "system", "content": sys}] + hist + [{"role": "user", "content": user}]
        n_tool = max(1, sum(1 for m in xm if m.get("role") == "tool" or m.get("_tool_text")))
        for m in xm:
            m2 = {k: v for k, v in m.items() if k != "_tool_text"}
            if m.get("role") == "tool" or m.get("_tool_text"):
                m2["content"] = truncate_tokens(m["content"], max(150, tool_cap // n_tool))
            msgs.append(m2)
        if mode == "final" and xm and xm[-1].get("role") == "tool":
            pass
        return msgs

    dropped = 0
    msgs = assemble(ctx_cap, tool_cap, hist)
    while msgs_tokens(msgs) > budget and hist:
        hist = hist[2:] if len(hist) >= 2 else []   # 오래된 (user, assistant) 쌍부터 제거
        dropped += 1
        msgs = assemble(ctx_cap, tool_cap, hist)
    while msgs_tokens(msgs) > budget and ctx_cap > 300:
        ctx_cap = int(ctx_cap * 0.75); msgs = assemble(ctx_cap, tool_cap, hist)
    while msgs_tokens(msgs) > budget and xm and tool_cap > 300:
        tool_cap = int(tool_cap * 0.75); msgs = assemble(ctx_cap, tool_cap, hist)
    stats = {"page_type": ptype, "est_input_tokens": msgs_tokens(msgs) + reserve, "input_budget": st.input_budget,
             "tool_schema_tokens": reserve, "history_kept": len(hist), "history_dropped_pairs": dropped, "page_ctx_cap": ctx_cap}
    return msgs, stats

# ---------------- 출력 후처리 (관대한 동작 파서) ----------------
_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)
_FENCE = re.compile(r"```[ \t]*(action|json|tool_call|tool|function)?[ \t]*\n?(.*?)```", re.S | re.I)
_TOOL_TAG = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|$)", re.S | re.I)
_XML_FUNC = re.compile(r"<function=([\w.\-]+)>(.*?)</function>", re.S)
_XML_PARAM = re.compile(r"<parameter=([\w\-]+)>\s*(.*?)\s*</parameter>", re.S)

def strip_think(text):
    t = _THINK.sub("", text or "")
    if re.search(r"</think>", t, re.I): t = re.split(r"</think>", t, flags=re.I)[-1]  # 여는 태그 없이 닫는 태그만 있는 경우
    if re.search(r"<think>", t, re.I): t = re.split(r"<think>", t, flags=re.I)[0]    # 닫히지 않은 생각 블록
    return t.strip()

def _norm_call(o):
    """{"cmd"/"name"/"type"/"tool"/"function": x, "args"/"arguments"/"parameters": {...} | 나머지 키} → {"cmd", "args"} 또는 None."""
    from . import commands
    if not isinstance(o, dict): return None
    if isinstance(o.get("function"), dict):  # OpenAI 형식 {"type":"function","function":{"name","arguments"}}
        return _norm_call(o["function"])
    name = next((o.get(k) for k in ("cmd", "name", "tool", "type", "function", "action") if isinstance(o.get(k), str) and commands.resolve(o.get(k))), None)
    if not name: return None
    args = next((o.get(k) for k in ("args", "arguments", "parameters", "params", "input") if k in o), None)
    if isinstance(args, str):
        try: args = json.loads(args)
        except Exception: args = None
    if not isinstance(args, dict):
        args = {k: v for k, v in o.items() if k not in ("cmd", "name", "tool", "type", "function", "action", "confirm", "id")}
    return {"cmd": name, "args": args}

def _json_calls(s):
    try: o = json.loads(s)
    except Exception: return None
    items = o if isinstance(o, list) else [o]
    calls = [c for c in (_norm_call(x) for x in items) if c]
    return calls or None

def _bare_json_spans(text):
    """본문 속 균형 잡힌 {...} / [...] 덩어리 (위치, 문자열)."""
    spans, i, n = [], 0, len(text)
    while i < n:
        if text[i] in "{[":
            open_, close = text[i], "}" if text[i] == "{" else "]"
            depth, j, ins, esc = 0, i, False, False
            while j < n:
                ch = text[j]
                if ins:
                    if esc: esc = False
                    elif ch == "\\": esc = True
                    elif ch == '"': ins = False
                elif ch == '"': ins = True
                elif ch in "{[": depth += 1
                elif ch in "}]":
                    depth -= 1
                    if depth == 0: break
                j += 1
            if j < n and text[j] == close:
                spans.append((i, j + 1)); i = j + 1; continue
        i += 1
    return spans

def parse_action(text):
    """답변에서 동작(도구 호출) 텍스트를 찾아 떼어 낸다 → (보이는 본문, [{"cmd","args"}] | None).
    지원: ```action/```json/``` 블록, <tool_call>{...}</tool_call>(Hermes/Qwen), <function=x><parameter=k>v</parameter></function>
    (Qwen3 XML), 본문 속 {"type"/"name"/"cmd": ...} JSON."""
    text = text or ""
    calls, cut = [], []
    for m in _TOOL_TAG.finditer(text):
        body = m.group(1)
        got = _json_calls(body)
        if not got:
            got = [{"cmd": f.group(1), "args": {p.group(1): p.group(2) for p in _XML_PARAM.finditer(f.group(2))}} for f in _XML_FUNC.finditer(body)]
        if got: calls += got
        cut.append(m.span())
    for f in _XML_FUNC.finditer(text):
        if any(a <= f.start() < b for a, b in cut): continue
        calls.append({"cmd": f.group(1), "args": {p.group(1): p.group(2) for p in _XML_PARAM.finditer(f.group(2))}}); cut.append(f.span())
    for m in _FENCE.finditer(text):
        if any(a <= m.start() < b for a, b in cut): continue
        got = _json_calls(m.group(2).strip())
        if got: calls += got; cut.append(m.span())
        elif (m.group(1) or "").lower() == "action": cut.append(m.span())  # 깨진 action 블록도 숨김
    for a, b in _bare_json_spans(text):
        if any(x <= a < y for x, y in cut): continue
        got = _json_calls(text[a:b])
        if got: calls += got; cut.append((a, b))
    clean = text
    for a, b in sorted(cut, reverse=True): clean = clean[:a] + clean[b:]
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    from . import commands
    calls = [c for c in calls if commands.resolve(c["cmd"])]
    return clean, (calls or None)

def validate_actions(raw, page=None):
    """레지스트리 기준 검증. confirm 플래그는 레지스트리 값으로 강제."""
    from . import commands
    page = page if isinstance(page, dict) else {}
    ctx = {"article_id": page.get("id") if page.get("type") == "article" else None}
    return commands.validate_llm(raw or [], ctx)

# ---------------- 도구 실행 (서버) ----------------
TOOL_CMDS = ("search", "summarize", "bookmarks", "sources")

def _search_text(q, cat, src, df, dt, st, sort="date"):
    try:
        total, items = db.search(q, cat, src, df, dt, limit=st.caps["tool_items"])
    except Exception as e:
        return f"검색 실패: {type(e).__name__}", 0
    head = (f"검색어 '{q}' 분류 '{CATS.get(cat, '전체')}' 출처 '{src or '전체'}'" + (f" 기간 {df or '…'}~{dt or '…'}" if df or dt else "")
            + f" → 총 {total}건, 최신 {len(items)}건:")
    lines = [head] + [f"#{i['id']} | {i['source']} | {(i['published'] or '')[:10]} | {_s(i['title'], 160)} — {_s(i.get('summary'), 200)}"
                      for i in items]
    return ("\n".join(lines) if items else head + " (결과 없음)"), total

def tool_results(action, page, st):
    """(이전 호환) 동작 하나의 서버 측 결과 텍스트."""
    return execute_tool(action, page, st, {})[0]

def execute_tool(action, page, st, state):
    """검증된 동작 하나 실행 → (모델에 줄 결과 텍스트, 화면 동작|None, 사용자 표시 메모|None).
    confirm 명령은 절대 실행하지 않고 화면에 확인 버튼만 띄운다."""
    from . import commands
    page = page if isinstance(page, dict) else {}
    n, a = action["name"], action.get("args", {})
    if action.get("confirm"):
        return (f"사용자 확인 대기 중: 화면에 '{n}' 실행 버튼이 표시됐다. 아직 실행되지 않았다.", action, None)
    if n == "search":
        txt, _ = _search_text(a.get("q", ""), a.get("category", ""), a.get("source", ""), a.get("date_from", ""), a.get("date_to", ""), st)
        state.update({k: a.get(k, "") for k in ("q", "category", "source", "date_from", "date_to")})
        return txt + "\n(화면에도 같은 검색이 실행된다)", action, None
    if n == "filter":
        base = {k: state.get(k, page.get(k, "")) or "" for k in ("q", "date_from", "date_to")}
        txt, _ = _search_text(_s(base["q"], 200), a.get("category", ""), a.get("source", ""), _s(base["date_from"], 10), _s(base["date_to"], 10), st)
        state.update(category=a.get("category", ""), source=a.get("source", ""))
        return txt + "\n(화면 필터도 바뀐다)", action, None
    if n == "summarize":
        if page.get("type") in ("article", "home_digest"):
            return "요약 대상은 [현재 화면]에 있다. 그 내용을 요약하라.", None, None
        txt, _ = _search_text(_s(state.get("q", page.get("q")), 200), _s(state.get("category", page.get("category")), 20),
                              _s(state.get("source", page.get("source")), 100), _s(state.get("date_from", page.get("date_from")), 10),
                              _s(state.get("date_to", page.get("date_to")), 10), st)
        return txt, None, None
    if n in ("sources", "bookmarks", "bookmark", "unbookmark"):
        ctx = {"article_id": page.get("id") if page.get("type") == "article" else None}
        r = commands.run(n, a, ctx=ctx)
        msg = r.get("message", "")
        return msg, None, (msg if n in ("bookmark", "unbookmark") else None)
    if n == "export":
        from urllib.parse import urlencode
        p = a or {k: state.get(k, page.get(k, "")) for k in ("q", "category", "source", "date_from", "date_to")}
        url = "/api/export?" + urlencode({k: v for k, v in p.items() if v})
        return f"CSV 다운로드를 시작한다: {url}", action, None
    return f"화면에서 '{n}' 실행됨", action, None

# ---------------- 모델 호출 (Arli AI / Google AI Studio) ----------------
_sems = {"arli": threading.Semaphore(1), "google": threading.Semaphore(2)}  # Arli 무료/기본 플랜: 동시 1요청

class ChatError(Exception):
    pass

def _err_detail(r):
    try:
        j = r.json()
        e = j.get("error")
        d = (e.get("message") if isinstance(e, dict) else e) or j.get("message") or ""
    except Exception:
        d = r.text
    return str(d).replace("\n", " ")[:200]

def _post(st, url, body, headers):
    sem = _sems.get(st.provider) or threading.Semaphore(1)
    if not sem.acquire(timeout=st.timeout):
        raise ChatError("다른 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.")
    try:
        r = None
        for i in range(3):  # 일시적 서버 오류(5xx)는 최대 2회 재시도
            r = httpx.post(url, json=body, timeout=st.timeout, headers=headers)
            if r.status_code < 500 or i == 2:
                break
            log.warning("%s HTTP %s, 재시도 %d", st.label, r.status_code, i + 1)
            time.sleep(1.5 * (i + 1))
        return r
    except httpx.TimeoutException:
        raise ChatError(f"{st.label} 응답 시간 초과({st.timeout}초).")
    except httpx.HTTPError as e:
        raise ChatError(f"{st.label} 서버에 연결할 수 없습니다 ({type(e).__name__}).")
    finally:
        sem.release()

def _http_error(st, r, detail):
    log.warning("%s 오류 %s: %s", st.label, r.status_code, detail)  # 키는 절대 기록하지 않음 (헤더로만 전송)
    sfx = f" ({detail})" if detail else ""
    if r.status_code in (401, 403) or "API_KEY_INVALID" in detail or "API key not valid" in detail:
        k = "ARLIAI_API_KEY" if st.provider == "arli" else "GOOGLE_API_KEY"
        return ChatError(f"{st.label} API 키가 올바르지 않거나 이 모델에 접근 권한이 없습니다. .secrets의 {k}를 확인해 주세요.{sfx}")
    if r.status_code == 429:
        lim = "무료 플랜은 모델당 2일에 5회만 요청할 수 있습니다." if st.provider == "arli" else "무료 등급의 분당/일일 요청 한도를 넘었을 수 있습니다."
        return ChatError(f"{st.label} 사용 한도를 초과했습니다. {lim} 잠시 후 다시 시도해 주세요.{sfx}")
    return ChatError(f"{st.label} 오류 (HTTP {r.status_code}){': ' + detail if detail else ''}")

class ToolsRejected(ChatError):
    """제공자가 tools 파라미터를 거부(400) → 텍스트 동작 블록 방식으로 재시도."""

def _openai_msgs(msgs):
    out = []
    for m in msgs:
        if m.get("role") == "tool":
            out.append({"role": "tool", "tool_call_id": m.get("tool_call_id") or "", "content": m.get("content") or ""})
        elif m.get("tool_calls"):
            out.append({"role": "assistant", "content": m.get("content") or "",
                        "tool_calls": [{"id": c["id"], "type": "function",
                                        "function": {"name": c["name"], "arguments": json.dumps(c.get("args") or {}, ensure_ascii=False)}}
                                       for c in m["tool_calls"]]})
        else:
            out.append({"role": m["role"], "content": m.get("content") or ""})
    return out

def call_arli(msgs, st, tools=None):
    """→ {"text", "tool_calls":[{"id","name","args"}]}. tools 를 주면 tool_choice=auto (Arli 기본값은 none)."""
    body = {"model": st.model, "messages": _openai_msgs(msgs), "max_completion_tokens": st.max_output,
            "temperature": st.temperature, "stream": False}
    if st.reasoning_effort and st.reasoning_effort.lower() != "default":
        body["reasoning_effort"] = st.reasoning_effort
    if tools:
        body["tools"] = tools; body["tool_choice"] = "auto"
    r = _post(st, f"{st.base_url}/chat/completions", body,
              {"Authorization": f"Bearer {st.key}", "Content-Type": "application/json"})
    if r.status_code == 400 and tools:
        d = _err_detail(r)
        log.warning("%s tools 거부(400) → 텍스트 동작 방식: %s", st.label, d)
        raise ToolsRejected(f"{st.label} tools 거부: {d}")
    if r.status_code != 200: raise _http_error(st, r, _err_detail(r))
    try:
        msg = r.json()["choices"][0]["message"]
    except Exception:
        raise ChatError(f"{st.label} 응답 형식을 해석할 수 없습니다.")
    calls = []
    for i, c in enumerate(msg.get("tool_calls") or []):
        f = c.get("function") or {}
        args = f.get("arguments")
        if isinstance(args, str):
            try: args = json.loads(args) if args.strip() else {}
            except Exception: args = {}
        calls.append({"id": c.get("id") or f"call_{i}", "name": f.get("name") or "", "args": args if isinstance(args, dict) else {}})
    return {"text": msg.get("content") or "", "tool_calls": calls}

def to_gemini(msgs, fold_system=False):
    """OpenAI 형식(+도구 왕복) messages → Gemini (contents, systemInstruction).
    assistant.tool_calls → model functionCall 파트, tool → user functionResponse 파트. 같은 역할 연속은 합친다.
    fold_system=True면 시스템 프롬프트를 첫 user 메시지 앞에 붙인다."""
    system = "\n\n".join(m["content"] for m in msgs if m["role"] == "system")
    contents = []
    def push(role, parts):
        if contents and contents[-1]["role"] == role:
            last = contents[-1]["parts"]
            if parts and "text" in parts[0] and last and "text" in last[-1] and len(parts) == 1:
                last[-1] = {"text": last[-1]["text"] + "\n\n" + parts[0]["text"]}
            else:
                last.extend(parts)
        else:
            contents.append({"role": role, "parts": list(parts)})
    for m in msgs:
        r = m["role"]
        if r == "system": continue
        if r == "tool":
            fr = {"name": m.get("name") or "", "response": {"result": m.get("content") or ""}}
            if m.get("tool_call_id") and not str(m["tool_call_id"]).startswith("call_"): fr["id"] = m["tool_call_id"]
            push("user", [{"functionResponse": fr}])
        elif r == "assistant" and (m.get("tool_calls") or m.get("_gparts")):
            parts = m.get("_gparts") or ([{"text": m["content"]}] if m.get("content") else []) + \
                [{"functionCall": dict({"name": c["name"], "args": c.get("args") or {}},
                                       **({"id": c["id"]} if c.get("id") and not str(c["id"]).startswith("call_") else {}))}
                 for c in m["tool_calls"]]
            push("model", parts)
        else:
            push("model" if r == "assistant" else "user", [{"text": m.get("content") or ""}])
    if fold_system and system:
        first = next((c for c in contents if c["role"] == "user" and "text" in c["parts"][0]), None)
        if first: first["parts"][0] = {"text": f"[지침]\n{system}\n\n[사용자 메시지]\n" + first["parts"][0]["text"]}
        return contents, None
    return contents, ({"parts": [{"text": system}]} if system else None)

def call_google(msgs, st, tools=None):
    """Gemini API 네이티브 generateContent (Gemma 4 공식 문서 방식). 키는 x-goog-api-key 헤더로 전송(URL에 넣지 않음).
    tools 는 [{"functionDeclarations":[...]}], toolConfig.functionCallingConfig.mode=AUTO."""
    url = f"{st.base_url}/models/{st.model}:generateContent"
    headers = {"x-goog-api-key": st.key, "Content-Type": "application/json"}
    def body(fold, thinking):
        contents, sysi = to_gemini(msgs, fold)
        gc = {"maxOutputTokens": st.max_output, "temperature": st.temperature}
        if thinking and st.thinking_level and st.thinking_level.lower() != "default":
            gc["thinkingConfig"] = {"thinkingLevel": st.thinking_level}
        b = {"contents": contents, "generationConfig": gc}
        if sysi: b["systemInstruction"] = sysi
        if tools:
            b["tools"] = tools; b["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
        return b
    fold = st.system_mode == "fold"
    r = _post(st, url, body(fold, True), headers)
    if r.status_code == 400:  # 시스템 지시/thinkingConfig 미지원 등 → 접어서 + thinking 설정 없이 1회 재시도
        d = _err_detail(r)
        if "API_KEY" not in d and "API key" not in d:
            log.info("%s 400 → 시스템 프롬프트를 user 메시지에 합쳐 재시도: %s", st.label, d)
            r = _post(st, url, body(True, False), headers)
            if r.status_code == 400 and tools:
                d = _err_detail(r)
                log.warning("%s tools 거부(400) → 텍스트 동작 방식: %s", st.label, d)
                raise ToolsRejected(f"{st.label} tools 거부: {d}")
    if r.status_code != 200: raise _http_error(st, r, _err_detail(r))
    try:
        j = r.json()
        cand = (j.get("candidates") or [{}])[0]
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought") and "text" in p)  # 생각(thought) 부분 제외
        calls = [{"id": (p["functionCall"].get("id") or f"call_{i}"), "name": p["functionCall"].get("name") or "",
                  "args": p["functionCall"].get("args") or {}} for i, p in enumerate(parts) if isinstance(p.get("functionCall"), dict)]
    except Exception:
        raise ChatError(f"{st.label} 응답 형식을 해석할 수 없습니다.")
    if not text.strip() and not calls:
        fr = cand.get("finishReason") or (j.get("promptFeedback") or {}).get("blockReason") or ""
        raise ChatError(f"{st.label} 빈 응답{' (' + fr + ')' if fr else ''}")
    keep = [p for p in parts if not p.get("thought")]
    return {"text": text, "tool_calls": calls, "_gparts": keep if calls else None}

def call_model(msgs, st, tools=None):
    return call_google(msgs, st, tools) if st.provider == "google" else call_arli(msgs, st, tools)

NO_KEY_MSG = ("AI 챗봇을 쓰려면 API 키가 필요합니다. 아래 중 하나(또는 둘 다)를 설정하세요.\n\n"
              "- **Arli AI** (기본): https://www.arliai.com → **My API Keys** 에서 키 복사 → `.secrets`의 `ARLIAI_API_KEY=` 뒤에 붙여 넣기\n"
              "- **Google AI Studio** (예비, Gemma 4 26B): https://aistudio.google.com/apikey 에서 키 발급 → `.secrets`의 `GOOGLE_API_KEY=` 뒤에 붙여 넣기\n\n"
              "저장한 뒤 앱(`python run.py`)을 다시 시작하고 다시 질문해 주세요.")

def _no_key_for(mode):
    if mode == "arli":
        return "CHAT_PROVIDER=arli 로 설정되어 있지만 `.secrets`의 `ARLIAI_API_KEY`가 비어 있습니다. 키를 넣고 앱을 다시 시작해 주세요."
    return "CHAT_PROVIDER=google 로 설정되어 있지만 `.secrets`의 `GOOGLE_API_KEY`가 비어 있습니다. 키를 넣고 앱을 다시 시작해 주세요."

# ---------------- 디버그 로그 (data/chat_debug.log, 회전) ----------------
_dbg_logger = None
def _debug_logger():
    global _dbg_logger
    if _dbg_logger is None:
        from logging.handlers import RotatingFileHandler
        lg = logging.getLogger("chat.debug"); lg.propagate = False; lg.setLevel(logging.INFO)
        try:
            p = db.DB_PATH.parent / "chat_debug.log"; p.parent.mkdir(parents=True, exist_ok=True)
            h = RotatingFileHandler(p, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
            h.setFormatter(logging.Formatter("%(message)s")); lg.addHandler(h)
        except Exception:
            lg.addHandler(logging.NullHandler())
        _dbg_logger = lg
    return _dbg_logger

def _write_debug(rec):
    """프롬프트 전체·키는 기록하지 않는다 (모델 원문 2000자, 도구 호출/결과 요약, 오류)."""
    if str(cfg("CHAT_DEBUG_LOG", "1")).lower() in ("0", "false", "off", "no"): return
    try:
        from datetime import datetime
        rec = dict(rec, ts=datetime.now().isoformat(timespec="seconds"))
        _debug_logger().info(json.dumps(rec, ensure_ascii=False, default=str))
    except Exception:
        log.exception("디버그 로그 기록 실패")

# ---------------- 에이전트 루프 ----------------
def _invoke(caller, msgs, st, tools):
    try:
        import inspect
        n = len(inspect.signature(caller).parameters)
    except (TypeError, ValueError):
        n = 3
    r = caller(msgs, st, tools) if n >= 3 else caller(msgs, st)
    if isinstance(r, str): r = {"text": r, "tool_calls": []}
    r = dict(r or {}); r["text"] = r.get("text") or ""; r["tool_calls"] = r.get("tool_calls") or []
    return r

def _render(convo, mode):
    """도구 왕복 기록을 모드에 맞게: tools → assistant.tool_calls + tool 메시지, text/final → 텍스트 결과 메시지."""
    if mode == "tools": return convo
    out, buf = [], []
    def flush():
        if buf:
            out.append({"role": "user", "_tool_text": True, "content": "[시스템: 도구 실행 결과]\n" + "\n\n".join(buf) +
                        ("\n\n위 결과를 근거로 답하라. 화면 조작이 더 필요하면 동작 블록을 붙인다." if mode == "text" else "")})
            buf.clear()
    for m in convo:
        if m["role"] == "tool":
            buf.append(f"[{m.get('name')}] {m['content']}")
        else:
            flush()
            calls = m.get("tool_calls") or []
            desc = " ".join(f"(동작 {c['name']} {json.dumps(c.get('args') or {}, ensure_ascii=False)})" for c in calls)
            out.append({"role": "assistant", "content": ((m.get("content") or "") + " " + desc).strip() or "(동작 실행)"})
    flush()
    return out

_TOOLS_REJECTED = {}  # (provider, model) → 시각. 프로세스가 살아 있는 동안 tools 를 다시 보내지 않는다 (요청 낭비 방지)

def _tools_enabled(st):
    if str(cfg("CHAT_TOOLS", "1")).lower() in ("0", "false", "off", "no"): return False
    return getattr(st, "tools_ok", True) and (st.provider, st.model) not in _TOOLS_REJECTED

def _auto_reply(ui, notes):
    if any(a.get("confirm") for a in ui): return "실행 버튼을 눌러 확인해 주세요."
    if notes: return "\n".join(notes)
    return "실행했습니다." if ui else ""

def chat(messages, page, caller=None):
    caller = caller or call_model
    mode_cfg, providers, _ = provider_order()
    if not providers:
        return {"reply": NO_KEY_MSG if mode_cfg == "auto" else _no_key_for(mode_cfg), "actions": [], "action": None, "error": "no_key", "provider": None}
    from . import commands
    sources = source_names()
    page = page if isinstance(page, dict) else {}
    try:
        _, stats0 = build_messages(messages, page, providers[0], sources)  # 형식 검증
    except ValueError as e:
        return {"reply": f"요청 형식 오류: {e}", "actions": [], "action": None, "error": "bad_request", "provider": None}
    ptype = stats0["page_type"]
    last_user = next((str(m.get("content", "")) for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), "")
    dbg = {"page_type": ptype, "user": last_user[:300], "attempts": [], "tool_results": []}
    max_rounds = max(0, providers[0].agent_rounds)
    convo, ui, notes, failures, state = [], [], [], [], {}
    pi, st, meta, final, n_calls = 0, providers[0], {"rounds": 0}, None, 0
    tool_ctx = {"article_id": page.get("id") if ptype == "article" else None}
    try:
        for rnd in range(max_rounds + 1):
            allow = rnd < max_rounds
            while True:  # 제공자 호출 (실패 시 다음 제공자, tools 거부 시 같은 제공자 텍스트 모드)
                if pi >= len(providers): raise ChatError(failures[-1]["error"] if failures else "사용 가능한 모델이 없습니다.")
                st = providers[pi]
                mode = ("tools" if _tools_enabled(st) else "text") if allow else ("final" if convo else "text")
                tools = commands.tool_defs(ptype, "gemini" if st.provider == "google" else "openai") if mode == "tools" else None
                reserve = est_tokens(json.dumps(tools, ensure_ascii=False)) if tools else 0
                msgs, stats = build_messages(messages, page, st, sources, mode=mode, extra_msgs=_render(convo, mode), reserve=reserve)
                att = {"round": rnd + 1, "provider": st.provider, "model": st.model, "mode": mode, "est_input_tokens": stats["est_input_tokens"]}
                try:
                    r = _invoke(caller, msgs, st, tools)
                    raw = r["text"]; text = strip_think(raw)
                    if not text and not r["tool_calls"]: raise ChatError(f"{st.label} 빈 응답")
                    att.update(raw=raw[:2000], native_calls=[{"name": c["name"], "args": c.get("args")} for c in r["tool_calls"]])
                    dbg["attempts"].append(att)
                    break
                except ToolsRejected as e:
                    att["error"] = str(e)[:300]; dbg["attempts"].append(att)
                    st.tools_ok = False
                    import time as _t; _TOOLS_REJECTED[(st.provider, st.model)] = _t.time()
                except ChatError as e:
                    att["error"] = str(e)[:300]; dbg["attempts"].append(att)
                    failures.append({"provider": st.provider, "error": str(e)[:300]})
                    log.info("%s 실패 → %s", st.label, "다음 제공자로 전환" if pi + 1 < len(providers) else "더 이상 대체 없음")
                    pi += 1
            meta = dict(stats, rounds=rnd + 1, mode=mode)
            clean, parsed = parse_action(text)
            calls = r["tool_calls"]
            if not calls and parsed:
                calls = [{"id": f"call_{rnd}_{i}", "name": p["cmd"], "args": p["args"], "_text": True} for i, p in enumerate(parsed)]
                att["text_calls"] = [{"name": c["name"], "args": c["args"]} for c in calls]
            if not allow or not calls:
                final = clean; break
            n_calls += len(calls)
            results, needs_model = [], False
            for c in calls[: commands.MAX_ACTIONS]:
                try:
                    act = commands.validate(c["name"], c.get("args") or {}, dict(tool_ctx))
                except commands.CmdError as e:
                    results.append((c, f"오류: {e}")); needs_model = True; continue
                res, ui_act, note = execute_tool(act, page, st, state)
                if ui_act and len(ui) < commands.MAX_ACTIONS: ui.append(ui_act)
                if note: notes.append(note)
                if act["name"] in commands.DATA_TOOLS and act["name"] != "export": needs_model = True
                results.append((c, res))
                dbg["tool_results"].append({"round": rnd + 1, "name": act["name"], "args": act["args"], "confirm": act["confirm"], "result": res[:200]})
            convo.append({"role": "assistant", "content": clean, "tool_calls": [{"id": c["id"], "name": c["name"], "args": c.get("args") or {}} for c, _ in results],
                          **({"_gparts": r["_gparts"]} if r.get("_gparts") and st.provider == "google" else {})})
            for c, res in results:
                convo.append({"role": "tool", "tool_call_id": c["id"], "name": c["name"], "content": res})
            if not needs_model:  # 화면 조작만 → 추가 호출 없이 끝 (요청 한도 절약)
                final = clean or _auto_reply(ui, notes); break
    except ChatError as e:
        msg = str(e)
        if len(failures) > 1: msg = "모든 AI 제공자 호출에 실패했습니다.\n" + "\n".join(f"- {f['error']}" for f in failures)
        dbg.update(error=msg[:500]); _write_debug(dbg)
        return {"reply": msg, "actions": ui, "action": ui[0] if ui else None, "error": "api_error", "provider": None, "failures": failures}
    reply = final or _auto_reply(ui, notes) or "답변을 생성하지 못했습니다. 다시 시도해 주세요."
    meta.update(tool_calls=n_calls)
    out = {"reply": reply, "actions": ui, "action": ui[0] if ui else None, "notes": notes,
           "provider": st.provider, "provider_label": st.label, "model": st.model, "meta": meta}
    if failures:
        out["fallback_from"] = [f["provider"] for f in failures]
        out["fallback_reason"] = failures[0]["error"]
    dbg.update(provider=st.provider, model=st.model, reply=reply[:300], actions=[{"name": a["name"], "args": a["args"], "confirm": a["confirm"]} for a in ui],
               failures=failures)
    _write_debug(dbg)
    return out
