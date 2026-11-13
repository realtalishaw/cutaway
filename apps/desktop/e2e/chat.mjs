// Ask AI chat and viewable versions, through the real app with a canned provider:
//   node e2e/chat.mjs [outDir]
// The harness runs with the CLIs switched off; window.__cutawayFakeAi (honoured only in
// e2e runs) supplies the replies, so prompts, parsing, validation, cards, checkpoints,
// version viewing, restore and saving are all exercised without spending anyone's account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, root } from './harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-chat'));
fs.mkdirSync(out, { recursive: true });
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
let failed = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

const { app, page } = await launch();
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const state = (fn, arg) => page.evaluate(fn, arg);
const say = async (text) => {
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="chat-input"]').press('Enter');
};
const replies = () => page.locator('[data-testid="chat-reply"]');
const waitReply = async (count) => {
  await page.waitForFunction((c) => document.querySelectorAll('[data-testid="chat-reply"]').length >= c && !document.querySelector('[data-testid="chat-thinking"]'), count, { timeout: 20000 });
};

try {
  // ── a project with a known edit: two AI zooms, one the creator made, one locked range ──
  await state((files) => window.__cutaway.actions.importIntoNewProject(files), [fx('screen.mp4'), fx('camera-a.mov')]);
  const base = await state(() => {
    const { useApp, core } = window.__cutaway;
    let st = useApp.getState();
    st.replace(core.applyProposal(st.project, [{ op: 'zoom', start: 2, end: 6, scale: 1.8, x: 0.3, y: 0.3, reason: 'settings' }, { op: 'zoom', start: 14, end: 18, scale: 2, x: 0.7, y: 0.5, reason: 'format' }], { label: 'AI first cut' }).project, 'AI first cut');
    st = useApp.getState();
    st.edit((e, p) => core.applyOps(e, [{ op: 'zoom', start: 24, end: 27, scale: 1.5, x: 0.5, y: 0.5, follow: false }], 'creator', p.revision + 1), 'My zoom');
    st.edit((e) => core.addLock(e, { start: 30, end: 34 }, 'keep'), 'Lock');
    st.setView('edit');
    useApp.setState({ claude: { found: true, path: '/fake/ai', version: '0', signedIn: true, message: 'test provider', provider: 'claude' } });
    window.__cutaway.jobs.grantConsent();
    window.__cutawayFakeAi = { replies: [], seen: [] };
    st.setPanels({ inspector: true, tab: 'chat' });
    const p = useApp.getState().project;
    return { revision: p.revision, zooms: p.edit.zooms.length, duration: p.duration };
  });
  await page.waitForSelector('[data-testid="chat-tab"]');
  check('the Ask AI tab opens with an empty thread', (await page.locator('[data-testid="chat-tab"]').isVisible()) && (await replies().count()) === 0);
  check('it says nothing is applied until you say so', /Nothing is applied until you say so/.test(await page.locator('[data-testid="chat-provider"]').innerText()));
  check('whole video is the default scope', /Whole video/.test(await page.locator('[data-testid="chat-scope"]').innerText()));
  await shot('01-empty');

  // ── first message: a removal, a new zoom, an operation inside a lock, an unknown operation ──
  await state(() => {
    window.__cutawayFakeAi.replies.push((req) => {
      const d1 = /- (D\d+) \[zooms\] 2\.00–6\.00/.exec(req.prompt)?.[1];
      return { reply: 'I would drop the early zoom and add a gentler one where the export starts.', edits: [{ op: 'zoom', start: 8, end: 11, scale: 1.6, x: 0.5, y: 0.5, reason: 'The export button is pressed here.' }, { op: 'cut', start: 31, end: 33, kind: 'pacing', reason: 'A slow moment.' }, { op: 'delete-project', start: 0, end: 1 }], remove: [d1, 'D99'] };
    });
  });
  await say('Remove the zooms in the first ten seconds');
  await waitReply(1);
  const first = replies().nth(0);
  const cards = first.locator('[data-testid="chat-card"]');
  const statuses = await cards.evaluateAll((els) => els.map((e) => [e.dataset.kind, e.dataset.status, e.querySelector('.chat-card-what').textContent]));
  check('the reply text is shown', /drop the early zoom/.test(await first.locator('.chat-text').innerText()));
  check('four cards: a removal, a new zoom and two refusals', statuses.length === 4 && statuses.filter((s) => s[1] === 'open').length === 2 && statuses.filter((s) => s[1] === 'refused').length === 2, JSON.stringify(statuses));
  check('the removal card names what goes', statuses.some((s) => s[0] === 'remove' && /Remove the zoom/.test(s[2])));
  const notes = await first.locator('[data-testid="chat-note"]').allInnerTexts();
  check('refused cards say why', notes.length === 2 && notes.every((t) => /Not possible:/.test(t)), notes.join(' | '));
  const seen1 = await state(() => window.__cutawayFakeAi.seen[0]);
  check('the prompt had the request, the current edit and the rules, and no stills for a whole-video request', /<request>\nRemove the zooms in the first ten seconds/.test(seen1.prompt) && /\[zooms\] 2\.00–6\.00/.test(seen1.prompt) && /made by the creator/.test(seen1.prompt) && /EDITORIAL RULES/.test(seen1.prompt) && seen1.images === 0);
  check('nothing was applied by the reply itself', (await state(() => window.__cutaway.useApp.getState().project.revision)) === base.revision);
  await shot('02-proposal');

  // jump link
  await cards.filter({ hasText: 'Zoom to 1.6×' }).locator('[data-testid="chat-jump"]').click();
  const jumped = await state(() => {
    const { useApp, usePlayback, timeMapOf } = window.__cutaway;
    return timeMapOf(useApp.getState().project).toSource(usePlayback.getState().time);
  });
  check('the time on a card jumps the playhead there', Math.abs(jumped - 8) < 0.05, jumped.toFixed(2));

  // ── apply one card ──
  await cards.filter({ hasText: 'Remove the zoom' }).locator('[data-testid="chat-apply"]').click();
  await page.waitForFunction((r) => window.__cutaway.useApp.getState().project.revision === r + 1, base.revision);
  const after1 = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    const rec = p.revisions.find((r) => r.revision === p.revision);
    return { zooms: p.edit.zooms.map((z) => z.start), rec: rec && { label: rec.label, via: rec.via, origin: rec.origin, messageId: !!rec.messageId }, before: p.revisions.some((r) => r.revision === p.revision - 1 && /^Before: Chat:/.test(r.label)) };
  });
  check('applying one card removes just that zoom', JSON.stringify(after1.zooms) === JSON.stringify([14, 24]), JSON.stringify(after1.zooms));
  check('it is saved as a chat version, with the state before it', after1.rec?.via === 'chat' && /^Chat: Remove the zoom/.test(after1.rec.label) && after1.rec.messageId && after1.before, JSON.stringify(after1.rec));
  check('the card shows as applied and the reply links its version', (await cards.filter({ hasText: 'Remove the zoom' }).getAttribute('data-status')) === 'applied' && (await first.locator('[data-testid="chat-view-version"]').isVisible()));

  // ── apply the other open card, then undo it ──
  await cards.filter({ hasText: 'Zoom to 1.6×' }).locator('[data-testid="chat-apply"]').click();
  await page.waitForFunction((r) => window.__cutaway.useApp.getState().project.revision === r + 2, base.revision);
  check('the second card adds the zoom as an AI decision', await state(() => window.__cutaway.useApp.getState().project.edit.zooms.some((z) => z.start === 8 && z.meta.origin === 'ai' && z.meta.reason === 'The export button is pressed here.')));
  await state(() => window.__cutaway.useApp.getState().undo());
  check('one undo takes that change back', await state(() => !window.__cutaway.useApp.getState().project.edit.zooms.some((z) => z.start === 8)));
  await state(() => window.__cutaway.useApp.getState().redo());
  await shot('03-applied');

  // ── follow-up: the next prompt carries a digest and the edit as it is now ──
  await state(() => {
    window.__cutawayFakeAi.replies.push((req) => {
      const h = /- (D\d+) \[zooms\] 24\.00–27\.00/.exec(req.prompt)?.[1];
      return { reply: 'Bringing one back at the format choice, and replacing your zoom with a stronger one.', edits: [{ op: 'zoom', start: 2, end: 5, scale: 1.7, x: 0.3, y: 0.3, reason: 'The settings panel opens here.' }, { op: 'zoom', start: 24, end: 27, scale: 2.4, x: 0.5, y: 0.5, reason: 'Stronger, as asked.' }, { op: 'overlay', kind: 'callout', start: 20, end: 23, text: 'Pick the format first', reason: 'Names the step.' }], remove: [h] };
    });
  });
  await say('Actually bring one back where the format is chosen');
  await waitReply(2);
  const seen2 = await state(() => window.__cutawayFakeAi.seen[1].prompt);
  const convo = seen2.slice(seen2.indexOf('<conversation>\n'), seen2.indexOf('</conversation>'));
  check('the follow-up prompt has a digest of the thread with what was applied', /Creator: Remove the zooms in the first ten seconds/.test(convo) && /You: I would drop the early zoom/.test(convo) && /2 applied/.test(convo) && /2 refused by validation/.test(convo), convo.slice(0, 400));
  check('…and the edit as it is now, not as it was', /\[zooms\] 8\.00–11\.00/.test(seen2) && !/\[zooms\] 2\.00–6\.00/.test(seen2));
  check('the new request is in <request>, not repeated in the digest', /<request>\nActually bring one back/.test(seen2) && !/Creator: Actually bring one back/.test(convo));
  const second = replies().nth(1);
  check('four open cards, including the removal of a zoom the creator made', (await second.locator('[data-testid="chat-card"][data-status="open"]').count()) === 4 && /You made this one yourself/.test(await second.innerText()));
  await second.locator('[data-testid="chat-apply-all"]').click();
  await page.waitForFunction((r) => window.__cutaway.useApp.getState().project.revision === r + 5, base.revision);
  const after2 = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    const rec = p.revisions.find((r) => r.revision === p.revision);
    return { zooms: p.edit.zooms.map((z) => [z.start, z.scale, z.meta.origin]), overlays: p.edit.overlays.length, label: rec?.label, locks: p.edit.locks.length, chatVersions: p.revisions.filter((r) => r.via === 'chat').length };
  });
  check('Apply all makes every change in one step', JSON.stringify(after2.zooms) === JSON.stringify([[2, 1.7, 'ai'], [8, 1.6, 'ai'], [14, 2, 'ai'], [24, 2.4, 'ai']]) && after2.overlays === 1, JSON.stringify(after2.zooms));
  check('…named after the request, as one version', /^Chat: Actually bring one back where the format/.test(after2.label) && after2.chatVersions === 3, `${after2.label} / ${after2.chatVersions}`);
  check('the locked range is untouched', after2.locks === 1);
  await shot('04-follow-up');

  // ── a question: an answer with moments, no edits ──
  await state(() => window.__cutawayFakeAi.replies.push({ reply: 'It drags in two places.', edits: [], remove: [], moments: [{ start: 9, end: 12, note: 'A long wait with nothing on screen.' }, { start: 21, end: 23, note: 'The same point is made twice.' }] }));
  await say('Where does it drag?');
  await waitReply(3);
  const third = replies().nth(2);
  check('a question gets an answer with moments and no cards', (await third.locator('[data-testid="chat-moment"]').count()) === 2 && (await third.locator('[data-testid="chat-card"]').count()) === 0);
  await third.locator('[data-testid="chat-moment"]').nth(1).click();
  check('a moment jumps the playhead', Math.abs((await state(() => window.__cutaway.timeMapOf(window.__cutaway.useApp.getState().project).toSource(window.__cutaway.usePlayback.getState().time))) - 21) < 0.05);

  // ── a section: the message is about the selection only ──
  await state(() => {
    window.__cutaway.useApp.getState().select({ kind: 'range', range: { start: 12, end: 20 } });
    window.__cutawayFakeAi.replies.push({ reply: 'Screen only here, and one change outside that I should not have made.', edits: [{ op: 'layout', start: 12, end: 20, mode: 'screen', reason: 'The picture matters here.' }, { op: 'zoom', start: 26, end: 29, scale: 2, reason: 'outside' }], remove: [] });
  });
  await page.waitForFunction(() => /Selection/.test(document.querySelector('[data-testid="chat-scope"]')?.textContent ?? ''));
  check('with a range selected the chat stays open and shows the section', (await page.locator('[data-testid="chat-tab"]').isVisible()) && /Selection 0:12 – 0:20/.test(await page.locator('[data-testid="chat-scope"]').innerText()));
  await say('Show only the screen here');
  await waitReply(4);
  const seen4 = await state(() => window.__cutawayFakeAi.seen[3]);
  check('the prompt names the section', /SECTION THE CREATOR SELECTED: 12\.00–20\.00/.test(seen4.prompt));
  const fourth = replies().nth(3);
  const st4 = await fourth.locator('[data-testid="chat-card"]').evaluateAll((els) => els.map((e) => e.dataset.status));
  check('a change outside the section is refused', JSON.stringify(st4) === JSON.stringify(['open', 'refused']), JSON.stringify(st4));
  await fourth.locator('[data-testid="chat-dismiss"]').click();
  check('a dismissed card changes nothing', (await fourth.locator('[data-testid="chat-card"]').first().getAttribute('data-status')) === 'dismissed' && (await state(() => window.__cutaway.useApp.getState().project.edit.layouts.length)) === 0);
  await state(() => window.__cutaway.useApp.getState().select(null));

  // ── history: every checkpoint, with origin and what changed ──
  await state(() => window.__cutaway.useApp.getState().setPanels({ tab: 'history' }));
  await page.waitForSelector('[data-testid="history"]');
  const rows = await page.locator('[data-testid="version-row"]').evaluateAll((els) => els.map((e) => ({ origin: e.dataset.origin, rev: Number(e.dataset.revision), title: e.querySelector('.review-title').textContent, diff: e.querySelector('[data-testid="version-diff"]').textContent, pill: e.querySelector('.version-origin').textContent })));
  check('history lists every distinct version newest first', rows.length >= 5 && new Set(rows.map((r) => r.rev)).size === rows.length && rows.every((r, i) => i === 0 || rows[i - 1].rev > r.rev), `${rows.length} rows`);
  check('each row says who made it: you, AI or chat', ['You', 'AI', 'Chat'].every((l) => rows.some((r) => r.pill === l)), JSON.stringify([...new Set(rows.map((r) => r.pill))]));
  const chatRow = rows.find((r) => /^Chat: Actually bring one back/.test(r.title));
  check('each row says what differs from the version before', chatRow?.diff === '+2 zooms · −1 zoom · +1 graphic' && rows.find((r) => r.title === 'AI first cut')?.diff === '+2 zooms', `${chatRow?.diff} | ${rows.find((r) => r.title === 'AI first cut')?.diff}`);
  await shot('05-history');

  // ── view a version: read-only, nothing changes, nothing is saved over the latest ──
  const liveBefore = await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit));
  await page.locator('[data-testid="version-row"]', { hasText: 'AI first cut' }).filter({ hasNotText: 'Before:' }).first().click();
  await page.waitForSelector('[data-testid="version-bar"]');
  const view = await state(() => {
    const { useApp, viewedProject } = window.__cutaway;
    const s = useApp.getState();
    return { label: s.viewing.label, shownZooms: viewedProject(s).edit.zooms.map((z) => z.start), liveZooms: s.project.edit.zooms.map((z) => z.start) };
  });
  check('clicking a version shows it, with a bar that names it', view.label === 'AI first cut' && /AI first cut/.test(await page.locator('[data-testid="version-label"]').innerText()) && JSON.stringify(view.shownZooms) === JSON.stringify([2, 14]), JSON.stringify(view));
  const blocks = await page.locator('.tl-item.zoom, .tl-zoom, [data-lane="zooms"] [data-id]').count();
  check('the timeline shows that version', blocks === 0 || blocks === 2, `${blocks} zoom blocks`);
  await shot('06-viewing');
  // attempts to edit do nothing
  const tried = await state(() => {
    const { useApp, core } = window.__cutaway;
    const s = useApp.getState();
    const r = s.project.revision;
    s.edit((e, p) => core.applyOps(e, [{ op: 'zoom', start: 20, end: 22, scale: 3 }], 'creator', p.revision + 1), 'Sneaky');
    s.undo();
    return { same: useApp.getState().project.revision === r, toast: useApp.getState().toasts.at(-1)?.text ?? '' };
  });
  check('editing is off while a version is on screen, and says why', tried.same && /earlier version/.test(tried.toast), tried.toast);
  // playback works on the viewed version
  await state(() => (window.__cutaway.usePlayback.getState().seek(1), window.__cutaway.usePlayback.getState().setPlaying(true)));
  await page.waitForTimeout(1500);
  const played = await state(() => (window.__cutaway.usePlayback.getState().setPlaying(false), window.__cutaway.usePlayback.getState().time));
  check('the viewed version plays', played > 1.4, played.toFixed(2));
  await page.keyboard.press('ArrowRight');
  check('the arrow keys still step through it', (await state(() => window.__cutaway.usePlayback.getState().time)) > played);
  // the inspector reflects it
  await state(() => window.__cutaway.useApp.getState().setPanels({ tab: 'motion' }));
  check('switching inspector tabs keeps the version on screen', await page.locator('[data-testid="version-bar"]').isVisible());
  // saving while viewing writes the latest, never the viewed version
  await state(() => window.__cutaway.saveNow());
  const disk = await state(async () => {
    const { useApp } = window.__cutaway;
    const loaded = await window.cutaway.library.open(useApp.getState().projectPath);
    return JSON.stringify((loaded.project ?? loaded).edit.zooms.map((z) => z.start));
  });
  check('saving while viewing writes the latest edit, not the one on screen', disk === JSON.stringify([2, 8, 14, 24]) && (await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit))) === liveBefore, disk);
  // compare with latest
  await page.locator('[data-testid="version-bar"]').getByRole('button', { name: 'Latest', exact: true }).click();
  check('Compare flips to the latest edit and back', (await state(() => window.__cutaway.viewedProject(window.__cutaway.useApp.getState()) === null)) && (await page.locator('[data-testid="version-bar"]').isVisible()));
  await page.locator('[data-testid="version-bar"]').getByRole('button', { name: 'This version', exact: true }).click();
  // back to latest
  await page.locator('[data-testid="version-back"]').click();
  check('Back to latest leaves everything as it was', !(await page.locator('[data-testid="version-bar"]').isVisible()) && (await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit))) === liveBefore);

  // step with the keyboard
  await page.keyboard.press('Alt+BracketLeft');
  const stepped = await state(() => window.__cutaway.useApp.getState().viewing?.label ?? null);
  check('⌥[ looks at the previous version', !!stepped && stepped !== 'AI first cut', String(stepped));
  await page.keyboard.press('Escape');
  check('Esc goes back to the latest', (await state(() => window.__cutaway.useApp.getState().viewing)) === null);

  // ── restore ──
  await state(() => window.__cutaway.useApp.getState().setPanels({ tab: 'history' }));
  const revBefore = await state(() => window.__cutaway.useApp.getState().project.revision);
  await page.locator('[data-testid="version-row"]', { hasText: 'AI first cut' }).filter({ hasNotText: 'Before:' }).first().click();
  await page.locator('[data-testid="version-restore"]').click();
  const restored = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    return { zooms: p.edit.zooms.map((z) => z.start), revision: p.revision, saved: p.revisions.some((r) => r.label === 'Before restore' && r.revision === p.revision - 1), viewing: window.__cutaway.useApp.getState().viewing };
  });
  check('Restore makes that version the current edit as a new revision', JSON.stringify(restored.zooms) === JSON.stringify([2, 14]) && restored.revision === revBefore + 1 && restored.viewing === null, JSON.stringify(restored.zooms));
  check('what was there before is checkpointed', restored.saved);
  await state(() => window.__cutaway.useApp.getState().undo());
  check('one undo brings back what was there', (await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit))) === liveBefore);

  // "View this version" from the chat
  await state(() => window.__cutaway.useApp.getState().setPanels({ tab: 'chat' }));
  await replies().nth(0).locator('[data-testid="chat-view-version"]').click();
  const fromChat = await state(() => ({ label: window.__cutaway.useApp.getState().viewing?.label, zooms: window.__cutaway.viewedProject(window.__cutaway.useApp.getState())?.edit.zooms.map((z) => z.start) }));
  check('View this version on a reply shows the edit right after that change', /^Chat: Zoom to 1\.6×/.test(fromChat.label ?? '') && JSON.stringify(fromChat.zooms) === JSON.stringify([8, 14, 24]), JSON.stringify(fromChat));
  check('the composer steps aside while a version is on screen', !(await page.locator('[data-testid="chat-input"]').isVisible()));
  await shot('07-view-from-chat');
  await page.locator('[data-testid="version-back"]').click();

  // ── the thread is saved with the project ──
  await state(() => window.__cutaway.saveNow());
  const saved = await state(async () => {
    const loaded = await window.cutaway.library.open(window.__cutaway.useApp.getState().projectPath);
    const p = loaded.project ?? loaded;
    return { messages: p.chat?.length ?? 0, applied: (p.chat ?? []).flatMap((m) => m.items ?? []).filter((i) => i.status === 'applied').length };
  });
  check('the conversation is saved with the project', saved.messages === 8 && saved.applied === 6, JSON.stringify(saved));

  // ── a reply that cannot be used falls back to the built-in rules and says so ──
  await state(() => window.__cutawayFakeAi.replies.push({ error: 'provider exploded' }));
  await say('No zooms at all please');
  await waitReply(5);
  const fifth = replies().nth(4);
  check('when the provider fails, the built-in rules answer and say so', (await fifth.getAttribute('data-mode')) === 'local-rules' && /provider exploded/.test(await fifth.innerText()) && (await fifth.locator('[data-testid="chat-card"][data-kind="rules"]').count()) === 1, (await fifth.innerText()).slice(0, 160));
  await fifth.locator('[data-testid="chat-apply"]').click();
  await page.waitForFunction(() => window.__cutaway.useApp.getState().project.edit.zooms.every((z) => z.meta.origin !== 'ai') || window.__cutaway.useApp.getState().project.edit.zooms.length === 0, null, { timeout: 10000 });
  const rules = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    return { zooms: p.edit.zooms.length, via: p.revisions.find((r) => r.revision === p.revision)?.via };
  });
  check('applying the rules card removes the automatic zooms as a chat version', rules.zooms === 0 && rules.via === 'chat', JSON.stringify(rules));

  // ── consent is asked before the first message when it has not been given ──
  await state(() => window.__cutaway.jobs.revokeConsent());
  await page.locator('[data-testid="chat-input"]').fill('Tighten this');
  await page.locator('[data-testid="chat-send"]').click();
  const stay = page.getByRole('button', { name: 'Stay on this Mac' });
  const asked6 = await stay.waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('without consent, sending asks first and says what would leave this Mac', asked6 && /What is sent/.test(await page.locator('.scrim, .modal').first().innerText().catch(() => '')));
  await page.getByRole('button', { name: 'Stay on this Mac' }).click();
  await waitReply(6);
  check('declining keeps it on this Mac', (await state(() => window.__cutawayFakeAi.seen.length)) === 5 && (await replies().nth(5).getAttribute('data-mode')) === 'local-rules');
  // ── without a signed-in provider ──
  await state(() => window.__cutaway.useApp.setState({ claude: { found: true, path: '/fake/ai', version: '0', signedIn: false, message: 'signed out', provider: 'claude' } }));
  await page.waitForFunction(() => /No AI provider is signed in/.test(document.querySelector('[data-testid="chat-provider"]')?.textContent ?? ''));
  await say('Write a better intro for me');
  await waitReply(7);
  const sixth = replies().nth(6);
  const asked = await state(() => window.__cutawayFakeAi.seen.length);
  check('signed out: the tab says so, sends nothing, and explains what the rules can do', asked === 5 && (await sixth.getAttribute('data-mode')) === 'local-rules' && /needs Claude/.test(await sixth.innerText()), (await sixth.innerText()).slice(0, 200));

  await shot('08-end');
} catch (e) {
  failed++;
  console.log('ERROR', e.stack ?? e.message);
  await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} of ${n} checks failed` : `\n${n}/${n} checks passed`);
console.log(`screenshots → ${out}`);
process.exit(failed ? 1 : 0);
