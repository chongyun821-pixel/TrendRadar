import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false });
export interface Span { start: number; end: number }
interface Section extends Span { bodyStart: number; title: string; level: number }
export const PROBLEM_FIELDS = [
  { id: 'question', label: '해결해야 할 기본 질문', hint: '이번 과제에서 답해야 할 핵심 질문을 적어주세요.', aliases: ['해결해야할기본질문', '해결해야할핵심질문', '핵심질문', '기본질문'] },
  { id: 'background', label: '문제의 배경', hint: '현재 상황(Situation)과 해결이 필요한 문제점(Complication)을 정리하세요.', aliases: ['문제의배경', '문제배경'] },
  { id: 'success', label: '성공 측정 기준', hint: '목표와 측정 지표, 기준시점을 적어주세요.', aliases: ['성공측정기준', '성공기준', '성공판단기준'] },
  { id: 'decision', label: '의사결정자', hint: '의사결정에 참여하는 사람과 역할을 적어주세요.', aliases: ['의사결정자'] },
  { id: 'stakeholders', label: '주요 이해관계자', hint: '해결 방안의 영향을 받거나 참여하는 대상을 적어주세요.', aliases: ['주요이해관계자', '이해관계자'] },
  { id: 'constraints', label: '해결 방안에 대한 제약사항', hint: '반드시 지켜야 할 조건과 제약을 적어주세요.', aliases: ['해결방안에대한제약사항', '해결방안의제약사항', '해결방안의제약조건', '제약사항'] },
  { id: 'scope', label: '해결 방안의 범위', hint: '대상과 포함·제외 범위를 적어주세요.', aliases: ['해결방안의범위', '해결방안에대한범위', '검토범위', '범위'] },
] as const;
const normalize = (text: string) => text.replace(/[\s*_`]/g, '').toLowerCase();
function lineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
export function sections(text: string): Section[] {
  const starts = lineStarts(text), tokens = md.parse(text, {});
  const result: Section[] = [];
  tokens.forEach((token, i) => {
    if (token.type !== 'heading_open' || token.level !== 0 || !token.map) return;
    result.push({ start: starts[token.map[0]], bodyStart: starts[token.map[1]] ?? text.length, end: text.length, title: tokens[i + 1].content, level: Number(token.tag.slice(1)) });
  });
  result.forEach((section, i) => { section.end = result.slice(i + 1).find(next => next.level <= section.level)?.start ?? text.length; });
  return result;
}
function findSection(text: string, aliases: readonly string[]) { return sections(text).find(s => aliases.includes(normalize(s.title))); }
export function replaceSpan(text: string, span: Span, replacement: string) { return text.slice(0, span.start) + replacement + text.slice(span.end); }
export function extraParts(text: string, consumed: Span[]): (Span & { content: string })[] {
  const ranges = consumed.slice().sort((a, b) => a.start - b.start), result: (Span & { content: string })[] = [];
  let cursor = 0;
  const push = (start: number, end: number) => {
    const raw = text.slice(start, end), left = raw.length - raw.trimStart().length, right = raw.trimEnd().length;
    if (right > left) result.push({ start: start + left, end: start + right, content: raw.slice(left, right) });
  };
  for (const range of ranges) { if (range.start > cursor) push(cursor, range.start); cursor = Math.max(cursor, range.end); }
  push(cursor, text.length); return result;
}
export function problemLayout(text: string) {
  const fields = PROBLEM_FIELDS.map(def => {
    const section = findSection(text, def.aliases);
    return { ...def, content: section ? text.slice(section.bodyStart, section.end).trim() : '', section };
  });
  return { fields, extra: extraParts(text, fields.flatMap(field => field.section ? [field.section] : [])) };
}
export function setProblemField(text: string, id: string, value: string) {
  const field = PROBLEM_FIELDS.find(field => field.id === id);
  if (!field) throw new Error('문제정의서 항목을 찾을 수 없습니다.');
  const section = findSection(text, field.aliases);
  if (section) return replaceSpan(text, { start: section.bodyStart, end: section.end }, value.trim() + '\n\n');
  return text.trimEnd() + (text.trim() ? '\n\n' : '') + `## ${field.label}\n\n${value.trim()}\n`;
}
export interface IssueNode { text: string; children: IssueNode[] }
export type NodePath = number[];
export function nodeAt(nodes: IssueNode[], path: NodePath): IssueNode | undefined {
  let node: IssueNode | undefined;
  for (const index of path) { node = nodes[index]; if (!node) return; nodes = node.children; }
  return node;
}
export function changeNodes(nodes: IssueNode[], path: NodePath, change: (node: IssueNode) => IssueNode | null): IssueNode[] {
  const [index, ...rest] = path;
  return nodes.flatMap((node, i) => {
    if (i !== index) return [node];
    const next = rest.length ? { ...node, children: changeNodes(node.children, rest, change) } : change(node);
    return next ? [next] : [];
  });
}
export function countNodes(nodes: IssueNode[]): number { return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0); }
export function treeDepth(nodes: IssueNode[]): number { return nodes.length ? 1 + Math.max(...nodes.map(node => treeDepth(node.children))) : 0; }
const questionAliases = ['핵심질문', '기본질문', '해결해야할기본질문'];
const treeAliases = ['이슈트리', 'issuetree'];
export function issueLayout(text: string) {
  const questionSection = findSection(text, questionAliases), treeSection = findSection(text, treeAliases);
  const questionBody = questionSection ? text.slice(questionSection.bodyStart, questionSection.end) : '';
  const paragraph = md.parse(questionBody, {}).find(token => token.type === 'paragraph_open' && token.map);
  const qStarts = lineStarts(questionBody);
  const questionSpan = questionSection && paragraph?.map ? { start: questionSection.bodyStart + qStarts[paragraph.map[0]], end: questionSection.bodyStart + (qStarts[paragraph.map[1]] ?? questionBody.length) } : undefined;
  const question = questionSpan ? text.slice(questionSpan.start, questionSpan.end).trim() : '';
  const bodyStart = treeSection?.bodyStart ?? 0, body = treeSection ? text.slice(bodyStart, treeSection.end) : /^\s*[-+*]\s/.test(text) ? text : '';
  const tokens = md.parse(body, {}), starts = lineStarts(body);
  const first = tokens.findIndex(token => ['bullet_list_open', 'ordered_list_open'].includes(token.type) && token.level === 0);
  const roots: IssueNode[] = [], lists: IssueNode[][] = [], parents: IssueNode[] = [];
  const ordinals: (number | null)[] = [], markers = new WeakMap<IssueNode, string>();
  let editable = true;
  const listToken = tokens[first];
  if (first >= 0) {
    for (let i = first; i < tokens.length; i++) {
      const token = tokens[i];
      if (['bullet_list_open', 'ordered_list_open'].includes(token.type)) {
        lists.push(parents.at(-1)?.children ?? roots);
        ordinals.push(token.type === 'ordered_list_open' ? Number(token.attrGet('start') || 1) : null);
        if (token.type === 'ordered_list_open') editable = false;
      }
      else if (token.type === 'list_item_open') {
        const node = { text: '', children: [] }; lists.at(-1)!.push(node); parents.push(node);
        const ordinal = ordinals.at(-1);
        if (ordinal != null) { markers.set(node, `${ordinal}. `); ordinals[ordinals.length - 1] = ordinal + 1; }
      }
      else if (token.type === 'inline') { const node = parents.at(-1)!; node.text += (node.text ? '\n\n' : '') + token.content; }
      else if (token.type === 'list_item_close') { const node = parents.pop()!; if (markers.has(node)) node.text = markers.get(node)! + node.text; }
      else if (['bullet_list_close', 'ordered_list_close'].includes(token.type)) { lists.pop(); ordinals.pop(); if (!lists.length) break; }
      else if (!['paragraph_open', 'paragraph_close'].includes(token.type)) editable = false;
    }
  }
  const listSpan = listToken?.map ? { start: bodyStart + starts[listToken.map[0]], end: bodyStart + (starts[listToken.map[1]] ?? body.length) } : undefined;
  const consumed: Span[] = [
    ...(questionSection && questionSpan ? [{ start: questionSection.start, end: questionSpan.end }] : []),
    ...(treeSection ? [{ start: treeSection.start, end: treeSection.bodyStart }] : []),
    ...(listSpan ? [listSpan] : []),
  ];
  return { question, questionSpan, questionSection, treeSection, nodes: roots, listSpan, editable, extra: extraParts(text, consumed) };
}
export function setIssueQuestion(text: string, value: string) {
  const layout = issueLayout(text);
  if (layout.questionSpan) return replaceSpan(text, layout.questionSpan, value.trim() + '\n');
  if (layout.questionSection) return replaceSpan(text, { start: layout.questionSection.bodyStart, end: layout.questionSection.bodyStart }, value.trim() + '\n\n');
  return `## 핵심 질문\n\n${value.trim()}\n\n${text}`;
}
function writeNodes(nodes: IssueNode[], depth = 0): string {
  return nodes.map(node => {
    const [first, ...rest] = node.text.split('\n'), indent = '  '.repeat(depth);
    return `${indent}- ${first || '새 이슈'}${rest.map(line => '\n' + (line ? indent + '  ' + line : '')).join('')}` + (node.children.length ? '\n' + writeNodes(node.children, depth + 1) : '');
  }).join('\n');
}
export function setIssueNodes(text: string, nodes: IssueNode[], fallbackQuestion = '') {
  const layout = issueLayout(text);
  if (!layout.editable) throw new Error('목록에 복합 서식이 있습니다. 텍스트 구조 편집에서 수정해주세요.');
  const list = nodes.length ? writeNodes(nodes) + '\n' : '';
  let next = layout.listSpan ? replaceSpan(text, layout.listSpan, list) : layout.treeSection ? replaceSpan(text, { start: layout.treeSection.bodyStart, end: layout.treeSection.bodyStart }, list + '\n') : text.trimEnd() + (text.trim() ? '\n\n' : '') + '## 이슈트리\n\n' + list;
  if (!layout.questionSection && fallbackQuestion) next = setIssueQuestion(next, fallbackQuestion);
  return next;
}
