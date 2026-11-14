import { describe, expect, it } from 'vitest';
import { createProject, defaultSync, motionIdeas, motionSuggestions, type MediaSource, type Project, type Word } from '../src';

const screen: MediaSource = { id: 'scr', role: 'screen', name: 'screen.mov', path: '/tmp/screen.mov', managed: false, origin: 'import', kind: 'video', duration: 120, hasAudio: true, fingerprint: { sizeBytes: 1, duration: 120 }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [] } as MediaSource;

/** A project whose transcript says `text`, one word every 0.4 s from 2 s. */
function saying(text: string): Project {
  const words: Word[] = text.split(/\s+/).map((w, i) => ({ id: `w${i}`, text: w, start: 2 + i * 0.4, end: 2.3 + i * 0.4, kind: 'word' }));
  const p = createProject('t', [screen]);
  return { ...p, duration: 120, transcript: { engine: 'test', locale: 'en-US', onDevice: true, sourceId: 'scr', hasSpeech: true, words, generatedAt: '' } };
}
const at = (p: Project, word: string) => p.transcript!.words.find((w) => w.text.replace(/[^\w]/g, '').toLowerCase() === word)!.start;

describe('animation ideas from the transcript', () => {
  it('finds a subscribe button where "subscribe" is said, a little before it, once', () => {
    const p = saying('If this helped please subscribe and I will see you next time. Subscribe!');
    const ideas = motionIdeas(p);
    expect(ideas.map((i) => i.template)).toEqual(['subscribe']);
    // the click lands at 1.3 s into the template, so it starts ~1.1 s before the word
    expect(ideas[0]!.t).toBeCloseTo(at(p, 'subscribe') - 1.1, 5);
  });

  it('finds a name tag with the name said', () => {
    const ideas = motionIdeas(saying('Hi everyone, my name is Alex Rivera and today we build an app.'));
    expect(ideas[0]).toMatchObject({ template: 'nametag', fields: { name: 'Alex Rivera' } });
  });

  it('counts up numbers that are worth it, with their noun', () => {
    const ideas = motionIdeas(saying('We now have 10,000 users and 2 million views, up 40% this year, in 3 weeks.'));
    expect(ideas.map((i) => [i.template, i.fields.target, i.fields.label, i.fields.suffix])).toEqual([
      ['counter', '10000', 'users', '+'],
    ]);
    // the next counters fall within 8 s of the first: one per kind there
    const spread = motionIdeas(saying(`We now have 10,000 users ${'and so on '.repeat(10)} and 2 million views.`));
    expect(spread.map((i) => i.fields.target)).toEqual(['10000', '2000000']);
  });

  it('turns "step two" and "next up" into title cards with what follows', () => {
    const ideas = motionIdeas(saying(`Step two, connect the database. ${'Then we wait. '.repeat(8)} Next up, deploying to production.`));
    expect(ideas.map((i) => [i.template, i.fields.kicker, i.fields.title])).toEqual([
      ['titlecard', 'Step 2', 'Connect The Database'],
      ['titlecard', 'Next up', 'Deploying To Production'],
    ]);
  });

  it('points an arrow at "click here"', () => {
    expect(motionIdeas(saying('Now click here to open the settings.'))[0]).toMatchObject({ template: 'arrow' });
  });

  it('ignores words that were cut, and places that already have an animation', () => {
    const p = saying('Please subscribe to the channel.');
    const t = at(p, 'subscribe');
    expect(motionIdeas({ ...p, edit: { ...p.edit, cuts: [{ id: 'c', start: t - 0.1, end: t + 0.5, kind: 'manual', meta: {} as never }] } } as Project)).toEqual([]);
    const withMotion = { ...p, edit: { ...p.edit, overlays: [{ id: 'm', kind: 'motion', start: t - 1, end: t + 3 } as never] } } as Project;
    expect(motionIdeas(withMotion)).toEqual([]);
  });

  it('becomes Review suggestions once: not again after being dismissed', () => {
    const p = saying('Please subscribe to the channel.');
    const s = motionSuggestions(p);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: 'animation', status: 'open', apply: [], motion: { template: 'subscribe' } });
    const after = { ...p, edit: { ...p.edit, suggestions: [{ ...s[0]!, status: 'dismissed' as const }] } };
    expect(motionSuggestions(after)).toEqual([]);
  });

  it('suggests nothing without speech', () => {
    const p = saying('subscribe');
    expect(motionIdeas({ ...p, transcript: { ...p.transcript!, hasSpeech: false } })).toEqual([]);
  });
});
