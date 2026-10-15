"""앱 내 기사 리더: 저장된 기사 + 원문 본문 추출(서버 측) + SQLite 캐시."""
import re, logging
from datetime import datetime, timezone
import httpx
from bs4 import BeautifulSoup
from . import db

log = logging.getLogger("article")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
FETCH_TIMEOUT = 15
MAX_CHARS = 30000      # 캐시에 저장하는 본문 최대 길이
RETRY_FAILED_HOURS = 6  # 실패한 추출은 이 시간이 지나면 다시 시도

def init():
    with db.connect() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS article_text(id INTEGER PRIMARY KEY, text TEXT, status TEXT,
                     final_url TEXT, error TEXT, fetched_at TEXT)""")

def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def get_item(item_id):
    with db.connect() as c:
        r = c.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    return dict(r) if r else None

def extract(html):
    """본문 단락 추출: <article>/<main> 우선, 없으면 <p>가 가장 많이 모인 블록."""
    s = BeautifulSoup(html, "html.parser")
    for t in s(["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "iframe", "svg", "figure", "button"]):
        t.decompose()
    cands = s.find_all("article") + s.find_all("main") + s.select("[itemprop=articleBody], .article-body, .entry-content, .post-content, .article-content")
    def score(el): return sum(len(p.get_text(" ", strip=True)) for p in el.find_all("p"))
    best = max(cands, key=score, default=None)
    if best is None or score(best) < 300:
        parents = {}
        for p in s.find_all("p"):
            par = p.parent
            parents[id(par)] = (par, parents.get(id(par), (par, 0))[1] + len(p.get_text(" ", strip=True)))
        best = max(parents.values(), key=lambda x: x[1], default=(s, 0))[0]
    paras, seen = [], set()
    for p in best.find_all(["p", "h2", "h3", "li"]):
        t = re.sub(r"\s+", " ", p.get_text(" ", strip=True))
        if len(t) < 40 and p.name == "p": continue
        if p.name in ("li",) and len(t) < 60: continue
        if t in seen: continue
        seen.add(t); paras.append(t)
    text = "\n\n".join(paras)
    return text[:MAX_CHARS]

def _cached(item_id):
    with db.connect() as c:
        r = c.execute("SELECT * FROM article_text WHERE id=?", (item_id,)).fetchone()
    return dict(r) if r else None

def _save(item_id, text, status, final_url, error):
    with db.connect() as c:
        c.execute("INSERT OR REPLACE INTO article_text VALUES(?,?,?,?,?,?)", (item_id, text, status, final_url, error, _now()))

def fetch_text(item, refresh=False):
    c = _cached(item["id"])
    if c and not refresh:
        if c["status"] == "ok": return c
        age = datetime.now(timezone.utc) - datetime.fromisoformat(c["fetched_at"])
        if age.total_seconds() < RETRY_FAILED_HOURS * 3600: return c
    url = item["url"]
    try:
        if "news.google.com/" in url:
            raise RuntimeError("Google News 링크는 JS 리디렉션이라 본문을 가져올 수 없음")
        r = httpx.get(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}, timeout=FETCH_TIMEOUT, follow_redirects=True)
        r.raise_for_status()
        if "html" not in r.headers.get("content-type", "html"):
            raise RuntimeError(f"HTML 아님: {r.headers.get('content-type')}")
        text = extract(r.text)
        if len(text) < 200:
            raise RuntimeError("본문 추출 실패(내용이 너무 짧음)")
        _save(item["id"], text, "ok", str(r.url), None)
    except Exception as e:
        msg = f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}"[:300]
        log.info("본문 가져오기 실패 id=%s: %s", item["id"], msg)
        _save(item["id"], None, "failed", None, msg)
    return _cached(item["id"])

def get(item_id, refresh=False):
    it = get_item(item_id)
    if not it: return None
    c = fetch_text(it, refresh) or {}
    ok = c.get("status") == "ok" and c.get("text")
    return dict(it, text=c.get("text") if ok else (it.get("summary") or ""),
                text_source="original" if ok else "summary", fetch_error=None if ok else c.get("error"),
                text_fetched_at=c.get("fetched_at"))
