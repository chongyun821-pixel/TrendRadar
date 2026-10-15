import sqlite3, threading
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "defense.db"
_lock = threading.Lock()

def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c

def init():
    with connect() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, title TEXT, url TEXT UNIQUE, source TEXT,
          category TEXT, published TEXT, summary TEXT, fetched_at TEXT);
        CREATE INDEX IF NOT EXISTS ix_pub ON items(published);
        CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, summary, source, content='items', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid,title,summary,source) VALUES(new.id,new.title,new.summary,new.source); END;
        CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
          INSERT INTO items_fts(items_fts,rowid,title,summary,source) VALUES('delete',old.id,old.title,old.summary,old.source); END;
        CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, started TEXT, finished TEXT, new_items INTEGER, details TEXT);
        """)

def insert_items(rows):
    n = 0
    with _lock, connect() as c:
        for r in rows:
            cur = c.execute("INSERT OR IGNORE INTO items(title,url,source,category,published,summary,fetched_at) VALUES(?,?,?,?,?,?,?)",
                            (r["title"], r["url"], r["source"], r["category"], r["published"], r["summary"], r["fetched_at"]))
            n += cur.rowcount
    return n

_OPS = {"OR": "OR", "|": "OR", "또는": "OR", "AND": "AND", "&": "AND", "그리고": "AND", "NOT": "NOT"}

def _qtokens(q):
    """검색어 → [("op","OR")|("phrase","a b")|("term","x")]. 따옴표 구문 유지, 괄호·FTS 특수문자 제거."""
    out = []
    for m in __import__("re").finditer(r'"([^"]*)"|(\S+)', q or ""):
        if m.group(1) is not None:
            t = " ".join(m.group(1).replace("*", " ").split())
            if t: out.append(("phrase", t))
            continue
        raw = m.group(2)
        lead = len(raw) - len(raw.lstrip("("))
        trail = len(raw.rstrip(")")) and len(raw) - len(raw.rstrip(")"))
        out += [("lp", "(")] * lead
        w = raw.strip("()").strip("[]{},;")
        if not w:
            out += [("rp", ")")] * (trail if raw.strip("()") else 0); continue
        if w in _OPS or w.upper() in ("OR", "AND") and w.isupper(): out.append(("op", _OPS.get(w, w.upper()))); continue
        if w.lower() == "or": out.append(("op", "OR")); continue
        w = w.replace('"', "").replace("^", "").replace(":", " ")
        prefix = w.endswith("*")
        w = w.rstrip("*").strip()
        if w: out.append(("term", w + ("*" if prefix else "")))
        out += [("rp", ")")] * trail
    return out

def fts_query(q):
    """FTS5 MATCH 식. 단어는 따옴표로 감싸 접두 검색(AND), OR/AND/NOT 연산자·괄호·"구문"은 유지.
    앞뒤·연속 연산자, 짝이 안 맞는 괄호, 빈 괄호는 버린다 (문법 오류 방지)."""
    toks = _qtokens(q)
    depth, ok = 0, True
    for k, _ in toks:
        depth += (k == "lp") - (k == "rp")
        if depth < 0: ok = False
    if depth != 0: ok = False
    if not ok: toks = [t for t in toks if t[0] not in ("lp", "rp")]
    out = []  # (kind, text)
    def prev(): return out[-1][0] if out else None
    for kind, v in toks:
        if kind == "op":
            if prev() in ("term", "phrase", "rp"): out.append(("op", v))
        elif kind == "lp":
            out.append(("lp", "("))
        elif kind == "rp":
            while prev() == "op": out.pop()
            if prev() == "lp": out.pop()          # 빈 괄호
            elif any(k == "lp" for k, _ in out): out.append(("rp", ")"))
        else:
            out.append((kind, f'"{v.rstrip("*")}"*' if kind == "term" else f'"{v}"'))
    while prev() == "op": out.pop()
    # 짝 다시 맞추기 (빈 괄호 제거 후)
    bal = sum((k == "lp") - (k == "rp") for k, _ in out)
    if bal: out = [t for t in out if t[0] not in ("lp", "rp")]
    res = []
    OPERAND_END, OPERAND_START = ("term", "phrase", "rp"), ("term", "phrase", "lp")
    for i, (k, v) in enumerate(out):
        if i and out[i - 1][0] in OPERAND_END and k in OPERAND_START and res and res[-1] not in ("OR", "AND", "NOT", "("):
            res.append("AND")  # 암묵적 AND 를 명시 (괄호 옆에서 FTS5 문법 오류 방지)
        if k == "op" and v == "NOT" and (not res or res[-1] in ("OR", "AND", "NOT", "(")): continue
        if k == "op" and (not res or res[-1] in ("OR", "AND", "NOT", "(")): continue
        res.append(v)
    while res and res[-1] in ("OR", "AND", "NOT", "("): res.pop()
    s = " ".join(res).replace("( ", "(").replace(" )", ")")
    return s if s.count("(") == s.count(")") else s.replace("(", "").replace(")", "")

import re as _re
from functools import lru_cache as _lru
_HANGUL = _re.compile(r"[\uac00-\ud7a3]")
GLOSSARY = {
    "드론": "drone", "무인기": "drone", "대드론": "counter-drone", "미사일": "missile", "요격": "interceptor",
    "요격미사일": "interceptor", "극초음속": "hypersonic", "전투기": "fighter", "폭격기": "bomber", "잠수함": "submarine",
    "함정": "ship", "구축함": "destroyer", "항공모함": "carrier", "전차": "tank", "자주포": "howitzer", "탄약": "ammunition",
    "포탄": "shell", "위성": "satellite", "우주": "space", "레이더": "radar", "방공": "air defense", "미사일방어": "missile defense",
    "계약": "contract", "수출": "export", "인공지능": "AI", "사이버": "cyber", "전자전": "electronic warfare", "레이저": "laser",
    "로켓": "rocket", "엔진": "engine", "헬기": "helicopter", "수송기": "transport aircraft", "무인수상정": "USV",
    "무인잠수정": "UUV", "로봇": "robot", "방산": "defense", "국방": "defense", "국방부": "Pentagon", "나토": "NATO",
    "한화": "Hanwha", "한화에어로스페이스": "Hanwha Aerospace", "록히드": "Lockheed", "록히드마틴": "Lockheed Martin",
    "레이시온": "Raytheon", "노스롭": "Northrop", "노스롭그루먼": "Northrop Grumman", "보잉": "Boeing", "에어버스": "Airbus",
    "제너럴다이내믹스": "General Dynamics", "안두릴": "Anduril", "현대로템": "Hyundai Rotem", "한국항공우주": "KAI",
    "LIG넥스원": "LIG Nex1", "우크라이나": "Ukraine", "러시아": "Russia", "중국": "China", "북한": "North Korea",
    "한국": "Korea", "일본": "Japan", "대만": "Taiwan", "이스라엘": "Israel", "폴란드": "Poland", "미국": "US",
    "육군": "Army", "해군": "Navy", "공군": "Air Force", "해병대": "Marine Corps", "우주군": "Space Force",
}

def _translate_ko(text):
    try:
        from deep_translator import GoogleTranslator
        return GoogleTranslator(source="ko", target="en").translate(text) or ""
    except Exception:
        return ""

@_lru(maxsize=512)
def translate_query(q):
    """한글 검색어 → 영어 (용어집 우선, 없으면 무료 번역, 실패 시 None).
    OR/AND 연산자와 따옴표 구문의 위치를 유지한다 (구간별로 번역)."""
    if not _HANGUL.search(q): return None
    segs, cur = [], []
    for kind, v in _qtokens(q):
        if kind == "op": segs.append(cur); segs.append(v); cur = []
        elif kind in ("lp", "rp"): continue
        else: cur.append((kind, v))
    segs.append(cur)
    out = []
    for seg in segs:
        if isinstance(seg, str): out.append(seg); continue
        words, unknown = [], []
        for kind, w in seg:
            base = w.rstrip("*")
            if kind == "term" and base in GLOSSARY: words.append(GLOSSARY[base])
            elif _HANGUL.search(base):
                if kind == "phrase": words.append('"' + (_translate_ko(base) or base).replace('"', "") + '"')
                else: unknown.append(base)
            else: words.append(f'"{base}"' if kind == "phrase" else w)
        if unknown:
            tr = _translate_ko(" ".join(unknown))
            words += [tr] if tr else unknown
        out.append(" ".join(x for x in words if x))
    res = " ".join(x for x in out if x).strip()
    return res or None

def _match_expr(q):
    expr = fts_query(q)
    en = translate_query(q.strip())
    if not expr: return fts_query(en) if en else ""
    if en and fts_query(en) and fts_query(en) != expr:
        expr = f"({expr}) OR ({fts_query(en)})"
    return expr

def search(q="", category="", source="", date_from="", date_to="", limit=50, offset=0, sort="date"):
    where, args = [], []
    sql = "SELECT i.* FROM items i"
    expr = _match_expr(q) if q.strip() else ""
    if expr:
        sql += " JOIN items_fts f ON f.rowid=i.id"; where.append("items_fts MATCH ?"); args.append(expr)
    if category: where.append("i.category=?"); args.append(category)
    if source: where.append("i.source=?"); args.append(source)
    if date_from: where.append("substr(i.published,1,10)>=?"); args.append(date_from)
    if date_to: where.append("substr(i.published,1,10)<=?"); args.append(date_to)
    w = (" WHERE " + " AND ".join(where)) if where else ""
    with connect() as c:
        total = c.execute("SELECT count(*) FROM (" + sql + w + ")", args).fetchone()[0]
        order = ("CASE i.category WHEN 'company' THEN 1 WHEN 'media' THEN 2 WHEN 'military' THEN 3 ELSE 4 END, i.source COLLATE NOCASE, i.published DESC"
                 if sort == "source" else "i.published DESC")
        rows = c.execute(sql + w + " ORDER BY " + order + " LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
    return total, [dict(r) for r in rows]

def sources_summary():
    with connect() as c:
        return [dict(r) for r in c.execute("SELECT source, category, count(*) n, max(published) latest FROM items GROUP BY source ORDER BY category, source")]

def save_run(started, finished, new, details):
    with connect() as c:
        c.execute("INSERT INTO runs(started,finished,new_items,details) VALUES(?,?,?,?)", (started, finished, new, details))

def last_run():
    with connect() as c:
        r = c.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        return dict(r) if r else None
