/** 최소 XLSX 읽기(공유 문자열, 숫자 셀만). 의존성은 이미 쓰는 fflate뿐이다. */
import { unzipSync, strFromU8 } from 'fflate';

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export function readXlsx(bytes: Uint8Array): Record<string, (string | number | null)[][]> {
  const files = unzipSync(bytes, { filter: f => f.name.startsWith('xl/') });
  const read = (p: string) => files[p] ? strFromU8(files[p]) : '';
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const rels = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(m => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const out: Record<string, (string | number | null)[][]> = {};
  for (const m of read('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/name="([^"]*)"/.exec(m[0])?.[1] || ''), rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const target = rels.get(rid); if (!target) continue;
    const xml = read(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    const rows: (string | number | null)[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: (string | number | null)[] = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(c[1])?.[1]; if (!ref) continue;
        const type = /t="(\w+)"/.exec(c[1])?.[1], v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1], inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] || '')?.[1];
        cells[colIndex(ref)] = type === 's' ? shared[Number(v)] ?? null : type === 'inlineStr' ? decodeXml(inline || '') : type === 'str' || type === 'b' ? (v == null ? null : decodeXml(v)) : v == null ? null : Number(v);
      }
      rows[Number(r[1]) - 1] = Array.from(cells, x => x ?? null);
    }
    out[name] = Array.from(rows, x => x ?? []);
  }
  return out;
}
