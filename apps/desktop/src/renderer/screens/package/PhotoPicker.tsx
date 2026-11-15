import { useEffect, useState } from 'react';
import { useApp } from '../../state/store';
import { Button } from '../../ui/kit';

/**
 * Which picture of the creator AI thumbnails are built on: a frame of them from the video (the default), or a photo
 * they chose, such as a studio headshot. The photo is saved once and used in every project.
 */
export function PhotoPicker() {
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void window.cutaway.ai.photo().then(setPhoto).catch(() => setPhoto(null));
  }, []);
  const choose = async () => {
    const [file] = await window.cutaway.app.pickFiles({ title: 'Choose a photo of yourself for thumbnails', kinds: ['image'], multiple: false });
    if (!file) return;
    try {
      setPhoto(await window.cutaway.ai.setPhoto(file));
      useApp.getState().toast('Your photo will be used for AI thumbnails in every project.');
    } catch (e) {
      useApp.getState().toast(e instanceof Error ? e.message : String(e));
    }
  };
  const clear = async () => setPhoto(await window.cutaway.ai.setPhoto(null).catch(() => null));
  if (photo === undefined) return null;
  return (
    <div className="row" style={{ gap: 10, alignItems: 'center' }} data-testid="thumb-photo">
      {photo ? <img src={window.cutaway.media.url(photo)} alt="Your photo for thumbnails" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flex: 'none' }} /> : null}
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="tiny">{photo ? 'Built on your photo' : 'Built on a frame of you from the video'}</span>
        <span className="tiny dim">{photo ? 'Used in every project.' : 'A clear, well-lit photo looks better.'}</span>
      </div>
      {photo ? (
        <Button size="sm" variant="ghost" onClick={() => void clear()} data-testid="thumb-photo-clear" title="Use frames from the video instead">
          Use the video
        </Button>
      ) : (
        <Button size="sm" onClick={() => void choose()} data-testid="thumb-photo-choose" title="Use a studio photo or headshot instead of a video frame">
          Use a photo…
        </Button>
      )}
    </div>
  );
}
