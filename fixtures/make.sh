#!/bin/bash
# Generates deterministic test footage into fixtures/generated (git-ignored).
# Needs ffmpeg and the macOS `say` command. Nothing here is real creator footage.
set -euo pipefail
cd "$(dirname "$0")"
OUT=generated
mkdir -p "$OUT"
FF="ffmpeg -hide_banner -loglevel error -y"

# Narration with long pauses, a filler, a negation and a retake.
say -v Samantha -r 175 -o "$OUT/narration.aiff" "Welcome to the settings tour. [[slnc 2600]] First, open the export panel. [[slnc 900]] Um. [[slnc 700]] So first we choose the format. So first we choose the format and the frame rate. [[slnc 3200]] Do not delete this file, because the project needs it. [[slnc 1800]] Now press render and wait for the result. [[slnc 5200]] There it is. The export finished in twelve seconds. [[slnc 1500]] That is the whole workflow."
$FF -i "$OUT/narration.aiff" -ar 48000 -ac 1 "$OUT/narration.wav"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/narration.wav")
TOTAL=$(python3 -c "print(round($DUR + 3.0, 2))")

# "Screen": a fake app window whose content changes at known times (so visual activity is measurable).
$FF -f lavfi -i "color=c=0x1b1f2a:s=1920x1080:r=30:d=$TOTAL" -i "$OUT/narration.wav" -filter_complex "\
[0:v]drawbox=x=0:y=0:w=1920:h=64:color=0x2a3040:t=fill,\
drawtext=text='Export Studio':fontcolor=white:fontsize=30:x=40:y=18,\
drawbox=x=120:y=160:w=760:h=420:color=0x283044:t=fill,\
drawtext=text='Format\: MP4  H.264':fontcolor=0xd0d6e4:fontsize=40:x=160:y=220:enable='gte(t,9)',\
drawtext=text='Frame rate\: 30 fps':fontcolor=0xd0d6e4:fontsize=40:x=160:y=300:enable='gte(t,13)',\
drawbox=x=1040:y=160:w=640:h=120:color=0xff5a36:t=fill:enable='between(t,24,26)',\
drawtext=text='Render':fontcolor=white:fontsize=56:x=1260:y=190,\
drawbox=x=1040:y=360:w='640*min(1\,max(0\,(t-26)/4))':h=40:color=0x6fd3c0:t=fill:enable='between(t,26,30.2)',\
drawtext=text='Export finished in 12 seconds':fontcolor=0x9bd68f:fontsize=44:x=1040:y=440:enable='gte(t,30.2)'[v]" \
  -map "[v]" -map 1:a -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 128k -t "$TOTAL" "$OUT/screen.mp4"

# "Camera A": different picture, same room sound, started 1.5 s later (independent device).
$FF -f lavfi -i "testsrc2=s=1280x720:r=30:d=$TOTAL" -itsoffset 0 -i "$OUT/narration.wav" -filter_complex "[0:v]drawtext=text='CAMERA A':fontcolor=white:fontsize=64:x=40:y=40:box=1:boxcolor=black@0.5[v];[1:a]volume=0.5,highpass=f=200[a]" \
  -map "[v]" -map "[a]" -ss 1.5 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 96k -t "$(python3 -c "print($TOTAL - 1.5)")" "$OUT/camera-a.mov"

# "Camera B": starts 8 s late, stops early, and has NO shared audio (must be aligned by hand).
$FF -f lavfi -i "smptebars=s=1280x720:r=30:d=14" -filter_complex "[0:v]drawtext=text='CAMERA B':fontcolor=white:fontsize=64:x=40:y=40:box=1:boxcolor=black@0.5[v]" -map "[v]" -c:v libx264 -preset veryfast -pix_fmt yuv420p "$OUT/camera-b.mov"

# B-roll clip + still, a music bed, a silent screen demo and a corrupt file.
$FF -f lavfi -i "mandelbrot=s=1280x720:r=30" -t 8 -c:v libx264 -preset veryfast -pix_fmt yuv420p "$OUT/broll-render-farm.mp4"
$FF -f lavfi -i "gradients=s=1920x1080:c0=0x112233:c1=0xff5a36" -frames:v 1 "$OUT/still-diagram.png"
$FF -f lavfi -i "sine=frequency=220:duration=60" -filter_complex "volume=0.2" -ar 48000 "$OUT/music-bed.wav"
$FF -f lavfi -i "color=c=0x202428:s=1920x1080:r=30:d=30" -filter_complex "[0:v]drawbox=x='200+40*floor(t)':y=300:w=200:h=200:color=0x6fd3c0:t=fill:enable='lt(t,6)',drawbox=x=900:y=300:w=300:h=300:color=0xf5c84b:t=fill:enable='gte(t,22)'[v]" -map "[v]" -c:v libx264 -preset veryfast -pix_fmt yuv420p "$OUT/silent-demo.mp4"
head -c 200000 /dev/urandom > "$OUT/corrupt.mp4"
echo "fixtures ready in fixtures/$OUT (narration ${DUR}s, total ${TOTAL}s)"
