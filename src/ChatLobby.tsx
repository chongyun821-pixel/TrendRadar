import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Plus,
  Paperclip,
  Square,
  MessageSquare,
  FileText,
  PanelLeftOpen,
  PanelLeftClose,
  Trash2,
  BookOpen,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import type { Report, Run } from "../shared/types";
export interface ConversationListItem {
  id: string;
  title: string;
  mode: "chat" | "report";
  updatedAt: string;
  confirmed: number;
}
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
interface Props {
  report?: Report;
  run: Run | null;
  streaming: string;
  busy: boolean;
  loading: boolean;
  conversations: ConversationListItem[];
  connectionLost: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onNew: () => void;
  onOpen: (id: string) => void;
  onSources: () => void;
  onDelete: (conversation: ConversationListItem) => void;
  onExample: () => Promise<void>;
}
export function ChatLobby({
  report,
  run,
  streaming,
  busy,
  loading,
  conversations,
  connectionLost,
  onSend,
  onStop,
  onNew,
  onOpen,
  onSources,
  onDelete,
  onExample,
}: Props) {
  const [text, setText] = useState(""),
    [navOpen, setNavOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false),
    priorId = useRef(report?.id);
  const messages = report?.messages || [];
  useEffect(() => {
    if (priorId.current && priorId.current !== report?.id)
      setText(localStorage.getItem(`h5s-message-${report?.id || "new"}`) || "");
    priorId.current = report?.id;
  }, [report?.id]);
  useEffect(() => {
    localStorage.setItem(`h5s-message-${report?.id || "new"}`, text);
  }, [text, report?.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages.length, streaming]);
  const send = async (value = text) => {
    if (!value.trim() || busy || loading || sending.current) return;
    sending.current = true;
    setText("");
    try {
      if (!(await onSend(value))) setText(value);
    } finally {
      sending.current = false;
      composer.current?.focus();
    }
  };
  return (
    <div className={`chat-home ${navOpen ? "nav-open" : ""}`}>
      <aside className="conversation-sidebar">
        <button
          className="conversation-new"
          onClick={() => {
            onNew();
            setNavOpen(false);
          }}
        >
          <Plus size={17} />새 대화
        </button>
        <div className="conversation-list-label">대화</div>
        <nav aria-label="대화 목록">
          {conversations.map((c) => (
            <div className={`conversation-row ${report?.id === c.id ? "selected" : ""}`}
              key={c.id}
            >
            <button
              className="conversation-link"
              onClick={() => {
                onOpen(c.id);
                setNavOpen(false);
              }}
            >
              {c.mode === "report" ? (
                <FileText size={15} />
              ) : (
                <MessageSquare size={15} />
              )}
              <span>{c.title}</span>
            </button>
            <button className="conversation-delete" type="button" aria-label={`${c.title} 대화 삭제`} title="대화 삭제" onClick={() => onDelete(c)}><Trash2 size={14} /></button>
            </div>
          ))}
        </nav>
      </aside>
      {navOpen && (
        <button
          className="conversation-nav-scrim"
          aria-label="대화 목록 닫기"
          onClick={() => setNavOpen(false)}
        />
      )}
      <main
        className={`conversation-main ${messages.length ? "has-messages" : "is-empty"}`}
      >
        <header className="conversation-header">
          <button
            className="icon-button mobile-chat-nav"
            onClick={() => setNavOpen(!navOpen)}
            aria-label="대화 목록"
          >
            {navOpen ? (
              <PanelLeftClose size={18} />
            ) : (
              <PanelLeftOpen size={18} />
            )}
          </button>
          <span>{report?.title === "새 대화" ? "" : report?.title}</span>
          {report?.attachments.length ? (
            <button className="text-button" onClick={onSources}>
              <Paperclip size={13} />
              {report.attachments.length}
            </button>
          ) : null}
        </header>
        {connectionLost && (
          <div className="connection-warning">
            연결을 확인하고 있습니다. 작성 중인 메시지는 유지됩니다.
          </div>
        )}
        <div className="conversation-scroll">
          {messages.length ? (
            <div className="conversation-thread">
              {messages.map((m) =>
                m.role === "system" ? (
                  <div className="conversation-notice" key={m.id}>
                    {m.text}
                  </div>
                ) : (
                  <article
                    className={`conversation-message ${m.role}`}
                    key={m.id}
                  >
                    <div className="conversation-author">
                      {m.role === "user" ? "나" : "H5S"}
                    </div>
                    <div
                      className="markdown"
                      dangerouslySetInnerHTML={{
                        __html: markdown.render(m.text),
                      }}
                    />
                  </article>
                ),
              )}
              {busy && (
                <article className="conversation-message assistant">
                  <div className="conversation-author">
                    H5S
                    <span className="thinking-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  {streaming ? (
                    <div
                      className="markdown"
                      dangerouslySetInnerHTML={{
                        __html: markdown.render(streaming),
                      }}
                    />
                  ) : (
                    <p className="conversation-thinking">
                      {run?.status === "stopping"
                        ? "답변을 중지하고 있습니다…"
                        : "답변을 준비하고 있습니다…"}
                    </p>
                  )}
                </article>
              )}
              {!busy && run?.status === "failed" && (
                <div className="chat-error">
                  {run.error ||
                    "답변을 준비하지 못했습니다. 다시 시도해주세요."}
                </div>
              )}
              <div ref={bottom} />
            </div>
          ) : (
            <div className="conversation-greeting">
              <div className="greeting-mark">
                H<span>5</span>S
              </div>
              <h1>무엇을 함께 정리할까요?</h1>
              <p>궁금한 점이나 검토할 자료를 보내주세요.</p>
            </div>
          )}
        </div>
        <div className="conversation-composer-wrap">
          <form
            className="conversation-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={composer}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="메시지를 입력하세요"
              aria-label="메시지"
              rows={3}
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
            <div className="conversation-composer-actions">
              <button
                type="button"
                className="icon-button"
                onClick={onSources}
                aria-label="자료 첨부 및 연결"
              >
                <Plus size={21} />
              </button>
              {report?.attachments.slice(0, 2).map((a) => (
                <button
                  type="button"
                  className="attachment-chip"
                  key={a.id}
                  onClick={onSources}
                >
                  <Paperclip size={11} />
                  <span>{a.name}</span>
                </button>
              ))}
              <div className="composer-spacer" />
              {busy ? (
                <button
                  type="button"
                  className="send-button stop-button"
                  onClick={() => void onStop()}
                  aria-label="답변 중지"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  disabled={!text.trim() || loading}
                  aria-label="메시지 보내기"
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </form>
          {!messages.length && (
            <div className="conversation-prompts">
              <button
                disabled={loading}
                onClick={() =>
                  void send(
                    "해결하려는 문제를 같이 정리하고 싶어. 무엇부터 이야기하면 될까?",
                  )
                }
              >
                문제 함께 정리하기
              </button>
              <button disabled={loading} onClick={onSources}>
                자료 검토하기
              </button>
              <button disabled={loading || busy} onClick={() => void onExample()} title="첨부 H5S 교재의 가상 은행 사례">
                <BookOpen size={13} />월드은행 사례로 시작
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
