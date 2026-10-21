/** 정규식 기반 HTML 조각 처리(수집 대상 페이지 구조가 단순한 표·목록이라 파서 의존성을 늘리지 않는다). */
export const decodeEntities = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
export const stripTags = (s: string) => decodeEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
export interface HtmlTable { caption: string; id: string; rows: { cells: string[]; html: string[] }[] }
export function htmlTables(html: string): HtmlTable[] {
  return [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].map(m => ({
    id: /id="([^"]*)"/.exec(m[1])?.[1] || '',
    caption: stripTags(/<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(m[2])?.[1] || ''),
    rows: [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => { const cells = [...r[1].matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map(c => c[2]); return { cells: cells.map(stripTags), html: cells }; }),
  }));
}
