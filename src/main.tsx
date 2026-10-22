import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ArrowRight,
  ArrowLeft,
  Plus,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  FolderOpen,
  Globe2,
  Layers3,
  Sparkles,
  LockKeyhole,
  PanelRightClose,
  PanelRightOpen,
  MoreHorizontal,
  Download,
  X,
  Search,
  Paperclip,
  Send,
  Square,
  Terminal,
  CheckCircle2,
  Circle,
  AlertCircle,
  ExternalLink,
  Bold,
  Italic,
  List,
  Heading2,
  Undo2,
  Redo2,
  Network,
  Target,
  CalendarDays,
  ChartNoAxesCombined,
  BookOpen,
  Settings2,
  RotateCw,
  Copy,
  Pencil,
  Eye,
  FileDown,
  Trash2,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
// @ts-expect-error The GFM extension provides no declarations.
import { gfm } from "turndown-plugin-gfm";
import { api, post, patch, ApiError } from "./api";
import {
  STEPS,
  PAGE_DEFS,
  MODEL,
  EFFORT,
  type Report,
  type ReportState,
  type ConnectionStatus,
  type Draft,
  type Run,
} from "../shared/types";
import { EDITOR_HINTS } from "../shared/templates";
import "./styles.css";
import "./h5s-editors.css";
import { ChatLobby, type ConversationListItem } from "./ChatLobby";
import { QuestionFields } from "./QuestionFields";
import { ProblemDefinitionEditor, IssueTreeEditor } from "./H5SEditors";
import { problemLayout } from "../shared/report-layout";
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});
turndown.use(gfm);
const icons = [Network, Target, CalendarDays, ChartNoAxesCombined, Layers3];
type Tab = "questions" | "draft" | "sources";
type ReportListItem = ConversationListItem;
function App() {
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [state, setState] = useState<ReportState | null>(null);
  const selectedConversation = useRef<string | null>(null);
  const [connections, setConnections] = useState<ConnectionStatus | null>(null);
  const [activePage, setActivePage] = useState("problem");
  const [tab, setTab] = useState<Tab>("questions");
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth > 1000);
  const [modal, setModal] = useState<
    "reports" | "settings" | "context" | "sources" | null
  >(null);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState("");
  const [events, setEvents] = useState<
    { method: string; text: string; at: string }[]
  >([]);
  const [connectionLost, setConnectionLost] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReportListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [creatingExample, setCreatingExample] = useState(false);
  const report = state?.report;
  const moduleOpen = !!report && report.mode !== "chat";
  const current = report?.pages.find((p) => p.id === activePage);
  const run = state?.run;
  const busy =
    !!run && ["starting", "running", "stopping"].includes(run.status);
  const tell = useCallback((text: string) => setToast(text), []);
  const forgetConversation = useCallback((id: string) => {
    setReports(old => old.filter(item => item.id !== id));
    const cacheKeys = Object.keys(localStorage).filter(key => key === `h5s-message-${id}` || key === `h5s-chat-${id}` || key.startsWith(`h5s-unsaved-${id}-`));
    cacheKeys.forEach(key => localStorage.removeItem(key));
    if (localStorage.getItem("h5s-active") === id) localStorage.removeItem("h5s-active");
    if (selectedConversation.current !== id) return;
    selectedConversation.current = null;
    setState(null); setStreaming(""); setEvents([]); setConnectionLost(false);
    setActivePage("problem"); setTab("questions"); setModal(null);
    history.replaceState({}, "", "/");
  }, []);
  const requestDelete = (item: ReportListItem) => {
    setModal(null); setDeleteError(""); setDeleteTarget(item);
  };
  const deleteConversation = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setDeleteError("");
    try {
      const id = deleteTarget.id;
      await api(`/reports/${id}`, { method: "DELETE" });
      forgetConversation(id); setDeleteTarget(null);
      tell("대화를 삭제했습니다.");
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 404) { forgetConversation(deleteTarget.id); setDeleteTarget(null); }
      else setDeleteError(e.message);
    } finally { setDeleting(false); }
  };
  const refreshReports = () =>
    api<ReportListItem[]>("/reports")
      .then(setReports)
      .catch((e) => tell(e.message));
  const refreshConnections = () => {
    setConnections(null);
    api<ConnectionStatus>("/connections?refresh=1")
      .then(setConnections)
      .catch((e) => tell(e.message));
  };
  const openReport = async (id: string) => {
    try {
      await saveRef.current?.();
      const s = await api<ReportState>(`/reports/${id}`);
      selectedConversation.current = id;
      setState(s);
      setActivePage(s.report.currentPage);
      setTab(
        s.report.pages.find((p) => p.id === s.report.currentPage)?.content
          ? "draft"
          : "questions",
      );
      setStreaming("");
      setEvents([]);
      setModal(null);
      localStorage.setItem("h5s-active", id);
      window.history.replaceState(
        {},
        "",
        `/?${s.report.mode === "chat" ? "chat" : "report"}=${id}`,
      );
    } catch (e: any) {
      tell(e.message);
    }
  };
  useEffect(() => {
    void (async () => {
      try {
        const list = await api<ReportListItem[]>("/reports");
        setReports(list);
        const wanted =
          new URLSearchParams(location.search).get("report") ||
          new URLSearchParams(location.search).get("chat") ||
          localStorage.getItem("h5s-active");
        if (wanted && list.some((r) => r.id === wanted))
          await openReport(wanted);
      } catch (e: any) {
        tell(e.message);
      }
      setLoading(false);
    })();
    api<ConnectionStatus>("/connections")
      .then(setConnections)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!report?.id) return;
    const source = new EventSource(`/api/reports/${report.id}/events`);
    source.onopen = () => setConnectionLost(false);
    source.onerror = () => setConnectionLost(true);
    source.onmessage = (e) => {
      if (selectedConversation.current !== report.id) return;
      const event = JSON.parse(e.data);
      if (event.type === "deleted") {
        source.close(); forgetConversation(report.id); return;
      }
      if (event.type === "state" || event.type === "snapshot") {
        setState(event.data);
        if (
          event.data.run &&
          ["starting", "running", "stopping"].includes(event.data.run.status)
        )
          setStreaming(event.data.run.text);
        else setStreaming("");
      }
      if (event.type === "delta") setStreaming(event.data.text);
      if (event.type === "terminal")
        setEvents((old) => [
          ...old.slice(-149),
          { ...event.data, at: event.at },
        ]);
    };
    return () => source.close();
  }, [report?.id]);
  useEffect(() => {
    if (!report) return;
    history.replaceState(
      {},
      "",
      `/?${report.mode === "chat" ? "chat" : "report"}=${report.id}`,
    );
    localStorage.setItem("h5s-active", report.id);
    void refreshReports();
  }, [report?.id, report?.mode, state?.run?.status]);
  const apply = (s: ReportState) => setState(s);
  const execute = async (action: "questions" | "draft" | "chat", text = "") => {
    if (!report) return false;
    try {
      await saveRef.current?.();
      const response = await post(`/reports/${report.id}/run`, {
        pageId: activePage,
        action,
        text,
      });
      setState((s) => (s ? { ...s, run: response.run } : s));
      if (action === "draft") setTab("draft");
      return true;
    } catch (e: any) {
      tell(e.message);
      return false;
    }
  };
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const navigate = async (id: string) => {
    if (!report) return;
    const index = report.pages.findIndex((p) => p.id === id);
    if (report.pages.slice(0, index).some((p) => p.status !== "confirmed")) {
      tell("앞선 내용을 확정한 뒤 계속해주세요.");
      return;
    }
    try {
      await saveRef.current?.();
      const result = await patch<ReportState>(`/reports/${report.id}`, {
        currentPage: id,
      });
      setActivePage(id);
      setTab(result.report.pages[index].content ? "draft" : "questions");
      apply(result);
    } catch (e: any) {
      tell(e.message);
    }
  };
  const confirm = async () => {
    if (!report || !current) return;
    try {
      await saveRef.current?.();
      const latest = await api<ReportState>(`/reports/${report.id}`);
      const result = await post<ReportState>(
        `/reports/${report.id}/pages/${activePage}/confirm`,
        {
          expectedVersion: latest.report.pages.find((p) => p.id === activePage)!
            .version,
        },
      );
      setState(result);
      setActivePage(result.report.currentPage);
      setTab(result.report.currentPage === activePage ? "draft" : "questions");
      tell("내용을 확정했습니다.");
      void refreshReports();
    } catch (e: any) {
      tell(e.message);
    }
  };
  const doExport = async (format: "html" | "pdf" | "docx", preview = false) => {
    if (!report) return;
    setExportMenu(false);
    // Open synchronously so browsers do not block the explicitly requested new tab.
    const previewTab = preview ? window.open("about:blank", "_blank") : null;
    try {
      await saveRef.current?.();
      if (preview) {
        if (previewTab) {
          previewTab.opener = null;
          previewTab.location.href = `/api/reports/${report.id}/export/html`;
        }
        return;
      }
      setExporting(true);
      const res = await fetch(
        `/api/reports/${report.id}/export/${format}?download=1`,
      );
      if (!res.ok) throw new Error((await res.json()).error);
      const blob = await res.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `${report.title}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      tell("보고서를 내려받았습니다.");
    } catch (e: any) {
      previewTab?.close();
      tell(e.message);
    } finally {
      setExporting(false);
    }
  };
  const newChat = async () => {
    try {
      await saveRef.current?.();
      selectedConversation.current = null;
      setState(null);
      setActivePage("problem");
      setTab("questions");
      setStreaming("");
      setEvents([]);
      setConnectionLost(false);
      setModal(null);
      localStorage.removeItem("h5s-active");
      history.replaceState({}, "", "/");
      void refreshReports();
    } catch (e: any) {
      tell(e.message);
    }
  };
  const sendGeneral = async (text: string) => {
    try {
      if (!report) {
        const s = await post<ReportState>("/chats", { text });
        selectedConversation.current = s.report.id;
        setState(s);
        setStreaming("");
        localStorage.setItem("h5s-active", s.report.id);
      } else {
        const { run } = await post(`/reports/${report.id}/run`, {
          pageId: "chat",
          action: "chat",
          text,
        });
        setState((s) => (s ? { ...s, run } : s));
        setStreaming("");
      }
      void refreshReports();
      return true;
    } catch (e: any) {
      tell(e.message);
      return false;
    }
  };
  const openSources = async () => {
    try {
      if (!report) {
        const s = await post<ReportState>("/chats");
        selectedConversation.current = s.report.id;
        setState(s);
      }
      setModal("sources");
    } catch (e: any) {
      tell(e.message);
    }
  };
  const stopRun = async () => {
    if (!report) return;
    try {
      await post(`/reports/${report.id}/stop`);
    } catch (e: any) {
      tell(e.message);
    }
  };
  const startExample = async () => {
    if (creatingExample) return;
    setCreatingExample(true);
    try {
      await saveRef.current?.();
      const result = await post<ReportState>("/examples/h5s-world-bank");
      selectedConversation.current = result.report.id;
      setState(result); setStreaming(""); setEvents([]); setConnectionLost(false);
      setActivePage("problem"); setTab("questions"); setModal(null);
      localStorage.setItem("h5s-active", result.report.id);
      void refreshReports();
    } catch (e: any) { tell(e.message); }
    finally { setCreatingExample(false); }
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => {
            setModal("reports");
            void refreshReports();
          }}
          aria-label="보고서 목록"
        >
          <div className="brand-mark">
            H<span>5</span>S<i />
          </div>
          <span className="brand-divider" />
          <span className="brand-studio">STUDIO</span>
        </button>
        <span className="topbar-caption">CONSULTING WORKSPACE</span>
        <div className="topbar-actions">
          <button
            className="connection-pill"
            onClick={() => setModal("settings")}
          >
            <span
              className={`status-dot ${connections?.codex.authenticated && connections.codex.modelAvailable ? "online" : connections ? "offline" : "loading"}`}
            />
            {connections?.codex.authenticated &&
            connections.codex.modelAvailable
              ? "Codex 연결됨"
              : connections
                ? "연결 확인"
                : "연결 중"}
            <ChevronDown size={12} />
          </button>
          <button
            className="icon-button help-button"
            aria-label="연결 및 사용 안내"
            onClick={() => setModal("settings")}
          >
            <CircleHelp size={18} />
          </button>
          <span className="avatar">H</span>
        </div>
      </header>
      {!moduleOpen ? (
        <ChatLobby
          loading={loading || creatingExample}
          report={report}
          run={run || null}
          streaming={streaming}
          busy={busy}
          conversations={reports}
          connectionLost={connectionLost}
          onSend={sendGeneral}
          onStop={stopRun}
          onSources={() => void openSources()}
          onNew={() => void newChat()}
          onOpen={openReport}
          onDelete={requestDelete}
          onExample={startExample}
        />
      ) : (
        <div className={`workspace ${chatOpen ? "" : "chat-hidden"}`}>
          <aside className="sidebar">
            <div className="sidebar-top">
              <div className="sidebar-label">MY WORKSPACE</div>
              <button
                className="workspace-picker"
                onClick={() => {
                  setModal("reports");
                  void refreshReports();
                }}
              >
                <div className="workspace-icon">
                  <FolderOpen size={17} />
                </div>
                <span>컨설팅 보고서</span>
                <ChevronDown size={14} />
              </button>
              <button className="new-report" onClick={() => void newChat()}>
                <Plus size={15} /> 새 대화
              </button>
            </div>
            <div className="nav-heading">작성할 내용</div>
            <nav aria-label="보고서 작성 단계">
              {STEPS.map((step, si) => {
                const Icon = icons[si],
                  pages = report.pages.filter((p) => step.pages.includes(p.id)),
                  done = pages.every((p) => p.status === "confirmed"),
                  active =
                    PAGE_DEFS.find((p) => p.id === activePage)!.step === si;
                return (
                  <div
                    className={`nav-step ${active ? "active" : ""} ${done ? "done" : ""}`}
                    key={si}
                  >
                    <div className="step-title">
                      <span className="step-node">
                        {done ? (
                          <Check size={12} />
                        ) : (
                          String(si + 1).padStart(2, "0")
                        )}
                      </span>
                      <span>{step.title}</span>
                      {active && <span className="current-dot" />}
                    </div>
                    <div className="nav-pages">
                      {pages.map((p) => {
                        const index = report.pages.indexOf(p),
                          locked = report.pages
                            .slice(0, index)
                            .some((p) => p.status !== "confirmed");
                        return (
                          <button
                            className={`nav-page ${p.id === activePage ? "selected" : ""} ${locked ? "locked" : ""}`}
                            onClick={() => void navigate(p.id)}
                            key={p.id}
                            title={
                              locked
                                ? "앞선 내용을 확정하면 열립니다."
                                : PAGE_DEFS[index].title
                            }
                          >
                            <FileText size={14} />
                            <span>
                              {p.id === "pyramid"
                                ? "Governing Thought"
                                : PAGE_DEFS[index].title}
                            </span>
                            {p.status === "confirmed" ? (
                              <Check size={12} />
                            ) : locked ? (
                              <LockKeyhole size={11} />
                            ) : (
                              <span className="page-no">
                                {String(index + 1).padStart(2, "0")}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </nav>
            <div className="sidebar-bottom">
              <div className="progress-caption">
                <span>보고서 완성도</span>
                <strong>
                  {report.pages.filter((p) => p.status === "confirmed").length}
                  <small> / 7</small>
                </strong>
              </div>
              <div className="progress-track">
                <i
                  style={{
                    width: `${(report.pages.filter((p) => p.status === "confirmed").length / 7) * 100}%`,
                  }}
                />
              </div>
              <button
                className="source-connection"
                onClick={() => {
                  setTab("sources");
                }}
              >
                <Globe2 size={16} />
                <div>
                  <span>Procurement Radar</span>
                  <small>
                    {connections?.radar.connected
                      ? "읽기 전용으로 연결됨"
                      : connections
                        ? "DB 연결 확인 필요"
                        : "연결 상태 확인 중"}
                  </small>
                </div>
                <span
                  className={`status-dot ${connections?.radar.connected ? "online" : "offline"}`}
                />
              </button>
              <span className="sidebar-version">
                H5S Methodology <span>v1.0</span>
              </span>
            </div>
          </aside>
          <main className="main">
            <div className="document-topbar">
              <div className="breadcrumb">
                <span>워크스페이스</span>
                <ChevronRight size={12} />
                <button onClick={() => setModal("context")}>
                  {report.title}
                </button>
              </div>
              <div className="document-actions">
                <button
                  onClick={() => void doExport("html", true)}
                  className="text-button"
                >
                  <Eye size={15} />
                  <span>전체 미리보기</span>
                </button>
                <div className="export-wrap">
                  <button
                    className="button button-small"
                    onClick={() => setExportMenu(!exportMenu)}
                    disabled={exporting}
                  >
                    <Download size={14} />
                    {exporting ? "변환 중…" : "내보내기"}
                    <ChevronDown size={12} />
                  </button>
                  {exportMenu && (
                    <>
                      <div
                        className="menu-backdrop"
                        onClick={() => setExportMenu(false)}
                      />
                      <div className="export-menu">
                        <div>보고서 내려받기</div>
                        {(["pdf", "docx", "html"] as const).map((f) => (
                          <button key={f} onClick={() => void doExport(f)}>
                            <FileDown size={16} />
                            {f === "docx"
                              ? "Word 문서"
                              : f.toUpperCase() + " 보고서"}
                            <span>.{f}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <button
                  className="icon-button"
                  onClick={() => setChatOpen(!chatOpen)}
                  title={chatOpen ? "채팅 접기" : "채팅 열기"}
                >
                  {chatOpen ? (
                    <PanelRightClose size={17} />
                  ) : (
                    <PanelRightOpen size={17} />
                  )}
                </button>
              </div>
            </div>
            {connectionLost && (
              <div className="connection-warning">
                <AlertCircle size={14} /> 서버와 다시 연결하는 중입니다. 편집
                중인 내용은 유지됩니다.
              </div>
            )}
            <div className="main-scroll">
              <div className="document-header">
                <div className="eyebrow">
                  <span className="eyebrow-line" />
                  STEP 0{PAGE_DEFS.find((p) => p.id === activePage)!.step + 1}
                  <span className="eyebrow-separator">/</span>
                  {STEPS[
                    PAGE_DEFS.find((p) => p.id === activePage)!.step
                  ].english.toUpperCase()}
                </div>
                <div className="document-title-row">
                  <div>
                    <h1>{PAGE_DEFS.find((p) => p.id === activePage)!.title}</h1>
                    <p>
                      {PAGE_DEFS.find((p) => p.id === activePage)!.description}
                    </p>
                  </div>
                  <span className="document-number">
                    <strong>
                      {String(
                        report.pages.findIndex((p) => p.id === activePage) + 1,
                      ).padStart(2, "0")}
                    </strong>
                    <span>/ 07</span>
                  </span>
                </div>
                <div className="stepper">
                  {STEPS.map((step, i) => {
                    const active =
                        PAGE_DEFS.find((p) => p.id === activePage)!.step === i,
                      done = step.pages.every(
                        (id) =>
                          report.pages.find((p) => p.id === id)?.status ===
                          "confirmed",
                      );
                    return (
                      <React.Fragment key={i}>
                        <button
                          className={`${active ? "active" : ""} ${done ? "done" : ""}`}
                          onClick={() => void navigate(step.pages[0])}
                        >
                          <span>{done ? <Check size={11} /> : i + 1}</span>
                          <em>{step.title}</em>
                        </button>
                        {i < 4 && <div className="stepper-line" />}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
              <div className="document-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={tab === "questions"}
                  onClick={() => setTab("questions")}
                >
                  <CircleHelp size={15} />
                  질문 · 답변 <span>{current?.questions.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "draft"}
                  onClick={() => setTab("draft")}
                >
                  <FileText size={15} />
                  초안 편집 {current?.content && <span className="tab-dot" />}
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "sources"}
                  onClick={() => setTab("sources")}
                >
                  <Paperclip size={15} />
                  참고자료<span>{report.attachments.length + 1}</span>
                </button>
                <div className="tab-spacer" />
                <span className={`draft-status ${current?.status}`}>
                  <span />
                  {current?.status === "confirmed"
                    ? "확정됨"
                    : current?.status === "draft"
                      ? "초안 작성됨"
                      : "작성 준비"}
                </span>
              </div>
              <div className="document-content">
                <PageWorkspace
                  key={`${report.id}-${activePage}`}
                  report={report}
                  page={current!}
                  tab={tab}
                  setTab={setTab}
                  busy={busy}
                  tell={tell}
                  apply={apply}
                  execute={execute}
                  saveRef={saveRef}
                />
              </div>
            </div>
            <footer className="main-footer">
              <div>
                <span className="status-dot online" />
                <span>대화와 초안은 워크스페이스에 보관됩니다</span>
              </div>
              <button
                className="button button-primary"
                onClick={() => void confirm()}
                disabled={busy || !current?.content.trim()}
              >
                {activePage === "recommendation"
                  ? "보고서 확정"
                  : "확정하고 다음으로"}
                <ArrowRight size={16} />
              </button>
            </footer>
          </main>
          {chatOpen && (
            <ChatPanel
              report={report}
              run={run || null}
              streaming={streaming}
              events={events}
              busy={busy}
              activePage={activePage}
              onSend={(text) => execute("chat", text)}
              onStop={async () => {
                try {
                  await post(`/reports/${report.id}/stop`);
                } catch (e: any) {
                  tell(e.message);
                }
              }}
              onUpload={() => setTab("sources")}
              onClose={() => setChatOpen(false)}
            />
          )}
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <AlertCircle size={17} />
          {toast}
          <button onClick={() => setToast("")} aria-label="알림 닫기">
            <X size={14} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal === "reports"
              ? "내 대화"
              : modal === "context"
                ? "과제 정보"
                : modal === "sources"
                  ? "참고자료"
                  : "연결 및 사용 안내"
          }
          onClose={() => setModal(null)}
        >
          {modal === "reports" ? (
            <div className="report-list">
              <button
                className="button button-primary"
                onClick={() => void newChat()}
              >
                <Plus size={15} />새 대화
              </button>
              {reports.length ? (
                reports.map((r) => (
                  <div className="report-list-item" key={r.id}>
                  <button
                    className="report-list-row"
                    onClick={() => void openReport(r.id)}
                  >
                    <FileText size={20} />
                    <div>
                      <strong>{r.title}</strong>
                      <small>
                        {new Date(r.updatedAt).toLocaleDateString("ko-KR")}
                      </small>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                  <button className="conversation-delete" type="button" aria-label={`${r.title} 대화 삭제`} title="대화 삭제" onClick={() => requestDelete(r)}><Trash2 size={16} /></button>
                  </div>
                ))
              ) : (
                <p className="muted">아직 대화가 없습니다.</p>
              )}
            </div>
          ) : modal === "sources" ? (
            report && <Sources report={report} tell={tell} apply={apply} />
          ) : modal === "settings" ? (
            <ConnectionPanel
              connections={connections}
              onRefresh={refreshConnections}
            />
          ) : (
            report && (
              <ContextForm
                report={report}
                onSave={async (data) => {
                  try {
                    apply(await patch(`/reports/${report.id}`, data));
                    setModal(null);
                    void refreshReports();
                  } catch (e: any) {
                    tell(e.message);
                  }
                }}
              />
            )
          )}
        </Modal>
      )}
      {deleteTarget && (
        <Modal title="대화를 삭제할까요?" onClose={() => { if (!deleting) setDeleteTarget(null); }}>
          <div className="delete-conversation-content">
            <strong>{deleteTarget.title}</strong>
            <p>이 앱에 저장된 대화, 보고서, 첨부자료가 삭제됩니다. 삭제 후에는 복구할 수 없습니다.</p>
            {deleteError && <p className="delete-error" role="alert">{deleteError}</p>}
            {deleteTarget.id === report?.id && busy && <p className="muted">답변을 중지하거나 작성이 끝난 뒤 삭제할 수 있습니다.</p>}
            <div className="delete-actions">
              <button className="button" disabled={deleting} onClick={() => setDeleteTarget(null)}>취소</button>
              {deleteTarget.id === report?.id && busy ? <button className="button" onClick={() => void stopRun()}>답변 중지</button> : <button className="button button-danger" disabled={deleting} onClick={() => void deleteConversation()}><Trash2 size={14} />{deleting ? "삭제 중…" : "대화 삭제"}</button>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
function PageWorkspace({
  report,
  page,
  tab,
  setTab,
  busy,
  tell,
  apply,
  execute,
  saveRef,
}: {
  report: Report;
  page: Draft;
  tab: Tab;
  setTab: (t: Tab) => void;
  busy: boolean;
  tell: (s: string) => void;
  apply: (s: ReportState) => void;
  execute: (
    a: "questions" | "draft" | "chat",
    text?: string,
  ) => Promise<boolean>;
  saveRef: React.RefObject<(() => Promise<void>) | null>;
}) {
  const [content, setContent] = useState(page.content),
    [answers, setAnswers] = useState(page.answers);
  const [saveStatus, setSaveStatus] = useState<
    "saved" | "saving" | "dirty" | "error"
  >("saved");
  const [conflict, setConflict] = useState(false),
    [editMode, setEditMode] = useState(true);
  const [sourceView, setSourceView] = useState(false);
  const contentRef = useRef(page.content),
    answersRef = useRef(page.answers),
    baseVersion = useRef(page.version),
    dirty = useRef(false),
    inFlight = useRef<Promise<void> | null>(null),
    previous = useRef({
      content: page.content,
      answers: JSON.stringify(page.answers),
    });
  const pageRef = useRef(page);
  pageRef.current = page;
  const pendingSave = useRef<{
    content: string;
    answers: string;
    version: number;
  } | null>(null);
  const conflictRef = useRef(false);
  conflictRef.current = conflict;
  useEffect(() => {
    if (
      page.version === baseVersion.current &&
      JSON.stringify(page.answers) === previous.current.answers
    )
      return;
    if (dirty.current) {
      const pending = pendingSave.current;
      if (
        pending &&
        page.version === pending.version + 1 &&
        page.content === pending.content &&
        JSON.stringify(page.answers) === pending.answers
      ) {
        baseVersion.current = page.version;
        return;
      }
      if (
        page.content === contentRef.current &&
        JSON.stringify(page.answers) === JSON.stringify(answersRef.current)
      ) {
        baseVersion.current = page.version;
        setConflict(false);
      } else if (page.version !== baseVersion.current) {
        setConflict(true);
      }
      return;
    }
    setContent(page.content);
    contentRef.current = page.content;
    setAnswers(page.answers);
    answersRef.current = page.answers;
    baseVersion.current = page.version;
    previous.current = {
      content: page.content,
      answers: JSON.stringify(page.answers),
    };
  }, [page.version, page.content, page.answers]);
  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      await inFlight.current;
      if (!dirty.current) return;
    }
    if (!dirty.current) return;
    if (conflictRef.current)
      throw new Error(
        "서버의 최신 초안과 편집 내용이 겹칩니다. 비교 후 저장 방식을 선택해주세요.",
      );
    const sentContent = contentRef.current,
      sentAnswers = JSON.stringify(answersRef.current);
    const sentVersion = baseVersion.current;
    pendingSave.current = {
      content: sentContent,
      answers: sentAnswers,
      version: sentVersion,
    };
    setSaveStatus("saving");
    const work = (async () => {
      try {
        const s = await patch<ReportState>(
          `/reports/${report.id}/pages/${page.id}`,
          {
            content: sentContent,
            answers: JSON.parse(sentAnswers),
            expectedVersion: sentVersion,
          },
        );
        const newPage = s.report.pages.find((p) => p.id === page.id)!;
        baseVersion.current = newPage.version;
        previous.current = {
          content: newPage.content,
          answers: JSON.stringify(newPage.answers),
        };
        dirty.current =
          contentRef.current !== sentContent ||
          JSON.stringify(answersRef.current) !== sentAnswers;
        setSaveStatus(dirty.current ? "dirty" : "saved");
        apply(s);
      } catch (e: any) {
        if (e instanceof ApiError && e.status === 409) setConflict(true);
        setSaveStatus("error");
        throw e;
      }
    })();
    inFlight.current = work;
    try {
      await work;
    } finally {
      inFlight.current = null;
      pendingSave.current = null;
    }
  }, [report.id, page.id]);
  useEffect(() => {
    saveRef.current = save;
    return () => {
      saveRef.current = null;
    };
  }, [save]);
  const autoPrepared = useRef(false);
  useEffect(() => {
    if (busy || tab !== "questions" || autoPrepared.current) return;
    if (page.questionSource === "codex" && page.questions.every(q => q.recommendedAnswer?.trim())) return;
    autoPrepared.current = true;
    void execute("questions");
  }, [busy, tab, page.questionSource, page.questions]);
  useEffect(() => {
    if (saveStatus !== "dirty" || conflict) return;
    const t = setTimeout(() => {
      void save().catch((e) => tell(e.message));
    }, 900);
    return () => clearTimeout(t);
  }, [content, answers, saveStatus, conflict, save]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const updateContent = (value: string) => {
    contentRef.current = value;
    dirty.current = true;
    setContent(value);
    setSaveStatus("dirty");
  };
  const updateAnswer = (id: string, text: string) => {
    const value = { ...answersRef.current, [id]: text };
    answersRef.current = value;
    dirty.current = true;
    setAnswers(value);
    setSaveStatus("dirty");
  };
  const localKey = `h5s-unsaved-${report.id}-${page.id}`;
  const cacheReady = useRef(false);
  useEffect(() => {
    if (!cacheReady.current) return;
    if (dirty.current)
      localStorage.setItem(
        localKey,
        JSON.stringify({
          content: contentRef.current,
          answers: answersRef.current,
          version: baseVersion.current,
        }),
      );
    else localStorage.removeItem(localKey);
  }, [content, answers, saveStatus]);
  const recovered = useRef(false);
  useEffect(() => {
    if (recovered.current) return;
    recovered.current = true;
    const stored = localStorage.getItem(localKey);
    cacheReady.current = true;
    if (!stored) return;
    try {
      const old = JSON.parse(stored);
      if (
        old.content !== page.content ||
        JSON.stringify(old.answers) !== JSON.stringify(page.answers)
      ) {
        contentRef.current = old.content;
        answersRef.current = old.answers;
        baseVersion.current = old.version;
        dirty.current = true;
        setContent(old.content);
        setAnswers(old.answers);
        setSaveStatus("dirty");
        setConflict(old.version !== page.version);
        tell("저장하지 못한 편집 내용을 복원했습니다.");
      }
    } catch {
      /* Ignore corrupt browser cache; original server data remains intact. */
    }
  }, []);
  const proposal = report.proposals.find((p) => p.pageId === page.id);
  return (
    <>
      {conflict && (
        <div className="conflict-box">
          <AlertCircle size={18} />
          <div>
            <strong>다른 수정 내용이 있습니다</strong>
            <p>
              입력한 내용을 보존했습니다. 최신 초안과 비교한 뒤 선택해주세요.
            </p>
            <details>
              <summary>최신 초안과 비교</summary>
              <div className="comparison">
                <pre>{page.content}</pre>
                <pre>{content}</pre>
              </div>
            </details>
            <div className="conflict-actions">
              <button
                className="button"
                onClick={() => {
                  setConflict(false);
                  conflictRef.current = false;
                  baseVersion.current = page.version;
                  void save().catch((e) => tell(e.message));
                }}
              >
                내 편집 내용 저장
              </button>
              <button
                className="text-button"
                onClick={() => {
                  dirty.current = false;
                  contentRef.current = page.content;
                  answersRef.current = page.answers;
                  setContent(page.content);
                  setAnswers(page.answers);
                  baseVersion.current = page.version;
                  setConflict(false);
                  setSaveStatus("saved");
                }}
              >
                최신 초안 사용
              </button>
            </div>
          </div>
        </div>
      )}
      {proposal && (
        <div className="conflict-box proposal-box">
          <Sparkles size={18} />
          <div>
            <strong>Codex의 수정 제안이 도착했습니다</strong>
            <p>직접 편집한 내용과 겹쳐 별도로 보관했습니다.</p>
            <details>
              <summary>제안 내용 보기</summary>
              <article
                className="markdown"
                dangerouslySetInnerHTML={{
                  __html: markdown.render(proposal.content),
                }}
              />
            </details>
            <div className="conflict-actions">
              <button
                className="button"
                onClick={async () => {
                  try {
                    await save();
                    apply(
                      await post(
                        `/reports/${report.id}/proposals/${proposal.id}`,
                        { accept: true, expectedVersion: baseVersion.current },
                      ),
                    );
                  } catch (e: any) {
                    tell(e.message);
                  }
                }}
              >
                제안 반영
              </button>
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    apply(
                      await post(
                        `/reports/${report.id}/proposals/${proposal.id}`,
                        { accept: false, expectedVersion: page.version },
                      ),
                    );
                  } catch (e: any) {
                    tell(e.message);
                  }
                }}
              >
                현재 내용 유지
              </button>
            </div>
          </div>
        </div>
      )}
      {tab === "questions" && (
        <>
          <div className="question-intro">
            <div className="spark-icon">
              <Sparkles size={19} />
            </div>
            <div>
              <strong>추천 답변에서 필요한 부분만 수정하세요</strong>
              <p>
                대화와 참고자료를 바탕으로 답변을 미리 채웁니다. 그대로 초안을 작성해도 됩니다.
              </p>
            </div>
            <button
              className="button button-small"
              disabled={busy}
              onClick={() => void execute("questions")}
            >
              <Sparkles size={14} />
              추천 답변 {page.questionSource === "codex" ? "다시 생성" : "생성"}
            </button>
          </div>
          <div className="section-label">
            <span>작성할 내용 확인</span>
            <span className="template-tag">
              {page.questionSource === "codex"
                ? "필요한 부분만 수정"
                : "추천 답변 준비 중"}
            </span>
          </div>
          {page.questionSource === "codex" ? <QuestionFields questions={page.questions} answers={answers} onChange={updateAnswer} onSave={() => void save().catch(e => tell(e.message))} /> : <p className="muted">{busy ? "대화와 자료를 바탕으로 추천 답변을 작성하고 있습니다…" : "추천 답변을 생성하면 바로 초안을 작성할 수 있습니다."}</p>}
          <div className="question-footer">
            <SaveIndicator status={saveStatus} />
            <button
              className="button button-ai"
              disabled={
                busy ||
                page.questionSource !== "codex" ||
                page.questions.some((q) => q.required && !answers[q.id]?.trim())
              }
              onClick={() => void execute("draft")}
            >
              <Sparkles size={15} />
              {busy
                ? "Codex 작성 중…"
                : content
                  ? "이 내용으로 초안 다시 작성"
                  : "이 내용으로 초안 작성"}
              <ArrowRight size={15} />
            </button>
          </div>
          <div className="method-note">
            <BookOpen size={15} />
            <span>
              {page.id === "problem"
                ? "문제정의서는 S-C-Q를 바탕으로 기본 질문, 배경, 성공 기준 등 7개 항목을 정리합니다."
                : page.id === "issue-tree"
                  ? "상위 질문과의 관련성, 같은 단계의 동일 수준, MECE 원칙을 검토합니다."
                  : "앞선 단계에서 확정한 내용과 참고자료를 이어받아 작성합니다."}
            </span>
          </div>
        </>
      )}
      {tab === "draft" && (
        <>
          <div className="editor-top">
            <div className="editor-heading">
              <span className="paper-icon">
                <FileText size={15} />
              </span>
              <strong>{PAGE_DEFS.find((p) => p.id === page.id)!.title}</strong>
              <span className="version-tag">v{page.version}</span>
            </div>
            <div className="editor-options">
              <button
                className={!sourceView && editMode ? "active" : ""}
                onClick={() => {
                  setEditMode(true);
                  setSourceView(false);
                }}
                title="직접 편집"
              >
                <Pencil size={14} />
              </button>
              <button
                className={!editMode ? "active" : ""}
                onClick={() => {
                  setEditMode(false);
                  setSourceView(false);
                }}
                title="문서 보기"
              >
                <Eye size={14} />
              </button>
              <button
                onClick={() => {
                  setSourceView(!sourceView);
                  setEditMode(true);
                }}
                title="텍스트 구조 편집"
              >
                <Terminal size={14} />
              </button>
            </div>
          </div>
          {content || page.id === "problem" || page.id === "issue-tree" ? (
            <>
              {page.id === "problem" && !sourceView ? <ProblemDefinitionEditor content={content} onChange={updateContent} readOnly={!editMode} onSave={() => void save().catch(e => tell(e.message))} /> : page.id === "issue-tree" && !sourceView ? <IssueTreeEditor content={content} fallbackQuestion={problemLayout(report.pages.find(p => p.id === "problem")?.content || "").fields[0].content.split(/\n\s*\n/)[0]} onChange={updateContent} readOnly={!editMode} onSave={() => void save().catch(e => tell(e.message))} /> : <RichEditor
                content={content}
                onChange={updateContent}
                readOnly={!editMode}
                sourceView={sourceView}
                onSave={() => void save().catch((e) => tell(e.message))}
              />}
              <div className="editor-footer">
                <SaveIndicator status={saveStatus} />
                <span>{content.length.toLocaleString()}자 · 1페이지</span>
              </div>
            </>
          ) : (
            <div className="empty-draft">
              <div className="empty-paper">
                <FileText size={33} />
                <span className="empty-paper-line" />
                <span className="empty-paper-line short" />
              </div>
              <h3>아직 초안이 없습니다</h3>
              <p>
                질문에 답한 뒤 Codex와 첫 초안을 작성해보세요.
                <br />
                직접 내용을 작성할 수도 있습니다.
              </p>
              <div>
                <button
                  className="button button-ai"
                  onClick={() => setTab("questions")}
                >
                  <CircleHelp size={15} />
                  질문에 답하기
                </button>
                <button
                  className="button"
                  onClick={() => updateContent(EDITOR_HINTS[page.id])}
                >
                  <Pencil size={14} />
                  직접 작성
                </button>
              </div>
            </div>
          )}
          <div className="method-note">
            <Sparkles size={15} />
            <span>
              직접 편집하거나 오른쪽 채팅에서 수정을 요청하세요. Codex의 수정은
              이 문서에 반영됩니다.
            </span>
          </div>
        </>
      )}
      {tab === "sources" && (
        <Sources report={report} tell={tell} apply={apply} />
      )}
    </>
  );
}
function SaveIndicator({ status }: { status: string }) {
  return (
    <span className={`save-indicator ${status}`}>
      <span
        className={`status-dot ${status === "saved" ? "online" : status === "error" ? "offline" : "loading"}`}
      />
      {status === "saved"
        ? "저장됨"
        : status === "saving"
          ? "저장 중…"
          : status === "dirty"
            ? "변경사항 저장 대기"
            : "저장 실패 · 편집 내용 보존됨"}
    </span>
  );
}
function RichEditor({
  content,
  onChange,
  readOnly,
  sourceView,
  onSave,
}: {
  content: string;
  onChange: (s: string) => void;
  readOnly: boolean;
  sourceView: boolean;
  onSave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    lastEmitted = useRef("");
  useEffect(() => {
    if (!ref.current || sourceView) return;
    if (content !== lastEmitted.current || !ref.current.innerHTML) {
      ref.current.innerHTML = markdown.render(content);
      lastEmitted.current = content;
    }
  }, [content, sourceView, readOnly]);
  const emit = () => {
    if (!ref.current) return;
    const text = turndown.turndown(ref.current.innerHTML);
    lastEmitted.current = text;
    onChange(text);
  };
  const command = (name: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(name, false, value);
    emit();
  };
  return (
    <div className={`editor ${readOnly ? "readonly" : ""}`}>
      {!readOnly && !sourceView && (
        <div className="editor-toolbar">
          {[
            [Bold, "bold", "굵게"],
            [Italic, "italic", "기울임"],
          ].map(([Icon, cmd, title]: any) => (
            <button
              key={cmd}
              title={title}
              aria-label={title}
              onMouseDown={(e) => {
                e.preventDefault();
                command(cmd);
              }}
            >
              <Icon size={15} />
            </button>
          ))}
          <span />
          <button
            title="소제목"
            onMouseDown={(e) => {
              e.preventDefault();
              command("formatBlock", "h2");
            }}
          >
            <Heading2 size={16} />
          </button>
          <button
            title="본문"
            onMouseDown={(e) => {
              e.preventDefault();
              command("formatBlock", "p");
            }}
          >
            본문
          </button>
          <span />
          <button
            title="목록"
            onMouseDown={(e) => {
              e.preventDefault();
              command("insertUnorderedList");
            }}
          >
            <List size={16} />
          </button>
          <span />
          <button
            title="되돌리기"
            onMouseDown={(e) => {
              e.preventDefault();
              command("undo");
            }}
          >
            <Undo2 size={15} />
          </button>
          <button
            title="다시 실행"
            onMouseDown={(e) => {
              e.preventDefault();
              command("redo");
            }}
          >
            <Redo2 size={15} />
          </button>
          <div />
          <small>문서를 클릭해 편집하세요</small>
        </div>
      )}
      {sourceView ? (
        <textarea
          className="source-editor"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onSave}
          aria-label="텍스트 구조 편집"
        />
      ) : (
        <div
          ref={ref}
          className={`markdown document-paper ${readOnly ? "" : "editable"}`}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          onInput={emit}
          onBlur={onSave}
          onPaste={(e) => {
            if (readOnly) return;
            e.preventDefault();
            document.execCommand(
              "insertText",
              false,
              e.clipboardData.getData("text/plain"),
            );
            emit();
          }}
          aria-label="보고서 초안 편집기"
          role={readOnly ? "article" : "textbox"}
          aria-multiline={!readOnly}
        />
      )}
    </div>
  );
}
function ChatPanel({
  report,
  run,
  streaming,
  busy,
  activePage,
  events,
  onSend,
  onStop,
  onUpload,
  onClose,
}: {
  report: Report;
  run: Run | null;
  streaming: string;
  busy: boolean;
  activePage: string;
  events: { method: string; text: string; at: string }[];
  onSend: (s: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onUpload: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(""),
    [terminalOpen, setTerminalOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [report.messages.length, streaming]);
  const send = async () => {
    if (!text.trim() || busy) return;
    const value = text;
    setText("");
    try {
      if (!(await onSend(value))) setText(value);
    } catch {
      setText(value);
    }
  };
  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <div className="chat-symbol">
          <Sparkles size={18} />
        </div>
        <div>
          <strong>H5S 컨설턴트</strong>
          <small>질문부터 권고안까지, 함께</small>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="채팅 접기"
        >
          <PanelRightClose size={17} />
        </button>
      </div>
      <div className="chat-context">
        <span className="status-dot online" />
        <span>{PAGE_DEFS.find((p) => p.id === activePage)!.title}</span>
        <span>맥락 공유 중</span>
      </div>
      <div className="chat-messages">
        {report.messages.length === 0 && (
          <p className="muted">??? ???? ??? ??? ?????.</p>
        )}
        {report.messages.map((m) =>
          m.role === "system" ? (
            <div className="system-message" key={m.id}>
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`chat-message ${m.role}`}>
              <div className="message-byline">
                {m.role === "assistant" ? (
                  <>
                    <Sparkles size={13} />
                    Codex
                  </>
                ) : (
                  "나"
                )}
                <time>
                  {new Date(m.createdAt).toLocaleTimeString("ko-KR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                </time>
              </div>
              <div
                className="message-body markdown"
                dangerouslySetInnerHTML={{ __html: markdown.render(m.text) }}
              />
            </div>
          ),
        )}
        {busy && (
          <div className="chat-message assistant">
            <div className="message-byline">
              <Sparkles size={13} />
              Codex
              <span className="thinking-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
            {streaming ? (
              <div
                className="message-body markdown"
                dangerouslySetInnerHTML={{ __html: markdown.render(streaming) }}
              />
            ) : (
              <div className="thinking-label">
                {run?.status === "starting"
                  ? "내용을 확인하고 있습니다…"
                  : run?.status === "stopping"
                    ? "작성을 중지하고 있습니다…"
                    : "자료와 답변을 검토하고 있습니다…"}
              </div>
            )}
          </div>
        )}
        {!busy && run?.status === "failed" && (
          <div className="chat-error">
            <AlertCircle size={15} />
            <span>{run.error || "연결 상태를 확인해주세요."}</span>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="chat-bottom">
        {report.messages.length === 0 && (
          <div className="chat-suggestions">
            <button
              onClick={() =>
                void onSend(
                  "현재 과제의 핵심 질문을 구체화할 수 있도록 도와줘. 필요한 정보를 질문해줘.",
                )
              }
              disabled={busy}
            >
              핵심 질문 구체화
              <ArrowUp size={12} />
            </button>
            <button
              onClick={() =>
                void onSend(
                  "현재 작성 중인 내용을 H5S 원칙으로 검토하고 보완할 점을 알려줘.",
                )
              }
              disabled={busy}
            >
              H5S 관점에서 검토
              <ArrowUp size={12} />
            </button>
          </div>
        )}
        <div className={`chat-composer ${busy ? "busy" : ""}`}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="수정할 내용이나 궁금한 점을 입력하세요"
            rows={3}
            aria-label="컨설턴트에게 메시지"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div>
            <button
              className="icon-button"
              title="참고자료 첨부"
              onClick={onUpload}
            >
              <Plus size={19} />
            </button>
            <span className="composer-spacer" />
            {busy ? (
              <button
                className="send-button stop-button"
                onClick={() => void onStop()}
                title="작성 중지"
                aria-label="작성 중지"
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-button"
                onClick={() => void send()}
                disabled={!text.trim()}
                title="메시지 보내기"
                aria-label="메시지 보내기"
              >
                <ArrowUp size={20} />
              </button>
            )}
          </div>
        </div>
        <button
          className="terminal-toggle"
          onClick={() => setTerminalOpen(!terminalOpen)}
        >
          <Terminal size={12} />
          <span>작업 내역</span>
          <span className="terminal-counter">{events.length}</span>
          <ChevronDown size={12} className={terminalOpen ? "rotated" : ""} />
        </button>
        {terminalOpen && (
          <div className="terminal-log">
            <div className="terminal-session">{report.title}</div>
            {events.map((e, i) => (
              <div key={i}>
                <span>
                  {new Date(e.at).toLocaleTimeString("ko-KR", {
                    hour12: false,
                  })}
                </span>
                <strong>{e.method}</strong>
                <p>{e.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
function Sources({
  report,
  tell,
  apply,
}: {
  report: Report;
  tell: (s: string) => void;
  apply: (s: ReportState) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("records"),
    [results, setResults] = useState<any[] | null>(null),
    [searching, setSearching] = useState(false);
  const [conversations, setConversations] = useState<any[] | null>(null),
    [remoteFiles, setRemoteFiles] = useState<any[]>([]),
    [linking, setLinking] = useState(false);
  const refreshRemoteFiles = () =>
    api<any[]>(`/reports/${report.id}/radar-files`)
      .then(setRemoteFiles)
      .catch((e) => tell(e.message));
  useEffect(() => {
    if (report.radarConversationId) void refreshRemoteFiles();
  }, [report.radarConversationId]);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const body = new FormData();
    [...files].forEach((f) => body.append("files", f));
    setUploading(true);
    try {
      apply(
        await api(`/reports/${report.id}/attachments`, {
          method: "POST",
          body,
        }),
      );
      tell("참고자료를 워크스페이스에 보관했습니다.");
    } catch (e: any) {
      tell(e.message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    try {
      setResults(
        await api(`/radar/search?q=${encodeURIComponent(query)}&kind=${kind}`),
      );
    } catch (e: any) {
      tell(e.message);
    } finally {
      setSearching(false);
    }
  };
  return (
    <div className="sources-panel">
      <div className="section-title">
        <div>
          <h2>과제의 근거를 한곳에</h2>
          <p>대화 맥락, 첨부자료와 기존 프로젝트의 데이터를 함께 활용합니다.</p>
        </div>
        <button
          className="button button-small"
          onClick={() => input.current?.click()}
          disabled={uploading}
        >
          <Plus size={14} />
          {uploading ? "첨부 중…" : "자료 첨부"}
        </button>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept=".txt,.md,.csv,.tsv,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp"
        hidden
        onChange={(e) => void upload(e.target.files)}
      />
      <button
        className="upload-zone"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
        disabled={uploading}
      >
        <div>
          <Paperclip size={22} />
        </div>
        <strong>파일을 놓거나 클릭해 첨부하세요</strong>
        <span>PDF, Word, 텍스트, 이미지 · 파일당 최대 30MB</span>
      </button>
      <div className="source-item">
        <span className="source-file-icon">
          <BookOpen size={18} />
        </span>
        <div>
          <strong>H5S 문제정의서 · 이슈트리 작성 가이드</strong>
          <small>참고자료 사진 8장 판독본 · 기본 제공</small>
        </div>
        <span className="source-badge">판독 완료</span>
      </div>
      {report.attachments.map((a) => (
        <div className="source-item" key={a.id}>
          <span className="source-file-icon">
            <FileText size={18} />
          </span>
          <div>
            <a
              href={`/api/reports/${report.id}/files/${a.id}`}
              target="_blank"
              rel="noreferrer"
            >
              {a.name}
            </a>
            <small>
              {(a.bytes / 1024).toFixed(1)} KB ·{" "}
              {a.extracted
                ? "텍스트 추출 완료"
                : a.mime.startsWith("image/")
                  ? "Codex가 이미지 직접 판독"
                  : a.error || "원본 보관"}
            </small>
          </div>
          {a.error ? (
            <AlertCircle size={15} className="warning-icon" />
          ) : (
            <CheckCircle2 size={15} className="success-icon" />
          )}
        </div>
      ))}
      <div className="source-block">
        <div className="section-title">
          <div>
            <h2>
              <Globe2 size={17} />
              Procurement Radar
            </h2>
            <p>기존 프로젝트를 수정하지 않고 읽기 전용으로 조회합니다.</p>
          </div>
          <span className="read-only-tag">
            <LockKeyhole size={11} />
            READ ONLY
          </span>
        </div>
        <form className="radar-search" onSubmit={search}>
          <select
            aria-label="자료 구분"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="records">조달 데이터</option>
            <option value="sources">보존 출처</option>
            <option value="reports">기존 보고서</option>
          </select>
          <input
            placeholder="국가, 무기체계, 키워드로 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Radar 검색어"
          />
          <button type="submit" aria-label="자료 검색" disabled={searching}>
            {searching ? (
              <RotateCw size={17} className="spinning" />
            ) : (
              <Search size={17} />
            )}
          </button>
        </form>
        {results && (
          <div className="radar-results">
            {results.length ? (
              results.map((r) => {
                let data: any;
                try {
                  data = JSON.parse(r.data);
                } catch {
                  data = r;
                }
                return (
                  <details key={r.id}>
                    <summary>
                      <FileText size={14} />
                      {data.title ||
                        data.name ||
                        data.countryName ||
                        data.country ||
                        r.id}
                      <ChevronDown size={12} />
                    </summary>
                    <pre>{JSON.stringify(data, null, 2)}</pre>
                  </details>
                );
              })
            ) : (
              <p className="muted">검색 결과가 없습니다.</p>
            )}
          </div>
        )}
      </div>
      <div className="source-block">
        <div className="section-title">
          <div>
            <h2>
              <FolderOpen size={17} />
              기존 대화 연결
            </h2>
            <p>
              {report.radarConversationId
                ? "전체 대화 원문과 자료 목록이 연결되었습니다."
                : "Radar에서 진행한 대화와 첨부자료를 이어받습니다."}
            </p>
          </div>
          <button
            className="button button-small"
            onClick={async () => {
              try {
                setConversations(await api("/radar/conversations"));
              } catch (e: any) {
                tell(e.message);
              }
            }}
          >
            {report.radarConversationId ? "연결 변경" : "대화 선택"}
            <ChevronRight size={13} />
          </button>
        </div>
        {conversations && (
          <div className="conversation-options">
            {conversations.length ? (
              conversations.map((c) => (
                <button
                  disabled={linking}
                  key={c.id}
                  onClick={async () => {
                    setLinking(true);
                    try {
                      const result = await post(`/reports/${report.id}/radar`, {
                        conversationId: c.id,
                      });
                      apply(result);
                      setConversations(null);
                      tell("기존 대화를 연결했습니다.");
                    } catch (e: any) {
                      tell(e.message);
                    } finally {
                      setLinking(false);
                    }
                  }}
                >
                  <span>{c.title}</span>
                  {c.id === report.radarConversationId ? (
                    <Check size={13} />
                  ) : (
                    <Plus size={13} />
                  )}
                </button>
              ))
            ) : (
              <p className="muted">연결할 대화가 없습니다.</p>
            )}
          </div>
        )}
        {report.radarConversationId && (
          <div className="connected-context">
            <CheckCircle2 size={14} />
            <span>
              원문 보존 · 모델이 필요한 대화와 자료를 조회할 수 있습니다.
            </span>
          </div>
        )}
        {remoteFiles.length > 0 && (
          <div className="remote-files">
            {remoteFiles.map((f) => (
              <div key={f.id}>
                <FileText size={14} />
                <span>{f.name}</span>
                <button
                  className="text-button"
                  onClick={async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true;
                    try {
                      apply(
                        await post(`/reports/${report.id}/radar-files/${f.id}`),
                      );
                      tell("원본 파일을 이 워크스페이스로 가져왔습니다.");
                    } catch (e: any) {
                      tell(e.message);
                    } finally {
                      btn.disabled = false;
                    }
                  }}
                >
                  가져오기
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    box.current?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const focusables = box.current?.querySelectorAll<HTMLElement>(
          "button,input,textarea,select,[href]",
        );
        if (!focusables?.length) return;
        const first = focusables[0],
          last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={box}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            <X size={19} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
function ContextForm({
  report,
  onSave,
}: {
  report: Report;
  onSave: (v: { title: string; context: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState(report.title),
    [context, setContext] = useState(report.context),
    [saving, setSaving] = useState(false);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await onSave({ title, context });
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        보고서 제목
        <input
          value={title}
          required
          maxLength={160}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        과제 맥락
        <textarea
          rows={8}
          value={context}
          maxLength={40000}
          onChange={(e) => setContext(e.target.value)}
        />
      </label>
      <button className="button button-primary form-submit" disabled={saving}>
        저장하기
        <Check size={16} />
      </button>
    </form>
  );
}
function ConnectionPanel({
  connections,
  onRefresh,
}: {
  connections: ConnectionStatus | null;
  onRefresh: () => void;
}) {
  return (
    <div className="connections-panel">
      <div className="connection-card">
        <Terminal size={22} />
        <div>
          <h3>Codex CLI</h3>
          <p>
            {MODEL} · {EFFORT}
          </p>
          <span
            className={
              connections?.codex.authenticated &&
              connections.codex.modelAvailable
                ? "success-text"
                : "muted"
            }
          >
            {connections
              ? connections.codex.error || "로그인 및 모델 사용 가능 확인됨"
              : "연결 상태를 확인하는 중입니다…"}
          </span>
        </div>
      </div>
      <div className="connection-card">
        <Globe2 size={22} />
        <div>
          <h3>Procurement Radar</h3>
          <p>Supabase · 읽기 전용</p>
          <span
            className={connections?.radar.connected ? "success-text" : "muted"}
          >
            {connections?.radar.connected
              ? `조달 기록 ${connections.radar.counts?.records.toLocaleString()}개 · 출처 ${connections.radar.counts?.sources.toLocaleString()}개 · 대화 ${connections.radar.counts?.conversations.toLocaleString()}개`
              : connections?.radar.error || "연결 상태를 확인하는 중입니다…"}
          </span>
        </div>
      </div>
      <button className="button" onClick={onRefresh} disabled={!connections}>
        <RotateCw size={14} />
        연결 다시 확인
      </button>
      <div className="usage-guide">
        <h3>이렇게 작성하세요</h3>
        <ol>
          <li>채팅으로 궁금한 점이나 작성할 내용을 알려주세요.</li>
          <li>보고서 작성이 필요하면 대화에서 바로 요청하세요.</li>
          <li>초안을 작성한 뒤 직접 편집하거나 채팅으로 수정합니다.</li>
          <li>작성한 내용을 확인하고 다음 문서로 이어갑니다.</li>
          <li>완성한 보고서를 HTML, PDF, Word로 내려받습니다.</li>
        </ol>
        <p>
          Codex 로그인은 서버 터미널에서 <code>codex login</code>으로
          설정합니다. 기존 프로젝트와 전역 Codex 설정은 변경하지 않습니다.
        </p>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
