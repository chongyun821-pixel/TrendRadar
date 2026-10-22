// 테스트용 가짜 그록 빌드·코덱스 CLI. 받은 인자를 답으로 돌려주고, 마지막 사용자 메시지에 「멈춤」이 있으면
// (마지막 사용자 줄 기준) SIGTERM을 무시하는 손자 프로세스를 띄운 채 끝나지 않는다(프로세스 트리 중지 검증용).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const codex = args[0] === 'exec';
if (args[0] === 'sessions') process.exit(0);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const promptFile = args[args.indexOf('--prompt-file') + 1];
  const prompt = codex ? Buffer.concat(chunks).toString('utf8') : readFileSync(promptFile, 'utf8');
  const reply = `ARGS ${JSON.stringify(args.filter(a => !a.includes('\n')).slice(0, 40))}`;
  if (prompt.slice(prompt.lastIndexOf('사용자: ')).includes('멈춤')) {
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
    writeFileSync('fake-cli.pids', JSON.stringify([process.pid, child.pid]));
    process.stdout.write(JSON.stringify(codex ? { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'search_sources' } } : { type: 'tool_call', rawInput: { name: 'procurement__search_sources' } }) + '\n');
    setInterval(() => {}, 1000);
    return;
  }
  const line = codex ? { type: 'item.completed', item: { type: 'agent_message', text: reply } } : { type: 'text', data: reply };
  process.stdout.write(JSON.stringify(line) + '\n');
});
