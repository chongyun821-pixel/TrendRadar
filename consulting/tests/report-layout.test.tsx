import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROBLEM_FIELDS, problemLayout, setProblemField, issueLayout, setIssueNodes, setIssueQuestion, changeNodes, countNodes, nodeAt } from '../shared/report-layout';
import { ProblemDefinitionEditor, IssueTreeEditor } from '../src/H5SEditors';

const problem = '교재의 가상 사례입니다.\n\n' + PROBLEM_FIELDS.map(field => `## ${field.id === 'constraints' ? '해결 방안의 제약사항' : field.label}\n\n${field.id === 'background' ? '### Situation\n기존 상황\n\n### Complication\n변화와 문제' : `${field.id} 내용`}`).join('\n\n') + '\n\n## 출처\n교재 사진 원본';
const issue = '교재의 가상 사례입니다.\n\n## 핵심 질문\n어떻게 수익성을 개선할까?\n\n**기준:** 검증 전 가설이다.\n\n## 이슈트리\n- **수익 개선**\n  - 순이자이익 개선\n    - NIM 하락의 원인은?\n  - 비이자수익 개선\n- 비용 절감\n  - 운영비 효율화\n\n## 분해 기준 및 검토\n- MECE: 중복과 누락 확인\n- Relevant: 상위 질문과 연결\n\n출처: 교재 사진';
describe('H5S document adapters', () => {
  it('keeps all seven fields including SCQ background, and changes only the chosen field', () => {
    const layout = problemLayout(problem);
    expect(layout.fields).toHaveLength(7); expect(layout.fields.every(field => field.content)).toBe(true);
    expect(layout.fields[1].content).toContain('### Complication');
    const changed = setProblemField(problem, 'success', '수지균형 달성');
    expect(problemLayout(changed).fields[2].content).toBe('수지균형 달성');
    expect(changed).toContain('교재의 가상 사례입니다.'); expect(changed).toContain('## 출처\n교재 사진 원본');
    expect(changed).toContain('### Situation\n기존 상황'); expect(problemLayout(changed).fields[5].content).toBe('constraints 내용');
  });
  it('preserves documents with missing headings and does not mistake code for a field', () => {
    const original = '기존에 작성한 본문\n\n```md\n## 의사결정자\n가짜 필드\n```';
    const changed = setProblemField(original, 'decision', '기획팀장');
    expect(changed).toContain(original); expect(problemLayout(changed).fields[3].content).toBe('기획팀장');
    const quoted = '## 문제의 배경\n배경\n\n> ## 의사결정자\n> 인용한 제목\n';
    expect(problemLayout(quoted).fields[3].content).toBe('');
  });
  it('parses deep issue branches without absorbing the review list into the diagram', () => {
    const layout = issueLayout(issue);
    expect(layout.question).toBe('어떻게 수익성을 개선할까?'); expect(layout.nodes).toHaveLength(2);
    expect(nodeAt(layout.nodes, [0, 0, 0])?.text).toBe('NIM 하락의 원인은?'); expect(countNodes(layout.nodes)).toBe(6);
    expect(layout.extra.map(p => p.content).join('\n')).toContain('MECE: 중복과 누락 확인');
    const changed = setIssueNodes(issue, changeNodes(layout.nodes, [0, 0, 0], node => ({ ...node, text: 'NIM과 규모의 영향은?' })));
    expect(issueLayout(changed).nodes[0].children[0].children[0].text).toBe('NIM과 규모의 영향은?');
    expect(changed).toContain('**기준:** 검증 전 가설이다.'); expect(changed).toContain('출처: 교재 사진');
    expect(changed).toContain('## 분해 기준 및 검토\n- MECE: 중복과 누락 확인');
  });
  it('adds and removes branches and edits the root without dropping notes or neighboring branches', () => {
    const layout = issueLayout(issue);
    let changed = setIssueQuestion(issue, '어떻게 적자를 줄일까?');
    changed = setIssueNodes(changed, changeNodes(layout.nodes, [0], () => null));
    const next = issueLayout(changed); expect(next.nodes).toHaveLength(1); expect(next.nodes[0].text).toBe('비용 절감');
    expect(next.question).toBe('어떻게 적자를 줄일까?'); expect(changed).toContain('**기준:** 검증 전 가설이다.');
    changed = setIssueNodes(changed, [...next.nodes, { text: '새 주요 이슈', children: [{ text: '세부 질문', children: [] }] }]);
    expect(issueLayout(changed).nodes[1].children[0].text).toBe('세부 질문');
  });
  it('keeps multi-paragraph node content and refuses to rewrite complex blocks lossily', () => {
    const original = '## 이슈트리\n- 주요 이슈\n\n  두 번째 문단\n  - 하위 이슈\n';
    const layout = issueLayout(original); expect(layout.nodes[0].text).toBe('주요 이슈\n\n두 번째 문단');
    expect(issueLayout(setIssueNodes(original, layout.nodes)).nodes[0].text).toBe(layout.nodes[0].text);
    const complex = '## 이슈트리\n- 이슈\n\n  > 인용 블록\n';
    expect(issueLayout(complex).editable).toBe(false); expect(() => setIssueNodes(complex, [])).toThrow(/복합 서식/);
    const ordered = '## 이슈트리\n10. 첫 이슈\n11. 다음 이슈\n';
    expect(issueLayout(ordered).nodes[0].text).toBe('10. 첫 이슈');
    expect(() => setIssueNodes(ordered, [])).toThrow(/복합 서식/);
  });
  it('starts an empty tree with the problem question and preserves unstructured prior text', () => {
    const changed = setIssueNodes('기존 메모', [{ text: '수익 개선', children: [] }], '어떻게 적자를 줄일까?');
    expect(changed).toContain('기존 메모'); expect(issueLayout(changed).question).toBe('어떻게 적자를 줄일까?');
    expect(issueLayout(changed).nodes[0].text).toBe('수익 개선');
  });
});
it('renders the photographed problem definition as seven editable table rows', () => {
  const html = renderToStaticMarkup(<ProblemDefinitionEditor content={problem} readOnly={false} onChange={() => {}} onSave={() => {}} />);
  expect((html.match(/role="rowheader"/g) || [])).toHaveLength(7);
  expect(html).toContain('해결 방안에 대한 제약사항'); expect(html).toContain('role="textbox"'); expect(html).toContain('Situation');
});
it('renders the issue tree as branch cards with a root question and preserves extra notes', () => {
  const html = renderToStaticMarkup(<IssueTreeEditor content={issue} readOnly={false} onChange={() => {}} onSave={() => {}} />);
  expect(html).toContain('role="tree"'); expect(html).toContain('NIM 하락의 원인은?'); expect(html).toContain('주요 이슈 추가'); expect(html).toContain('교재 사진');
  expect((html.match(/class="h5s-tree-node /g) || [])).toHaveLength(6);
  const viewing = renderToStaticMarkup(<IssueTreeEditor content={issue} readOnly onChange={() => {}} onSave={() => {}} />);
  expect(viewing).not.toContain('role="textbox"'); expect(viewing).not.toContain('주요 이슈 추가');
});
