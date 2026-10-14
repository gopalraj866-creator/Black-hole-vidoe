#!/usr/bin/env bash
# Concatenate rendered shards, mix audio (music ducked under narration), mux final MP4.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=build/falling-into-a-black-hole.mp4

ls build/shards/*.mp4 | sort | while read -r f; do echo "file '$PWD/$f'"; done > build/list.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i build/list.txt -c copy build/video_only.mp4

# Music ducks under the voice-over (sidechain), then loudness-normalised.
ffmpeg -y -loglevel error \
  -i build/audio/music.wav -i build/audio/narration.wav \
  -filter_complex "[1:a]volume=1.6,asplit=2[n1][n2];[0:a][n1]sidechaincompress=threshold=0.03:ratio=8:attack=40:release=700:makeup=1[duck];[duck][n2]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,loudnorm=I=-16:TP=-1.5:LRA=11[a]" \
  -map "[a]" -ar 48000 build/mix.wav

ffmpeg -y -loglevel error -i build/video_only.mp4 -i build/mix.wav \
  -c:v copy -c:a aac -b:a 192k -movflags +faststart -shortest "$OUT"

cp build/subtitles.srt build/falling-into-a-black-hole.srt
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
echo "wrote $OUT"
