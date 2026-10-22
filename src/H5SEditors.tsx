import { useEffect, useRef, useState } from 'react';
import { Plus, Minus, Maximize2, Trash2, Undo2, Network, ChevronDown, ArrowRight } from 'lucide-react';
import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';
// @ts-expect-error The GFM extension provides no declarations.
import { gfm } from 'turndown-plugin-gfm';
import { problemLayout, setProblemField, issueLayout, setIssueQuestion, setIssueNodes, nodeAt, changeNodes, countNodes, treeDepth, replaceSpan, type IssueNode, type NodePath } from '../shared/report-layout';

const md = new MarkdownIt({ html: false, breaks: true, linkify: true });
const nodeMd = new MarkdownIt({ html: false, breaks: true });
nodeMd.renderer.rules.link_open = () => '<span>';
nodeMd.renderer.rules.link_close = () => '</span>';
nodeMd.renderer.rules.image = (tokens, i) => nodeMd.utils.escapeHtml(tokens[i].content);
const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
turndown.use(gfm);
interface EditorProps { content: string; onChange: (content: string) => void; readOnly: boolean; onSave: () => void }

function MarkdownField({ value, label, placeholder, readOnly, onChange, onSave }: { value: string; label: string; placeholder?: string; readOnly: boolean; onChange: (value: string) => void; onSave: () => void }) {
  const ref = useRef<HTMLDivElement>(null), emitted = useRef<string | null>(null), initialHtml = useRef(md.render(value));
  useEffect(() => {
    if (ref.current && value !== emitted.current) ref.current.innerHTML = md.render(value);
  }, [value, readOnly]);
  const emit = () => {
    if (!ref.current) return;
    const value = turndown.turndown(ref.current.innerHTML);
    emitted.current = value; onChange(value);
  };
  return <div ref={ref} className={`h5s-field markdown ${readOnly ? 'is-readonly' : 'is-editable'}`} role={readOnly ? 'article' : 'textbox'} aria-label={label} aria-multiline={!readOnly} data-placeholder={readOnly ? '작성 전' : placeholder || '내용이 없습니다.'} contentEditable={!readOnly} suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: initialHtml.current }} onInput={emit} onBlur={onSave} onPaste={e => {
    if (readOnly) return;
    e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); emit();
  }} />;
}
function ExtraContent({ parts, ...props }: EditorProps & { parts: ReturnType<typeof problemLayout>['extra'] }) {
  if (!parts.length) return null;
  return <details className="h5s-extra"><summary><ChevronDown size={14} />추가 내용과 출처</summary><div>{parts.map((part, i) => <MarkdownField key={i} label={`추가 내용 ${i + 1}`} value={part.content} readOnly={props.readOnly} onSave={props.onSave} onChange={value => props.onChange(replaceSpan(props.content, part, value))} />)}</div></details>;
}
export function ProblemDefinitionEditor(props: EditorProps) {
  const layout = problemLayout(props.content);
  return <section className="h5s-definition" aria-label="H5S 문제정의서 양식">
    <div className="h5s-sheet-caption"><span>문제 정의</span><span>S–C–Q</span></div>
    <div className="h5s-definition-table" role="table" aria-label="문제정의서">
      {layout.fields.map((field, i) => <div className={`h5s-definition-row ${i === 0 ? 'is-question' : ''}`} role="row" key={field.id}>
        <div className="h5s-definition-label" role="rowheader"><span className="h5s-field-number">{String(i + 1).padStart(2, '0')}</span><strong>{field.label}</strong>{field.id === 'background' && <small>Situation · Complication</small>}</div>
        <div role="cell"><MarkdownField label={field.label} value={field.content} placeholder={field.hint} readOnly={props.readOnly} onSave={props.onSave} onChange={value => props.onChange(setProblemField(props.content, field.id, value))} /></div>
      </div>)}
    </div>
    <ExtraContent {...props} parts={layout.extra} />
  </section>;
}
function TreeBranches({ nodes, parentPath, selected, onSelect }: { nodes: IssueNode[]; parentPath: NodePath; selected: string; onSelect: (path: NodePath) => void }) {
  return <ul className="h5s-tree-branches" role="group">{nodes.map((node, i) => {
    const path = [...parentPath, i], key = path.join('.');
    return <li className="h5s-tree-branch" role="treeitem" aria-selected={selected === key} aria-expanded={node.children.length ? true : undefined} key={key}>
      <button type="button" className={`h5s-tree-node branch-${path[0] % 4} depth-${Math.min(path.length, 3)} ${selected === key ? 'is-selected' : ''}`} onClick={() => onSelect(path)} aria-label={`이슈 ${path.map(n => n + 1).join('.')}: ${node.text.replace(/[*_]/g, '')}`}>
        <span className="h5s-node-number">{path.map(n => n + 1).join('.')}</span><span className="markdown" dangerouslySetInnerHTML={{ __html: nodeMd.render(node.text) }} />
      </button>
      {node.children.length > 0 && <TreeBranches nodes={node.children} parentPath={path} selected={selected} onSelect={onSelect} />}
    </li>;
  })}</ul>;
}
export function IssueTreeEditor({ fallbackQuestion = '', ...props }: EditorProps & { fallbackQuestion?: string }) {
  const layout = issueLayout(props.content), [selected, setSelected] = useState<NodePath | null>(null), [removeConfirm, setRemoveConfirm] = useState(false);
  const history = useRef<string[]>([]), emitted = useRef(props.content), [undoCount, setUndoCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null), boardRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1), [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = boardRef.current;
    if (!element) return;
    const measure = () => setSize(old => old.width === element.offsetWidth && old.height === element.offsetHeight ? old : { width: element.offsetWidth, height: element.offsetHeight });
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const selectedNode = selected ? nodeAt(layout.nodes, selected) : undefined;
  useEffect(() => {
    if (emitted.current !== props.content) { history.current = []; setUndoCount(0); emitted.current = props.content; }
    if (selected && !nodeAt(layout.nodes, selected)) setSelected(null);
  }, [props.content]);
  const change = (next: string) => {
    if (next === props.content) return;
    history.current = [...history.current.slice(-29), props.content]; setUndoCount(history.current.length);
    emitted.current = next; props.onChange(next);
  };
  const select = (path: NodePath | null) => { setSelected(path); setRemoveConfirm(false); };
  const add = (parent: NodePath | null) => {
    const children = parent ? nodeAt(layout.nodes, parent)!.children : layout.nodes;
    const path = [...(parent || []), children.length], node = { text: '새 이슈', children: [] };
    const next = parent ? changeNodes(layout.nodes, parent, n => ({ ...n, children: [...n.children, node] })) : [...layout.nodes, node];
    change(setIssueNodes(props.content, next, layout.question || fallbackQuestion)); select(path);
  };
  const canEditTree = !props.readOnly && layout.editable;
  return <section className="h5s-issue-editor" aria-label="H5S 이슈트리 양식">
    <div className="h5s-tree-toolbar"><span><Network size={14} />질문을 나누어 구조화하세요</span><div>{!props.readOnly && <><button type="button" disabled={!undoCount} onClick={() => { const last = history.current.pop(); if (last === undefined) return; emitted.current = last; props.onChange(last); setUndoCount(history.current.length); select(null); }} title="변경 되돌리기"><Undo2 size={14} />되돌리기</button><button type="button" disabled={!canEditTree} onClick={() => add(null)}><Plus size={14} />주요 이슈 추가</button></>}</div></div>
    <div className="h5s-tree-view-controls"><span>가지를 선택하면 아래에서 내용을 확인할 수 있습니다.</span><div><button type="button" aria-label="트리 축소" disabled={zoom <= .2} onClick={() => setZoom(z => Math.max(.2, z - .1))}><Minus size={13} /></button><output aria-label="트리 확대 비율">{Math.round(zoom * 100)}%</output><button type="button" aria-label="트리 확대" disabled={zoom >= 1.5} onClick={() => setZoom(z => Math.min(1.5, z + .1))}><Plus size={13} /></button><button type="button" onClick={() => { if (!size.width) return; setZoom(Math.max(.1, Math.min(1, ((scrollRef.current?.clientWidth || size.width) - 2) / size.width, 600 / size.height))); scrollRef.current?.scrollTo(0, 0); }}><Maximize2 size={12} />전체 보기</button></div></div>
    <div className="h5s-tree-scroll" ref={scrollRef} tabIndex={0} aria-label="이슈트리 가로 도식">
      <div className="h5s-tree-scale-space" style={size.width ? { width: size.width * zoom, height: size.height * zoom } : undefined}><div className="h5s-tree-scale-content" ref={boardRef} style={{ transform: `scale(${zoom})`, position: size.width ? 'absolute' : 'relative' }}>
      <div className="h5s-tree-levels">{Array.from({ length: Math.max(3, treeDepth(layout.nodes) + 1) }, (_, i) => <span key={i}>{i ? `${i}단계` : '기본 질문'}</span>)}</div>
      <div className="h5s-tree-board" role="tree" aria-label="기본 질문과 세부 이슈">
        <div className="h5s-tree-root" role="treeitem" aria-expanded={layout.nodes.length ? true : undefined}>
          <span className="h5s-node-number">기본 질문</span><div className="markdown" dangerouslySetInnerHTML={{ __html: md.render(layout.question || fallbackQuestion || '해결해야 할 기본 질문을 입력하세요.') }} />
        </div>
        {layout.nodes.length ? <TreeBranches nodes={layout.nodes} parentPath={[]} selected={selected?.join('.') || ''} onSelect={path => select(path)} /> : <div className="h5s-tree-empty"><ArrowRight size={23} /><p>기본 질문을 해결할 주요 이슈를 추가하세요.</p>{canEditTree && <button className="button" onClick={() => add(null)}><Plus size={14} />주요 이슈 추가</button>}</div>}
      </div>
      </div></div>
    </div>
    {!layout.editable && <p className="h5s-format-note">복합 서식이 포함된 목록입니다. 내용을 보존한 상태로 표시합니다. 수정은 텍스트 구조 편집에서 할 수 있습니다.</p>}
    <div className="h5s-tree-inspector">
      <div className="h5s-inspector-heading"><strong>{selectedNode ? `이슈 ${selected!.map(n => n + 1).join('.')}` : '기본 질문'}</strong>{selectedNode && <button type="button" onClick={() => select(null)}>기본 질문 편집</button>}<span>{props.readOnly ? '보기' : '내용을 클릭해 수정'}</span></div>
      <MarkdownField key={selected?.join('.') || 'root'} label={selectedNode ? '선택한 이슈 내용' : '기본 질문 내용'} value={selectedNode ? selectedNode.text : layout.question || fallbackQuestion} placeholder="해결해야 할 질문을 입력하세요." readOnly={props.readOnly || (!!selectedNode && !layout.editable)} onSave={props.onSave} onChange={value => {
        if (selectedNode && selected) change(setIssueNodes(props.content, changeNodes(layout.nodes, selected, n => ({ ...n, text: value })), layout.question || fallbackQuestion));
        else change(setIssueQuestion(props.content, value));
      }} />
      {selectedNode && canEditTree && <div className="h5s-branch-actions"><button type="button" onClick={() => add(selected)}><Plus size={13} />하위 이슈 추가</button><button type="button" onClick={() => add(selected!.length > 1 ? selected!.slice(0, -1) : null)}><Plus size={13} />같은 단계 추가</button><button type="button" className="h5s-remove-branch" onClick={() => setRemoveConfirm(true)}><Trash2 size={13} />가지 삭제</button></div>}
      {removeConfirm && selectedNode && canEditTree && <div className="h5s-remove-confirm" role="alert"><span>이 이슈와 하위 이슈 {countNodes(selectedNode.children)}개를 삭제할까요?</span><button onClick={() => setRemoveConfirm(false)}>취소</button><button onClick={() => { change(setIssueNodes(props.content, changeNodes(layout.nodes, selected!, () => null), layout.question || fallbackQuestion)); select(null); }}>삭제</button></div>}
    </div>
    <div className="h5s-tree-principles"><span><b>MECE</b> 중복·누락 없이</span><span><b>Relevant</b> 상위 질문과 연결</span><span><b>Consistent</b> 같은 수준으로 분해</span></div>
    <ExtraContent {...props} onChange={change} parts={layout.extra} />
  </section>;
}
