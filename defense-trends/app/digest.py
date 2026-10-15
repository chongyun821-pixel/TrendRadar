"""요약(뉴스레터) 생성: LLM 없이 TF-IDF + 코사인 유사도 클러스터링.
OPENAI_API_KEY 가 있으면 한국어 요약을 LLM으로 개선 (선택)."""
import json, math, os, re, sys, shutil, signal, subprocess, threading, logging, concurrent.futures as cf
from collections import Counter
from datetime import datetime, timedelta, timezone
from . import db

log = logging.getLogger("digest")
STOP = set("""a an the and or but of to in on for with by at from as is are was were be been being it its this that these those
has have had will would can could should may might not no new says said say over into after before about than more most also
up out off his her their they them our we you he she who what which when where why how all any some such per via amid
year years week day days month us u.s news report reports update latest first two three one inc corp co ltd plc
https http www com html""".split())
TRANS_TIMEOUT = 8

def _clean_title(t):
    t = (t or "").strip()
    head, sep, tail = t.rpartition(" - ")  # Google News " - 매체명" 제거
    return head.strip() if sep and 2 <= len(tail) <= 60 else t

def _tokens(text):
    return [w for w in re.findall(r"[a-z0-9][a-z0-9\-]{1,}", (text or "").lower()) if w not in STOP and not w.isdigit()]

def _vec(tf, idf):
    v = {w: c * idf.get(w, 0) for w, c in tf.items()}
    n = math.sqrt(sum(x * x for x in v.values())) or 1
    return {w: x / n for w, x in v.items()}

def _cos(a, b):
    if len(a) > len(b): a, b = b, a
    return sum(x * b.get(w, 0) for w, x in a.items())

def _recent(days):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    with db.connect() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM items WHERE published>=? ORDER BY published DESC", (since,))]
    return [r for r in rows if not FIN_NOISE.search(r["title"])]

# 주가/투자 분석성 기사 제외 (뉴스레터 품질)
FIN_NOISE = re.compile(r"price target|\bstock\b|\bshares?\b|nyse:|nasdaq|stake in|position in|holdings|fair value|dividend|"
                       r"earnings call|analyst|buy rating|sell rating|valuation", re.I)

def cluster(items, thr=0.36):
    docs = []
    for it in items:
        t = _clean_title(it["title"])
        it["clean_title"] = t
        tf = Counter(_tokens(t) * 3 + _tokens(it.get("summary", ""))[:60])
        docs.append(tf)
    N = len(docs) or 1
    df = Counter(w for d in docs for w in d)
    idf = {w: math.log((1 + N) / (1 + n)) + 1 for w, n in df.items()}
    tvecs = [_vec(Counter(_tokens(it["clean_title"])), idf) for it in items]   # 제목 기반 (중복 판정)
    vecs = [_vec(d, idf) for d in docs]
    clusters = []  # {members, centroid}
    seen_titles = set()
    for i, it in enumerate(items):
        key = re.sub(r"\W+", "", it["clean_title"].lower())
        if key in seen_titles: continue  # 완전 동일 제목 제거
        seen_titles.add(key)
        best, bs = None, 0
        for c in clusters:
            s = max(_cos(tvecs[i], tvecs[j]) for j in c["m"][:8]) * 0.6 + _cos(vecs[i], c["cen"]) * 0.4
            if s > bs: best, bs = c, s
        if best and bs >= thr:
            best["m"].append(i)
            k = len(best["m"])
            best["cen"] = {w: best["cen"].get(w, 0) * (k - 1) / k + vecs[i].get(w, 0) / k for w in set(best["cen"]) | set(vecs[i])}
        else:
            clusters.append({"m": [i], "cen": dict(vecs[i])})
    return clusters, vecs

def _base_source(s):
    return s.replace(" (Google News)", "")

def _publisher(it):
    head, sep, tail = it["title"].rpartition(" - ")
    return tail.strip() if "(Google News)" in it["source"] and sep and 2 <= len(tail) <= 60 else it["source"]

def rank(items, clusters, days):
    now = datetime.now(timezone.utc)
    out = []
    for c in clusters:
        mem = [items[i] for i in c["m"]]
        pubs = {_publisher(x).lower() for x in mem}
        newest = max(datetime.fromisoformat(x["published"]) for x in mem)
        age_days = (now - newest).total_seconds() / 86400
        score = len(pubs) * 3 + math.log1p(len(mem)) + max(0, 1 - age_days / max(days, 1)) * 2
        out.append((score, c, mem))
    out.sort(key=lambda x: -x[0])
    return out

def pick(ranked, n=4, overlap=0.25):
    chosen = []
    for score, c, mem in ranked:
        if any(_cos(c["cen"], o["cen"]) > overlap for _, o, _ in chosen): continue  # 주제 중복 방지
        chosen.append((score, c, mem))
        if len(chosen) == n: break
    return chosen

# ---------- 번역 ----------
class Translator:
    def __init__(self):
        self.dead = False
    def _call(self, fn, text):
        ex = cf.ThreadPoolExecutor(1)
        try:
            return ex.submit(fn, text).result(timeout=TRANS_TIMEOUT)
        finally:
            ex.shutdown(wait=False)  # 응답 없는 번역 요청을 기다리지 않음
    def ko(self, text):
        if not text or self.dead: return None
        try:
            from deep_translator import GoogleTranslator, MyMemoryTranslator
        except ImportError:
            self.dead = True; return None
        for fn in (lambda t: GoogleTranslator(source="auto", target="ko").translate(t),
                   lambda t: MyMemoryTranslator(source="en-US", target="ko-KR").translate(t)):
            try:
                r = self._call(fn, text[:4500])
                if r and re.search(r"[가-힣]", r): return r
            except Exception as e:
                log.info("번역 실패: %s", type(e).__name__)
        self.dead = True  # 이후 호출은 즉시 원문 사용 (오프라인/차단 시 지연 방지)
        return None

def _sentences(text, k=3):
    s = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    s = [x for x in s if len(x) > 30 and not x.lower().startswith(("the post", "read more"))]
    return " ".join(s[:k])

def _rep_summary(mem):
    good = [m for m in mem if "(Google News)" not in m["source"] and len(m.get("summary") or "") > 80]
    if good: return _sentences(max(good, key=lambda m: len(m["summary"]))["summary"])
    return ""

def heuristic_topic(mem, tr):
    head = mem[0]["clean_title"]
    for m in mem:  # 원 매체 제목 우선
        if "(Google News)" not in m["source"]: head = m["clean_title"]; break
    summ = _rep_summary(mem)
    pubs = sorted({_publisher(m) for m in mem})
    head_ko = tr.ko(head)
    summ_ko = tr.ko(summ) if summ else None
    lead = f"{len(pubs)}개 출처({', '.join(pubs[:4])}{' 등' if len(pubs) > 4 else ''})에서 보도된 이슈입니다."
    if summ_ko: body = f"{summ_ko} {lead}"
    elif summ: body = f"{lead} (번역 불가로 원문 요약) {summ}"
    else:
        others = [m["clean_title"] for m in mem[1:3]]
        body = lead + (" 관련 보도: " + " / ".join(others) if others else "")
    return {"headline": head_ko or head, "headline_en": head, "summary": body, "translated": bool(head_ko)}

def openai_topics(groups):
    key = os.environ.get("OPENAI_API_KEY")
    if not key: return None
    import httpx
    payload = [{"id": i, "articles": [{"title": m["clean_title"], "source": _publisher(m), "summary": (m.get("summary") or "")[:400]}
                                      for m in mem[:6]]} for i, mem in enumerate(groups)]
    prompt = ("다음은 방산 뉴스 주제 묶음입니다. 각 묶음마다 한국어 뉴스레터 헤드라인(40자 이내)과 2~4문장 한국어 요약을 작성하세요. "
              "묶음 간 내용이 겹치지 않게 하세요. JSON으로만 답하세요: {\"topics\":[{\"id\":0,\"headline\":\"..\",\"summary\":\"..\"}]}\n"
              + json.dumps(payload, ensure_ascii=False))
    try:
        r = httpx.post(os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1") + "/chat/completions",
                       headers={"Authorization": f"Bearer {key}"}, timeout=60,
                       json={"model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"), "response_format": {"type": "json_object"},
                             "messages": [{"role": "user", "content": prompt}]})
        r.raise_for_status()
        data = json.loads(r.json()["choices"][0]["message"]["content"])
        return {t["id"]: t for t in data["topics"]}
    except Exception as e:
        log.warning("OpenAI 요약 실패, 휴리스틱 사용: %s", e)
        return None


# ======================= 생성기(provider) =======================
DATA_DIR = db.DB_PATH.parent
OUTPUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["topics"],
    "properties": {"topics": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["headline", "summary", "link_ids"],
        "properties": {"headline": {"type": "string"}, "summary": {"type": "string"},
                       "link_ids": {"type": "array", "items": {"type": "integer"}}}}}}}
CODEX_PROMPT = """현재 폴더의 {fname} 파일을 읽으세요. 최근 {days}일간 수집된 글로벌 방산 뉴스 후보 묶음(stories)이 들어 있습니다.
각 story는 같은 사건을 다룬 기사들(articles)의 묶음이며, 각 기사에는 정수 link_id가 있습니다.

작업:
1. 이 기간의 가장 중요한 방산 산업 동향 정확히 4개를 고르세요. 4개는 서로 내용이 겹치지 않아야 합니다(같은 사건·계약·인물을 두 번 다루지 말 것).
2. 여러 매체가 함께 보도한 이슈를 우선하고, 주가·애널리스트 목표가·투자 의견 같은 금융 잡음은 제외하세요.
3. 각 이슈마다 한국어 뉴스레터 헤드라인(40자 내외)과 왜 중요한지를 포함한 한국어 요약 3~5문장을 쓰세요.
4. 근거 기사는 link_ids 로만 인용하세요. 반드시 입력 파일에 있는 link_id 값만 사용하고 URL을 지어내지 마세요. 이슈당 1~6개.
5. 출력은 주어진 JSON 스키마를 따르며 topics 배열에 정확히 4개 항목을 넣으세요. 파일을 수정하거나 명령을 실행할 필요는 없습니다.
"""

def provider():
    p = (os.environ.get("DIGEST_PROVIDER") or "").strip().lower()
    if p in ("codex", "openai", "heuristic"): return p
    if shutil.which("codex"): return "codex"
    if os.environ.get("OPENAI_API_KEY"): return "openai"
    return "heuristic"

def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def _prepare(days):
    items = _recent(days)
    clusters, _ = cluster(items) if items else ([], None)
    ranked = rank(items, clusters, days) if items else []
    return items, ranked

def _links(mem, k=6):
    out, seen = [], set()
    for m in mem:
        if m["url"] in seen: continue
        seen.add(m["url"]); out.append({"title": m["clean_title"], "source": _publisher(m), "url": m["url"], "published": m["published"]})
    return out[:k]

def build_heuristic(days, items, ranked, n=4, use_openai=True):
    groups = [mem for _, _, mem in pick(ranked, n)]
    llm = openai_topics(groups) if use_openai else None
    tr = Translator()
    topics = []
    for i, mem in enumerate(groups):
        t = heuristic_topic(mem, tr) if not (llm and i in llm) else {"headline": llm[i]["headline"], "summary": llm[i]["summary"], "translated": True}
        t.update(no=i + 1, links=_links(mem), item_count=len(mem))
        topics.append(t)
    method = "openai" if llm else ("heuristic+translate" if any(t.get("translated") for t in topics) else "heuristic(en-fallback)")
    return {"topics": topics, "method": method}

# ---------- Codex CLI ----------
def _kill_tree(proc):
    try:
        if os.name == "nt":  # .cmd -> node 자식까지 종료
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        try: proc.kill()
        except Exception: pass

def codex_command(schema_path, out_path):
    exe = shutil.which("codex")
    if not exe: raise RuntimeError("codex 실행 파일을 찾을 수 없음 (PATH)")
    cmd = [exe, "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
           "-C", str(DATA_DIR), "--output-schema", str(schema_path), "-o", str(out_path), "--color", "never"]
    if os.environ.get("CODEX_MODEL"): cmd += ["-m", os.environ["CODEX_MODEL"]]
    return cmd + ["-"]  # 프롬프트는 stdin (Windows 명령줄 길이/따옴표 문제 회피)

def build_codex(days, items, ranked, max_stories=150):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stories, by_id, lid = [], {}, 0
    for sid, (score, c, mem) in enumerate(ranked[:max_stories]):
        arts = []
        for m in mem[:6]:
            lid += 1
            by_id[lid] = {"title": m["clean_title"], "source": _publisher(m), "url": m["url"], "published": m["published"]}
            arts.append({"link_id": lid, "title": m["clean_title"], "source": _publisher(m), "url": m["url"], "date": m["published"][:10]})
        stories.append({"id": sid, "outlets": len({a["source"].lower() for a in arts}), "articles": arts,
                        "summary": _rep_summary(mem)[:500] or (mem[0].get("summary") or "")[:300]})
    fname = f"digest_input_{days}.json"
    (DATA_DIR / fname).write_text(json.dumps({"period_days": days, "generated_at": _now(), "stories": stories},
                                             ensure_ascii=False, indent=1), encoding="utf-8")
    schema_path, out_path = DATA_DIR / "digest_schema.json", DATA_DIR / f"digest_output_{days}.json"
    schema_path.write_text(json.dumps(OUTPUT_SCHEMA, indent=1), encoding="utf-8")
    out_path.unlink(missing_ok=True)
    cmd = codex_command(schema_path, out_path)
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    timeout = int(os.environ.get("CODEX_TIMEOUT", "600"))
    log.info("codex 실행: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(DATA_DIR),
                            env=env, text=True, encoding="utf-8", errors="replace", **kw)
    try:
        _, err = proc.communicate(CODEX_PROMPT.format(fname=fname, days=days), timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try: proc.communicate(timeout=5)
        except Exception: pass
        raise RuntimeError(f"codex 시간 초과 ({timeout}s)")
    if proc.returncode != 0:
        raise RuntimeError(f"codex 종료 코드 {proc.returncode}: {(err or '').strip()[-400:]}")
    if not out_path.exists():
        raise RuntimeError("codex 출력 파일이 생성되지 않음")
    data = json.loads(out_path.read_text(encoding="utf-8"))
    topics = []
    for t in data.get("topics", []):
        links = [by_id[i] for i in dict.fromkeys(t.get("link_ids") or []) if isinstance(i, int) and i in by_id][:6]
        head, summ = str(t.get("headline", "")).strip(), str(t.get("summary", "")).strip()
        if head and summ and links:
            topics.append({"headline": head, "summary": summ, "links": links, "item_count": len(links), "translated": True})
    if len(topics) < 4:
        raise RuntimeError(f"codex 출력 검증 실패: 유효한 주제 {len(topics)}개 (4개 필요)")
    topics = topics[:4]
    for i, t in enumerate(topics): t["no"] = i + 1
    return {"topics": topics, "method": "codex"}

def build(days=7, prov=None):
    prov = prov or provider()
    items, ranked = _prepare(days)
    base = {"days": days, "provider": prov, "item_pool": len(items), "error": None}
    if not items:
        return dict(base, topics=[], method="none", generated_at=_now())
    res = None
    if prov == "codex":
        try:
            res = build_codex(days, items, ranked)
        except Exception as e:
            log.warning("codex 요약 실패 → 대체 방식: %s", e)
            base["error"] = f"{type(e).__name__}: {e}"[:600]
    if res is None:
        res = build_heuristic(days, items, ranked, use_openai=(prov in ("codex", "openai")))
    return dict(base, **res, generated_at=_now())

# ---------- 캐시 + 백그라운드 생성 ----------
_jobs, _jobs_lock = {}, threading.Lock()

def _key(days, prov): return f"{days}:{prov}"

def _cached(days, prov):
    with db.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS digests(key TEXT PRIMARY KEY, created TEXT, data TEXT)")
        row = c.execute("SELECT data FROM digests WHERE key=?", (_key(days, prov),)).fetchone()
    return json.loads(row["data"]) if row else None

def _run_job(days, prov):
    key = _key(days, prov)
    try:
        lr = db.last_run()
        d = build(days, prov)
        d["run_id"] = lr["id"] if lr else 0
        with db.connect() as c:
            c.execute("CREATE TABLE IF NOT EXISTS digests(key TEXT PRIMARY KEY, created TEXT, data TEXT)")
            c.execute("INSERT OR REPLACE INTO digests VALUES(?,?,?)", (key, d["generated_at"], json.dumps(d, ensure_ascii=False)))
    except Exception:
        log.exception("요약 생성 실패")
    finally:
        with _jobs_lock: _jobs.pop(key, None)

def start(days=7, prov=None):
    """백그라운드 생성 시작 (이미 진행 중이면 무시). 진행 중 여부 반환."""
    prov = prov or provider()
    key = _key(days, prov)
    with _jobs_lock:
        if key in _jobs: return True
        th = threading.Thread(target=_run_job, args=(days, prov), daemon=True, name=f"digest-{key}")
        _jobs[key] = th
    th.start()
    return True

def is_generating(days, prov=None):
    with _jobs_lock: return _key(days, prov or provider()) in _jobs

def get(days=7, refresh=False):
    """캐시가 있으면 즉시 반환. 없거나 refresh면 백그라운드 생성 후 status=generating."""
    prov = provider()
    d = _cached(days, prov)
    lr = db.last_run(); rid = lr["id"] if lr else 0
    stale = d is not None and (d.get("run_id") != rid or
            (d.get("method") == "heuristic(en-fallback)" and
             datetime.now(timezone.utc) - datetime.fromisoformat(d["generated_at"]) > timedelta(hours=1)))
    if refresh or d is None or stale:
        start(days, prov)
    gen = is_generating(days, prov)
    if d is None:
        return {"status": "generating", "days": days, "provider": prov, "topics": []}
    d["status"] = "generating" if gen else "ready"
    return d
