"""명령 레지스트리·!명령 파서·확인 게이트·다단계 동작·CSV·북마크·소스 관리 테스트.
실제 DB/sources.yaml 은 건드리지 않도록 임시 복사본을 쓴다. 실행: python tests/test_commands.py"""
import os, sys, json, shutil, tempfile, csv, io
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["ARLIAI_API_KEY"] = "test-dummy-key"
for k in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "CHAT_PROVIDER"): os.environ.pop(k, None)

TMP = Path(tempfile.mkdtemp())
from app import db
if (ROOT / "data" / "defense.db").exists(): shutil.copy(ROOT / "data" / "defense.db", TMP / "t.db")
db.DB_PATH = TMP / "t.db"; db.init()
with db.connect() as c:
    if not c.execute("SELECT count(*) FROM items").fetchone()[0]:
        db.insert_items([dict(title=f"Drone test {i}", url=f"https://x.test/{i}", source="Defense News", category="media",
                              published=f"2026-10-{10+i:02d}T00:00:00+00:00", summary="s", fetched_at="x") for i in range(5)])
yml = TMP / "sources.yaml"
yml.write_text("""settings: {interval_hours: 3}
sources:
  - {name: Defense News, category: media, url: "https://www.defensenews.com/rss"}
  - {name: CSIS, category: academic, url: "https://www.csis.org/rss.xml"}
""", encoding="utf-8")
from app import sources as srcmod, bookmarks, commands as C, collector, chat
srcmod.CONFIG = yml; collector.CONFIG = yml
srcmod.init(); bookmarks.init()
def err(fn, *a, **k):
    try: fn(*a, **k)
    except C.CmdError as e: return str(e)
    raise AssertionError("CmdError 기대")

# 1) 레지스트리 무결성
names = [c["name"] for c in C.COMMANDS]
alls = names + [a.lower() for c in C.COMMANDS for a in c["aliases"]]
assert len(alls) == len(set(alls)), "이름/별칭 중복"
need = {"search", "filter", "reset", "more", "tab", "open", "back", "digest_days", "regen", "collect", "sources", "source_enable",
        "source_disable", "source_add", "source_remove", "bookmark", "unbookmark", "bookmarks", "export", "summarize", "help"}
assert need <= set(names), need - set(names)
for c in C.COMMANDS:
    assert c["desc"] and c["usage"].startswith("!") and isinstance(c["confirm"], bool) and c["run"] in ("frontend", "backend", "llm")
assert {c["name"] for c in C.COMMANDS if c["confirm"]} == {"collect", "source_enable", "source_disable", "source_add", "source_remove"}
json.dumps(C.public_registry(), ensure_ascii=False)
# 모든 사용 예시가 파싱되는지 (source_add 예시가 먼저 실행되어야 source_remove 예시가 유효)
with db.connect() as c: any_id = c.execute("SELECT id FROM items LIMIT 1").fetchone()[0]
for c in sorted(C.COMMANDS, key=lambda c: c["name"] != "source_add"):
    u = c["usage"].replace("123", str(any_id))
    cmd = C.parse(u)
    assert cmd["name"] == c["name"], (u, cmd)
    if c["name"] == "source_add": srcmod.add(cmd["args"]["name"], cmd["args"]["url"], cmd["args"]["category"], check=False)
srcmod.remove("Naval Today")
print("레지스트리 OK:", len(C.COMMANDS), "개 명령")

# 2) 파서
r = C.parse('!search 드론 category=company source="Defense News" from=2026-10-01 to=2026-10-14 sort=date')
assert r["args"] == {"q": "드론", "category": "company", "source": "Defense News", "date_from": "2026-10-01", "date_to": "2026-10-14", "sort": "date"}
assert C.parse("!검색 hypersonic missile 분류=언론")["args"] == {"q": "hypersonic missile", "category": "media"}
assert C.parse("!search x from=7d")["args"]["date_from"] == C.parse_date("7d")
assert C.parse("!tab 요약")["args"] == {"tab": "digest"} and C.parse("!탭 raw")["name"] == "tab"
assert C.parse(f"!open #{any_id}")["args"] == {"id": any_id}
assert C.parse("!요약")["run"] == "llm" and C.parse("!내보내기")["name"] == "export" and C.parse("!도움말")["name"] == "help"
assert "!search" in C.parse("!help")["text"] and "별칭" in C.parse("!help 검색")["text"]
assert "혹시 !search" in err(C.parse, "!serch 드론")
assert "따옴표" in err(C.parse, '!search "드론')
assert "필요" in err(C.parse, "!open")
assert "숫자" in err(C.parse, "!open abc")
assert "없습니다" in err(C.parse, "!open 999999999")
assert "날짜" in err(C.parse, "!search x from=지난주")
assert "분류" in err(C.parse, "!filter category=xyz")
assert "출처" in err(C.parse, "!source_disable 없는출처")
assert "해석할 수 없는" in err(C.parse, "!tab digest extra")
assert C.parse("!bookmark", {"article_id": any_id})["args"] == {"id": any_id}   # 기사 화면에선 id 생략
print("파서 OK")

# 3) 확인 게이트
called = []
r = C.run("collect", {}, confirmed=False, collect_fn=lambda: called.append(1))
assert r.get("needs_confirm") and not called
import time
r = C.run("collect", {}, confirmed=True, collect_fn=lambda: called.append(1)); time.sleep(0.2)
assert r["ok"] and called == [1]
assert C.run("source_disable", {"name": "CSIS"})["needs_confirm"]
assert srcmod.find("CSIS")["enabled"]  # 확인 없으면 바뀌지 않음
acts, _ = C.validate_llm([{"cmd": "collect", "confirm": False}, {"cmd": "source_disable", "name": "CSIS", "confirm": False}])
assert all(a["confirm"] for a in acts)  # 모델이 confirm=false 라고 해도 레지스트리 값으로 강제
assert not C.run("search", {"q": "x"})["ok"]  # 프론트 명령은 백엔드에서 실행 안 함
print("확인 게이트 OK")

# 4) 소스 켜기/끄기/추가/삭제 영속성 + 수집기 반영
assert C.run("source_disable", {"name": "csis"}, confirmed=True)["ok"]
eff = [s["name"] for s in srcmod.effective()]
assert eff == ["Defense News"]
import importlib; importlib.reload(srcmod); srcmod.CONFIG = yml  # 재시작 흉내: 설정은 DB에 남음
assert [s["name"] for s in srcmod.effective()] == ["Defense News"]
assert C.run("source_enable", {"name": "CSIS"}, confirmed=True)["ok"] and len(srcmod.effective()) == 2
r = C.run("source_add", {"name": "Test Feed", "url": "https://example.com/feed", "category": "언론"}, confirmed=True, ctx={"check_feed": False})
assert r["ok"], r
assert C.run("source_add", {"name": "test feed", "url": "https://example.com/feed", "category": "media"}, confirmed=True, ctx={"check_feed": False})["ok"] is False
assert not C.run("source_add", {"name": "Bad", "url": "ftp://x", "category": "media"}, confirmed=True, ctx={"check_feed": False})["ok"]
seen = []
collector.sources = srcmod
orig = collector.collect_source
collector.collect_source = lambda client, src, cfg: (seen.append(src["name"]) or [])
collector.collect_all(); collector.collect_source = orig
assert seen == ["Defense News", "CSIS", "Test Feed"], seen
assert C.run("source_remove", {"name": "Test Feed"}, confirmed=True)["ok"] and not srcmod.find("Test Feed")
assert C.run("source_remove", {"name": "CSIS"}, confirmed=True)["ok"] and [s["name"] for s in srcmod.all_sources()] == ["Defense News"]
assert C.run("source_add", {"name": "CSIS", "url": "https://www.csis.org/rss.xml", "category": "academic"}, confirmed=True, ctx={"check_feed": False})["ok"]
assert [s["name"] for s in srcmod.effective()] == ["Defense News", "CSIS"]
assert "Defense News" in yml.read_text(encoding="utf-8") and "Test Feed" not in yml.read_text(encoding="utf-8")  # yaml 은 그대로
print("소스 영속성 OK:", C.run("sources")["message"].splitlines()[0])

# 5) 북마크
assert C.run("bookmark", {"id": any_id})["ok"] and "이미" in C.run("bookmark", {"id": any_id})["message"]
r = C.run("bookmarks"); assert f"#{any_id}" in r["message"] and len(r["items"]) == 1
assert not C.run("bookmark", {"id": 999999999})["ok"]
assert C.run("unbookmark", {"id": any_id})["ok"] and C.run("bookmarks")["message"] == "북마크가 없습니다."
print("북마크 OK")

# 6) CSV 내보내기
from fastapi.testclient import TestClient
from app import main
cl = TestClient(main.app)  # with 없이 → 스케줄러/수집 시작 안 함
resp = cl.get("/api/export", params={"q": "drone", "sort": "date"})
assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/csv") and "attachment" in resp.headers["content-disposition"]
assert resp.content.startswith(b"\xef\xbb\xbf")  # UTF-8 BOM (엑셀)
rows = list(csv.reader(io.StringIO(resp.content.decode("utf-8-sig"))))
assert rows[0] == ["id", "날짜", "분류", "출처", "제목", "URL", "요약"]
total = db.search("drone")[0]
assert len(rows) - 1 == min(total, 5000) and int(resp.headers["x-total-count"]) == total
print("CSV OK:", len(rows) - 1, "행")
assert cl.get("/api/commands").json()["commands"][0]["name"] == "search"
assert cl.post("/api/command", json={"text": "!검색 드론"}).json()["cmd"]["args"] == {"q": "드론"}
assert cl.post("/api/command", json={"text": "!xyz"}).json()["ok"] is False
assert cl.post("/api/command/run", json={"name": "collect"}).json()["needs_confirm"] is True

# 7) 모델의 다단계 동작: 최대 5개, 잘못된 항목 제거, 검색 결과 2차 호출
calls = []
def fake(msgs, st):
    calls.append(msgs)
    if len(calls) == 1:
        return ('지난주 드론 기사를 찾아 CSV로 내보낼게요.\n```action\n[{"cmd":"search","q":"drone","date_from":"2026-10-05","date_to":"2026-10-11"},'
                '{"cmd":"export"},{"cmd":"없는명령"},{"cmd":"collect"},{"cmd":"tab","tab":"raw"},{"cmd":"more"},{"cmd":"reset"},{"cmd":"back"}]\n```')
    return "지난주 드론 기사 요약입니다."
res = chat.chat([{"role": "user", "content": "지난주 드론 기사 찾아서 엑셀로 줘"}], {"type": "home_raw", "items": []}, caller=fake)
print("다단계:", [a["name"] for a in res["actions"]], res["meta"].get("action_errors"))
assert [a["name"] for a in res["actions"]] == ["search", "export", "collect", "tab", "more"]
assert res["actions"][2]["confirm"] is True and res["meta"]["rounds"] == 2 and len(calls) == 2
assert any(m["role"] == "tool" and "2026-10-05~2026-10-11" in m["content"] for m in calls[1])  # 기간 포함 DB 검색 결과가 2차 입력에
assert chat.msgs_tokens(calls[1]) <= chat.Settings().input_budget
assert "오늘: " in calls[0][0]["content"] and "반드시 해당 도구를 호출" in calls[0][0]["content"]  # 날짜·도구 규칙 주입
# 북마크 목록 질문 → bookmarks 도구 결과로 2차 호출
calls.clear(); bookmarks.add(any_id)
def fake2(msgs, st):
    calls.append(msgs)
    return '```action\n{"cmd":"bookmarks"}\n```' if len(calls) == 1 else "북마크 1건입니다."
res = chat.chat([{"role": "user", "content": "내 북마크 정리해줘"}], {"type": "home_raw"}, caller=fake2)
assert len(calls) == 2 and f"#{any_id}" in calls[1][-1]["content"] and res["reply"] == "북마크 1건입니다."
print("ALL OK")
shutil.rmtree(TMP, ignore_errors=True)
