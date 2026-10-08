import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Local video extraction for Nova's teardown worker. Given a clip's media URL we
// download the mp4, pull keyframes + scene-cut timestamps via ffmpeg, and
// transcribe the audio with local faster-whisper. EVERYTHING is fail-open: a
// missing binary, a failed download, or a slow actor degrades to an empty/partial
// result and NEVER throws, so the teardown worker just proceeds with whatever it
// got (caption + thumbnail at worst). The pure helpers (arg builders + parsers)
// are exported so they can be unit-tested without the binaries installed.

const pexec = promisify(execFile);

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await pexec(cmd, args, {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface ExtractedVideo {
  transcript: string;
  segments: TranscriptSegment[];
  keyframePaths: string[];
  cutTimestamps: number[];
  durationS: number | null;
  localVideoPath: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers — no IO, unit-tested.
// ---------------------------------------------------------------------------

/** yt-dlp args: quiet download of a post URL to outPath. */
export function buildDownloadArgs(url: string, outPath: string): string[] {
  return ["-q", "--no-warnings", "--no-playlist", "-o", outPath, url];
}

/** ffmpeg args: extract mono 16k wav (what faster-whisper wants). */
export function buildAudioArgs(videoPath: string, wavPath: string): string[] {
  return ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wavPath];
}

/** ffmpeg args: scene-change keyframes + showinfo (so stderr carries pts_time). */
export function buildKeyframeArgs(videoPath: string, framePattern: string, sceneThreshold = 0.4): string[] {
  return ["-y", "-i", videoPath, "-vf", `select='gt(scene,${sceneThreshold})',showinfo`, "-vsync", "vfr", framePattern];
}

/** ffmpeg args: evenly-spaced frames at `fps` (fallback when scene detection yields none). */
export function buildIntervalFrameArgs(videoPath: string, framePattern: string, fps = 0.5): string[] {
  return ["-y", "-i", videoPath, "-vf", `fps=${fps}`, framePattern];
}

/** ffprobe args: print the duration in seconds, bare. */
export function buildDurationArgs(videoPath: string): string[] {
  return ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoPath];
}

/** Parse ffmpeg showinfo stderr → ordered scene-cut timestamps (pts_time). */
export function parseSceneCuts(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** Parse faster-whisper JSON (text + segments); falls back to plain-text stdout. */
export function parseWhisperJson(raw: string): { transcript: string; segments: TranscriptSegment[] } {
  try {
    const j = JSON.parse(raw) as {
      text?: string;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };
    const segments: TranscriptSegment[] = (j.segments ?? []).map((s) => ({
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0),
      text: (s.text ?? "").trim(),
    }));
    const transcript = (j.text ?? segments.map((s) => s.text).join(" ")).trim();
    return { transcript, segments };
  } catch {
    return { transcript: raw.trim(), segments: [] };
  }
}

/** Bare-number ffprobe duration → seconds, or null. */
export function parseDuration(stdout: string): number | null {
  const t = Number(stdout.trim());
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Evenly sample at most `maxFrames` from an ordered list of frame paths. */
export function selectKeyframes(paths: string[], maxFrames: number): string[] {
  if (maxFrames <= 0) return [];
  if (paths.length <= maxFrames) return paths;
  const step = paths.length / maxFrames;
  const out: string[] = [];
  for (let i = 0; i < maxFrames; i++) out.push(paths[Math.floor(i * step)]!);
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration — fail-open IO.
// ---------------------------------------------------------------------------

export interface ExtractVideoOpts {
  /** Direct media URL (mp4) — used for the fetch fallback. */
  videoUrl: string;
  /** Canonical post URL — preferred for yt-dlp (handles expiring CDN links). */
  postUrl?: string;
  /** Scratch dir for this clip's artifacts. */
  workDir: string;
  maxFrames?: number;
  exec?: ExecFn;
  ytDlpBin?: string;
  ffmpegBin?: string;
  ffprobeBin?: string;
  whisperBin?: string;
  whisperModel?: string;
  log?: { warn: (o: Record<string, unknown>, m: string) => void };
}

const EMPTY: ExtractedVideo = {
  transcript: "",
  segments: [],
  keyframePaths: [],
  cutTimestamps: [],
  durationS: null,
  localVideoPath: null,
};

async function listFrames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => /^frame-\d+\.jpg$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Download + extract a clip. Returns whatever succeeded; never throws. With no
 * binaries / a dead URL you get EMPTY and the teardown falls back to caption-only.
 */
export async function extractVideo(opts: ExtractVideoOpts): Promise<ExtractedVideo> {
  const exec = opts.exec ?? defaultExec;
  const maxFrames = opts.maxFrames ?? 6;
  const ytDlp = opts.ytDlpBin ?? "yt-dlp";
  const ffmpeg = opts.ffmpegBin ?? "ffmpeg";
  const ffprobe = opts.ffprobeBin ?? "ffprobe";
  const whisper = opts.whisperBin ?? "whisper-ctranslate2";

  try {
    await mkdir(opts.workDir, { recursive: true });
  } catch {
    return EMPTY;
  }
  const videoPath = join(opts.workDir, "video.mp4");

  // 1) download — yt-dlp on the post URL first, then a direct fetch of the media URL.
  let downloaded = false;
  if (opts.postUrl) {
    try {
      await exec(ytDlp, buildDownloadArgs(opts.postUrl, videoPath));
      downloaded = true;
    } catch {
      /* fall through to fetch */
    }
  }
  if (!downloaded && opts.videoUrl) {
    try {
      const res = await fetch(opts.videoUrl);
      if (res.ok) {
        await writeFile(videoPath, Buffer.from(await res.arrayBuffer()));
        downloaded = true;
      }
    } catch {
      /* leave downloaded=false */
    }
  }
