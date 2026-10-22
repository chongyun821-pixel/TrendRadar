import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { openBrowser } from '../server/export';

// Isolated component fixture: no application origin, API, browser profile, or network access.
const root = resolve('.local/verification', `h5s-ui-${Date.now()}`); mkdirSync(root, { recursive: true });
const report = JSON.parse(readFileSync(resolve('.local/workspaces/507f9a4a-afd8-4e86-8d86-a63fe7ff34c5/report.json'), 'utf8'));
const initial = { problem: report.pages[0].content, tree: report.pages[1].content };
const bundle = await build({ stdin: { contents: `
import React, {useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {ProblemDefinitionEditor,IssueTreeEditor} from './src/H5SEditors';
const initial=${JSON.stringify(initial)};
function Preview(){
 const [view,setView]=useState('problem'),[docs,setDocs]=useState(initial);
 useEffect(()=>{window.qaSetDocument=(key,content)=>setDocs(old=>({...old,[key]:content}));},[]);
 return <main className="qa-shell"><header><div><small>H5S · 문제 구조화</small><h1>{view==='problem'?'문제정의서':'이슈트리'}</h1><p>월드은행 적자 축소 · 교재 사례</p></div><nav><button onClick={()=>setView('problem')}>문제정의서</button><button onClick={()=>setView('tree')}>이슈트리</button></nav></header><div className="qa-document">{view==='problem'?<ProblemDefinitionEditor content={docs.problem} readOnly={false} onChange={value=>setDocs(old=>({...old,problem:value}))} onSave={()=>{}}/>:<IssueTreeEditor content={docs.tree} readOnly={false} onChange={value=>setDocs(old=>({...old,tree:value}))} onSave={()=>{}}/>}</div><pre data-testid="document-state" hidden>{JSON.stringify(docs)}</pre></main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const styles = readFileSync(resolve('src/styles.css'), 'utf8') + '\n' + readFileSync(resolve('src/h5s-editors.css'), 'utf8');
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${styles}
body{background:#0b111b;margin:0;overflow:auto;color:#c7d1df}.qa-shell{max-width:1120px;margin:auto;padding:32px}.qa-shell>header{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:26px}.qa-shell h1{font-size:26px;letter-spacing:-.8px;color:#edf0f6;margin:7px 0}.qa-shell>header small{font-size:10px;color:#c69c79}.qa-shell>header p{font-size:11px;color:#8296b3}.qa-shell nav{display:flex;gap:12px;flex-shrink:0}.qa-shell nav button{border:1px solid #3c4e69;background:#162237;border-radius:6px;color:#b6cbea;font-size:11px;padding:9px 14px}.qa-document{min-width:0}@media(max-width:600px){.qa-shell{padding:20px 14px}.qa-shell>header{align-items:flex-start;flex-direction:column}.qa-shell h1{font-size:23px}}
</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
writeFileSync(join(root, 'preview.html'), html);
const browser = await openBrowser(), checks: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1240, height: 1000 } });
  await page.route('**/*', route => route.abort());
  await page.setContent(html, { waitUntil: 'load' });
  await page.getByRole('table', { name: '문제정의서', exact: true }).waitFor();
  assert.equal(await page.getByRole('rowheader').count(), 7);
  await page.screenshot({ path: join(root, 'problem-desktop.png'), fullPage: true });
  const goal = page.getByRole('textbox', { name: '성공 측정 기준', exact: true });
  await goal.fill('목표 확인 필요'); await goal.press('End'); await goal.press('Enter'); await goal.pressSequentially('시점도 확인');
  assert((await goal.innerText()).includes('시점도 확인'));
  const state = () => page.getByTestId('document-state').textContent().then(value => JSON.parse(value!));
  assert((await state()).problem.includes('시점도 확인')); assert((await state()).problem.includes('주요 이해관계자'));
  checks.push('seven-row form edits and multi-line input preserve other fields');
  await page.evaluate(content => (window as any).qaSetDocument('problem', content), initial.problem.replace('수지균형', '검증된 외부 갱신'));
  await page.getByRole('textbox', { name: '성공 측정 기준', exact: true }).getByText(/검증된 외부 갱신/).waitFor();
  checks.push('external draft updates reach form cells');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: join(root, 'problem-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1240, height: 1000 });
  await page.getByRole('button', { name: '이슈트리', exact: true }).click();
  await page.getByRole('tree').waitFor();
  await page.screenshot({ path: join(root, 'tree-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '트리 확대', exact: true }).click();
  assert.equal(await page.getByLabel('트리 확대 비율', { exact: true }).textContent(), '110%');
  await page.getByRole('button', { name: '전체 보기', exact: true }).click();
  assert(await page.locator('.h5s-tree-scale-content').evaluate(el => el.getBoundingClientRect().width <= el.closest('.h5s-tree-scroll')!.clientWidth + 2));
  await page.screenshot({ path: join(root, 'tree-overview.png'), fullPage: true });
  checks.push('zoom and fit-to-canvas show all branches without changing document content');
  await page.getByRole('button', { name: '트리 확대', exact: true }).click();
  const originalCount = await page.locator('.h5s-tree-node').count();
  await page.getByRole('button', { name: /^이슈 1:/ }).click();
  await page.getByRole('textbox', { name: '선택한 이슈 내용', exact: true }).fill('수익 개선 검증');
  await page.getByRole('button', { name: '하위 이슈 추가', exact: true }).click();
  assert.equal(await page.locator('.h5s-tree-node').count(), originalCount + 1);
  await page.getByRole('button', { name: '가지 삭제', exact: true }).click();
  await page.getByRole('alert').getByRole('button', { name: '삭제', exact: true }).click();
  assert.equal(await page.locator('.h5s-tree-node').count(), originalCount);
  await page.getByRole('button', { name: '되돌리기', exact: true }).click();
  assert.equal(await page.locator('.h5s-tree-node').count(), originalCount + 1);
  const edited = (await state()).tree;
  assert(edited.includes('수익 개선 검증')); assert(edited.includes('출처:')); assert(edited.includes('MECE'));
  checks.push('tree node editing, child addition, confirmed removal and undo preserve notes');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  assert(await page.locator('.h5s-tree-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
  await page.screenshot({ path: join(root, 'tree-mobile.png'), fullPage: true });
  checks.push('mobile form fits the viewport and tree scrolls inside its own canvas');
  const receipt = { ok: true, checks, root, at: new Date().toISOString() };
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
