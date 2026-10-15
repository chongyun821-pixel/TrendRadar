"""북마크 (SQLite)."""
from datetime import datetime, timezone
from . import db

def init():
    with db.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS bookmarks(item_id INTEGER PRIMARY KEY, created TEXT)")

def add(item_id):
    init()
    with db.connect() as c:
        if not c.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone(): raise ValueError(f"기사 #{item_id} 가 없습니다")
        cur = c.execute("INSERT OR IGNORE INTO bookmarks VALUES(?,?)", (item_id, datetime.now(timezone.utc).isoformat(timespec="seconds")))
        return cur.rowcount == 1

def remove(item_id):
    init()
    with db.connect() as c:
        return c.execute("DELETE FROM bookmarks WHERE item_id=?", (item_id,)).rowcount == 1

def list_(limit=100):
    init()
    with db.connect() as c:
        return [dict(r) for r in c.execute("""SELECT i.id, i.title, i.source, i.category, i.published, i.url, b.created FROM bookmarks b
                                               JOIN items i ON i.id=b.item_id ORDER BY b.created DESC LIMIT ?""", (limit,))]

def ids():
    init()
    with db.connect() as c:
        return [r[0] for r in c.execute("SELECT item_id FROM bookmarks")]
