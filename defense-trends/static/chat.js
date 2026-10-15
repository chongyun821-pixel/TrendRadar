/* 글로벌 방산 동향 검색 - AI 챗봇 위젯 (Arli AI). index.html / article.html 공용 */
(function () {
  "use strict";
  var KEY = "dt-chat-history-v1", MAX_SEND = 12;
  var CAT = { company: "기업", media: "언론", military: "군/국방부", academic: "학술/연구" };
  var hist = [];
  try { hist = JSON.parse(sessionStorage.getItem(KEY) || "[]") || []; } catch (e) { hist = []; }
  var busy = false;
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(hist.slice(-40))); } catch (e) {} }
  function el(id) { return document.getElementById(id); }
  function txt(node) { return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : ""; }

  // ---------- 안전한 간단 마크다운 (HTML 먼저 이스케이프) ----------
  function esc(s) { return String(s || "").replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function inline(s) {
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, function (m, t, u) {
      return '<a href="' + u + '" target="' + (u.charAt(0) === "/" ? "_self" : "_blank") + '" rel="noopener">' + t + "</a>";
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    s = s.replace(/(^|[\s(])#(\d{1,9})\b/g, '$1<a href="/article/$2">#$2</a>');  // 기사 id 링크
    return s;
  }
  function md(src) {
    var lines = esc(src).split(/\r?\n/), out = [], list = null, para = [];
    function flushP() { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } }
    function flushL() { if (list) { out.push("</" + list + ">"); list = null; } }
    lines.forEach(function (ln) {
      var m;
      if ((m = ln.match(/^\s*[-*•]\s+(.*)$/))) { flushP(); if (list !== "ul") { flushL(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(m[1]) + "</li>"); }
      else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (list !== "ol") { flushL(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(m[1]) + "</li>"); }
      else if (!ln.trim()) { flushP(); flushL(); }
      else if ((m = ln.match(/^\s*#{1,6}\s+(.*)$/))) { flushP(); flushL(); out.push("<p><b>" + inline(m[1]) + "</b></p>"); }
      else { flushL(); para.push(ln); }
    });
    flushP(); flushL();
    return out.join("");
  }

  // ---------- 현재 페이지 정보 ----------
  function getPageContext() {
    var base = { url: location.pathname + location.search + location.hash, title: document.title };
    if (document.body.dataset.page === "article") {
      var a = window.DT_ARTICLE || {};
      return Object.assign(base, { type: "article", id: a.id, title: a.title, source: a.source, date: a.published, url: a.url,
        text_source: a.text_source, text: String(a.text || "").slice(0, 6000) });
    }
    if (!el("raw")) return Object.assign(base, { type: "default" });
    var on = document.querySelector(".tab.on"), tab = on ? on.dataset.t : "raw";
    if (tab === "digest") {
      var topics = [].slice.call(document.querySelectorAll("#topics .topic")).slice(0, 4).map(function (t) {
        return { headline: txt(t.querySelector("h3")), summary: txt(t.querySelector("p")) };
      });
      return Object.assign(base, { type: "home_digest", days: el("days") ? el("days").value : "", meta: txt(el("nlmeta")), topics: topics });
    }
    var items = [].slice.call(document.querySelectorAll("#list .item")).slice(0, 20).map(function (it) {
      return { id: it.dataset.id, source: it.dataset.source, date: (it.dataset.date || "").slice(0, 10), title: txt(it.querySelector("a.ttl") || it.querySelector("a")) };
    });
    return Object.assign(base, { type: "home_raw", q: el("q").value, category: el("category").value, source: el("source").value,
      date_from: (window.DT_FILTER || {}).date_from || "", date_to: (window.DT_FILTER || {}).date_to || "", sort: (window.DT_FILTER || {}).sort || "",
      info: txt(el("info")), items: items });
  }
  window.getPageContext = getPageContext;

  // ---------- 명령 실행 (레지스트리: /api/commands) ----------
  function setSel(sel, v) {
    if (!sel) return;
    var ok = [].some.call(sel.options, function (o) { return o.value === v; });
    sel.value = ok ? v : "";
  }
  function isHome() { return !!el("f") && typeof window.search === "function"; }
  function F() { return window.DT_FILTER || (window.DT_FILTER = { date_from: "", date_to: "", sort: "source" }); }
  function homeUrl(a, hash) {
    var p = new URLSearchParams();
    ["q", "category", "source", "date_from", "date_to", "sort"].forEach(function (k) { if (a && a[k]) p.set(k, a[k]); });
    var s = p.toString(); return "/" + (s ? "?" + s : "") + (hash || "");
  }
  function tabBtn(t) { return document.querySelector('.tab[data-t="' + t + '"]'); }
  function showTab(t) { var b = tabBtn(t); if (b && !b.classList.contains("on")) b.click(); }
  function post(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }
  function label(a) {
    var parts = Object.keys(a.args || {}).map(function (k) { var v = String(a.args[k]); return k + "=" + (/\s/.test(v) ? '"' + v + '"' : v); });
    return "!" + a.name + (parts.length ? " " + parts.join(" ") : "");
  }
  function curSearch() {
    if (!isHome()) return {};
    var f = F();
    return { q: el("q").value, category: el("category").value, source: el("source").value, date_from: f.date_from, date_to: f.date_to, sort: f.sort };
  }
  // 하나 실행 → Promise<{text?, nav?}>
  function runOne(a, confirmed) {
    var g = a.args || {}, n = a.name;
    if (a.run === "backend") {
      return post("/api/command/run", { name: n, args: g, confirmed: !!confirmed, page: getPageContext() }).then(function (r) {
        if (r.refresh_sources && typeof window.loadSources === "function") window.loadSources();
        return { text: r.message, error: !r.ok };
      });
    }
    var home = isHome();
    if (n === "open") { location.href = "/article/" + encodeURIComponent(g.id); return Promise.resolve({ nav: true }); }
    if (n === "back") { if (history.length > 1) history.back(); else location.href = "/"; return Promise.resolve({ nav: true }); }
    if (n === "export") {
      var p = Object.keys(g).length ? g : curSearch(), q = new URLSearchParams();
      Object.keys(p).forEach(function (k) { if (p[k]) q.set(k, p[k]); });
      var link = document.createElement("a"); link.href = "/api/export?" + q.toString(); link.download = "";
      document.body.appendChild(link); link.click(); link.remove();
      return Promise.resolve({ text: "CSV 내려받기" });
    }
    if (!home) {  // 기사 화면 등 → 메인으로 이동
      if (n === "tab") location.href = g.tab === "digest" ? "/#digest" : "/";
      else if (n === "digest_days" || n === "regen") location.href = "/#digest";
      else if (n === "search" || n === "filter") location.href = homeUrl(g);
      else location.href = "/";
      return Promise.resolve({ nav: true });
    }
    if (n === "tab") { showTab(g.tab); return Promise.resolve({}); }
    if (n === "search" || n === "filter" || n === "reset") {
      showTab("raw");
      var f = F();
      if (n === "reset") { el("q").value = ""; setSel(el("category"), ""); setSel(el("source"), ""); f.date_from = f.date_to = ""; f.sort = "source"; }
      if (n === "search") {
        el("q").value = g.q || "";
        f.date_from = g.date_from || ""; f.date_to = g.date_to || ""; f.sort = g.sort || "source";
      }
      if (n !== "reset") { setSel(el("category"), g.category || ""); setSel(el("source"), g.source || ""); }
      return Promise.resolve(window.search()).then(function () {
        var m = /([\d,]+)\s*건/.exec(txt(el("info"))), cnt = m ? " (" + m[1] + "건)" : "";
        var desc = n === "reset" ? "🔄 화면 필터 초기화" : n === "filter" ? "🔎 화면 필터 적용" : "🔎 화면 검색: " + (g.q || "전체");
        var fl = [el("category").selectedOptions[0], el("source").selectedOptions[0]].filter(function (o) { return o && o.value; }).map(function (o) { return o.textContent; });
        return { text: desc + (fl.length ? " · " + fl.join(" · ") : "") + cnt };
      });
    }
    if (n === "more") {
      var m = el("more");
      if (!m || m.style.display === "none") return Promise.resolve({ text: "더 불러올 결과가 없습니다" });
      return Promise.resolve(window.search(true)).then(function () { return {}; });
    }
    if (n === "digest_days" || n === "regen") {
      showTab("digest");
      var d = el("days");
      if (n === "digest_days" && d) {
        if (![].some.call(d.options, function (o) { return o.value === String(g.days); })) {
          var o = document.createElement("option"); o.value = g.days; o.textContent = "최근 " + g.days + "일"; d.appendChild(o);
        }
        d.value = String(g.days);
      }
      if (typeof window.loadDigest === "function") window.loadDigest(n === "regen");
      return Promise.resolve({});
    }
    return Promise.resolve({ text: "실행할 수 없는 명령: !" + n, error: true });
  }
  // 순서대로 실행. confirm 명령에서 멈추고 버튼 표시.
  function runChain(list, msg, firstConfirmed) {
    var i = 0;
    function step() {
      if (i >= list.length || i >= 5) { if (msg.direct && !msg.content) msg.content = "완료"; save(); render(); return; }
      var a = list[i];
      if (a.confirm && !(i === 0 && firstConfirmed)) { msg.pending = list.slice(i); save(); render(); return; }
      i++;
      runOne(a, a.confirm).then(function (r) {
        if (r.nav) { save(); return; }
        if (r.text) addResult(msg, r.text, r.error);
        step();
      }).catch(function (e) { addResult(msg, "실행 실패: " + e.message, true); save(); render(); });
    }
    step();
  }
  function addResult(msg, text, error) {
    if (msg.direct) { msg.content = (msg.content ? msg.content + "\n\n" : "") + text; if (error) msg.error = true; }
    else msg.actionText = (msg.actionText ? msg.actionText + "\n" : "") + text;
  }

  // ---------- UI ----------
  var css = document.querySelector('link[href*="chat.css"]');
  if (!css) { css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/static/chat.css"; document.head.appendChild(css); }
  var panel = document.createElement("div"); panel.id = "dtc-panel";
  panel.innerHTML = '<div class="dtc-head"><b>인공지능 챗봇</b>' +
    '<button type="button" id="dtc-close" title="닫기">✕</button></div>' +
    '<div class="dtc-msgs" id="dtc-msgs"></div>' +
    '<form class="dtc-form" id="dtc-form"><textarea id="dtc-in" rows="1" placeholder="AI에게 질문"></textarea>' +
    '<button id="dtc-send">전송</button></form>';
  var btn = document.createElement("button"); btn.id = "dtc-btn"; btn.type = "button"; btn.title = "인공지능 챗봇"; btn.textContent = "💬";
  document.body.appendChild(panel); document.body.appendChild(btn);
  var box = el("dtc-msgs"), input = el("dtc-in"), send = el("dtc-send");
  // ---- resize (drag top/left edges or top-left corner) ----
  (function () {
    var SK = "dt-chat-size";
    try { var sz = JSON.parse(localStorage.getItem(SK) || "null"); if (sz) { panel.style.width = sz.w + "px"; panel.style.height = sz.h + "px"; } } catch (e) {}
    ["tl", "l", "t"].forEach(function (k) {
      var g = document.createElement("div"); g.className = "dtc-grip " + k; panel.appendChild(g);
      g.addEventListener("pointerdown", function (e) {
        e.preventDefault(); g.setPointerCapture(e.pointerId);
        var sx = e.clientX, sy = e.clientY, r = panel.getBoundingClientRect(), w0 = r.width, h0 = r.height;
        panel.style.maxHeight = "none"; document.body.classList.add("dtc-resizing");
        function mv(ev) {
          if (k !== "t") panel.style.width = Math.max(280, Math.min(window.innerWidth - 30, w0 + sx - ev.clientX)) + "px";
          if (k !== "l") panel.style.height = Math.max(300, Math.min(window.innerHeight - 100, h0 + sy - ev.clientY)) + "px";
        }
        function up() {
          g.removeEventListener("pointermove", mv); g.removeEventListener("pointerup", up); document.body.classList.remove("dtc-resizing");
          try { localStorage.setItem(SK, JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight })); } catch (e) {}
        }
        g.addEventListener("pointermove", mv); g.addEventListener("pointerup", up);
      });
      g.addEventListener("dblclick", function () { panel.style.width = ""; panel.style.height = ""; panel.style.maxHeight = ""; try { localStorage.removeItem(SK); } catch (e) {} });
    });
  })();

  function bubble(m) {
    var d = document.createElement("div");
    d.className = "dtc-m " + m.role + (m.error ? " err" : "");
    if (m.role === "user") d.textContent = m.content;
    else {
      d.innerHTML = md(m.content || "");
      if (m.actionText) { var s = document.createElement("div"); s.className = "dtc-act"; s.textContent = m.actionText; d.appendChild(s); }
      if (m.pending && m.pending.length) {
        var c = document.createElement("div"); c.className = "dtc-confirm";
        var lb = document.createElement("code"); lb.textContent = label(m.pending[0]); c.appendChild(lb);
        var ok = document.createElement("button"); ok.type = "button"; ok.textContent = "실행";
        var no = document.createElement("button"); no.type = "button"; no.textContent = "취소"; no.className = "no";
        ok.onclick = function () { var p = m.pending; m.pending = null; runChain(p, m, true); };
        no.onclick = function () { m.pending = null; addResult(m, "취소됨"); save(); render(); };
        c.appendChild(ok); c.appendChild(no); d.appendChild(c);
      }
    }
    box.appendChild(d);
  }
  function render() {
    box.innerHTML = "";
    hist.forEach(bubble);
    box.scrollTop = box.scrollHeight;
  }
  function setOpen(o) { panel.classList.toggle("open", o); document.body.classList.toggle("dtc-open", o); if (o) { render(); input.focus(); } }
  btn.onclick = function () { setOpen(!panel.classList.contains("open")); };
  el("dtc-close").onclick = function () { setOpen(false); };
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); el("dtc-form").requestSubmit ? el("dtc-form").requestSubmit() : submit(e); }
  });
  input.addEventListener("input", function () { input.style.height = "38px"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });
  el("dtc-form").addEventListener("submit", submit);

  function loading() {
    busy = true; send.disabled = true;
    var ld = document.createElement("div"); ld.className = "dtc-load"; ld.innerHTML = "답변 작성 중 <span>●</span><span>●</span><span>●</span>";
    box.appendChild(ld); box.scrollTop = box.scrollHeight;
  }
  function done() { busy = false; send.disabled = false; render(); }
  function submit(e) {
    if (e) e.preventDefault();
    var q = input.value.trim();
    if (!q || busy) return;
    input.value = ""; input.style.height = "38px";
    if (q.charAt(0) === "!") return direct(q);
    hist.push({ role: "user", content: q }); save(); render();
    askLLM();
  }
  // !명령: LLM 호출 없이 처리 (summarize 제외)
  function direct(q) {
    var um = { role: "user", content: q, direct: true }; hist.push(um); save(); render();
    loading();
    post("/api/command", { text: q, page: getPageContext() }).then(function (r) {
      busy = false; send.disabled = false;
      var m = { role: "assistant", content: "", direct: true };
      if (!r.ok) { m.content = r.message; m.error = true; hist.push(m); save(); render(); return; }
      var c = r.cmd;
      if (c.name === "help") { m.content = c.text; hist.push(m); save(); render(); return; }
      if (c.run === "llm") {
        um.direct = false; um.llm = "지금 화면(보이는 기사 목록 또는 읽고 있는 기사)을 핵심 위주로 요약해줘.";
        save(); return askLLM();
      }
      hist.push(m); render();
      runChain([c], m, false);
    }).catch(function (err) {
      hist.push({ role: "assistant", content: "서버와 통신하지 못했습니다: " + err.message, error: true, direct: true }); save(); done();
    });
  }
  function askLLM() {
    loading();
    var convo = hist.filter(function (m) { return !m.direct; }).slice(-MAX_SEND)
      .map(function (m) { return { role: m.role, content: String(m.llm || m.content || "").slice(0, 2000) }; });
    post("/api/chat", { messages: convo, page: getPageContext() })
      .then(function (d) {
        var m = { role: "assistant", content: d.reply || "(빈 응답)" };
        if (d.error) m.error = true;
        if (d.notes && d.notes.length) m.actionText = d.notes.join("\n");
        hist.push(m); save(); done();
        var acts = d.actions || (d.action ? [d.action] : []);
        if (acts.length) setTimeout(function () { runChain(acts.slice(0, 5), m, false); }, 150);
      })
      .catch(function (err) {
        hist.push({ role: "assistant", content: "서버와 통신하지 못했습니다: " + err.message, error: true }); save(); done();
      });
  }
  if (sessionStorage.getItem(KEY + "-open") === "1") setOpen(true);
  window.addEventListener("beforeunload", function () { try { sessionStorage.setItem(KEY + "-open", panel.classList.contains("open") ? "1" : "0"); } catch (e) {} });
})();
