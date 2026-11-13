import { describe, expect, it } from 'vitest';
import {
  EDITING_PLAYBOOK,
  EDITORIAL_RULES,
  NOTE_MAX,
  PACKAGING_RULES,
  PLAYBOOKS,
  PLAYBOOK_SOURCES,
  THUMBNAILS_PLAYBOOK,
  TITLES_PLAYBOOK,
  artDirection,
  buildFirstCutPrompt,
  buildPackagingPrompt,
  buildRevisionPrompt,
  cleanNote,
  complementText,
  isPlaceholderName,
  packagingWarnings,
  repeatsTitle,
  thumbnailWordCount,
  titleSentenceScore,
  withNotes,
} from '../src/index';

const brief = { audience: 'beginners', targetDuration: 'auto' as const, pacing: 'balanced' as const, visualIntensity: 'balanced' as const, allowBroll: false, notes: '' };
const firstCut = (extra = {}) =>
  buildFirstCutPrompt({ projectName: 'Export settings', duration: 40, brief: brief as never, sources: [], hasSpeech: true, sentences: [], localOps: [], hints: [], activeRanges: [], clickClusters: [], assets: [], locks: [], keeps: [], keyframes: [], ...extra });
const packaging = (extra = {}) =>
  buildPackagingPrompt({ projectName: 'Export settings', brief: { audience: 'beginners', notes: '' }, outDuration: 30, hasSpeech: true, sentences: [], visualMoments: [], frames: [], paletteCount: 4, chapters: [], editSummary: '', ...extra });

describe('playbooks', () => {
  it('are compact, written as instructions, and defer to the fixed rules', () => {
    for (const pb of PLAYBOOKS) {
      expect(pb.text.length).toBeGreaterThan(900);
      expect(pb.text.length).toBeLessThan(4200);
      expect(pb.text).toMatch(/always win/);
      expect(pb.text).toMatch(/\nDo: /);
      expect(pb.text).toMatch(/\nDon't: /);
    }
    expect(PLAYBOOKS.map((p) => p.id)).toEqual(['editing', 'titles', 'thumbnails']);
  });

  it('do not contradict the non-negotiable rules they sit beside', () => {
    // hooks and reordering stay suggestions; views are never switched on a timer
    expect(EDITING_PLAYBOOK).toMatch(/"suggest" of kind "hook"; never move it yourself/);
    expect(EDITING_PLAYBOOK).toMatch(/If nothing motivates a change, leave the shot alone/);
    expect(EDITING_PLAYBOOK).not.toMatch(/every \d+ seconds? (you )?must/i);
    // numbers only when spoken, five words at most: same limits as the packaging rules
    expect(TITLES_PLAYBOOK).toMatch(/only when it is spoken in the video/);
    expect(THUMBNAILS_PLAYBOOK).toMatch(/five the limit/);
    expect(TITLES_PLAYBOOK).not.toMatch(/guarantee|viral|#1/i);
  });

  it('list their sources with a licence and a URL', () => {
    expect(PLAYBOOK_SOURCES.length).toBeGreaterThanOrEqual(4);
    for (const s of PLAYBOOK_SOURCES) expect(s.url.startsWith('https://') && s.licence.length > 2 && s.used.length > 10).toBe(true);
  });

  it('reach the prompts: editing for cuts and revisions, titles and thumbnails for packaging', () => {
    const fc = firstCut();
    expect(fc).toContain(EDITORIAL_RULES);
    expect(fc).toContain(EDITING_PLAYBOOK);
    expect(fc.indexOf(EDITING_PLAYBOOK)).toBeGreaterThan(fc.indexOf(EDITORIAL_RULES));
    expect(fc).not.toContain(TITLES_PLAYBOOK);
    const rev = buildRevisionPrompt({ projectName: 'x', instruction: 'no zooms', scope: { start: 0, end: 5 }, duration: 40, brief: brief as never, sources: [], hasSpeech: true, sentences: [], decisions: [], activeRanges: [], clickClusters: [], assets: [], locks: [], keeps: [], keyframes: [] });
    expect(rev).toContain(EDITING_PLAYBOOK);
    const pk = packaging();
    expect(pk).toContain(PACKAGING_RULES);
    expect(pk).toContain(TITLES_PLAYBOOK);
    expect(pk).toContain(THUMBNAILS_PLAYBOOK);
    expect(pk).not.toContain(EDITING_PLAYBOOK);
  });

  it("append the creator's notes under the right playbook, cleaned and capped", () => {
    const long = `keep my sign-off\u0007 ${'x'.repeat(2000)}`;
    const fc = firstCut({ playbookNotes: { editing: long, titles: 'sentence case only' } });
    expect(fc).toContain("THE CREATOR'S OWN NOTES FOR THIS");
    expect(fc).toContain('keep my sign-off');
    expect(fc).not.toContain('\u0007');
    expect(fc).not.toContain('sentence case only');
    expect(fc.length - firstCut().length).toBeLessThan(NOTE_MAX + 140);
    expect(packaging({ playbookNotes: { titles: 'sentence case only' } })).toContain('sentence case only');
    expect(cleanNote('   ')).toBe('');
    expect(withNotes('P', null)).toBe('P');
  });
});

describe('packaging warnings', () => {
  it('pass a concept that follows the playbooks', () => {
    expect(packagingWarnings({ title: 'How to export for YouTube without blurry video', thumbnailText: "DON'T DELETE THIS" })).toEqual([]);
  });

  it('flag a long title, an over-limit title and a shouted one', () => {
    expect(packagingWarnings({ title: 'x'.repeat(85), thumbnailText: 'Look' }).map((w) => w.code)).toEqual(['title-long']);
    expect(packagingWarnings({ title: 'x'.repeat(120), thumbnailText: 'Look' }).map((w) => w.code)).toEqual(['title-over-limit']);
    expect(packagingWarnings({ title: 'THE EXPORT SETTINGS NOBODY TELLS YOU', thumbnailText: 'Look' }).map((w) => w.code)).toContain('title-shouting');
  });

  it('flag more than five words on a thumbnail, counting only real words', () => {
    expect(thumbnailWordCount('BEFORE / AFTER')).toBe(2);
    expect(packagingWarnings({ title: 'Export settings', thumbnailText: 'one two three four five' })).toEqual([]);
    expect(packagingWarnings({ title: 'Export settings', thumbnailText: 'one two three four five six' }).map((w) => w.code)).toEqual(['thumb-too-many-words']);
  });

  it('flag a thumbnail that repeats the title, but not one that shares a single word', () => {
    expect(repeatsTitle('Export panel walkthrough', 'Export panel walkthrough')).toBe(true);
    expect(repeatsTitle('The export settings that stop blurry uploads', 'Export settings')).toBe(true);
    expect(repeatsTitle('The export settings that stop blurry uploads', 'Blurry no more')).toBe(false);
    expect(repeatsTitle('How to export for YouTube', "DON'T DELETE")).toBe(false);
    expect(packagingWarnings({ title: 'Export panel walkthrough', thumbnailText: 'Export panel' }).map((w) => w.code)).toEqual(['thumb-repeats-title']);
  });
});

describe('built-in title helpers', () => {
  it('know a made-up project name from a real topic', () => {
    for (const n of ['Recording Nov 13 at 8.58 AM', 'Untitled', '', 'Screen Recording 2026-11-13 at 08.58.01', 'screen', 'Take 3']) expect(isPlaceholderName(n), n).toBe(true);
    for (const n of ['Export panel walkthrough', 'Recording studio tour', 'How I set up my render farm']) expect(isPlaceholderName(n), n).toBe(false);
  });

  it('prefer a warning or a how/why line as title material', () => {
    const warning = titleSentenceScore('Do not close the window until the progress bar finishes');
    const how = titleSentenceScore('How the export folder is chosen in settings');
    const plain = titleSentenceScore('First open the settings panel on the left');
    expect(warning).toBeGreaterThan(how);
    expect(how).toBeGreaterThan(plain);
    expect(titleSentenceScore('Okay')).toBe(0);
  });

  it('pick thumbnail words that add to the title', () => {
    expect(complementText('Export panel walkthrough', ['Export panel', 'render queue', 'x'], 'Step by step')).toBe('render queue');
    expect(complementText('Export panel walkthrough', ['Export panel walkthrough'], 'Step by step')).toBe('Step by step');
    expect(complementText('A', ['one two three four five six.'], 'f')).toBe('one two three four');
  });
});

describe('artDirection', () => {
  it('asks for a wordless background with room for the text, and no claims', () => {
    const p = artDirection({ title: 'How to export for YouTube', thumbnailText: "DON'T DELETE", subject: 'A screen tutorial about export settings in a video editor.', template: 'banner', palette: ['#ffcc00', 'not-a-colour'], notes: 'yellow on dark' });
    expect(p).toMatch(/16:9/);
    expect(p).toMatch(/No text of any kind/);
    expect(p).toMatch(/bottom third calm/);
    expect(p).toMatch(/#ffcc00/);
    expect(p).not.toMatch(/not-a-colour/);
    expect(p).toMatch(/No recognisable real people/);
    expect(p).toMatch(/not a result/);
    expect(p).toMatch(/yellow on dark/);
    expect(artDirection({ title: 'T', thumbnailText: 'X', subject: '' })).toMatch(/The video: T/);
  });
});
