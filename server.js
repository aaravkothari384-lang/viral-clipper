const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const TEMP_DIR = path.join(__dirname, 'temp');
const OUT_DIR = path.join(__dirname, 'exports');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

app.use('/exports', express.static(OUT_DIR));

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 30 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Please paste a YouTube URL.' });

  try {
    const raw = await runCmd('yt-dlp', [
      '--dump-single-json',
      '--no-playlist',
      '--skip-download',
      url
    ]);

    const info = JSON.parse(raw);
    const duration = info.duration || 0;
    const heatmap = info.heatmap || [];
    let peaks = [];

    if (heatmap.length > 0) {
      const sorted = [...heatmap]
        .filter(h => h.value >= 0.4)
        .sort((a, b) => b.value - a.value);

      const chosen = [];
      for (const h of sorted) {
        const start = Math.max(0, Math.floor(h.start_time - 3));
        const end = Math.min(duration, Math.ceil(Math.max(h.end_time + 5, start + 22)));
        const overlaps = chosen.some(c => Math.abs(c.start - start) < 18);
        if (!overlaps && end - start >= 8) {
          chosen.push({ start, end });
          peaks.push({
            start,
            end,
            score: Math.round(h.value * 100),
            label: `Most Replayed Spike (${Math.round(h.value * 100)}% viewer retention)`
          });
        }
        if (peaks.length >= 5) break;
      }
    }

    if (peaks.length === 0 && duration > 10) {
      const step = Math.max(25, Math.floor(duration / 5));
      for (let t = 5; t < duration - 12 && peaks.length < 5; t += step) {
        peaks.push({
          start: t,
          end: Math.min(duration, t + 24),
          score: 88 - peaks.length * 4,
          label: 'High-Retention Highlight Window'
        });
      }
    }

    res.json({
      title: info.title || 'YouTube Video',
      duration,
      hasRealHeatmap: heatmap.length > 0,
      peaks
    });
  } catch (err) {
    res.status(500).json({ error: `Could not fetch video info: ${err.message}` });
  }
});

app.post('/api/generate', async (req, res) => {
  const {
    url,
    start,
    end,
    layoutMode = 'blur-fill',
    silenceCut = 'smart',
    colorFilter = 'vibrant',
    hookText = '',
    captions = ''
  } = req.body;

  if (!url) return res.status(400).json({ error: 'YouTube URL is required.' });

  const id = `short_${Date.now()}`;
  const rawFile = path.join(TEMP_DIR, `${id}_raw.mp4`);
  const srtFile = path.join(TEMP_DIR, `${id}.srt`);
  const outFile = path.join(OUT_DIR, `${id}.mp4`);

  try {
    const s = Math.max(0, Number(start) || 0);
    const e = Math.max(s + 5, Number(end) || s + 20);

    await runCmd('yt-dlp', [
      '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--download-sections', `*${s}-${e}`,
      '--force-keyframes-at-cuts',
      '--merge-output-format', 'mp4',
      '-o', rawFile,
      url
    ]);

    const lines = captions.split('\n').map(l => l.trim()).filter(Boolean);
    let hasSubs = false;
    if (lines.length > 0) {
      hasSubs = true;
      const total = e - s;
      const step = Math.max(1.8, total / lines.length);
      let srt = '';
      lines.forEach((line, i) => {
        const t1 = i * step;
        const t2 = Math.min(total, (i + 1) * step);
        srt += `${i + 1}\n${srtTime(t1)} --> ${srtTime(t2)}\n${line.toUpperCase()}\n\n`;
      });
      fs.writeFileSync(srtFile, srt, 'utf8');
    }

    let eq = '';
    if (colorFilter === 'vibrant') eq = ',eq=contrast=1.13:saturation=1.22:brightness=0.02';
    if (colorFilter === 'cinematic') eq = ',eq=contrast=1.18:saturation=1.06';

    let vFilter = '';
    if (layoutMode === 'center-punch') {
      vFilter = `[0:v]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0${eq}[v1]`;
    } else {
      vFilter =
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5,eq=brightness=-0.18[bg];` +
        `[0:v]scale=1080:-2${eq}[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[v1]`;
    }

    let pad = '[v1]';
    const extra = [];

    if (hookText.trim()) {
      const cleanHook = hookText.trim().replace(/[':\\]/g, '');
      extra.push(
        `${pad}drawtext=text='${cleanHook}':fontcolor=white:fontsize=46:box=1:boxcolor=black@0.82:boxborderw=22:x=(w-text_w)/2:y=150[v2]`
      );
      pad = '[v2]';
    }

    if (hasSubs) {
      const escSrt = srtFile.replace(/\\/g, '/').replace(/:/g, '\\:');
      extra.push(
        `${pad}subtitles='${escSrt}':force_style='Alignment=2,MarginV=230,FontName=Arial,FontSize=20,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Bold=1'[vout]`
      );
      pad = '[vout]';
    }

    const filterComplex = [vFilter, ...extra].join(';');
    const outPad = pad.replace(/[\[\]]/g, '');

    let aFilter = 'loudnorm=I=-14:TP=-1.5:LRA=11';
    if (silenceCut === 'smart') {
      aFilter = 'silenceremove=stop_periods=-1:stop_duration=0.45:stop_threshold=-38dB,loudnorm=I=-14:TP=-1.5:LRA=11';
    } else if (silenceCut === 'aggressive') {
      aFilter = 'silenceremove=stop_periods=-1:stop_duration=0.25:stop_threshold=-32dB,loudnorm=I=-14:TP=-1.5:LRA=11';
    }

    await runCmd('ffmpeg', [
      '-y',
      '-i', rawFile,
      '-filter_complex', filterComplex,
      '-map', `[${outPad}]`,
      '-map', '0:a?',
      '-af', aFilter,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outFile
    ]);

    if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
    if (fs.existsSync(srtFile)) fs.unlinkSync(srtFile);

    res.json({
      success: true,
      videoUrl: `/exports/${id}.mp4`,
      filename: `${id}.mp4`
    });
  } catch (err) {
    res.status(500).json({ error: `Generation failed: ${err.message}` });
  }
});

function srtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ViralClip Studio running on port ${PORT}`);
});
