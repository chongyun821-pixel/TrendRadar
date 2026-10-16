import { describe, it, expect } from 'vitest';
import { md, esc } from '../src/md';

describe('채팅 Markdown', () => {
  it('표의 헤더·셀·정렬과 셀 안의 마크다운을 렌더링', () => {
    const html = md('| 장비 | 수량 |\n| :--- | ---: |\n| **K9** | 12 |');
    expect(html).toContain('class="md-table"');
    expect(html).toContain('<thead>'); expect(html).toContain('<tbody>');
    expect(html).toContain('<th style="text-align:right">수량</th>');
    expect(html).toContain('<strong>K9</strong>'); expect(html).toContain('<td style="text-align:right">12</td>');
  });
  it('언어가 지정된 코드 블록에서 들여쓰기·줄바꿈·기호를 그대로 표시', () => {
    const html = md('```ts\nif (a < b) {\n  console.log("**코드**");\n}\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('if (a &lt; b) {\n  console.log(&quot;**코드**&quot;);\n}\n</code></pre>');
    expect(html).not.toContain('<strong>');
  });
  it('숫자 목록·글머리 목록을 섞어 여러 단계로 중첩', () => {
    const html = md('3. 상위\n   - 하위\n     1. 세부\n\n4. 다음');
    expect(html).toMatch(/<ol start="3">[\s\S]*<li>\s*<p>상위<\/p>[\s\S]*<ul>[\s\S]*<li>하위[\s\S]*<ol>[\s\S]*<li>세부<\/li>/);
    expect(html.match(/<\/ol>/g)).toHaveLength(2);
    expect(html).toMatch(/<li>\s*<p>다음<\/p>\s*<\/li>/);
  });
  it('제목·인용·취소선·인라인 코드·일반 줄바꿈 지원', () => {
    const html = md('# 제목\n\n> 인용 **강조**\n\n~~취소~~ `코드`\n다음 줄');
    expect(html).toContain('<h1>제목</h1>'); expect(html).toContain('<blockquote>');
    expect(html).toContain('<s>취소</s>'); expect(html).toContain('<code>코드</code>'); expect(html).toContain('<br>');
  });
  it('원문 HTML과 스크립트를 실행 가능한 태그로 바꾸지 않음', () => {
    const html = md('<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n<svg onload="alert(1)"></svg>');
    expect(html).not.toMatch(/<(script|img|svg)\b/i);
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img');
  });
  it('위험한 링크는 링크로 만들지 않고 정상 링크는 별도 탭에서 열기', () => {
    expect(md('[실행](javascript:alert%281%29)')).not.toContain('href=');
    expect(md('[실행](jav&#x61;script:alert%281%29)')).not.toContain('href=');
    expect(md('[본문](https://example.org?q=1&x=2)')).toContain('href="https://example.org?q=1&amp;x=2" target="_blank" rel="noopener noreferrer"');
  });
  it('일반 UI 텍스트용 이스케이프는 유지', () => {
    expect(esc('<b>"&\'</b>')).toBe('&lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;');
  });
});
