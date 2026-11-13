/**
 * Thumbnail art: one AI-generated background picture for a concept.
 *
 * Only Codex can make pictures (its built-in image tool). What is sent is the
 * concept's title and rationale, a few words the creator says, their own
 * direction and up to two stills as reference; the request is refused in the
 * UI until the creator has allowed exactly that (Project.artConsent).
 *
 * The picture never carries the thumbnail's words: text stays Cutaway's own
 * editable layer on top. Generated pictures are marked on the layer
 * (`generated`), shown as such in the editor and written to the package
 * manifest.
 */
import { PROVIDERS, buildArtPrompt } from '@cutaway/ai';
import { uid, type GeneratedArt, type PackagingConcept, type Project, type ThumbnailLayer } from '@cutaway/core';
import { resolveSourcePath } from '../../shared/api';

export const ART_PROVIDER = PROVIDERS.codex;

/** Has the creator allowed thumbnail pictures to be made for this project by the image provider? */
export function artAllowed(project: Project | null): boolean {
  return project?.artConsent?.provider === ART_PROVIDER.consent;
}

type FrameLayer = Extract<ThumbnailLayer, { kind: 'frame' }>;
type ImageLayer = Extract<ThumbnailLayer, { kind: 'image' }>;

/** The stills worth showing the image model: the concept's own frames, at most two. */
export function artReferences(concept: PackagingConcept): { sourceId: string; time: number }[] {
  const seen = new Set<string>();
  const out: { sourceId: string; time: number }[] = [];
  for (const l of concept.layers) {
    if (l.kind !== 'frame') continue;
    const key = `${l.sourceId}@${l.time.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceId: (l as FrameLayer).sourceId, time: l.time });
  }
  return out.slice(0, 2);
}

/** What the prompt is built from. Pure. */
export function artPromptInput(concept: PackagingConcept, direction: string, referenceCount: number, variation: number, notes: string | null = null) {
  const texts = concept.layers.flatMap((l) => (l.kind === 'text' && l.text.trim() ? [l] : []));
  const colours = [...texts.map((l) => l.color), ...concept.layers.flatMap((l) => (l.kind === 'shape' ? [l.color] : l.kind === 'scrim' ? [l.from, l.to] : []))];
  return {
    title: concept.title,
    rationale: concept.rationale,
    quotes: concept.evidence.map((e) => e.quote),
    overlayText: texts.map((l) => l.text),
    palette: [...new Set(colours.filter((c) => /^#[0-9a-f]{6}$/i.test(c) && !/^#(f{6}|0{6})$/i.test(c)))],
    direction,
    referenceCount,
    variation,
    template: layoutOf(texts),
    notes,
  };
}

/** Where the words sit, so the picture keeps that part calm: a low band, a centred block, or the left half. */
function layoutOf(texts: Extract<ThumbnailLayer, { kind: 'text' }>[]): 'headline' | 'banner' | 'badge' {
  const main = [...texts].sort((a, b) => b.size - a.size)[0];
  if (!main) return 'headline';
  if (main.y > 0.66) return 'banner';
  return main.align === 'center' ? 'badge' : 'headline';
}

/** The layer id of the generated picture currently in the thumbnail, if any. */
export function artInUse(concept: PackagingConcept): ImageLayer | null {
  return (concept.layers.find((l) => l.kind === 'image' && !!l.generated) as ImageLayer | undefined) ?? null;
}

/**
 * Put a generated picture into the thumbnail as its background: full-bleed,
 * above any video frames (which it replaces visually) and below the shade,
 * shapes and text. A generated picture already in use is swapped out, so
 * there is one background at a time.
 */
export function withArt(layers: ThumbnailLayer[], art: GeneratedArt): ThumbnailLayer[] {
  const rest = layers.filter((l) => !(l.kind === 'image' && l.generated));
  const layer: ThumbnailLayer = { id: uid('tl'), kind: 'image', path: art.path, x: 0.5, y: 0.5, scale: 1, opacity: 1, generated: { provider: art.provider, note: art.note, direction: art.direction, at: art.at } };
  const lastFrame = rest.reduce((acc, l, i) => (l.kind === 'frame' ? i : acc), -1);
  return [...rest.slice(0, lastFrame + 1), layer, ...rest.slice(lastFrame + 1)];
}

/** Take the generated background out again; the video frame underneath shows as before. */
export function withoutArt(layers: ThumbnailLayer[]): ThumbnailLayer[] {
  return layers.filter((l) => !(l.kind === 'image' && l.generated));
}

export interface ArtRequest {
  /** The creator's standing notes for thumbnails (Settings → Playbooks). */
  notes?: string | null;
  projectPath: string;
  project: Project;
  concept: PackagingConcept;
  direction: string;
  signal: AbortSignal;
}

export type ArtOutcome = { ok: true; art: GeneratedArt; durationMs: number } | { ok: false; code: string; message: string };

let seq = 0;

/** Make one picture. Never called without `artAllowed(project)`; it checks again so no path skips the sheet. */
export async function generateArt(req: ArtRequest): Promise<ArtOutcome> {
  if (!artAllowed(req.project)) return { ok: false, code: 'no-consent', message: 'Nothing was sent: making pictures has not been allowed for this project.' };
  const refs: string[] = [];
  for (const r of artReferences(req.concept)) {
    const src = req.project.sources.find((s) => s.id === r.sourceId && s.available && s.kind === 'video');
    if (!src) continue;
    try {
      const frames = await window.cutaway.native.frames(req.projectPath, resolveSourcePath(req.projectPath, src.path), [Math.max(0, Math.min(r.time, Math.max(0, src.duration - 0.05)))], 640);
      if (frames[0]?.path) refs.push(frames[0].path);
    } catch {
      // A reference still is a help, not a requirement.
    }
  }
  if (req.signal.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled. Nothing was changed.' };
  const prompt = buildArtPrompt(artPromptInput(req.concept, req.direction, refs.length, (req.concept.art?.length ?? 0) + seq, req.notes ?? null));
  const id = `art_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const onAbort = () => void window.cutaway.ai.cancel(id).catch(() => undefined);
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await window.cutaway.ai.generateImage({ id, projectPath: req.projectPath, prompt, referencePaths: refs });
    if (!res.ok || !res.path) return { ok: false, code: res.error?.code ?? 'failed', message: res.error?.code === 'cancelled' ? 'Cancelled. Nothing was changed.' : (res.error?.message ?? 'No picture was made.') };
    return { ok: true, art: { id: uid('art'), path: res.path, provider: ART_PROVIDER.consent, note: res.note ?? '', direction: req.direction.trim(), at: new Date().toISOString() }, durationMs: res.durationMs };
  } catch (e) {
    return { ok: false, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
}
