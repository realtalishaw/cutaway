import { TimeMap, buildCues, toSrt, type Appearance } from '@cutaway/core';
import { useApp, useProject } from '../../../state/store';
import { Segmented, Slider, Toggle } from '../../../ui/kit';
import { Reset, Section, setAppearance } from './shared';

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function CaptionsTab() {
  const project = useProject();
  const ap = project.edit.appearance;
  const t = project.transcript;
  const captions = (patch: Partial<Appearance['captions']>, label: string, key: string) => setAppearance((a) => ({ ...a, captions: { ...a.captions, ...patch } }), label, key);
  const exportTranscript = () => {
    const map = TimeMap.fromEdit(project.duration, project.edit);
    const cues = buildCues(project.transcript, project.edit, map);
    if (cues.length === 0) return useApp.getState().toast('There is no speech in the current cut to export.');
    download(`${project.name}.srt`, toSrt(cues));
  };
  return (
    <>
      <Section group="Transcript" title="Captions" icon="captions">
        <Toggle label="Hide transcript" hint="Off burns captions into the video. A captions.srt file is exported either way." checked={!ap.captions.burnIn} onChange={(v) => captions({ burnIn: !v }, 'Captions', 'cap')} />
      </Section>
      <Section title="Transcript size" icon="captions" action={<Reset show={ap.captions.size !== 1} onClick={() => captions({ size: 1 }, 'Caption size', 'capsize')} />}>
        <Slider min={0.6} max={1.8} value={ap.captions.size} onChange={(v) => captions({ size: v }, 'Caption size', 'capsize')} />
      </Section>
      <Section title="Style" icon="text">
        <Segmented full value={ap.captions.style} onChange={(v) => captions({ style: v }, 'Caption style', 'capstyle')} options={[{ value: 'pill', label: 'Pill' }, { value: 'plain', label: 'Outline' }, { value: 'bold', label: 'Bold' }]} />
        <Segmented full value={ap.captions.position} onChange={(v) => captions({ position: v }, 'Caption position', 'cappos')} options={[{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }]} />
      </Section>
      <Section title="Transcript" icon="captions">
        <button className="btn block" onClick={() => useApp.getState().setPanels({ tab: 'transcript' })}>
          Edit transcript
        </button>
        <button className="btn block" onClick={exportTranscript} disabled={!t?.hasSpeech}>
          Export transcript
        </button>
        <div className="tiny dim">{t ? (t.hasSpeech ? `${t.words.length} words, recognised on this Mac.` : 'No speech was found in this recording.') : 'Not transcribed yet. Open Edit transcript to transcribe on this Mac.'}</div>
      </Section>
    </>
  );
}
