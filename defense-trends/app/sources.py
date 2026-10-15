"""수집 소스 관리: sources.yaml(기본, 손대지 않음) + SQLite source_overrides(사용자 변경: 켜기/끄기/추가/삭제).
yaml 파일은 주석이 많고 사용자가 직접 고치는 파일이라 덮어쓰지 않고 DB에 덮어쓰기 정보를 저장한다(더 안전)."""
import json, re
from datetime import datetime, timezone
from pathlib import Path
import yaml
from . import db

CONFIG = Path(__file__).resolve().parent.parent / "sources.yaml"
CATS = ("company", "media", "military", "academic")

def init():
    with db.connect() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS source_overrides(name TEXT PRIMARY KEY COLLATE NOCASE, enabled INTEGER NOT NULL DEFAULT 1,
                     removed INTEGER NOT NULL DEFAULT 0, custom TEXT, updated TEXT)""")

def load_config(path=None):
    return yaml.safe_load(Path(path or CONFIG).read_text(encoding="utf-8")) or {}

def _overrides():
    init()
    with db.connect() as c:
        return {r["name"].lower(): dict(r) for r in c.execute("SELECT * FROM source_overrides")}

def _now(): return datetime.now(timezone.utc).isoformat(timespec="seconds")

def all_sources(cfg=None):
    """모든 소스 (비활성 포함, 삭제 제외): dict + enabled/origin."""
    cfg = cfg if cfg is not None else load_config()
    ov, out, seen = _overrides(), [], set()
    for s in cfg.get("sources") or []:
        o = ov.get(s["name"].lower())
        if o and o["removed"]: continue
        out.append(dict(s, enabled=bool(o["enabled"]) if o else True, origin="yaml")); seen.add(s["name"].lower())
    for k, o in ov.items():
        if k in seen or o["removed"] or not o["custom"]: continue
        out.append(dict(json.loads(o["custom"]), enabled=bool(o["enabled"]), origin="custom"))
    return out

def effective(cfg=None):
    """수집기가 사용할 활성 소스 목록."""
    return [{k: v for k, v in s.items() if k not in ("enabled", "origin")} for s in all_sources(cfg) if s["enabled"]]

def find(name, cfg=None):
    n = (name or "").strip().lower()
    for s in all_sources(cfg):
        if s["name"].lower() == n: return s
    return None

def _upsert(name, **kw):
    init()
    with db.connect() as c:
        r = c.execute("SELECT * FROM source_overrides WHERE name=?", (name,)).fetchone()
        row = dict(r) if r else {"name": name, "enabled": 1, "removed": 0, "custom": None}
        row.update(kw); row["updated"] = _now()
        c.execute("INSERT OR REPLACE INTO source_overrides(name,enabled,removed,custom,updated) VALUES(?,?,?,?,?)",
                  (row["name"], int(row["enabled"]), int(row["removed"]), row["custom"], row["updated"]))

def set_enabled(name, enabled, cfg=None):
    s = find(name, cfg)
    if not s: raise ValueError(f"출처를 찾을 수 없습니다: {name}")
    _upsert(s["name"], enabled=1 if enabled else 0)
    return s["name"]

def validate_new(name, url, category):
    name, url, category = (name or "").strip(), (url or "").strip(), (category or "").strip().lower()
    if not (1 <= len(name) <= 80) or re.search(r"[\r\n\t]", name): raise ValueError("출처 이름은 1~80자여야 합니다")
    if not re.match(r"^https?://[^\s/$.?#][^\s]*$", url, re.I) or len(url) > 1000: raise ValueError("URL은 http(s):// 로 시작해야 합니다")
    if category not in CATS: raise ValueError("분류는 company / media / military / academic 중 하나여야 합니다")
    return name, url, category

def check_feed(url, timeout=20):
    """피드를 실제로 받아 항목이 있는지 확인."""
    import httpx, feedparser
    r = httpx.get(url, timeout=timeout, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 (compatible; DefenseTrendsBot/1.0)"})
    r.raise_for_status()
    f = feedparser.parse(r.content)
    if not f.entries: raise ValueError("RSS/Atom 피드 항목이 없습니다 (피드 주소인지 확인하세요)")
    return len(f.entries)

def add(name, url, category, cfg=None, check=True):
    name, url, category = validate_new(name, url, category)
    ex = find(name, cfg)
    if ex: raise ValueError(f"이미 있는 출처입니다: {ex['name']}")
    n = check_feed(url) if check else None
    in_yaml = any(s["name"].lower() == name.lower() for s in (cfg if cfg is not None else load_config()).get("sources") or [])
    if in_yaml:   # 예전에 삭제한 기본 소스를 다시 추가 → 삭제 표시만 해제
        _upsert(name, removed=0, enabled=1)
    else:
        _upsert(name, removed=0, enabled=1, custom=json.dumps({"name": name, "category": category, "url": url}, ensure_ascii=False))
    return name, n

def remove(name, cfg=None):
    s = find(name, cfg)
    if not s: raise ValueError(f"출처를 찾을 수 없습니다: {name}")
    if s["origin"] == "custom":
        with db.connect() as c: c.execute("DELETE FROM source_overrides WHERE name=?", (s["name"],))
    else:
        _upsert(s["name"], removed=1, enabled=0)
    return s["name"]
