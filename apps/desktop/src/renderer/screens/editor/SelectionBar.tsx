/**
 * The bar above the preview while something on the timeline is selected: the few things you can do to
 * that one thing, as buttons, with "…" for the rest. Music gets its level and fades right here.
 */
import { useState } from 'react';
import { clipLength, clipTrim, clipsOf, isPhotoClip, musicClipsOf, playingClips } from '@cutaway/core';
import { setPhotoLength } from '../../state/actions';
import { readOnly, selectedItems, useApp, useShownProject } from '../../state/store';
import { Icon, type IconName } from '../../ui/icons';
import { Slider } from '../../ui/kit';
import { PopMenu, anchorOf, type Anchor } from '../../ui/PopMenu';
import { selectionMenuItems } from './addMenus';
import { removeClipById, splitClipAtPlayhead } from './clipOps';
import { duplicateSelected } from './itemOps';
import { removeSelected, restoreOne } from './ops';
import { patchMusic } from './titleSoundOps';

const split = () => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'split' }));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${v.toFixed(1)}s`;

function Btn({ icon, label, onClick, on, testId, title }: { icon?: IconName; label: string; onClick(e: React.MouseEvent<HTMLButtonElement>): void; on?: boolean; testId?: string; title?: string }) {
  return (
    <button className={`selbar-btn${on ? ' on' : ''}`} onClick={onClick} data-testid={testId} title={title ?? label}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {label}
    </button>
  );
}

export function SelectionBar() {
  const project = useShownProject();
  const sel = useApp((s) => s.selection);
  const also = useApp((s) => s.also);
  const ro = useApp(readOnly);
  const [pop, setPop] = useState<{ kind: 'volume' | 'fade' | 'more' | 'length'; anchor: Anchor } | null>(null);
  if (!sel || ro || sel.kind === 'range' || sel.kind === 'words' || sel.kind === 'lock' || sel.kind === 'suggestion') return null;
  const many = selectedItems({ selection: sel, also });
  const open = (kind: 'volume' | 'fade' | 'more' | 'length') => (e: React.MouseEvent<HTMLButtonElement>) => setPop(pop?.kind === kind ? null : { kind, anchor: anchorOf(e.currentTarget, false) });
  const more = <Btn icon="dots" label="" title="More" testId="selbar-more" onClick={open('more')} />;
  const del = <Btn icon="trash" label="Delete" testId="selbar-delete" onClick={() => removeSelected()} />;

  let title = '';
  let buttons: React.ReactNode = null;
  const music = sel.kind === 'music' ? musicClipsOf(project.edit, project.sources).find((c) => c.id === sel.id) : undefined;
  if (many.length > 1) {
    title = `${many.length} items`;
    buttons = (
      <>
        <Btn icon="copy" label="Duplicate" onClick={() => duplicateSelected()} />
        {del}
      </>
    );
  } else if (sel.kind === 'clip') {
    const clips = playingClips(clipsOf(project));
    const c = clips.find((x) => x.id === sel.id);
    const photo = !!c && isPhotoClip(project, c);
    title = c ? `${photo ? 'Photo · ' : ''}${c.name}` : 'Clip';
    const shown = c ? clipLength(c) - clipTrim(project.edit, c).head - clipTrim(project.edit, c).tail : 0;
    buttons = (
      <>
        {photo && c ? <Btn label={`Length ${secs(shown)}`} title="How long the photo is shown" testId="selbar-length" on={pop?.kind === 'length'} onClick={open('length')} /> : null}
        <Btn icon="scissors" label="Split" title="Split at the playhead (S)" testId="selbar-split" onClick={() => void splitClipAtPlayhead(project)} />
        {clips.length > 1 ? <Btn icon="trash" label="Remove" testId="selbar-delete" onClick={() => void removeClipById(sel.id)} /> : null}
      </>
    );
  } else if (sel.kind === 'cut') {
    title = 'Removed part';
    buttons = <Btn icon="undo" label="Bring back" testId="selbar-restore" onClick={() => restoreOne(sel.id)} />;
  } else if (music) {
    title = project.sources.find((s) => s.id === music.sourceId)?.name ?? 'Music';
    buttons = (
      <>
        <Btn icon="speaker" label={`Volume ${pct(music.gain)}`} testId="selbar-volume" on={pop?.kind === 'volume'} onClick={open('volume')} />
        <Btn label="Fade" testId="selbar-fade" on={pop?.kind === 'fade'} onClick={open('fade')} />
        <Btn label={music.loop ? 'Looping' : 'Loop'} title="Start the song again when it runs out" testId="selbar-loop" on={!!music.loop} onClick={() => patchMusic(music.id, { loop: !music.loop }, music.loop ? 'Stop looping music' : 'Loop music')} />
        <Btn icon="scissors" label="Split" title="Split at the playhead (S)" onClick={split} />
        {del}
      </>
    );
  } else {
    const kind = sel.kind;
    const o = kind === 'overlay' ? project.edit.overlays.find((x) => x.id === sel.id) : undefined;
    title = o ? (o.kind === 'text' ? `Text · ${o.text}` : o.kind === 'motion' ? `Animation · ${o.text}` : o.text) : ({ zoom: 'Zoom', broll: 'Photo or B-roll', mask: 'Mask', layout: 'View', speed: 'Speed change', sound: 'Sound effect' } as Record<string, string>)[kind] ?? '';
    buttons = (
      <>
        {o?.kind === 'motion' ? <Btn icon="sparkle" label="Change with AI" testId="selbar-motion-revise" onClick={() => window.dispatchEvent(new CustomEvent('cutaway-motion', { detail: o.id }))} /> : null}
        {o ? <Btn icon="text" label="Edit" title="Edit in the panel on the right" onClick={() => useApp.getState().setPanels({ inspector: true })} /> : null}
        <Btn icon="copy" label="Duplicate" testId="selbar-duplicate" onClick={() => duplicateSelected()} />
        {kind !== 'sound' && o?.kind !== 'motion' ? <Btn icon="scissors" label="Split" title="Split at the playhead (S)" onClick={split} /> : null}
        {del}
      </>
    );
  }

  return (
    <div className="selbar" role="toolbar" aria-label="Selected item" data-testid="selection-bar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="selbar-title">{title}</span>
      <i className="selbar-sep" />
      {buttons}
      {more}
      {pop?.kind === 'more' ? <PopMenu anchor={pop.anchor} label="More" onClose={() => setPop(null)} items={selectionMenuItems(project)} /> : null}
      {pop?.kind === 'length' && sel.kind === 'clip' ? (
        <PopMenu anchor={pop.anchor} label="Photo length" onClose={() => setPop(null)} width={260}>
          <div className="pm-body">
            {(() => {
              const c = clipsOf(project).find((x) => x.id === sel.id);
              if (!c) return null;
              const t = clipTrim(project.edit, c);
              return <Slider label="Shown for" min={0.5} max={30} step={0.1} value={clipLength(c) - t.head - t.tail} format={secs} onChange={(v) => setPhotoLength(c.id, v + t.head + t.tail, 'bar')} />;
            })()}
          </div>
        </PopMenu>
      ) : null}
      {pop && music && (pop.kind === 'volume' || pop.kind === 'fade') ? (
        <PopMenu anchor={pop.anchor} label={pop.kind === 'volume' ? 'Volume' : 'Fade'} onClose={() => setPop(null)} width={260}>
          <div className="pm-body">
            {pop.kind === 'volume' ? (
              <Slider label="Volume" min={0} max={1} value={music.gain} format={pct} onChange={(v) => patchMusic(music.id, { gain: v }, 'Music level', 'gain')} />
            ) : (
              <>
                <Slider label="Fade in" min={0} max={Math.min(8, music.length)} step={0.1} value={music.fadeIn} format={secs} onChange={(v) => patchMusic(music.id, { fadeIn: v }, 'Fade in', 'fadeIn')} />
                <Slider label="Fade out" min={0} max={Math.min(8, music.length)} step={0.1} value={music.fadeOut} format={secs} onChange={(v) => patchMusic(music.id, { fadeOut: v }, 'Fade out', 'fadeOut')} />
              </>
            )}
          </div>
        </PopMenu>
      ) : null}
    </div>
  );
}
