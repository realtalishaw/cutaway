// AI tools through MCP: Cutaway runs, the cutaway-mcp server is started the way Claude Code or Codex start it
// (Cutaway's own runtime, stdio), and a video is made with tool calls only: a project, footage, transcript,
// cuts and a zoom, text, a template animation (and a broken hand-written one that is sent back), captions, a
// look at a frame, versions and undo, an export, and the switch in Settings that turns it all off.
// Every change is checked in the app's own state too, as the creator would see it. No AI model is used.
//   node e2e/mcp.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-mcp'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const FF = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${String(d).slice(0, 300)}` : ''}`);
  if (!ok) failed++;
};

const { app, page, userData, exportDir } = await launch();
const state = (fn, a) => page.evaluate(fn, a);
const controlFile = path.join(userData, 'control.json');
for (let i = 0; i < 40 && !fs.existsSync(controlFile); i++) await new Promise((r) => setTimeout(r, 250));
check('Cutaway starts its local control server, with its key in a file only this user can read', fs.existsSync(controlFile) && (fs.statSync(controlFile).mode & 0o077) === 0, fs.existsSync(controlFile) ? (fs.statSync(controlFile).mode & 0o777).toString(8) : 'missing');
const ctl = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
// a request without the key is refused
const refused = await fetch(`http://127.0.0.1:${ctl.port}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"status"}' }).then((r) => r.status);
check('a request without the key is refused', refused === 401, refused);

// ── the MCP server, started like an AI tool starts it ──
const electron = createRequire(import.meta.url)('electron');
const mcp = spawn(electron, [path.join(root, 'dist/mcp/cutaway-mcp.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUTAWAY_CONTROL_FILE: controlFile }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
mcp.stdout.setEncoding('utf8').on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  }
});
let seq = 0;
const rpc = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
/** Call a tool; returns its parsed JSON (or the raw content for pictures) and whether it was an error. */
const tool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) return { error: r.error.message };
  const c = r.result.content;
  const text = c.find((x) => x.type === 'text')?.text ?? '';
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { isError: !!r.result.isError, data, content: c, text };
};

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  mcp.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  check('the MCP server introduces itself, with a guide to making a video', init.result?.serverInfo?.name === 'cutaway' && /typical video/.test(init.result.instructions), init.result?.protocolVersion);
  const list = await rpc('tools/list', {});
  check('it offers the tools', list.result.tools.length >= 25 && list.result.tools.every((t) => t.inputSchema?.type === 'object' && t.description), list.result.tools.length);

  let r = await tool('status');
  check('status: Cutaway is up with no project open', !r.isError && r.data.project === null, r.text);
  r = await tool('create_project', { name: 'MCP demo' });
  check('create_project makes and opens a project', !r.isError && /MCP demo/.test(r.data.name) && (await state(() => window.__cutaway.useApp.getState().project?.name)) === r.data.name, r.text);
  r = await tool('import_media', { paths: [fx('screen.mp4'), fx('camera-a.mov')] });
  check('import_media adds the footage', !r.isError && r.data.added.length === 2, r.text.slice(0, 200));
  r = await tool('get_transcript');
  check('get_transcript before prepare says to prepare', r.isError && /prepare/.test(r.text));
  r = await tool('prepare');
  check('prepare transcribes on this Mac', !r.isError && /words/.test(r.data.transcript), r.text);
  r = await tool('get_transcript', { words: true });
  const lines = r.data.lines ?? [];
  check('get_transcript returns timed lines (recording seconds) and words', lines.length > 2 && typeof lines[0].start === 'number' && r.data.words.length > 10, `${lines.length} lines · “${lines[0]?.text}”`);
  const proj0 = (await tool('get_project')).data;

  // edits: cut the second line, zoom during the third, and one impossible op
  const L = lines[1];
  r = await tool('apply_edits', { label: 'tighten', ops: [{ op: 'cut', start: L.start, end: L.end, kind: 'pacing', reason: 'not needed', confidence: 'high' }, { op: 'zoom', start: lines[2].start, end: Math.max(lines[3].end, lines[2].start + 2.5), scale: 1.6, x: 0.5, y: 0.4, reason: 'focus' }, { op: 'teleport', start: 0, end: 1 }] });
  check('apply_edits applies valid decisions and explains refusals', !r.isError && r.data.applied === 2 && r.data.refused.length === 1 && r.data.videoSeconds < proj0.videoSeconds, r.text);
  const live = await state(() => { const e = window.__cutaway.useApp.getState().project.edit; return { cuts: e.cuts.length, zooms: e.zooms.length, ai: e.cuts.every((c) => c.meta.origin === 'ai') }; });
  check('the creator sees them in Cutaway, marked as made by AI', live.cuts >= 1 && live.zooms >= 1 && live.ai, JSON.stringify(live));

  r = await tool('add_text', { text: 'How to export', template: 'big-title', start: 0.5, end: 3 });
  check('add_text puts a title on screen', !r.isError && r.data.ids.length >= 1, r.text);
  r = await tool('list_animation_templates');
  check('list_animation_templates lists the templates with their fields', !r.isError && r.data.some((t) => t.id === 'subscribe' && t.fields.some((f) => f.id === 'label')), r.data.length);
  r = await tool('add_animation', { template: 'subscribe', fields: { label: 'Join' }, start: lines[3].start });
  check('add_animation adds a template with its words', !r.isError && r.data.added && (await state((id) => window.__cutaway.useApp.getState().project.edit.overlays.find((o) => o.id === id)?.motion?.fields.find((f) => f.id === 'label')?.value, r.data.id)) === 'Join', r.text);
  r = await tool('get_animation_guide');
  check('get_animation_guide gives the rules and examples', !r.isError && /ANIMATION CONTRACT/.test(r.data.contract) && /cutaway-motion/.test(r.data.example));
  r = await tool('add_animation', { html: '<!doctype html><html><head><script type="application/json" id="cutaway-motion">{"name":"Still","duration":2,"fields":[],"sounds":[]}</script></head><body><div style="position:absolute;left:10%;top:10%;width:100px;height:100px;background:red"></div></body></html>', start: 1 });
  check('a hand-written animation that fails Cutaway’s test is sent back with what to fix', !r.isError && r.data.added === false && r.data.problems.some((p) => /moves/i.test(p)), r.text);

  r = await tool('set_captions', { burn_in: true, style: 'bold' });
  check('set_captions turns on burned-in captions', !r.isError && r.data.captions.burnIn === true && r.data.captions.style === 'bold');
  r = await tool('set_look', { background: '#123456', padding: 0.06 });
  check('set_look changes the background and padding', !r.isError && r.data.background.color === '#123456');

  r = await tool('get_frame', { time: 1.2, width: 640 });
  const img = r.content?.find((c) => c.type === 'image');
  const png = img ? Buffer.from(img.data, 'base64') : null;
  if (png) fs.writeFileSync(path.join(out, 'frame.png'), png);
  check('get_frame returns a picture of the finished video', !r.isError && !!png && png.subarray(1, 4).toString() === 'PNG' && png.length > 5000, png?.length);

  r = await tool('list_versions');
  check('list_versions shows the changes, each named', !r.isError && r.data.some((v) => /AI tool: tighten/.test(v.label)), r.data.slice?.(0, 3).map((v) => v.label).join(' | '));
  const before = await state(() => window.__cutaway.useApp.getState().project.edit.appearance.background);
  r = await tool('undo');
  const after = await state(() => window.__cutaway.useApp.getState().project.edit.appearance.background);
  check('undo takes back the last change', !r.isError && before.color === '#123456' && after.color !== '#123456', `${before.color} → ${after.color}`);
  await tool('redo');

  r = await tool('export_video', { folder: exportDir });
  const file = r.data?.file;
  const dur = file && fs.existsSync(file) ? Number(execFileSync(FF, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString()) : 0;
  check('export_video renders the finished video and says where it is', !r.isError && dur > 1 && Math.abs(dur - r.data.seconds) < 0.5, r.isError ? r.text : `${file} · ${dur.toFixed(2)} s (expected ${r.data?.seconds})`);

  // the switch in Settings
  await state(() => window.cutaway.control.setEnabled(false));
  r = await tool('status');
  check('with “Let AI tools control Cutaway” off, tools are refused with how to turn it on', r.isError && /Settings/.test(r.text), r.text);
  await state(() => window.cutaway.control.setEnabled(true));
  r = await tool('status');
  check('and turning it back on works without restarting the AI tool', !r.isError && r.data.project?.name === 'MCP demo', r.text);
  await state(() => { const s = window.__cutaway.useApp.getState(); s.go('settings'); });
  await page.click('button:has-text("AI tools")').catch(() => {});
  await page.waitForSelector('[data-testid="aitools-claude"]', { timeout: 10000 }).catch(() => {});
  await page.screenshot({ path: path.join(out, 'settings.png') });
  check('Settings › AI tools shows Claude Code and Codex', (await page.locator('[data-testid="aitools-claude"]').count()) === 1 && (await page.locator('[data-testid="aitools-codex"]').count()) === 1);
} finally {
  mcp.kill();
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all mcp checks passed');
process.exit(failed ? 1 : 0);
