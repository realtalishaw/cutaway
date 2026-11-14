// Animations, slice 3: ideas from what the creator says show in AI Review (name tag, counter, subscribe, arrow),
// one is added at the moment it is said, undone and redone, another dismissed; then Ask AI proposes animations
// (a stand-in AI): a template card goes in at once with its words, and a "write it" card opens the animation
// sheet with the request, which is written, checked and added. Nothing is sent to a real AI.
//   node e2e/motion-ideas.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const FF = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-motion-ideas'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const video = path.join(out, 'screen.mp4');
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1ec81e:s=1280x720:r=30:d=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failed++;
};
const { app, page } = await launch();
const state = (fn, a) => page.evaluate(fn, a);
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const motions = () => state(() => window.__cutaway.useApp.getState().project.edit.overlays.filter((o) => o.kind === 'motion').map((o) => ({ id: o.id, start: +o.start.toFixed(2), template: o.motion.origin.template ?? null, origin: o.motion.origin.kind, box: o.motion.box ?? null, fields: Object.fromEntries(o.motion.fields.map((f) => [f.id, f.value])) })));
const ideas = () => state(() => window.__cutaway.useApp.getState().project.edit.suggestions.filter((s) => s.kind === 'animation').map((s) => ({ id: s.id, template: s.motion.template, start: +s.start.toFixed(2), status: s.status, title: s.title, fields: s.motion.fields })));

// what the creator says, one word every 0.4 s from each start time
const LINES = [
  [2, 'Hi everyone, my name is Alex Rivera and today we ship.'],
  [8, 'We now have 10,000 users on the app.'],
  [14, 'If this helps, please subscribe to the channel.'],
  [22, 'Now click here to start a new project.'],
];

try {
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), video);
  await state((lines) => {
    const { useApp } = window.__cutaway;
    const st = useApp.getState();
    st.go('project');
    st.setView('edit');
    const words = [];
    for (const [t0, text] of lines) text.split(' ').forEach((w, i) => words.push({ id: `w${words.length}`, text: w, start: t0 + i * 0.4, end: t0 + i * 0.4 + 0.3, kind: 'word' }));
    const src = st.project.sources[0].id;
    st.patch((p) => ({ ...p, transcript: { engine: 'test', locale: 'en-US', onDevice: true, sourceId: src, hasSpeech: true, words, generatedAt: '' } }));
    st.setPanels({ inspector: true, tab: 'review' });
  }, LINES);
  await page.waitForSelector('[data-testid="motion-ideas"]');
  const banner = await page.locator('[data-testid="motion-ideas"]').innerText();
  check('Review says animations would fit four moments in what you say', /4 moments/.test(banner), banner.replace(/\s+/g, ' '));
  await shot('1-banner');

  await page.click('[data-testid="motion-ideas-show"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="suggestion"][data-kind="animation"]').length === 4 && !document.querySelector('[data-testid="motion-ideas"]'), null, { timeout: 10000 }).catch(() => {});
  let list = await ideas();
  const subscribeAt = 14 + 4 * 0.4; // “subscribe” is the fifth word
  check(
    'they become “Your call” cards: a name tag with the name, a counter to 10,000 users, a subscribe button just before the word, an arrow at “click here”',
    list.length === 4 &&
      list[0].template === 'nametag' && list[0].fields.name === 'Alex Rivera' &&
      list[1].template === 'counter' && list[1].fields.target === '10000' && list[1].fields.label === 'users' &&
      list[2].template === 'subscribe' && Math.abs(list[2].start - (subscribeAt - 1.1)) < 0.02 &&
      list[3].template === 'arrow' && list.every((s) => s.status === 'open'),
    JSON.stringify(list.map((s) => [s.template, s.start, s.fields])),
  );
  check('the cards show in Review with Add animation buttons, and the banner goes', (await page.locator('[data-testid="suggestion"][data-kind="animation"]').count()) === 4 && (await page.locator('[data-testid="suggestion-add-motion"]').count()) === 4 && (await page.locator('[data-testid="motion-ideas"]').count()) === 0);
  await shot('2-cards');

  // add the subscribe button
  await page.locator('[data-testid="suggestion"]', { hasText: 'Subscribe button' }).locator('[data-testid="suggestion-add-motion"]').click();
  await page.waitForTimeout(600);
  let m = await motions();
  list = await ideas();
  check('Add animation puts the Subscribe button in at the moment, and the card is done', m.length === 1 && m[0].template === 'subscribe' && Math.abs(m[0].start - (subscribeAt - 1.1)) < 0.02 && list.find((s) => s.template === 'subscribe').status === 'accepted' && (await page.locator('[data-testid="suggestion"]').count()) === 3, JSON.stringify(m));
  await state(() => window.__cutaway.useApp.getState().undo());
  await page.waitForTimeout(200);
  m = await motions();
  list = await ideas();
  check('one undo takes the animation out and puts the card back', m.length === 0 && list.find((s) => s.template === 'subscribe').status === 'open');
  await state(() => window.__cutaway.useApp.getState().redo());
  await page.waitForTimeout(200);
  check('redo puts it back', (await motions()).length === 1);

  await page.locator('[data-testid="suggestion"]', { hasText: 'Name tag' }).locator('[data-testid="suggestion-dismiss"]').click();
  await page.waitForTimeout(200);
  list = await ideas();
  check('Dismiss sets an idea aside without adding anything, and it is not offered again', list.find((s) => s.template === 'nametag').status === 'dismissed' && (await motions()).length === 1 && (await page.locator('[data-testid="motion-ideas"]').count()) === 0);

  await page.locator('[data-testid="suggestion"]', { hasText: 'Count up' }).locator('[data-testid="suggestion-add-motion"]').click();
  await page.waitForTimeout(600);
  m = await motions();
  const counter = m.find((x) => x.template === 'counter');
  check('the counter goes in counting to 10,000 users', !!counter && counter.fields.target === '10000' && counter.fields.label === 'users' && counter.fields.suffix === '+', JSON.stringify(counter));
  await state((id) => window.__cutaway.useApp.getState().select({ kind: 'overlay', id }), counter.id);
  await page.waitForSelector('[data-testid="motion-render-status"][data-state="ready"]', { timeout: 60000 });
  await state((t) => { const { usePlayback, useApp } = window.__cutaway; useApp.getState().select(null); usePlayback.getState().setPlaying(false); usePlayback.getState().seek(t); }, 8 + 3.2);
  await shot('3-counter');

  // ── Ask AI ──
  await state(() => {
    const { useApp } = window.__cutaway;
    useApp.setState({ claude: { found: true, path: '/fake/ai', version: '0', signedIn: true, message: 'test provider', provider: 'claude' } });
    window.__cutaway.jobs.grantConsent();
    window.__cutawayFakeAi = { seen: [], replies: [] };
    window.__cutawayFakeAi.replies.push((req) => ({
      reply: 'An arrow where you say click here, and a confetti burst I will write for you.',
      edits: [],
      remove: [],
      animations: [
        { at: /- arrow: Arrow \(boxed\)/.test(req.prompt) ? 22.3 : 0, template: 'arrow', fields: { note: 'Start here' }, request: 'arrow', reason: 'You tell viewers where to click.' },
        { at: null, template: null, fields: {}, request: 'a burst of gold confetti', reason: 'No template does confetti.' },
      ],
    }));
    useApp.getState().setPanels({ inspector: true, tab: 'chat' });
  });
  await page.waitForSelector('[data-testid="chat-input"]');
  await page.locator('[data-testid="chat-input"]').fill('Add an arrow when I say click here, and some confetti');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-reply"]').length >= 1 && !document.querySelector('[data-testid="chat-thinking"]'), null, { timeout: 20000 });
  const seen = await state(() => window.__cutawayFakeAi.seen[0]?.prompt ?? '');
  check('Ask AI tells the model which animation templates there are', /ANIMATION TEMPLATES/.test(seen) && /- subscribe: Subscribe/.test(seen) && /"animations"/.test(seen));
  const cards = page.locator('[data-testid="chat-card"][data-kind="motion"]');
  const texts = await cards.evaluateAll((els) => els.map((e) => [e.querySelector('.chat-card-what').textContent, e.querySelector('[data-testid="chat-apply"]')?.textContent]));
  check('the reply has two animation cards: Add animation (the arrow, with its note) and Write it…', texts.length === 2 && /Arrow animation at 0:22 with “Start here”/.test(texts[0][0]) && texts[0][1] === 'Add animation' && /gold confetti/.test(texts[1][0]) && texts[1][1] === 'Write it…', JSON.stringify(texts));
  await shot('4-chat');

  await cards.nth(0).locator('[data-testid="chat-apply"]').click();
  await page.waitForTimeout(700);
  m = await motions();
  const arrow = m.find((x) => x.template === 'arrow');
  check('Add animation puts the arrow in at 0:22 with its note, in its box', !!arrow && Math.abs(arrow.start - 22.3) < 0.02 && arrow.fields.note === 'Start here' && !!arrow.box, JSON.stringify(arrow));
  check('and the card says Added', /Added/.test(await cards.nth(0).innerText()));

  const good = '<!doctype html><html><head><script type="application/json" id="cutaway-motion">{"name":"Gold confetti","duration":2,"fields":[{"id":"tint","label":"Colour","type":"color","default":"#ffd400"}],"sounds":[{"t":0.1,"sound":"pop"}]}</script><style>#d{position:absolute;left:45%;top:40%;width:10vh;height:10vh;border-radius:50%;background:var(--tint)}</style></head><body><div id="d"></div><script>document.getElementById("d").animate([{transform:"scale(0)"},{transform:"scale(1.4)"}],{duration:2000,fill:"both"});</script></body></html>';
  await state((html) => window.__cutawayFakeAi.replies.push({ html, summary: 'Gold confetti' }), good);
  await state((t) => { const { usePlayback } = window.__cutaway; usePlayback.getState().setPlaying(false); usePlayback.getState().seek(t); }, 26);
  await cards.nth(1).locator('[data-testid="chat-apply"]').click();
  await page.waitForSelector('[data-testid="motion-sheet"]');
  const req = await page.locator('[data-testid="motion-request"]').inputValue().catch(() => '');
  await page.waitForFunction(() => window.__cutawayFakeAi.replies.length === 0 && !document.querySelector('[data-testid="motion-generate"] .spinner'), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const asked = await state(() => window.__cutawayFakeAi.seen.map((s) => s.purpose));
  check('Write it… opens the animation sheet and starts writing the request straight away', asked.join(',') === 'local-revision,motion' && (req === '' || /gold confetti/.test(req)), `${asked.join(',')} · box “${req}”`);
  await shot('5-written');
  await page.click('[data-testid="motion-add"]');
  await page.waitForTimeout(700);
  m = await motions();
  const gold = m.find((x) => x.origin === 'ai');
  check('once checked, it is added at the playhead, marked as written by the AI', !!gold && Math.abs(gold.start - 26) < 0.05, JSON.stringify(gold));
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all motion-ideas checks passed');
process.exit(failed ? 1 : 0);
