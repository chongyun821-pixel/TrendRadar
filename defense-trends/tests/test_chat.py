"""챗봇 컨텍스트 조립·토큰 예산·동작 파싱 테스트 (Arli AI 호출은 모의). 실행: python tests/test_chat.py"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["ARLIAI_API_KEY"] = "test-dummy-key"
for k in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "CHAT_PROVIDER"): os.environ.pop(k, None)
from app import chat, db

st = chat.Settings()
print("입력 예산:", st.input_budget, "| 출력:", st.max_output, "| 컨텍스트:", st.context)

# 1) 토큰 추정
assert chat.est_tokens("abc" * 100) == 100
assert chat.est_tokens("가" * 100) == 100
t = chat.truncate_tokens("가나다라" * 500, 100)
assert chat.est_tokens(t) <= 100 and t.endswith("…(생략)")

# 2) 긴 대화 + 큰 화면 정보 → 예산 이하로 줄어드는지
long = "드론 대응 체계에 대한 긴 질문입니다. " * 200
history = []
for i in range(20):
    history += [{"role": "user", "content": f"{i} " + long}, {"role": "assistant", "content": f"{i} " + long}]
history.append({"role": "user", "content": "지금 보이는 기사 요약해줘"})
items = [{"id": i, "source": "Defense News", "date": "2026-10-14", "title": "Very long title about hypersonic missiles " * 5} for i in range(60)]
page = {"type": "home_raw", "q": "드론", "category": "media", "source": "", "info": "검색 결과 60건", "items": items}
msgs, stats = chat.build_messages(history, page, st, sources=["Defense News", "Breaking Defense"])
print("home_raw:", json.dumps(stats, ensure_ascii=False))
assert stats["est_input_tokens"] <= st.input_budget
assert msgs[0]["role"] == "system" and msgs[-1]["content"] == "지금 보이는 기사 요약해줘"
assert stats["history_kept"] <= st.caps["hist_msgs"] and msgs[1]["role"] == "user"
assert msgs[0]["content"].count("\n#") <= 30  # 제목 상위 20개만

# 3) 기사 페이지 (DB 본문/요약 사용), 매우 작은 예산에서도 동작
with db.connect() as c:
    aid = c.execute("SELECT id FROM items ORDER BY published DESC LIMIT 1").fetchone()[0]
small = chat.Settings(); small.input_budget = 2500
msgs, stats = chat.build_messages(history, {"type": "article", "id": aid}, small, sources=[])
print("article(작은 예산):", json.dumps(stats, ensure_ascii=False))
assert stats["est_input_tokens"] <= 2500 + 200 and stats["history_kept"] == 0

# 4) think 제거 / 동작 파싱 / 검증
assert chat.strip_think("<think>음...</think>\n안녕") == "안녕"
assert chat.strip_think("생각 중...</think>답") == "답"
txt, a = chat.parse_action('검색할게요.\n```action\n{"type":"search","q":"Hanwha","category":"기업","source":"hanwha aerospace"}\n```')
assert txt == "검색할게요." and a[0]["args"]["q"] == "Hanwha"
srcs = chat.source_names()
v, errs = chat.validate_actions(a)
print("검증된 동작:", v, errs)
assert v[0]["name"] == "search" and v[0]["args"]["category"] == "company" and v[0]["args"]["source"] == "Hanwha Aerospace (Google News)"
assert chat.validate_actions([{"type": "rm -rf"}])[0] == []
assert chat.validate_actions([{"type": "open_tab", "tab": "요약"}])[0][0]["args"] == {"tab": "digest"}
assert chat.validate_actions([{"type": "open_article", "id": 99999999}])[0] == []
assert chat.validate_actions([{"cmd": "filter", "category": "nope"}])[0] == []

# 5) 에이전트 루프 (모의 호출): 1차 search 동작 → DB 검색 → 2차 최종 답
calls = []
def fake(msgs, st):
    calls.append(msgs)
    if len(calls) == 1:
        return '<think>검색 필요</think>한화 관련 기사를 찾아볼게요.\n```action\n{"type":"search","q":"한화","category":"","source":""}\n```'
    assert msgs[-1]["role"] == "tool" and "검색어 '한화'" in msgs[-1]["content"]
    return "**한화 최신 소식**\n- 기사 A (출처 X)"
res = chat.chat([{"role": "user", "content": "한화 관련 최신 소식 요약해줘"}], {"type": "home_raw", "q": "", "items": []}, caller=fake)
print("에이전트 결과:", json.dumps(res, ensure_ascii=False)[:400])
print("2차 호출 도구 결과 일부:", calls[1][-1]["content"][:300].replace("\n", " / "))
assert len(calls) == 2 and res["action"]["name"] == "search" and res["reply"].startswith("**한화")
assert chat.msgs_tokens(calls[1]) <= st.input_budget

# 6) 동작 없는 일반 답변 (1회 호출)
calls.clear()
res = chat.chat([{"role": "user", "content": "이 서비스는 뭐야?"}], {"type": "home_digest", "days": "7", "topics": []},
                caller=lambda m, s: (calls.append(m) or "방산 뉴스 검색 앱입니다."))
assert len(calls) == 1 and res["action"] is None and res["meta"]["rounds"] == 1

# 7) 오류 처리
def boom(m, s): raise chat.ChatError("Arli AI 사용 한도를 초과했습니다.")
res = chat.chat([{"role": "user", "content": "hi"}], {}, caller=boom)
assert res["error"] == "api_error"

# 8) .secrets 파서
import tempfile, pathlib
p = pathlib.Path(tempfile.mktemp())
p.write_text('# 주석\nARLIAI_API_KEY="abc 123"\nexport ARLIAI_MODEL=Foo # 메모\nEMPTY=\n', encoding="utf-8")
assert chat.load_secrets(p) == {"ARLIAI_API_KEY": "abc 123", "ARLIAI_MODEL": "Foo", "EMPTY": ""}
print("전역 지식 추정 토큰:", chat.est_tokens(chat.global_knowledge()), "| 동작 규칙:", chat.est_tokens(chat.action_spec(srcs)))

# 9) 제공자 전환 (모의)
def mk(behav, log_):
    def f(msgs, st):
        log_.append((st.provider, chat.msgs_tokens(msgs), st.input_budget))
        b = behav[st.provider]
        if isinstance(b, Exception): raise b
        return b
    return f
U = [{"role": "user", "content": "안녕"}]
# 9a) arli 429 → google
os.environ["GOOGLE_API_KEY"] = "g-dummy"
L = []
res = chat.chat(U, {"type": "home_raw", "items": items},
                caller=mk({"arli": chat.ChatError("Arli AI 사용 한도를 초과했습니다. (429)"), "google": "<think>x</think>Gemma 답변"}, L))
print("arli429→google:", res["provider"], res.get("fallback_from"), L)
assert res["provider"] == "google" and res["reply"] == "Gemma 답변" and res["fallback_from"] == ["arli"] and "429" in res["fallback_reason"]
assert [x[0] for x in L] == ["arli", "google"] and L[1][2] == chat.Settings("google").input_budget and all(t <= b for _, t, b in L)
# 9b) 빈 응답도 전환
L = []
res = chat.chat(U, {}, caller=mk({"arli": "<think>생각만</think>", "google": "ok"}, L))
assert res["provider"] == "google" and res["reply"] == "ok"
# 9c) arli 키 없음 → google 직접
os.environ["ARLIAI_API_KEY"] = ""
L = []
res = chat.chat(U, {}, caller=mk({"arli": "X", "google": "구글 답"}, L))
assert res["provider"] == "google" and [x[0] for x in L] == ["google"] and "fallback_from" not in res
# 9d) 둘 다 없음 → 안내 메시지
os.environ["GOOGLE_API_KEY"] = ""
res = chat.chat(U, {}, caller=mk({"arli": "X", "google": "Y"}, []))
assert res["error"] == "no_key" and "ARLIAI_API_KEY" in res["reply"] and "GOOGLE_API_KEY" in res["reply"]
# 9e) CHAT_PROVIDER=google 강제인데 키 없음
os.environ["CHAT_PROVIDER"] = "google"; os.environ["ARLIAI_API_KEY"] = "a"
res = chat.chat(U, {}, caller=mk({"arli": "X", "google": "Y"}, []))
assert res["error"] == "no_key" and "GOOGLE_API_KEY" in res["reply"]
# 9f) CHAT_PROVIDER=arli → 실패해도 google 안 씀
os.environ["CHAT_PROVIDER"] = "arli"; os.environ["GOOGLE_API_KEY"] = "g"
L = []
res = chat.chat(U, {}, caller=mk({"arli": chat.ChatError("boom"), "google": "Y"}, L))
assert res["error"] == "api_error" and [x[0] for x in L] == ["arli"]
os.environ.pop("CHAT_PROVIDER")
# 9g) 둘 다 실패 → 두 오류 모두 안내
L = []
res = chat.chat(U, {}, caller=mk({"arli": chat.ChatError("A 실패"), "google": chat.ChatError("G 실패")}, L))
assert res["error"] == "api_error" and "A 실패" in res["reply"] and "G 실패" in res["reply"]
# 9h) 2차 호출(검색 결과)에서 arli 실패 → google이 마무리, 동적 모델 이름이 시스템 프롬프트에 들어감
L = []; seen = []
def f2(msgs, st):
    seen.append((st.provider, msgs[0]["content"]))
    if st.provider == "arli":
        if len(seen) == 1: return '찾아볼게요\n```action\n{"type":"search","q":"drone"}\n```'
        raise chat.ChatError("Arli 429")
    return "드론 요약"
res = chat.chat([{"role": "user", "content": "드론 소식 요약"}], {"type": "home_raw", "items": []}, caller=f2)
print("2차 전환:", [p for p, _ in seen], res["provider"], res["action"])
assert [p for p, _ in seen] == ["arli", "arli", "google"] and res["reply"] == "드론 요약" and res["action"]["args"]["q"] == "drone"
assert "Arli AI · Qwen3.5-27B-Derestricted" in seen[0][1] and "Google AI Studio · gemma-4-26b-a4b-it" in seen[2][1]
# 9i) Gemini 변환: system → systemInstruction, assistant → model, 같은 역할 합치기, fold 모드
m = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "u1"}, {"role": "user", "content": "u2"}, {"role": "assistant", "content": "a1"}]
c, si = chat.to_gemini(m)
assert si == {"parts": [{"text": "SYS"}]} and [x["role"] for x in c] == ["user", "model"] and c[0]["parts"][0]["text"] == "u1\n\nu2"
c, si = chat.to_gemini(m, fold_system=True)
assert si is None and c[0]["parts"][0]["text"].startswith("[지침]\nSYS")
os.environ["ARLIAI_API_KEY"] = "test-dummy-key"; os.environ.pop("GOOGLE_API_KEY", None)
print("ALL OK")
