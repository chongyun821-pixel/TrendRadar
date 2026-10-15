import json, threading, logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, HTTPException, Body
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler
from . import db, collector, digest, article, chat, commands, bookmarks
from . import sources as srcmod

logging.basicConfig(level=logging.INFO)
STATIC = Path(__file__).resolve().parent.parent / "static"
sched = BackgroundScheduler()

@asynccontextmanager
async def lifespan(app):
    db.init()
    article.init()
    srcmod.init()
    bookmarks.init()
    hours = collector.load_config().get("settings", {}).get("interval_hours", 3)
    sched.add_job(collector.collect_all, "interval", hours=hours, id="collect", max_instances=1, coalesce=True)
    collector.ON_FINISH.append(lambda: digest.start(7))  # 수집 후 7일 요약 자동 재생성
    sched.start()
    if db.last_run() is None:
        threading.Thread(target=collector.collect_all, daemon=True).start()
    yield
    sched.shutdown(wait=False)

app = FastAPI(title="방산 동향 검색", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")

@app.get("/api/search")
def search(q: str = "", category: str = "", source: str = "", date_from: str = "", date_to: str = "",
           limit: int = Query(50, le=500), offset: int = 0, sort: str = "date"):
    total, items = db.search(q, category, source, date_from, date_to, limit, offset, sort)
    return {"total": total, "items": items}

@app.get("/api/sources")
def sources():
    return db.sources_summary()

@app.get("/api/status")
def status():
    r = db.last_run()
    if r: r["details"] = json.loads(r["details"] or "[]")
    job = sched.get_job("collect")
    return {"running": collector.STATE["running"], "last_run": r,
            "next_run": job.next_run_time.isoformat() if job and job.next_run_time else None}

@app.post("/api/collect")
def collect_now():
    if collector.STATE["running"]:
        return {"status": "already_running"}
    threading.Thread(target=collector.collect_all, daemon=True).start()
    return {"status": "started"}

@app.get("/api/digest")
def get_digest(days: int = Query(7, ge=1, le=30), refresh: bool = False):
    return digest.get(days, refresh=refresh)

@app.get("/article/{item_id}")
def article_page(item_id: int):
    return FileResponse(STATIC / "article.html")

@app.get("/api/article/{item_id}")
def get_article(item_id: int, refresh: bool = False):
    a = article.get(item_id, refresh=refresh)
    if not a: raise HTTPException(404, "기사를 찾을 수 없습니다")
    return a

@app.post("/api/chat")
def chat_api(payload: dict = Body(...)):
    return chat.chat(payload.get("messages") or [], payload.get("page") or {})

# ---------------- 명령 (챗봇 / !명령) ----------------
@app.get("/api/commands")
def list_commands():
    return {"commands": commands.public_registry(), "help": commands.help_text(), "max_actions": commands.MAX_ACTIONS}

def _ctx(page):
    page = page if isinstance(page, dict) else {}
    return {"article_id": page.get("id") if page.get("type") == "article" else None}

@app.post("/api/command")
def parse_command(payload: dict = Body(...)):
    """'!명령' 문자열 파싱 (LLM 호출 없음)."""
    try:
        return {"ok": True, "cmd": commands.parse(str(payload.get("text") or ""), _ctx(payload.get("page")))}
    except commands.CmdError as e:
        return {"ok": False, "message": str(e)}

@app.post("/api/command/run")
def run_command(payload: dict = Body(...)):
    """백엔드 명령 실행. confirm 명령은 confirmed=true 일 때만 실행."""
    return commands.run(str(payload.get("name") or ""), payload.get("args") or {}, bool(payload.get("confirmed")),
                        _ctx(payload.get("page")))

@app.get("/api/export")
def export_csv(q: str = "", category: str = "", source: str = "", date_from: str = "", date_to: str = "",
               sort: str = "date", limit: int = Query(5000, ge=1, le=20000)):
    import csv, io
    from datetime import datetime
    total, items = db.search(q, category, source, date_from, date_to, limit, 0, sort)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "날짜", "분류", "출처", "제목", "URL", "요약"])
    for i in items:
        w.writerow([i["id"], (i["published"] or "")[:16].replace("T", " "), commands.CATS.get(i["category"], i["category"]),
                    i["source"], i["title"], i["url"], (i["summary"] or "")[:1000]])
    name = f"defense_trends_{datetime.now():%Y%m%d_%H%M}.csv"
    return Response("\ufeff" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Total-Count": str(total)})
