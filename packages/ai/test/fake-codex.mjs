// A fake `codex` executable for tests (unit tests here, and the desktop app's
// e2e runs). It records how it was called and behaves like `codex exec --json`
// as observed on codex-cli 0.160.0: a thread.started event, agent messages, the
// reply written to --output-last-message, and pictures from the image tool
// saved under $CODEX_HOME/generated_images/<thread>/.
//
// Behaviour is steered by files beside the executable:
//   reply.json   text of the final agent message (default {"ok":true})
//   status.txt   what `login status` prints (default "Logged in using ChatGPT")
//   sleep.txt    seconds to wait before answering
//   fail.txt     if present: a turn.failed event with this message, exit 1
//   image.txt    "1": the image tool "makes" a picture (image.png beside it, or a 1×1 PNG)
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const D = __dirname;
const read = (f, d) => { try { return fs.readFileSync(path.join(D, f), 'utf8'); } catch { return d; } };
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  const s = read('status.txt', 'Logged in using ChatGPT').trim();
  console.log(s);
  process.exit(/not logged in/i.test(s) ? 1 : 0);
}
if (args[0] === 'login') { console.log('Opening browser to sign in…'); process.exit(0); }
if (args[0] !== 'exec') { console.error('unexpected command'); process.exit(2); }
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const n = Number(read('calls.txt', '0')) + 1;
  fs.writeFileSync(path.join(D, 'calls.txt'), String(n));
  fs.writeFileSync(path.join(D, 'args.json'), JSON.stringify(args));
  fs.writeFileSync(path.join(D, 'stdin.txt'), stdin);
  fs.writeFileSync(path.join(D, 'cwd.txt'), process.cwd());
  fs.writeFileSync(path.join(D, 'env.txt'), Object.keys(process.env).sort().join('\n'));
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const schemaFile = opt('--output-schema');
  if (schemaFile) fs.writeFileSync(path.join(D, 'schema.json'), fs.readFileSync(schemaFile, 'utf8'));
  const thread = 'fake-' + process.pid + '-' + n;
  const say = (o) => console.log(JSON.stringify(o));
  const finish = () => {
    say({ type: 'thread.started', thread_id: thread });
    say({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Under-development features enabled: something.' } });
    say({ type: 'turn.started' });
    const fail = read('fail.txt', '');
    if (fail) { say({ type: 'turn.failed', error: { message: fail.trim() } }); process.exit(1); }
    if (read('image.txt', '').trim() === '1') {
      const home = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
      const dir = path.join(home, 'generated_images', thread);
      fs.mkdirSync(dir, { recursive: true });
      let png;
      try { png = fs.readFileSync(path.join(D, 'image.png')); }
      catch { png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==', 'base64'); }
      fs.writeFileSync(path.join(dir, 'exec-' + n + '.png'), png);
      say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Making the picture.' } });
    }
    const reply = read('reply.json', '{"ok":true}');
    say({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: reply } });
    const out = opt('--output-last-message');
    if (out) fs.writeFileSync(out, reply);
    say({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 40 } });
    process.exit(0);
  };
  setTimeout(finish, Number(read('sleep.txt', '0')) * 1000);
});
`;

/** Write the fake into `dir` as an executable named `codex` and return its path. */
export function makeFakeCodex(dir) {
  const file = join(dir, 'codex');
  writeFileSync(file, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(file, 0o755);
  return file;
}
