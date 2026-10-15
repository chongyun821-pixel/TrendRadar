import webbrowser, threading, sys, os
import uvicorn
if __name__ == "__main__":
    if "--no-browser" not in sys.argv and not os.environ.get("NO_BROWSER"):
        threading.Timer(1.5, lambda: webbrowser.open("http://localhost:8000")).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000)
