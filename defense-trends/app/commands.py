"""챗봇/직접 명령(!명령) 공용 명령 레지스트리 — 단일 기준.
- GET /api/commands 로 프론트엔드에 제공, 모델용 동작 규칙(action_spec)도 여기서 생성.
- parse(): "!search 드론 category=company from=2026-10-01" 파싱 (따옴표 지원, 한국어 별칭).
- validate(): 인자 검증·정규화 (분류/출처/날짜/열거값). confirm=True 명령은 사용자가 '실행'을 눌러야만 실행된다.
- run(): 백엔드에서 실행되는 명령(collect, sources, source_*, bookmark*, help)."""
import re, shlex, difflib, threading
from datetime import date, timedelta, datetime
from . import db, sources as srcmod, bookmarks

CATS = {"company": "기업", "media": "언론", "military": "군/국방부", "academic": "학술/연구"}
CAT_ALIASES = {"기업": "company", "회사": "company", "언론": "media", "매체": "media", "군": "military", "국방부": "military",
               "군/국방부": "military", "군·국방부": "military", "학술": "academic", "연구": "academic", "학술/연구": "academic",
               "학술·연구": "academic", "전체": "", "all": ""}
DAYS = [1, 3, 7, 14, 30]
MAX_ACTIONS = 5

def A(name, type, desc, **kw):
    return dict(name=name, type=type, desc=desc, **kw)

SEARCH_ARGS = [
    A("q", "text", "검색어", pos=True),
    A("category", "category", "분류 company|media|military|academic (기업/언론/군/학술)", alias=["cat", "분류"]),
    A("source", "source", "출처 이름", alias=["src", "출처"]),
    A("date_from", "date", "시작일 YYYY-MM-DD (7d=7일 전)", alias=["from", "시작"]),
    A("date_to", "date", "종료일 YYYY-MM-DD", alias=["to", "끝"]),
    A("sort", "enum", "정렬 source(출처별)|date(최신순)", values=["source", "date"], alias=["정렬"]),
]
COMMANDS = [
    dict(name="search", aliases=["검색", "찾기"], run="frontend", confirm=False, args=SEARCH_ARGS,
         desc="기사 검색 (키워드·분류·출처·기간·정렬)", usage='!search 드론 category=company source="Defense News" from=2026-10-01'),
    dict(name="filter", aliases=["필터"], run="frontend", confirm=False, args=SEARCH_ARGS[1:3],
         desc="분류·출처 필터만 변경", usage="!filter category=media"),
    dict(name="reset", aliases=["초기화", "리셋"], run="frontend", confirm=False, args=[], desc="검색어·필터·기간 초기화", usage="!reset"),
    dict(name="more", aliases=["더보기"], run="frontend", confirm=False, args=[], desc="검색 결과 더 불러오기", usage="!more"),
    dict(name="tab", aliases=["탭"], run="frontend", confirm=False,
         args=[A("tab", "enum", "raw(원문)|digest(요약)", values=["raw", "digest"], pos=True, required=True, map={"원문": "raw", "요약": "digest"})],
         desc="탭 전환", usage="!tab digest"),
    dict(name="open", aliases=["열기", "읽기"], run="frontend", confirm=False, args=[A("id", "int", "기사 id", pos=True, required=True)],
         desc="기사 리더 열기", usage="!open 123"),
    dict(name="back", aliases=["뒤로"], run="frontend", confirm=False, args=[], desc="이전 화면으로", usage="!back"),
    dict(name="digest_days", aliases=["기간", "요약기간"], run="frontend", confirm=False,
         args=[A("days", "enum", "요약 기간(일) " + "|".join(map(str, DAYS)), values=[str(d) for d in DAYS], pos=True, required=True)],
         desc="요약 탭 기간 변경", usage="!digest_days 14"),
    dict(name="regen", aliases=["재생성", "요약다시"], run="frontend", confirm=False, args=[], desc="요약(뉴스레터) 다시 만들기", usage="!regen"),
    dict(name="collect", aliases=["수집"], run="backend", confirm=True, args=[], desc="지금 바로 전체 소스 수집", usage="!collect"),
    dict(name="sources", aliases=["출처목록", "소스"], run="backend", confirm=False, args=[], desc="수집 소스 목록과 상태", usage="!sources"),
    dict(name="source_enable", aliases=["출처켜기"], run="backend", confirm=True,
         args=[A("name", "source_cfg", "출처 이름", pos=True, required=True)], desc="수집 소스 켜기", usage='!source_enable "Defense News"'),
    dict(name="source_disable", aliases=["출처끄기"], run="backend", confirm=True,
         args=[A("name", "source_cfg", "출처 이름", pos=True, required=True)], desc="수집 소스 끄기", usage='!source_disable "Defense News"'),
    dict(name="source_add", aliases=["출처추가"], run="backend", confirm=True,
         args=[A("name", "str", "출처 이름", pos=True, required=True), A("url", "url", "RSS/Atom 피드 주소", pos=True, required=True),
               A("category", "category", "분류", pos=True, required=True, alias=["분류"])],
         desc="RSS 소스 추가", usage='!source_add "Naval Today" https://www.navaltoday.com/feed/ media'),
    dict(name="source_remove", aliases=["출처삭제"], run="backend", confirm=True,
         args=[A("name", "source_cfg", "출처 이름", pos=True, required=True)], desc="수집 소스 삭제", usage='!source_remove "Naval Today"'),
    dict(name="bookmark", aliases=["북마크", "즐겨찾기"], run="backend", confirm=False,
         args=[A("id", "int", "기사 id (기사 화면에선 생략 가능)", pos=True)], desc="기사 북마크", usage="!bookmark 123"),
    dict(name="unbookmark", aliases=["북마크해제"], run="backend", confirm=False,
         args=[A("id", "int", "기사 id (기사 화면에선 생략 가능)", pos=True)], desc="북마크 해제", usage="!unbookmark 123"),
    dict(name="bookmarks", aliases=["북마크목록"], run="backend", confirm=False, args=[], desc="북마크 목록", usage="!bookmarks"),
    dict(name="export", aliases=["내보내기", "csv"], run="frontend", confirm=False, args=SEARCH_ARGS,
         desc="현재 검색 결과 CSV 내려받기 (인자를 주면 그 조건)", usage="!export"),
    dict(name="summarize", aliases=["요약"], run="llm", confirm=False, args=[], desc="보이는 기사 또는 현재 기사 요약 (AI 호출)", usage="!요약"),
    dict(name="help", aliases=["도움말", "명령어", "?"], run="frontend", confirm=False,
         args=[A("cmd", "str", "명령 이름", pos=True)], desc="명령 목록 / 명령 설명", usage="!help search"),
]
BY_NAME = {c["name"]: c for c in COMMANDS}
_ALIAS = {}
for _c in COMMANDS:
    _ALIAS[_c["name"].lower()] = _c["name"]
    for _a in _c["aliases"]: _ALIAS[_a.lower()] = _c["name"]
# 이전 동작 형식(type) 호환
_ALIAS.update({"open_tab": "tab", "open_article": "open", "query": "search"})

def resolve(name):
    return _ALIAS.get(str(name or "").strip().lstrip("!").lower())

def suggest(name):
    m = difflib.get_close_matches(str(name).lower(), list(_ALIAS), n=1, cutoff=0.6)
    return _ALIAS[m[0]] if m else None

def public_registry():
    return [{k: c[k] for k in ("name", "aliases", "run", "confirm", "desc", "usage")} |
            {"args": [{k: a[k] for k in a if k != "map"} for a in c["args"]]} for c in COMMANDS]

# ---------------- 값 검증 ----------------
class CmdError(ValueError):
    pass

def parse_date(v, today=None):
    v = str(v).strip().lower()
    today = today or date.today()
    if v in ("today", "오늘"): return today.isoformat()
    if v in ("yesterday", "어제"): return (today - timedelta(days=1)).isoformat()
    m = re.fullmatch(r"(\d+)\s*(d|일|일전|days?)", v)
    if m: return (today - timedelta(days=int(m.group(1)))).isoformat()
    m = re.fullmatch(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", v)
    if m:
        try: return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError: pass
    raise CmdError(f"날짜 형식 오류: {v} (예: 2026-10-01, 7d)")

def _known_sources():
    names = [r["source"] for r in db.sources_summary()]
    for s in srcmod.all_sources():
        if s["name"] not in names: names.append(s["name"])
    return names

def match_source(v, names):
    low = str(v).strip().lower()
    if not low: return ""
    for s in names:
        if s.lower() == low: return s
    hits = [s for s in names if low in s.lower() or s.lower().replace(" (google news)", "") == low]
    if len(hits) == 1: return hits[0]
    raise CmdError(f"알 수 없는 출처: {v}" + (f" (후보: {', '.join(hits[:4])})" if hits else ""))

def _value(a, v, ctx):
    t = a["type"]
    if v is None or str(v).strip() == "": return None
    v = str(v).strip()
    if t in ("text", "str"): return v[:200]
    if t == "int":
        try: return int(str(v).lstrip("#"))
        except ValueError: raise CmdError(f"{a['name']} 는 숫자여야 합니다: {v}")
    if t == "date": return parse_date(v, ctx.get("today"))
    if t == "category":
        c = v.lower() if v.lower() in CATS else CAT_ALIASES.get(v, None)
        if c is None: raise CmdError(f"알 수 없는 분류: {v} (company/media/military/academic)")
        return c or None
    if t == "enum":
        v2 = a.get("map", {}).get(v, v.lower())
        if v2 not in a["values"]: raise CmdError(f"{a['name']} 값은 {'|'.join(a['values'])} 중 하나: {v}")
        return v2
    if t == "source": return match_source(v, ctx.setdefault("sources", _known_sources())) or None
    if t == "source_cfg":
        names = ctx.setdefault("cfg_sources", [s["name"] for s in srcmod.all_sources()])
        return match_source(v, names)
    if t == "url":
        if not re.match(r"^https?://\S+$", v, re.I): raise CmdError(f"URL 형식 오류: {v}")
        return v[:1000]
    return v

def validate(name, args, ctx=None):
    """→ {"name","args","confirm","run"}. 오류 시 CmdError."""
    ctx = {} if ctx is None else ctx
    n = resolve(name)
    if not n:
        s = suggest(name)
        raise CmdError(f"알 수 없는 명령: {name}" + (f" — 혹시 !{s} ?" if s else " — !help 로 목록 확인"))
    c = BY_NAME[n]
    spec = {a["name"]: a for a in c["args"]}
    alias = {al.lower(): a["name"] for a in c["args"] for al in a.get("alias", [])}
    out = {}
    for k, v in (args or {}).items():
        key = k if k in spec else alias.get(str(k).lower())
        if not key: continue  # 모르는 인자는 무시
        val = _value(spec[key], v, ctx)
        if val is not None: out[key] = val
    if n in ("bookmark", "unbookmark") and "id" not in out and ctx.get("article_id"):
        out["id"] = int(ctx["article_id"])
    for a in c["args"]:
        if a.get("required") and a["name"] not in out:
            raise CmdError(f"!{n}: {a['name']} 가 필요합니다 — 예: {c['usage']}")
    if n == "open":
        with db.connect() as con:
            if not con.execute("SELECT 1 FROM items WHERE id=?", (out["id"],)).fetchone(): raise CmdError(f"기사 #{out['id']} 가 없습니다")
    if n == "search" and not out: raise CmdError("!search: 검색어나 조건이 필요합니다 — 예: " + c["usage"])
    return {"name": n, "args": out, "confirm": bool(c["confirm"]), "run": c["run"]}

# ---------------- !명령 파서 ----------------
def tokenize(s):
    try:
        lex = shlex.shlex(s, posix=True); lex.whitespace_split = True; lex.commenters = ""
        return list(lex)
    except ValueError:
        raise CmdError("따옴표가 닫히지 않았습니다")

def parse(text, ctx=None):
    """'!search 드론 category=company' → validate() 결과. help는 {"name":"help","text":...} 포함."""
    s = (text or "").strip()
    if not s.startswith("!"): raise CmdError("명령은 ! 로 시작합니다")
    toks = tokenize(s[1:])
    if not toks: raise CmdError("명령이 비어 있습니다 — !help")
    name, rest = toks[0], toks[1:]
    n = resolve(name)
    if not n: validate(name, {})  # 오류 + 제안
    c = BY_NAME[n]
    pos_args = [a for a in c["args"] if a.get("pos")]
    named, pos = {}, []
    for t in rest:
        m = re.match(r"^([A-Za-z_가-힣]+)[=:](.*)$", t, re.S)
        if m and (m.group(1) in {a["name"] for a in c["args"]} or m.group(1).lower() in {al.lower() for a in c["args"] for al in a.get("alias", [])}):
            named[m.group(1)] = m.group(2)
        else:
            pos.append(t)
    for i, a in enumerate(pos_args):
        if not pos: break
        if a["name"] in named: continue
        last = i == len(pos_args) - 1
        if last and a["type"] in ("text", "str"):
            named[a["name"]] = " ".join(pos); pos = []
        else:
            named[a["name"]] = pos.pop(0)
    if pos: raise CmdError(f"!{n}: 해석할 수 없는 인자 {' '.join(pos)} — 예: {c['usage']}")
    cmd = validate(n, named, ctx)
    if n == "help": cmd["text"] = help_text(cmd["args"].get("cmd"))
    return cmd

# ---------------- 도움말 / 모델용 규칙 ----------------
def _sig(c):
    parts = []
    for a in c["args"]:
        key = (a.get("alias") or [a["name"]])[0] if a["name"].startswith("date_") else a["name"]
        parts.append(f"<{a['name']}>" if a.get("pos") and a.get("required") else (f"[{a['name']}]" if a.get("pos") else f"[{key}=]"))
    return " ".join(parts)

def help_text(cmd=None):
    if cmd:
        n = resolve(cmd)
        if not n:
            s = suggest(cmd)
            return f"알 수 없는 명령: {cmd}" + (f" — 혹시 !{s} ?" if s else "")
        c = BY_NAME[n]
        lines = [f"**!{n}** {_sig(c)}", c["desc"] + (" · 실행 전 확인" if c["confirm"] else "")]
        if c["aliases"]: lines.append("별칭: " + ", ".join("!" + a for a in c["aliases"]))
        for a in c["args"]:
            al = f" (= {', '.join(a['alias'])})" if a.get("alias") else ""
            lines.append(f"- `{a['name']}`{al}: {a['desc']}" + (" · 필수" if a.get("required") else ""))
        lines.append(f"예: `{c['usage']}`")
        return "\n".join(lines)
    return "\n".join(f"- `!{c['name']}`{' (!' + c['aliases'][0] + ')' if c['aliases'] else ''} {c['desc']}{' · 확인' if c['confirm'] else ''} · `{c['usage']}`"
                     for c in COMMANDS) + "\n자세히: `!help <명령>`"

def action_spec(source_names, today=None):
    today = today or date.today()
    lines = []
    for c in COMMANDS:
        if c["name"] in ("help",): continue
        args = ",".join(a["name"] for a in c["args"])
        lines.append(f"{c['name']}({args}) {c['desc']}{' [확인필요]' if c['confirm'] else ''}")
    wd = "월화수목금토일"[today.weekday()]
    return ("# 앱 조작(선택)\n"
            f"오늘: {today.isoformat()}({wd}). '지난주'·'최근 3일' 같은 표현은 date_from/date_to(YYYY-MM-DD)로 바꾼다.\n"
            "찾기·필터·열기·이동·내보내기 등 앱 조작을 요청받으면 설명하지 말고 반드시 답변 끝에 블록 하나를 붙인다(블록이 없으면 아무것도 실행되지 않는다). 최대 5개, 순서대로 실행. 조작이 필요 없으면 붙이지 않는다.\n"
            '```action\n[{"cmd":"search","q":"drone","date_from":"2026-10-01"},{"cmd":"export"}]\n```\n'
            "명령:\n" + "\n".join(lines) + "\n"
            "[확인필요] 명령은 사용자가 버튼을 눌러야 실행되니 '실행 버튼을 눌러 주세요'라고 안내한다. open·back·tab 이동은 마지막에 둔다.\n"
            "search·summarize·bookmarks·sources 를 쓰면 시스템이 결과를 다시 보여 주므로 그때 최종 답을 쓴다. 기사 본문·뉴스레터 요약은 동작 없이 바로 답한다. search 의 q 는 영어 키워드가 가장 잘 맞고 'A OR B' 를 지원한다.\n"
            "category: company|media|military|academic. source 는 다음 중 하나: " + ", ".join(source_names))

def validate_llm(actions, ctx=None):
    """모델 출력 동작 목록 검증 → (유효 목록, 오류 목록). 잘못된 항목은 버린다."""
    ctx = {} if ctx is None else ctx
    if isinstance(actions, dict): actions = [actions]
    if not isinstance(actions, list): return [], ["동작 형식 오류"]
    ok, errs = [], []
    for a in actions[: MAX_ACTIONS * 2]:
        if not isinstance(a, dict): continue
        name = a.get("cmd") or a.get("name") or a.get("type")
        args = a.get("args") if isinstance(a.get("args"), dict) else {k: v for k, v in a.items() if k not in ("cmd", "name", "type")}
        if resolve(name) == "help": continue
        try: ok.append(validate(name, args, ctx))
        except CmdError as e: errs.append(str(e))
        if len(ok) >= MAX_ACTIONS: break
    return ok, errs

# ---------------- 백엔드 실행 ----------------
def _fmt_item(i):
    return f"- #{i['id']} {i['title'][:120]} ({i['source']}, {(i.get('published') or '')[:10]})"

def run(name, args=None, confirmed=False, ctx=None, collect_fn=None):
    """백엔드 명령 실행 → {"ok","message", ...}. confirm 명령은 confirmed=True 가 아니면 실행하지 않는다."""
    try:
        cmd = validate(name, args or {}, ctx)
    except CmdError as e:
        return {"ok": False, "message": str(e)}
    n, a = cmd["name"], cmd["args"]
    if cmd["run"] != "backend" and n != "help":
        return {"ok": False, "message": f"!{n} 는 화면에서 실행되는 명령입니다"}
    if cmd["confirm"] and not confirmed:
        return {"ok": False, "needs_confirm": True, "message": f"!{n} 는 실행 전 확인이 필요합니다"}
    try:
        if n == "help":
            return {"ok": True, "message": help_text(a.get("cmd"))}
        if n == "collect":
            from . import collector
            if collector.STATE["running"]: return {"ok": True, "message": "이미 수집 중입니다."}
            threading.Thread(target=collect_fn or collector.collect_all, daemon=True).start()
            return {"ok": True, "message": "수집을 시작했습니다. 끝나면 목록이 갱신됩니다(수십 초~수 분)."}
        if n == "sources":
            counts = {r["source"]: r["n"] for r in db.sources_summary()}
            rows = srcmod.all_sources()
            lines = [f"- {'✅' if s['enabled'] else '⛔'} {s['name']} · {CATS.get(s['category'], s['category'])} · {counts.get(s['name'], 0)}건"
                     + (" · 추가함" if s["origin"] == "custom" else "") for s in rows]
            return {"ok": True, "message": f"수집 소스 {sum(s['enabled'] for s in rows)}/{len(rows)}개 활성\n" + "\n".join(lines)}
        if n in ("source_enable", "source_disable"):
            nm = srcmod.set_enabled(a["name"], n == "source_enable")
            return {"ok": True, "message": f"{nm}: {'켰습니다' if n == 'source_enable' else '껐습니다'} (다음 수집부터 적용)", "refresh_sources": True}
        if n == "source_add":
            nm, cnt = srcmod.add(a["name"], a["url"], a["category"], check=(ctx or {}).get("check_feed", True))
            return {"ok": True, "message": f"{nm} 추가함" + (f" (피드 항목 {cnt}개 확인)" if cnt else "") + ". 다음 수집부터 반영됩니다.", "refresh_sources": True}
        if n == "source_remove":
            nm = srcmod.remove(a["name"])
            return {"ok": True, "message": f"{nm} 삭제함 (이미 저장된 기사는 남습니다)", "refresh_sources": True}
        if n == "bookmark":
            if "id" not in a: return {"ok": False, "message": "!bookmark: 기사 id 가 필요합니다 — 예: !bookmark 123"}
            new = bookmarks.add(a["id"])
            return {"ok": True, "message": f"#{a['id']} {'북마크함' if new else '이미 북마크되어 있습니다'}"}
        if n == "unbookmark":
            if "id" not in a: return {"ok": False, "message": "!unbookmark: 기사 id 가 필요합니다"}
            return {"ok": True, "message": f"#{a['id']} {'북마크 해제함' if bookmarks.remove(a['id']) else '북마크에 없습니다'}"}
        if n == "bookmarks":
            rows = bookmarks.list_()
            return {"ok": True, "message": ("북마크 " + str(len(rows)) + "건\n" + "\n".join(_fmt_item(i) for i in rows)) if rows else "북마크가 없습니다.",
                    "items": rows}
    except (ValueError, CmdError) as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:
        return {"ok": False, "message": f"실행 실패: {type(e).__name__}: {str(e)[:200]}"}
    return {"ok": False, "message": f"!{n} 실행기가 없습니다"}

# ---------------- 네이티브 도구(tool/function calling) 정의 ----------------
TOOL_DESC = {  # 레지스트리 desc 보다 모델에 더 유용한 짧은 설명 (없으면 desc 사용)
    "search": "기사 검색 후 화면에도 표시. q는 영어 키워드가 가장 잘 맞음. 'A OR B', \"정확한 구문\" 지원. 기간은 date_from/date_to",
    "filter": "현재 검색어는 두고 분류·출처만 변경",
    "summarize": "보이는 기사 목록(또는 현재 기사) 데이터를 받아 요약",
    "export": "검색 조건(생략 시 현재 화면)으로 CSV 내려받기",
    "open": "기사 리더 열기(화면 이동)",
    "collect": "전체 소스 즉시 수집(사용자 확인 필요)",
    "source_enable": "수집 소스 켜기(사용자 확인 필요)", "source_disable": "수집 소스 끄기(사용자 확인 필요)",
    "source_add": "RSS 소스 추가(사용자 확인 필요)", "source_remove": "수집 소스 삭제(사용자 확인 필요)",
}
ARG_DESC = {"date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD", "q": "검색어", "source": "출처 이름", "name": "출처 이름", "id": "기사 id"}
_SRC_TOOLS = ["sources", "collect", "source_enable", "source_disable", "source_add", "source_remove"]
TOOLSETS = {
    "home_raw": ["search", "filter", "reset", "more", "open", "tab", "export", "summarize", "bookmark", "unbookmark", "bookmarks"] + _SRC_TOOLS,
    "home_digest": ["search", "tab", "digest_days", "regen", "open", "bookmarks"] + _SRC_TOOLS,
    "article": ["search", "back", "tab", "open", "bookmark", "unbookmark", "bookmarks", "summarize"] + _SRC_TOOLS,
}

def _schema(c, gemini=False):
    props, req = {}, []
    T = (lambda t: t.upper()) if gemini else (lambda t: t)
    for a in c["args"]:
        p = {"type": T("integer" if a["type"] == "int" else "string")}
        if a["type"] == "category": p["enum"] = list(CATS)
        elif a["type"] == "enum": p["enum"] = list(a["values"])
        d = ARG_DESC.get(a["name"])
        if d: p["description"] = d
        props[a["name"]] = p
        if a.get("required"): req.append(a["name"])
    sch = {"type": T("object"), "properties": props}
    if req: sch["required"] = req
    return sch

def tool_names(page_type=None):
    names = TOOLSETS.get(page_type) or [c["name"] for c in COMMANDS if c["name"] != "help"]
    return [n for n in names if n in BY_NAME]

def tool_defs(page_type=None, fmt="openai"):
    """레지스트리 → 도구 정의. fmt='openai' → [{"type":"function","function":{...}}], 'gemini' → [{"functionDeclarations":[...]}]."""
    out = []
    for n in tool_names(page_type):
        c = BY_NAME[n]
        f = {"name": n, "description": TOOL_DESC.get(n, c["desc"])}
        if fmt == "gemini":
            if c["args"]: f["parameters"] = _schema(c, True)
            out.append(f)
        else:
            f["parameters"] = _schema(c)
            out.append({"type": "function", "function": f})
    return [{"functionDeclarations": out}] if fmt == "gemini" else out

# 서버에서 실행해 결과를 모델에 돌려주는 도구 / 화면에서 실행할 도구
DATA_TOOLS = {"search", "filter", "summarize", "sources", "bookmarks", "bookmark", "unbookmark", "export"}
