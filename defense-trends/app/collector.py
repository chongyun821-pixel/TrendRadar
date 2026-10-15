import json, logging, threading, html, re
from datetime import datetime, timezone
from pathlib import Path
from calendar import timegm
import httpx, feedparser, yaml
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from . import db, sources

log = logging.getLogger("collector")
CONFIG = Path(__file__).resolve().parent.parent / "sources.yaml"
_run_lock = threading.Lock()
STATE = {"running": False}
ON_FINISH = []  # 수집 완료 후 호출할 콜백 (예: 요약 재생성)

def load_config():
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def clean(text, n=600):
    t = BeautifulSoup(text or "", "html.parser").get_text(" ", strip=True)
    t = re.sub(r"\s+", " ", html.unescape(t))
    return t[:n]

def entry_date(e):
    for k in ("published_parsed", "updated_parsed"):
        if e.get(k):
            return datetime.fromtimestamp(timegm(e[k]), timezone.utc).isoformat(timespec="seconds")
    return now()

def parse_rss(src, content, fetched):
    f = feedparser.parse(content)
    if not f.entries:
        raise ValueError("피드 항목 0개 (bozo=%s)" % getattr(f, "bozo_exception", ""))
    out = []
    for e in f.entries:
        url = e.get("link") or e.get("id")
        if not url or not e.get("title"): continue
        out.append(dict(title=clean(e.title, 400), url=url.strip(), source=src["name"], category=src["category"],
                        published=entry_date(e), summary=clean(e.get("summary") or e.get("description")), fetched_at=fetched))
    return out

def parse_html(src, content, fetched):
    s = BeautifulSoup(content, "html.parser")
    out = []
    for a in s.select(src["link_selector"]):
        href, title = a.get("href"), a.get_text(" ", strip=True)
        if href and title:
            out.append(dict(title=title[:400], url=urljoin(src.get("base_url", src["url"]), href), source=src["name"],
                            category=src["category"], published=fetched, summary="", fetched_at=fetched))
    if not out: raise ValueError("선택자에 일치하는 링크 없음")
    return out

def collect_source(client, src, cfg):
    fetched = now()
    r = client.get(src["url"])
    r.raise_for_status()
    items = (parse_html if src.get("type") == "html" else parse_rss)(src, r.content, fetched)
    return items[: cfg.get("max_items_per_source", 100)]

def collect_all():
    if not _run_lock.acquire(blocking=False):
        return {"status": "already_running"}
    STATE["running"] = True
    try:
        cfg = load_config(); st = cfg.get("settings", {})
        started, total, details = now(), 0, []
        headers = {"User-Agent": st.get("user_agent", "DefenseTrendsBot/1.0")}
        with httpx.Client(headers=headers, timeout=st.get("timeout_seconds", 25), follow_redirects=True) as client:
            for src in sources.effective(cfg):  # sources.yaml + 사용자 변경(켜기/끄기/추가/삭제)
                try:  # 소스별 오류 격리
                    items = collect_source(client, src, st)
                    new = db.insert_items(items)
                    total += new
                    details.append({"source": src["name"], "ok": True, "fetched": len(items), "new": new})
                except Exception as e:
                    log.warning("소스 실패 %s: %s", src["name"], e)
                    details.append({"source": src["name"], "ok": False, "error": f"{type(e).__name__}: {e}"[:300]})
        db.save_run(started, now(), total, json.dumps(details, ensure_ascii=False))
        for cb in ON_FINISH:
            try: cb()
            except Exception: log.exception("수집 후 콜백 실패")
        return {"status": "ok", "new_items": total, "details": details}
    finally:
        STATE["running"] = False
        _run_lock.release()
