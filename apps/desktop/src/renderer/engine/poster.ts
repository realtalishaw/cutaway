/**
 * The picture on a project's card in the projects list: the chosen thumbnail when a package is chosen, otherwise a
 * frame from somewhere in the middle of the edit. Saved as poster.jpg inside the project folder.
 */
import { TimeMap, toSourceTime, type Project } from '@cutaway/core';
import { loadFrame, thumbnailJpeg } from './thumb';

const W = 640;
const H = 360;

/** Tells the projects list to show the new picture. */
const announce = (projectPath: string) => window.dispatchEvent(new CustomEvent('cutaway-poster', { detail: { projectPath } }));

/** The chosen package's thumbnail layers, if a package is chosen. */
function chosenLayers(project: Project) {
  const pkg = project.packaging;
  return pkg.selectedId ? (pkg.concepts.find((c) => c.id === pkg.selectedId)?.layers ?? null) : null;
}

/** A frame of the main picture at a random point between 20% and 80% of the finished video. */
async function frameJpeg(projectPath: string, project: Project): Promise<Uint8Array | null> {
  const order = ['screen', 'cameraA', 'cameraB', 'broll', 'image'];
  const src = project.sources.filter((s) => s.available && s.kind !== 'audio').sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))[0];
  if (!src) return null;
  const map = TimeMap.fromEdit(project.duration, project.edit);
  const out = map.outDuration * (0.2 + Math.random() * 0.6);
  const session = map.outDuration > 0 ? map.toSource(out) : project.duration / 2;
  const t = src.kind === 'image' ? 0 : Math.max(0, Math.min(toSourceTime(src.sync, session), Math.max(0, src.duration - 0.05)));
  const frame = await loadFrame({ projectPath, sources: project.sources }, src.id, t);
  if (!frame) return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const fw = frame.width;
  const fh = frame.height;
  if (!fw || !fh) return null;
  const s = Math.max(W / fw, H / fh);
  ctx.drawImage(frame, (W - fw * s) / 2, (H - fh * s) / 2, fw * s, fh * s);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.82));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * Save the card picture. With a chosen package it is always redrawn (the thumbnail may have been edited). Without
 * one, a frame is only taken when `replace` is set or there is no picture yet.
 */
export async function updatePoster(projectPath: string, project: Project, opts: { replace?: boolean; hasPoster?: boolean } = {}): Promise<'thumbnail' | 'frame' | null> {
  try {
    const layers = chosenLayers(project);
    if (layers?.length) {
      const { data } = await thumbnailJpeg(layers, { projectPath, sources: project.sources }, { width: W, height: H, maxBytes: 4_000_000 });
      await window.cutaway.library.savePoster(projectPath, data);
      announce(projectPath);
      return 'thumbnail';
    }
    if (opts.hasPoster && !opts.replace) return null;
    const data = await frameJpeg(projectPath, project);
    if (!data) return null;
    await window.cutaway.library.savePoster(projectPath, data);
    announce(projectPath);
    return 'frame';
  } catch {
    // A card picture is a nicety; never get in the way.
    return null;
  }
}
