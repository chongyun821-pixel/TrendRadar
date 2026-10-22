import { CodexBridge } from '../server/codex';
import { RadarReader } from '../server/radar';
import { MODEL, EFFORT } from '../shared/types';
const bridge = new CodexBridge(), radar = new RadarReader();
try {
  const [codex, db] = await Promise.all([bridge.status(), radar.status()]);
  console.log(JSON.stringify({ model: MODEL, effort: EFFORT, codex, radar: db }, null, 2));
  process.exitCode = codex.authenticated && codex.modelAvailable && db.connected ? 0 : 1;
} finally { bridge.stop(); await radar.close(); }
