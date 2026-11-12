# Verifies cross-source alignment of a synthetic take: the bar position in every video
# frame encodes host time, and the audio carries a beep at each host-clock second.
import json, subprocess, sys, struct, array
take = sys.argv[1]; BIN = sys.argv[2]
m = json.load(open(f"{take}/manifest.json"))
src = {s['id']: s for s in m['sources']}
def beeps(file, start):
    subprocess.run([BIN, 'pcm', f"{take}/{file}", '--out', f"{take}/.pcm.f32", '--rate', '48000'], check=True, capture_output=True)
    a = array.array('f'); a.frombytes(open(f"{take}/.pcm.f32", 'rb').read())
    on = []; i = 0
    while i < len(a):
        if abs(a[i]) > 0.1:
            on.append(i / 48000 + start); i += 4800 * 2
        else: i += 1
    return on
def frames(file, start, width):
    pts = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', f"{take}/{file}"], capture_output=True, text=True).stdout.split()
    pts = sorted(float(p) for p in pts)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f"{take}/{file}", '-vf', 'format=gray,crop=iw:1:0:10', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], capture_output=True).stdout
    out = []
    for n, t in enumerate(pts):
        row = raw[n * width:(n + 1) * width]
        if len(row) < width: break
        xs = [x for x in range(width) if row[x] > 200]
        if not xs or xs[-1] - xs[0] > 60: continue      # bar wrapping or missing
        phase = xs[0] / (width - 40)                     # = frac(host / 2)
        out.append((t + start, phase))
    return out
mic = beeps(src['microphone']['file'], src['microphone']['start'])
print('beep onsets (session s):', [round(b, 4) for b in mic])
if 'system' in src:
    sysb = beeps(src['system']['file'], src['system']['start'])
    print('mic vs system beep offset ms:', [round((a - b) * 1000, 2) for a, b in zip(mic, sysb)])
for vid in ['screen', 'cameraA', 'cameraB']:
    if vid not in src or src[vid].get('empty'): continue
    fr = frames(src[vid]['file'], src[vid]['start'], src[vid]['width'])
    errs = []
    cuts = [p['at'] for p in m.get('pauses', [])]
    seg = lambda x: sum(1 for c in cuts if x >= c)
    gaps = src[vid].get('gaps', [])
    for t, phase in fr:
        # compare only with a beep from the same pause-free stretch: host seconds shift across a pause
        same = [b for b in mic if seg(b + 0.05) == seg(t) and seg(b) == seg(t)]
        if not same: continue
        b = min(same, key=lambda x: abs(x - t))
        d = ((t - b) / 2 - phase) % 0.5                  # bar period 2 s, beeps every 1 s
        d = min(d, 0.5 - d) * 2
        errs.append((t, d * 1000))
    if not errs: print(vid, 'no comparable frames'); continue
    n = len(errs)
    pick = [errs[0], errs[n // 2], errs[-1]]
    print(f"{vid}: frames compared {n}, A/V offset ms  start {pick[0][1]:.1f} @ {pick[0][0]:.2f}s | middle {pick[1][1]:.1f} @ {pick[1][0]:.2f}s | end {pick[2][1]:.1f} @ {pick[2][0]:.2f}s | max {max(e[1] for e in errs):.1f}")
