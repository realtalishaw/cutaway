/**
 * Thumbnail art: one AI-generated background picture for a concept.
 *
 * Pictures come from Codex (its built-in image tool) or, without Codex, from fal.ai with the creator's own key.
 * What is sent is the
 * concept's title and rationale, a few words the creator says, their own
 * direction and up to two stills as reference; the request is refused in the
 * UI until the creator has allowed exactly that (Project.artConsent).
 *
 * The picture never carries the thumbnail's words: text stays Cutaway's own
 * editable layer on top. Generated pictures are marked on the layer
 * (`generated`), shown as such in the editor and written to the package
 * manifest.
 */
import { PROVIDERS, buildArtPrompt, buildCodexFullThumbnailPrompt, buildFullThumbnailPrompt, buildImageModelArtPrompt } from '@cutaway/ai';
import { toSourceTime, uid, type GeneratedArt, type PackagingConcept, type Project, type ThumbnailLayer } from '@cutaway/core';
import { resolveSourcePath } from '../../shared/api';

export const ART_PROVIDER = PROVIDERS.codex;

/** Who can make a thumbnail picture on this Mac. */
export interface ArtSource {
  id: 'codex' | 'fal';
  /** The app or service, as the creator knows it. */
  app: string;
  /** Where the request goes. */
  company: string;
  /** Stored in Project.artConsent: allowing one never covers the other. */
  consent: string;
}
export const ART_SOURCES: Record<ArtSource['id'], ArtSource> = {
  codex: { id: 'codex', app: ART_PROVIDER.app, company: ART_PROVIDER.company, consent: ART_PROVIDER.consent },
  fal: { id: 'fal', app: 'fal.ai', company: 'fal.ai', consent: 'fal.ai with your own key' },
};

/** What is set up: Codex signed in comes first, then a fal.ai key. `source` is null when neither is. */
export async function findArtSource(force = false): Promise<{ source: ArtSource | null; codexFound: boolean; codexSignedIn: boolean; falKey: boolean }> {
  const [providers, keys] = await Promise.all([window.cutaway.ai.providers(force).catch(() => null), window.cutaway.gen.status().catch(() => null)]);
  const codexFound = !!providers?.codex.found;
  const codexSignedIn = codexFound && providers?.codex.signedIn === true;
  const falKey = !!keys?.fal.set;
  return { source: codexSignedIn ? ART_SOURCES.codex : falKey ? ART_SOURCES.fal : null, codexFound, codexSignedIn, falKey };
}

/** Has the creator allowed thumbnail pictures to be made for this project by this source (Codex when not given)? */
export function artAllowed(project: Project | null, source: ArtSource = ART_SOURCES.codex): boolean {
  return project?.artConsent?.provider === source.consent;
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
  /** Who makes it. Default: Codex. */
  source?: ArtSource;
}

export type ArtOutcome = { ok: true; art: GeneratedArt; durationMs: number } | { ok: false; code: string; message: string };

let seq = 0;

/** fal.ai model for thumbnail pictures when the creator kept the default (fast, lower quality) image model. */
export const THUMBNAIL_FAL_MODEL = 'fal-ai/flux/dev';

/** Make one picture. Never called without `artAllowed(project)`; it checks again so no path skips the sheet. */
export async function generateArt(req: ArtRequest): Promise<ArtOutcome> {
  const source = req.source ?? ART_SOURCES.codex;
  if (!artAllowed(req.project, source)) return { ok: false, code: 'no-consent', message: 'Nothing was sent: making pictures has not been allowed for this project.' };
  // fal.ai is asked in words only; Codex also gets up to two stills of the video to match.
  const refs: string[] = [];
  for (const r of source.id === 'codex' ? artReferences(req.concept) : []) {
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
  const input = artPromptInput(req.concept, req.direction, refs.length, (req.concept.art?.length ?? 0) + seq, req.notes ?? null);
  // Codex is an agent and gets instructions; an image model gets a picture description.
  const prompt = source.id === 'fal' ? buildImageModelArtPrompt(input) : buildArtPrompt(input);
  const id = `art_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const started = Date.now();
  const onAbort = () => void (source.id === 'fal' ? window.cutaway.gen.cancel(id) : window.cutaway.ai.cancel(id)).catch(() => undefined);
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (source.id === 'fal') {
      // The default image model is built for speed; thumbnails get a better one, unless the creator chose their own.
      const keys = await window.cutaway.gen.status().catch(() => null);
      const model = !keys || keys.models.image === keys.defaults.image ? THUMBNAIL_FAL_MODEL : undefined;
      const r = await window.cutaway.gen.generate(req.projectPath, { jobId: id, provider: 'fal', kind: 'image', prompt, aspect: '16:9', ...(model ? { model } : {}) });
      return { ok: true, art: { id: uid('art'), path: r.path, provider: source.consent, note: `fal.ai · ${r.model}`, direction: req.direction.trim(), at: new Date().toISOString() }, durationMs: Date.now() - started };
    }
    const res = await window.cutaway.ai.generateImage({ id, projectPath: req.projectPath, prompt, referencePaths: refs });
    if (!res.ok || !res.path) return { ok: false, code: res.error?.code ?? 'failed', message: res.error?.code === 'cancelled' ? 'Cancelled. Nothing was changed.' : (res.error?.message ?? 'No picture was made.') };
    return { ok: true, art: { id: uid('art'), path: res.path, provider: source.consent, note: res.note ?? '', direction: req.direction.trim(), at: new Date().toISOString() }, durationMs: res.durationMs };
  } catch (e) {
    if (req.signal.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled. Nothing was changed.' };
    return { ok: false, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
}


// ───────────────────────────── whole thumbnails ─────────────────────────────

/** fal.ai model for a whole thumbnail when there is no photo of the creator to work from. */
export const THUMBNAIL_TEXT_MODEL = 'fal-ai/nano-banana-pro';

/** Is the concept's thumbnail one finished AI picture (words included)? */
export function isWholeThumbnail(concept: PackagingConcept): boolean {
  return concept.layers.length > 0 && concept.layers.every((l) => l.kind === 'image' && !!l.generated);
}

/** The thumbnail becomes this one finished picture, full size. Undo brings the layers back. */
export function withWholeThumbnail(art: GeneratedArt): ThumbnailLayer[] {
  return [{ id: uid('tl'), kind: 'image', path: art.path, x: 0.5, y: 0.5, scale: 1, opacity: 1, generated: { provider: art.provider, note: art.note, direction: art.direction, at: art.at } }];
}

/** For a concept no AI described (built from templates): a simple description of a whole thumbnail. Pure. */
export function fallbackImagePrompt(concept: PackagingConcept): string {
  const words = concept.layers.flatMap((l) => (l.kind === 'text' && l.text.trim() ? [l.text.trim()] : [])).slice(0, 1)[0] ?? concept.title.split(' ').slice(0, 4).join(' ');
  return `YouTube thumbnail, 16:9. The person from image 1 on the right third, from the chest up, with an excited, surprised expression, pointing toward the words. On the left, the words "${words.toUpperCase()}" in huge bold white sans-serif capitals with a thick black outline. A bold, saturated background with one prop that shows the video's topic: ${concept.title}. High contrast, clean studio lighting, bold modern YouTube style.`;
}

/**
 * The picture of the creator to build thumbnails on: their saved photo if they chose one, otherwise a frame of them
 * from the video's camera (the moment the concept is about). Null when there is neither.
 */
export async function creatorPhoto(projectPath: string, project: Project, concept: PackagingConcept): Promise<{ path: string; from: 'photo' | 'video' } | null> {
  const saved = await window.cutaway.ai.photo().catch(() => null);
  if (saved) return { path: saved, from: 'photo' };
  const cams = project.sources.filter((s) => (s.role === 'cameraA' || s.role === 'cameraB') && s.available && s.kind === 'video').sort((a, b) => a.role.localeCompare(b.role));
  const cam = cams[0];
  if (!cam) return null;
  const frame = concept.layers.find((l) => l.kind === 'frame' && l.sourceId === cam.id) as FrameLayer | undefined;
  const session = concept.evidence[0]?.sessionTime;
  const t = frame ? frame.time : session !== undefined ? toSourceTime(cam.sync, session) : cam.duration / 2;
  try {
    const frames = await window.cutaway.native.frames(projectPath, resolveSourcePath(projectPath, cam.path), [Math.max(0, Math.min(t, cam.duration - 0.05))], 1280);
    return frames[0]?.path ? { path: frames[0].path, from: 'video' } : null;
  } catch {
    return null;
  }
}

/**
 * Make the whole finished thumbnail (person, props and words) as one picture, from the concept's description and a
 * photo of the creator. Never called without `artAllowed(project, source)`; it checks again.
 */
export async function generateThumbnail(req: ArtRequest): Promise<ArtOutcome> {
  const source = req.source ?? ART_SOURCES.codex;
  if (!artAllowed(req.project, source)) return { ok: false, code: 'no-consent', message: 'Nothing was sent: making pictures has not been allowed for this project.' };
  const photo = await creatorPhoto(req.projectPath, req.project, req.concept);
  if (req.signal.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled. Nothing was changed.' };
  const input = { imagePrompt: req.concept.imagePrompt || fallbackImagePrompt(req.concept), hasPhoto: !!photo, direction: req.direction, notes: req.notes ?? null };
  const id = `thumb_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const started = Date.now();
  const onAbort = () => void (source.id === 'fal' ? window.cutaway.gen.cancel(id) : window.cutaway.ai.cancel(id)).catch(() => undefined);
  req.signal.addEventListener('abort', onAbort, { once: true });
  const made = (path: string, note: string): ArtOutcome => ({ ok: true, art: { id: uid('art'), path, provider: source.consent, note, direction: req.direction.trim(), at: new Date().toISOString(), kind: 'thumbnail' }, durationMs: Date.now() - started });
  try {
    if (source.id === 'fal') {
      const r = await window.cutaway.gen.generate(req.projectPath, { jobId: id, provider: 'fal', kind: 'image', prompt: buildFullThumbnailPrompt(input), aspect: '16:9', ...(photo ? { referencePaths: [photo.path] } : { model: THUMBNAIL_TEXT_MODEL }) });
      return made(r.path, `fal.ai · ${r.model}${photo ? ` · from ${photo.from === 'photo' ? 'your photo' : 'a frame of you in the video'}` : ''}`);
    }
    const res = await window.cutaway.ai.generateImage({ id, projectPath: req.projectPath, prompt: buildCodexFullThumbnailPrompt(input), referencePaths: photo ? [photo.path] : [] });
    if (!res.ok || !res.path) return { ok: false, code: res.error?.code ?? 'failed', message: res.error?.code === 'cancelled' ? 'Cancelled. Nothing was changed.' : (res.error?.message ?? 'No picture was made.') };
    return made(res.path, res.note ?? '');
  } catch (e) {
    if (req.signal.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled. Nothing was changed.' };
    return { ok: false, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
}

/** The concept with this finished thumbnail in use (and kept as a variation); its earlier layers are kept to go back to. */
export function applyWholeThumbnail(c: PackagingConcept, art: GeneratedArt, add = true): PackagingConcept {
  return { ...c, art: add ? [...(c.art ?? []), art] : (c.art ?? []), layers: withWholeThumbnail(art), baseLayers: c.baseLayers ?? (isWholeThumbnail(c) ? undefined : c.layers) };
}

/** Back to the layers from before the whole thumbnail. */
export function withoutWholeThumbnail(c: PackagingConcept): PackagingConcept {
  return c.baseLayers ? { ...c, layers: c.baseLayers } : c;
}
