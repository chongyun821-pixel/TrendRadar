"""네이티브 도구 호출(Arli tools / Gemini functionDeclarations), 다회 에이전트 루프, 확인 게이트, tools 거부(400) 대체,
관대한 동작 파서, FTS OR 검색, 디버그 로그 테스트. HTTP 는 httpx.post 를 가짜로 바꿔 검사. 실행: python tests/test_tools.py"""
import os, sys, json, shutil, tempfile, random
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["ARLIAI_API_KEY"] = "arli-SECRET-key"
for k in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "CHAT_PROVIDER", "CHAT_AGENT_ROUNDS", "CHAT_TOOLS"): os.environ.pop(k, None)
TMP = Path(tempfile.mkdtemp())
from app import db
shutil.copy(ROOT / "data" / "defense.db", TMP / "t.db"); db.DB_PATH = TMP / "t.db"
import httpx
from app import chat, commands as C, bookmarks, collector
bookmarks.init()
with db.connect() as c: AID = c.execute("SELECT id FROM items ORDER BY published DESC LIMIT 1").fetchone()[0]
U = lambda t: [{"role": "user", "content": t}]
RAW = {"type": "home_raw", "q": "", "category": "", "source": "", "items": []}

# ---------- 가짜 HTTP ----------
class Fake:
    def __init__(self, script): self.script, self.reqs = list(script), []
    def __call__(self, url, json=None, timeout=None, headers=None):
        self.reqs.append({"url": url, "body": json, "headers": headers})
        status, payload = self.script.pop(0)(json) if callable(self.script[0]) else self.script.pop(0)
        return httpx.Response(status, json=payload, request=httpx.Request("POST", url))
def oa(text="", calls=None):
    m = {"role": "assistant", "content": text}
    if calls: m["tool_calls"] = [{"id": f"call_x{i}", "type": "function", "function": {"name": n, "arguments": __import__("json").dumps(a)}} for i, (n, a) in enumerate(calls)]
    return (200, {"choices": [{"message": m}]})
def gm(text="", calls=None):
    parts = ([{"text": text}] if text else []) + [{"functionCall": {"name": n, "args": a}} for n, a in (calls or [])]
    return (200, {"candidates": [{"content": {"role": "model", "parts": parts}}]})
def use(fake): chat.httpx.post = fake; return fake

# 1) 도구 정의: 레지스트리에서 생성, 페이지별 일부, 형식
for pt in ("home_raw", "home_digest", "article", None):
    t = C.tool_defs(pt); g = C.tool_defs(pt, "gemini")[0]["functionDeclarations"]
    assert [x["function"]["name"] for x in t] == [x["name"] for x in g] == C.tool_names(pt)
    assert all(x["type"] == "function" and x["function"]["parameters"]["type"] == "object" for x in t)
    assert all(("parameters" not in x) or x["parameters"]["type"] == "OBJECT" for x in g)
    assert "help" not in C.tool_names(pt)
assert "regen" in C.tool_names("home_digest") and "regen" not in C.tool_names("home_raw") and "back" in C.tool_names("article")
assert "A OR B" in C.tool_defs("home_raw")[0]["function"]["description"]
st = chat.Settings("arli")
tok = chat.est_tokens(json.dumps(C.tool_defs("home_raw"), ensure_ascii=False))
msgs, stats = chat.build_messages(U("x"), RAW, st, mode="tools", reserve=tok)
print("도구 스키마 추정 토큰(home_raw):", tok, "| 전체 입력:", stats["est_input_tokens"], "/", st.input_budget)
assert stats["est_input_tokens"] <= st.input_budget and "```action" not in msgs[0]["content"] and "반드시 해당 도구를 호출" in msgs[0]["content"]

# 2) Arli 네이티브 tool_calls → 서버 검색 → 결과로 2차 호출 → 최종 답
f = use(Fake([oa("", [("search", {"q": "frigate OR destroyer", "sort": "date"})]), oa("함정 기사 25건을 찾았습니다.")]))
res = chat.chat(U("함정 기사 찾아줘"), RAW)
b1, b2 = f.reqs[0]["body"], f.reqs[1]["body"]
assert b1["tool_choice"] == "auto" and b1["tools"][0]["function"]["name"] == "search" and b1["reasoning_effort"] == "none"
am = [m for m in b2["messages"] if m.get("tool_calls")][0]
tm = [m for m in b2["messages"] if m["role"] == "tool"][0]
assert json.loads(am["tool_calls"][0]["function"]["arguments"])["q"] == "frigate OR destroyer" and tm["tool_call_id"] == "call_x0"
assert "총 " in tm["content"] and "건" in tm["content"] and "#" in tm["content"]
assert res["reply"] == "함정 기사 25건을 찾았습니다." and [a["name"] for a in res["actions"]] == ["search"] and res["actions"][0]["args"]["q"] == "frigate OR destroyer"
assert res["meta"]["rounds"] == 2 and res["meta"]["mode"] == "tools"
print("Arli 네이티브 OK:", tm["content"].splitlines()[0])

# 3) Google(Gemma) functionCall → functionResponse
os.environ["ARLIAI_API_KEY"] = ""; os.environ["GOOGLE_API_KEY"] = "g-SECRET-key"
f = use(Fake([gm("", [("search", {"q": "drone", "category": "media"})]), gm("드론 기사입니다.")]))
res = chat.chat(U("드론 언론 기사"), RAW)
g1, g2 = f.reqs[0]["body"], f.reqs[1]["body"]
assert g1["toolConfig"] == {"functionCallingConfig": {"mode": "AUTO"}} and g1["tools"][0]["functionDeclarations"][0]["name"] == "search"
assert f.reqs[0]["headers"]["x-goog-api-key"] == "g-SECRET-key" and "key=" not in f.reqs[0]["url"]
roles = [(c["role"], list(c["parts"][0])[0]) for c in g2["contents"]]
assert ("model", "functionCall") in roles and ("user", "functionResponse") in roles
fr = [p["functionResponse"] for c in g2["contents"] for p in c["parts"] if "functionResponse" in p][0]
assert fr["name"] == "search" and "검색어 'drone'" in fr["response"]["result"]
assert res["provider"] == "google" and res["actions"][0]["args"] == {"q": "drone", "category": "media"}
print("Gemini 네이티브 OK")

# 4) 다회 루프: search → filter → 답 (3회 호출), 최대 라운드 제한
os.environ["ARLIAI_API_KEY"] = "arli-SECRET-key"; os.environ["GOOGLE_API_KEY"] = ""
f = use(Fake([oa("", [("search", {"q": "missile"})]), oa("", [("filter", {"category": "company"})]), oa("기업 미사일 기사입니다.")]))
res = chat.chat(U("미사일 기사 중 기업 것만"), RAW)
assert len(f.reqs) == 3 and [a["name"] for a in res["actions"]] == ["search", "filter"]
assert "검색어 'missile'" in [m for m in f.reqs[2]["body"]["messages"] if m["role"] == "tool"][-1]["content"]  # filter 는 이전 검색어 유지
os.environ["CHAT_AGENT_ROUNDS"] = "2"
f = use(Fake([oa("", [("search", {"q": "a"})]), oa("", [("search", {"q": "b"})]), oa("최종 답")]))
res = chat.chat(U("계속 검색"), RAW)
assert len(f.reqs) == 3 and "tools" not in f.reqs[2]["body"] and res["reply"] == "최종 답" and res["meta"]["mode"] == "final"
os.environ.pop("CHAT_AGENT_ROUNDS")
print("다회 루프 OK")

# 5) 확인 게이트: collect 는 서버에서 실행하지 않음, 화면 동작만으로 끝나면 추가 호출 없음
ran = []; orig = collector.collect_all; collector.collect_all = lambda: ran.append(1)
f = use(Fake([oa("", [("collect", {})])]))
res = chat.chat(U("지금 수집해"), RAW)
assert len(f.reqs) == 1 and not ran and res["actions"][0]["name"] == "collect" and res["actions"][0]["confirm"] is True
assert "실행 버튼" in res["reply"]
f = use(Fake([oa("", [("search", {"q": "x"}), ("source_disable", {"name": "CSIS"})]), oa("CSIS 끄기는 실행 버튼을 눌러 주세요.")]))
res = chat.chat(U("x 검색하고 CSIS 꺼"), RAW)
assert [(a["name"], a["confirm"]) for a in res["actions"]] == [("search", False), ("source_disable", True)]
tm = [m for m in f.reqs[1]["body"]["messages"] if m["role"] == "tool"]
assert "확인 대기" in tm[1]["content"] and not ran
from app import sources as srcmod; assert srcmod.find("CSIS")["enabled"]
collector.collect_all = orig
# 화면 전용 도구(tab) → 1회 호출로 끝
f = use(Fake([oa("요약 탭으로 이동합니다.", [("tab", {"tab": "digest"})])]))
res = chat.chat(U("요약 보여줘"), RAW)
assert len(f.reqs) == 1 and res["actions"] == [{"name": "tab", "args": {"tab": "digest"}, "confirm": False, "run": "frontend"}] and res["reply"] == "요약 탭으로 이동합니다."
# 북마크 도구는 서버에서 실행, 화면 동작으로는 보내지 않음(중복 방지), 메모로 표시
f = use(Fake([oa("", [("bookmark", {})]), oa("북마크했습니다.")]))
res = chat.chat(U("이 기사 북마크"), {"type": "article", "id": AID})
assert res["actions"] == [] and AID in bookmarks.ids() and res["notes"] and "북마크" in res["notes"][0]
# 잘못된 인자 → 오류를 모델에 돌려줌
f = use(Fake([oa("", [("open", {"id": 999999999})]), oa("그 기사는 없습니다.")]))
res = chat.chat(U("999999999 열어"), RAW)
assert "오류" in [m for m in f.reqs[1]["body"]["messages"] if m["role"] == "tool"][0]["content"] and res["actions"] == []
print("확인 게이트 OK")

# 6) tools 거부(400) → 같은 제공자 텍스트 동작 방식, 이후 요청엔 tools 안 보냄
chat._TOOLS_REJECTED.clear()
f = use(Fake([(400, {"error": {"message": "\"auto\" tool choice requires --enable-auto-tool-choice"}}),
              oa('함정 검색합니다.\n```action\n{"cmd":"search","q":"frigate OR corvette"}\n```'), oa("결과입니다.")]))
res = chat.chat(U("함정"), RAW)
assert "tools" in f.reqs[0]["body"] and "tools" not in f.reqs[1]["body"] and "```action" in f.reqs[1]["body"]["messages"][0]["content"]
assert res["actions"][0]["args"]["q"] == "frigate OR corvette" and res["reply"] == "결과입니다." and res["meta"]["mode"] == "text"
assert "[시스템: 도구 실행 결과]" in f.reqs[2]["body"]["messages"][-1]["content"]
f = use(Fake([oa("안녕하세요")])); chat.chat(U("hi"), RAW)
assert "tools" not in f.reqs[0]["body"]  # 캐시: 다시 400 낭비 안 함
chat._TOOLS_REJECTED.clear()
# Google: 400 → fold 재시도 → 또 400 → 텍스트 방식
os.environ["ARLIAI_API_KEY"] = ""; os.environ["GOOGLE_API_KEY"] = "g"
f = use(Fake([(400, {"error": {"message": "Function calling is not enabled"}}), (400, {"error": {"message": "Function calling is not enabled"}}),
              gm('<tool_call>{"name":"tab","arguments":{"tab":"digest"}}</tool_call>')]))
res = chat.chat(U("요약 탭"), RAW)
assert len(f.reqs) == 3 and "tools" not in f.reqs[2]["body"] and res["actions"][0]["name"] == "tab" and res["reply"] == "실행했습니다."
chat._TOOLS_REJECTED.clear()
os.environ["ARLIAI_API_KEY"] = "arli-SECRET-key"; os.environ["GOOGLE_API_KEY"] = ""
# Arli 429 → Google 이 도구 대화를 이어받음
os.environ["GOOGLE_API_KEY"] = "g"
f = use(Fake([oa("", [("search", {"q": "radar"})]), (429, {"message": "quota"}), gm("레이더 기사입니다.")]))
res = chat.chat(U("레이더"), RAW)
assert res["provider"] == "google" and res["fallback_from"] == ["arli"] and res["actions"][0]["args"]["q"] == "radar"
assert any("functionResponse" in p for c in f.reqs[2]["body"]["contents"] for p in c["parts"])
os.environ["GOOGLE_API_KEY"] = ""
print("tools 거부/전환 OK")

# 7) 관대한 파서
P = chat.parse_action
cases = {
    '찾을게요\n```action\n{"type":"search","q":"drone"}\n```': ("찾을게요", "search", {"q": "drone"}),
    '```json\n[{"cmd":"tab","tab":"digest"},{"cmd":"regen"}]\n```': ("", "tab", {"tab": "digest"}),
    '검색합니다 {"type": "search", "q": "Hanwha", "category": "company"} 잠시만요': ("검색합니다  잠시만요", "search", {"q": "Hanwha", "category": "company"}),
    '<tool_call>\n{"name": "search", "arguments": {"q": "frigate OR destroyer"}}\n</tool_call>': ("", "search", {"q": "frigate OR destroyer"}),
    '<tool_call>\n<function=search>\n<parameter=q>\nsubmarine\n</parameter>\n<parameter=sort>date</parameter>\n</function>\n</tool_call>': ("", "search", {"q": "submarine", "sort": "date"}),
    '{"type":"function","function":{"name":"open","arguments":"{\\"id\\": 5}"}}': ("", "open", {"id": 5}),
    '<function=tab><parameter=tab>raw</parameter></function> 원문 탭': ("원문 탭", "tab", {"tab": "raw"}),
}
for t, (clean, name, args) in cases.items():
    c, calls = P(t)
    assert c == clean and calls[0]["cmd"] == name and calls[0]["args"] == args, (t, c, calls)
for t in ['예시 JSON: {"foo": 1}', "검색어: `frigate OR destroyer` 정렬: 최신순 (date_desc) 결과가 나오면 보여드리겠습니다", '{"type":"없는명령"}']:
    c, calls = P(t); assert calls is None and c == t.strip(), (t, c, calls)
assert P('```action\n{깨진 json\n```\n본문')[0] == "본문"
# 산문만 답한 실패 사례 → 아무것도 실행하지 않지만 정상 응답
prose = "검색어: `frigate OR destroyer OR submarine OR cruiser OR corvette` 정렬: 최신순 (date_desc) 결과가 나오면 최신 기사부터 보여드리겠습니다"
f = use(Fake([oa(prose)])); res = chat.chat(U("함정 기사"), RAW)
assert res["actions"] == [] and res["reply"] == prose and len(f.reqs) == 1 and "error" not in res
# 네이티브 모드에서도 본문 속 <tool_call> 은 실행 (vLLM 파서가 꺼져 있는 경우)
f = use(Fake([oa('<tool_call>{"name":"search","arguments":{"q":"corvette"}}</tool_call>'), oa("코르벳 기사입니다.")]))
res = chat.chat(U("코르벳"), RAW)
assert res["actions"][0]["args"]["q"] == "corvette" and res["reply"] == "코르벳 기사입니다." and "<tool_call>" not in res["reply"]
print("관대한 파서 OK")

# 8) FTS: OR / 구문 / 괄호
n = lambda q: db.search(q, limit=1)[0]
a, b, ab = n("frigate"), n("destroyer"), n("frigate OR destroyer")
assert ab >= max(a, b) and ab <= a + b and n("frigate destroyer") <= min(a, b)
assert n("frigate OR destroyer OR submarine OR cruiser OR corvette") >= ab
assert n('"air defense"') <= n("air defense") and n("(drone OR uav) army") <= n("drone OR uav")
_tr = db._translate_ko; db._translate_ko = lambda s: {"함정": "ship", "잠수함": "submarine", "방공 체계": "air defense system"}.get(s.strip(), "x")  # 네트워크 없이
assert db.translate_query("함정 OR 잠수함") == "ship OR submarine" and db.translate_query('함정 OR "방공 체계"') == 'ship OR "air defense system"'
random.seed(7)
for _ in range(2000):
    q = "".join(random.choice(['a', 'drone', '(', ')', '"', ' ', 'OR', 'AND', 'NOT', '*', ':', '-', '^', '|', '함정']) for _ in range(random.randint(1, 9)))
    db.search(q, limit=1)
db._translate_ko = _tr
print("FTS OK:", a, b, ab)

# 9) 디버그 로그: 회전 파일, 키·전체 프롬프트 없음
logf = TMP / "chat_debug.log"
lines = [json.loads(l) for l in logf.read_text(encoding="utf-8").splitlines()]
txt = logf.read_text(encoding="utf-8")
assert lines and "arli-SECRET-key" not in txt and "g-SECRET-key" not in txt and "서비스 개요" not in txt
r0 = [l for l in lines if l.get("user") == "함정 기사 찾아줘"][0]
assert r0["provider"] == "arli" and r0["attempts"][0]["native_calls"][0]["name"] == "search" and r0["tool_results"][0]["name"] == "search"
assert any(a.get("error") for l in lines for a in l["attempts"])  # 400/429 기록
print("디버그 로그 OK:", len(lines), "턴")
print("ALL OK")
shutil.rmtree(TMP, ignore_errors=True)
