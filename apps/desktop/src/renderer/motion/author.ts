/**
 * Animations described in words, written by the creator's own Claude Code or Codex. The model gets the
 * animation contract, the output's size, the project's colours and worked examples close to the request, and answers with one
 * HTML page. Cutaway then loads that page in its locked-down renderer and looks at it; whatever is wrong
 * goes back to the model to fix, at most twice, so the creator only ever sees an animation that works.
 */
import { BUILTIN_SOUNDS, DEFAULT_BOX, MAX_MOTION_SECONDS, MOTION_META_ID, motionPixels, parseMotionMeta, type Project } from '@cutaway/core';
import type { MotionCheck } from '@shared/api';
import { askClaude } from '../jobs/shared';
import type { JobContext } from '../jobs/types';
import { examplesFor } from './templates';

export const MOTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['html', 'summary'],
  properties: {
    html: { type: 'string', description: 'The complete animation page: <!doctype html> … </html>.' },
    summary: { type: 'string', description: 'One sentence: what the animation shows.' },
  },
} as const;

/** The rules every animation page follows. Kept short and literal: it is read by a model. */
export function motionContract(width: number, height: number): string {
  return [
    'ANIMATION CONTRACT (Cutaway motion graphics)',
    `- One self-contained HTML page. It is drawn over the creator's video at ${width}×${height} px. The page background MUST stay transparent: never paint a full-frame background; only the graphic itself is visible.`,
    '- Size everything relative to the frame (vw, vh, %, or em with `font-size: calc(min(100vw, 100vh) * …)` on body) so it works wide, square and tall. Keep key content inside the middle 90% of the frame; text inside the middle 80%.',
    '- Motion ONLY with CSS @keyframes/animations or the Web Animations API (element.animate(...)), created when the page loads, with fill "both". Cutaway pauses every animation and sets its currentTime to show any moment, so timing must come only from those animations. Easiest: give every animation the full duration and place moments with keyframe offsets.',
    '- For particles, confetti, drawing and anything per-frame: define `window.__render = (t) => { … }` (t = seconds since the start) and draw on a <canvas> purely as a function of t. Use a seeded random generator, never Math.random() for anything visible.',
    '- Forbidden: external files, fonts, images or scripts (no http/https, no <link>, no imports; the page cannot load anything), Date.now(), performance.now(), setTimeout/setInterval, requestAnimationFrame loops, fetch, localStorage, alert. Inline SVG and data: URIs are fine. Use system fonts (-apple-system, "Helvetica Neue", Arial, Georgia, Menlo).',
    `- Declare the animation in <head> with exactly one <script type="application/json" id="${MOTION_META_ID}"> block: {"name": short title, "duration": seconds (0.3–${MAX_MOTION_SECONDS}), "fields": [{"id","label","type":"text"|"color"|"number","default"}], "sounds": [{"t": seconds, "sound": one of ${BUILTIN_SOUNDS.map((b) => b.id).join('/')}, "gain": 0–1}]}.`,
    '- Make the words and the main colours fields, so the creator can change them without code. A field reaches the page as the CSS custom property var(--<id>) and as the text of any element with data-field="<id>" (and as window.__fields).',
    '- Add a sound at each visible action (a click, a pop, a whoosh as something flies in) unless the request asks for silence.',
    '- End cleanly: the graphic animates out (or holds) by the end of its duration.',
    '- PLACEMENT. A graphic that annotates one spot of the video (circle, arrow, underline, highlight, a box around a button, a pointer) is BOXED: add "placement": "box" and "box": {"x","y","w","h"} (fractions of the frame, where it should start) to the JSON block. A boxed page is shown inside that box, stretched to its shape, and the creator moves and resizes the box; so the graphic must fill its own viewport (100vw × 100vh is the box, not the frame) and keep any text inside it. Everything else (titles, name tags, counters, confetti, buttons) leaves placement out and covers the frame.',
    '- Draw strokes that "draw on" (circles, arrows, underlines, scribbles) on a <canvas> in window.__render, sized to the canvas pixels. Do NOT use SVG stroke-dasharray with vector-effect: non-scaling-stroke or a stretched viewBox: the stroke comes out partly drawn or distorted once the box is resized.',
    '- Add a "description" (one short sentence a creator would understand) to the JSON block.',
  ].join('\n');
}

const ctxOf = (signal: AbortSignal) => ({ signal }) as unknown as JobContext;

/** Pull the page out of a reply, whether it came as the schema asked or as a bare string. */
function htmlOf(data: unknown): string | null {
  const html = typeof data === 'string' ? data : (data as { html?: unknown } | null)?.html;
  if (typeof html !== 'string') return null;
  const m = html.match(/<!doctype html[\s\S]*<\/html>/i) ?? html.match(/<html[\s\S]*<\/html>/i);
  return (m ? m[0] : html).trim() || null;
}

export interface AuthorResult {
  html: string;
  check: MotionCheck;
  attempts: number;
  provider: string;
  /** Where the time went, step by step (for the log and for tuning). */
  timings: { step: string; ms: number; note?: string }[];
}

/** One step of making an animation, as the creator sees it. */
export interface MotionStep {
  id: string;
  label: string;
  state: 'active' | 'done' | 'failed';
  /** What is happening inside the step, or how it went. */
  detail?: string;
  startedAt: number;
  ms?: number;
}

const kb = (chars: number) => (chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(1)} KB`);
const secs = (ms: number) => (ms < 1000 ? 'under a second' : `${Math.round(ms / 1000)} s`);

/**
 * Ask for an animation (or a change to one), check it, and have it fixed if needed. `onSteps` hears every step
 * (the brief, the code being written, the test in the renderer, a fix), so the creator sees what is happening.
 */
export async function authorMotion(opts: {
  project: Project;
  request: string;
  previous?: string | null;
  signal: AbortSignal;
  onStatus(text: string): void;
  onSteps?(steps: MotionStep[]): void;
}): Promise<AuthorResult> {
  const out = opts.project.edit.appearance.output;
  const { width, height } = out;
  const steps: MotionStep[] = [];
  const emit = () => opts.onSteps?.(steps.map((x) => ({ ...x })));
  const begin = (id: string, label: string, detail?: string) => {
    steps.push({ id, label, state: 'active', detail, startedAt: Date.now() });
    opts.onStatus(`${label}…`);
    emit();
    return steps[steps.length - 1]!;
  };
  const end = (step: MotionStep, state: 'done' | 'failed', detail?: string) => {
    step.state = state;
    step.ms = Date.now() - step.startedAt;
    if (detail !== undefined) step.detail = detail;
    emit();
  };
  const update = (step: MotionStep, detail: string) => {
    step.detail = detail;
    emit();
  };

  const brief = begin('brief', 'Getting the brief ready');
  const examples = examplesFor(`${opts.request} ${opts.previous ? (parseMotionMeta(opts.previous).meta?.name ?? '') : ''}`);
  const brand = brandColours(opts.project);
  const base = [
    motionContract(width, height),
    '',
    brand ? `The video's own colours, to use where they fit: ${brand}.` : '',
    ...examples.flatMap((e, i) => [`WORKED EXAMPLE ${i + 1}${e.boxed ? ' (boxed)' : ''} — ${e.name} (a complete, correct page):`, e.html, '']),
  ].join('\n');
  let prompt = opts.previous
    ? `${base}\nTHE CURRENT ANIMATION:\n${opts.previous}\n\nCHANGE IT AS FOLLOWS (keep everything else as it is):\n${opts.request}\n\nAnswer with the complete updated page.`
    : `${base}\nMAKE THIS ANIMATION:\n${opts.request}\n\nAnswer with the complete page.`;
  end(brief, 'done', `The animation rules, ${out.width}×${out.height}${brand ? ', your video’s colours' : ''} and ${examples.length === 1 ? 'a worked example' : `${examples.length} worked examples`} (${examples.map((e) => e.name).join(', ')})`);

  let provider = 'claude';
  const timings: AuthorResult['timings'] = [];
  const aiName = () => (provider === 'codex' ? 'Codex' : 'Claude');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const write = begin(
      `write-${attempt}`,
      attempt === 1 ? (opts.previous ? 'Rewriting the animation code with your change' : 'Writing the animation code') : `Fixing the code (attempt ${attempt} of 3)`,
      'Waiting for the first lines…',
    );
    const t0 = performance.now();
    const res = await askClaude(ctxOf(opts.signal), { purpose: 'motion', prompt, schema: MOTION_SCHEMA as unknown as Record<string, unknown>, imagePaths: [], imageDir: null }, (chars) => update(write, `${kb(chars)} written so far`));
    timings.push({ step: `ai attempt ${attempt}`, ms: Math.round(performance.now() - t0), note: `prompt ${prompt.length} chars` });
    if (opts.signal.aborted) {
      end(write, 'failed', 'Stopped.');
      throw new Error('Stopped.');
    }
    if (!res.ok) {
      end(write, 'failed', res.error?.message ?? 'The AI could not write it.');
      throw new Error(res.error?.message ?? 'The AI could not write the animation.');
    }
    provider = res.provider ?? provider;
    const html = htmlOf(res.data);
    if (!html) {
      end(write, 'failed', `${aiName()} answered without a page. Asking again.`);
      prompt = `${base}\nYour last answer had no HTML page in "html". ${opts.previous ? `Change the current animation as asked: ${opts.request}` : `Make this animation: ${opts.request}`}\nAnswer with the complete page.`;
      continue;
    }
    const meta = parseMotionMeta(html).meta;
    end(write, 'done', `${aiName()} wrote ${kb(html.length)}${meta ? ` — “${meta.name}”, ${meta.duration.toFixed(1)} s${meta.fields.length ? `, ${meta.fields.length} thing${meta.fields.length === 1 ? '' : 's'} you can change` : ''}${meta.sounds.length ? `, ${meta.sounds.length} sound${meta.sounds.length === 1 ? '' : 's'}` : ''}` : ''} in ${secs(performance.now() - t0)}`);

    // a boxed animation is checked at the size it will be shown
    const px = motionPixels({ box: meta?.placement === 'box' ? (meta.box ?? DEFAULT_BOX) : undefined }, width, height);
    const test = begin(`check-${attempt}`, attempt === 1 ? 'Testing it in Cutaway’s renderer' : 'Testing the fix', `Playing it at ${px.width}×${px.height} and looking at three moments: is something visible, does it move, is the background see-through, any script errors?`);
    const c0 = performance.now();
    const check = await window.cutaway.motion.check(html, null, px.width, px.height);
    timings.push({ step: `check ${attempt}`, ms: Math.round(performance.now() - c0), note: check.ok ? 'ok' : check.errors.join(' | ') });
    if (check.ok) {
      end(test, 'done', 'It draws, moves and stays see-through, with no errors.');
      return { html, check, attempts: attempt, provider, timings };
    }
    end(test, 'failed', `Found ${check.errors.length === 1 ? 'a problem' : `${check.errors.length} problems`}: ${check.errors.map((e) => e.replace(/\.$/, '')).join('; ')}`);
    if (attempt === 3) return { html, check, attempts: attempt, provider, timings };
    prompt = `${base}\nYOUR PAGE:\n${html}\n\nWHEN CUTAWAY RENDERED IT, THESE PROBLEMS CAME UP:\n${check.errors.map((e) => `- ${e}`).join('\n')}\n\nFix every problem and keep what was asked (${opts.request}). Answer with the complete corrected page.`;
  }
  throw new Error('The AI could not write a working animation.');
}

/** The colours the video already uses (background and accent), to suggest a matching look. */
function brandColours(project: Project): string {
  const bg = project.edit.appearance.background;
  const cs = bg.type === 'gradient' ? bg.colors : bg.type === 'solid' ? [bg.color] : [];
  return cs.slice(0, 3).join(', ');
}
