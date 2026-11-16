/**
 * cutaway-mcp: lets an AI harness (Claude Code, Codex, or any MCP client) make videos in Cutaway.
 *
 * A Model Context Protocol server over stdio (newline-delimited JSON-RPC), with no dependencies so it ships
 * inside Cutaway.app and runs on the app's own runtime (ELECTRON_RUN_AS_NODE=1). Each tool call is passed to the
 * running Cutaway through its local control server (127.0.0.1, token in a file only this user can read); Cutaway
 * is opened if it is not running. Everything an AI does shows up live in Cutaway and stays editable by hand.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.3.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ───────────────────────────── tools ─────────────────────────────

type Schema = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra });
const N = (description: string, extra: Schema = {}): Schema => ({ type: 'number', description, ...extra });
const B = (description: string): Schema => ({ type: 'boolean', description });
const LABEL = S('Optional short name for this change, shown in Cutaway’s undo and version history.');
const RO = { readOnlyHint: true };

const OP_SCHEMA: Schema = {
  type: 'object',
  description:
    'One edit decision. All times are recording seconds. Shapes:\n' +
    '- {op:"cut", start, end, kind:"silence"|"filler"|"retake"|"trim"|"pacing", reason, confidence} — remove a stretch. A cut that removes speech needs confidence:"high"; otherwise it is left as a suggestion for the creator in Review.\n' +
    '- {op:"speed", start, end, speed (1.25–3)}\n' +
    '- {op:"zoom", start, end, scale (1.1–3), x, y (0–1 point to zoom on), follow (track the cursor)}\n' +
    '- {op:"layout", start, end, mode:"screen"|"camera"|"overlay"|"split"|"presenter", camera:"A"|"B"}\n' +
    '- {op:"overlay", kind:"lower-third"|"callout"|"section-card", start, end, text, subtext}\n' +
    '- {op:"broll", assetId (a source id from get_project), start, end, assetIn}',
  properties: { op: { type: 'string', enum: ['cut', 'speed', 'zoom', 'layout', 'overlay', 'broll'] } },
  required: ['op'],
  additionalProperties: true,
};

const TOOLS: Tool[] = [
  { name: 'status', description: 'Is Cutaway running, which project is open, and is it busy. Call this first.', inputSchema: obj({}), annotations: RO },
  { name: 'list_projects', description: 'The projects in the creator’s Cutaway library.', inputSchema: obj({}), annotations: RO },
  { name: 'create_project', description: 'Create a new empty project and open it.', inputSchema: obj({ name: S('Project name, for example the video’s working title.') }, ['name']) },
  { name: 'open_project', description: 'Open an existing project by name or path.', inputSchema: obj({ project: S('Project name (or part of it) or its full path.') }, ['project']) },
  {
    name: 'get_project',
    description:
      'Everything about the open project: sources (footage, audio, images and their ids), clips, length of the recording and of the finished video, how recording time maps to video time (keptStretches), every edit decision with its id, captions and output size.',
    inputSchema: obj({}),
    annotations: RO,
  },
  {
    name: 'import_media',
    description: 'Add files to the open project. Videos become clips at the end of the timeline, audio becomes music, pictures go over the video unless "as" says otherwise.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' }, as: S('auto (default), clips (pictures/videos on the video row), over (on top of the video, like B-roll), or music.', { enum: ['auto', 'clips', 'over', 'music'] }) }, ['paths']),
  },
  {
    name: 'prepare',
    description: 'Transcribe the speech and analyse the footage on this Mac, without changing the edit. Needed before get_transcript. Takes a while for long footage.',
    inputSchema: obj({}),
  },
  {
    name: 'get_transcript',
    description: 'What is said, as timed lines (recording seconds), with whether each line is currently cut. Optionally every word with its time.',
    inputSchema: obj({ start: N('From (recording seconds).'), end: N('To (recording seconds).'), words: B('Also return every word with its start and end.') }),
    annotations: RO,
  },
  {
    name: 'get_frame',
    description: 'A picture of the finished video at a moment, exactly as Cutaway will export it. Use it to check your work.',
    inputSchema: obj({ time: N('Video seconds.'), width: N('Pixels wide (160–1280, default 960).') }, ['time']),
    annotations: RO,
  },
  {
    name: 'first_cut',
    description:
      'Let Cutaway make an automatic first pass: removes pauses, filler words and retakes, picks layouts, zooms where the cursor clicks. By default its built-in rules do it (fast, free); you can then refine with apply_edits. Replaces earlier automatic decisions, never the creator’s.',
    inputSchema: obj({ pacing: S('relaxed, balanced or energetic.', { enum: ['relaxed', 'balanced', 'energetic'] }), target_seconds: N('Aim for about this many seconds of video.'), notes: S('Anything the edit should keep in mind.'), use_ai: B('Use the creator’s own Claude Code or Codex for this pass instead of the built-in rules.') }),
  },
  {
    name: 'apply_edits',
    description:
      'Apply edit decisions (cuts, speed-ups, zooms, layouts, graphics, B-roll) in one undoable step. Cutaway validates each one against the footage and refuses anything that does not fit, saying why. Times are recording seconds.',
    inputSchema: obj({ ops: { type: 'array', items: OP_SCHEMA, description: 'The decisions to add.' }, label: LABEL }, ['ops']),
  },
  { name: 'remove_items', description: 'Remove edit decisions, text, animations or audio by their ids (from get_project). Removing a cut brings that footage back.', inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } }, label: LABEL }, ['ids']), annotations: { destructiveHint: true } },
  {
    name: 'add_text',
    description: 'Put text on screen. Templates: plain, big-title, title-subtitle, editorial, punchy, chapter, end-card, lower-third-bar, lower-third-clean, label-pill, typed. Times are recording seconds.',
    inputSchema: obj({ text: S('The words.'), subtext: S('Second line, for templates that have one.'), template: S('Template id (default plain).'), start: N('When it appears (recording seconds).'), end: N('When it goes (recording seconds).'), x: N('Centre across, 0–1.'), y: N('Centre down, 0–1.'), label: LABEL }, ['text', 'start']),
  },
  {
    name: 'add_audio',
    description: 'Add an audio file (music, a voiceover or a sound effect) at a moment in the finished video. Music is quieter and lowered under speech unless told otherwise.',
    inputSchema: obj({ path: S('Absolute path of the audio file.'), kind: S('music (default), voice or sound.', { enum: ['music', 'voice', 'sound'] }), at: N('Video seconds (default 0).'), volume: N('Level, 0–1.5 (music default 0.35, voice 1).'), duck: B('Music only: lower it under speech (default true).'), loop: B('Music only: repeat to the end of the video.'), label: LABEL }, ['path']),
  },
  {
    name: 'add_photos',
    description: 'Add pictures as clips on the video row, in order (for videos made from stills, slides or generated images).',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Absolute image paths, in playing order.' }, seconds_each: N('How long each shows (default 4).') }, ['paths']),
  },
  { name: 'list_animation_templates', description: 'Ready-made animations (subscribe button, name tag, counter, title card, checklist, arrow, circle, highlighter, and the creator’s own) with the words and colours each one takes.', inputSchema: obj({}), annotations: RO },
  { name: 'get_animation_guide', description: 'The rules and two worked examples for writing a new animation as one HTML page, for add_animation’s "html".', inputSchema: obj({}), annotations: RO },
  {
    name: 'add_animation',
    description:
      'Add a motion graphic at a moment (recording seconds): a template by id with its fields, or your own HTML page written to the animation guide. A page is tested in Cutaway’s renderer first; if it fails you get the problems back to fix. Boxed animations (arrow, circle, highlighter) take a box over the part of the screen to point at.',
    inputSchema: obj(
      {
        template: S('Template id from list_animation_templates.'),
        html: S('A complete animation page (see get_animation_guide), instead of a template.'),
        description: S('With html: what it is, for the creator.'),
        fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Words and colours by field id, for example {"label": "Join"}.' },
        start: N('When it starts (recording seconds).'),
        box: obj({ x: N('Left, 0–1'), y: N('Top, 0–1'), w: N('Width, 0–1'), h: N('Height, 0–1') }, ['x', 'y', 'w', 'h']),
      },
      ['start'],
    ),
  },
  {
    name: 'generate',
    description:
      'Make media with the creator’s own ElevenLabs or fal.ai key (this spends their credits) and put it in the video: a voiceover from text, music or a sound effect from a description (placed at "at" video seconds), or a picture or short video (as a clip on the video row with place "clip", or over the video).',
    inputSchema: obj(
      {
        kind: S('voice, music, sound, image or video.', { enum: ['voice', 'music', 'sound', 'image', 'video'] }),
        prompt: S('For voice: the exact words to say. Otherwise: a description of what to make.'),
        provider: S('elevenlabs or fal (default: whichever has a key; images and video need fal).', { enum: ['elevenlabs', 'fal'] }),
        voice: S('Voice id (ElevenLabs) or name (fal).'),
        seconds: N('Length for music, sound effects and video.'),
        aspect: S('Pictures and video: 16:9, 9:16 or 1:1.', { enum: ['16:9', '9:16', '1:1'] }),
        place: S('Pictures and video: clip (on the video row) or over (default).', { enum: ['clip', 'over'] }),
        at: N('Audio: where it starts (video seconds).'),
        volume: N('Audio level, 0–1.5.'),
        instrumental: B('Music: no singing (default true).'),
      },
      ['kind', 'prompt'],
    ),
    annotations: { openWorldHint: true },
  },
  { name: 'set_captions', description: 'Captions from the transcript: burn them into the video or not, and their look.', inputSchema: obj({ burn_in: B('Burn captions into the video.'), style: S('pill, plain or bold.', { enum: ['pill', 'plain', 'bold'] }), position: S('bottom or top.', { enum: ['bottom', 'top'] }), size: N('0.5–2 (1 = normal).'), label: LABEL }) },
  {
    name: 'set_look',
    description: 'The video’s shape and frame: 16:9, 9:16, 1:1, 4:3 or 4:5; a solid or gradient background behind the footage; padding, corner radius and shadow.',
    inputSchema: obj({ shape: S('16:9, 9:16, 1:1, 4:3 or 4:5.'), background: S('Solid background colour, #rrggbb.'), gradient: { type: 'array', items: { type: 'string' }, description: 'Two to four #rrggbb colours.' }, padding: N('0–0.3 of the frame.'), corner_radius: N('0–0.2.'), shadow: N('0–1.'), label: LABEL }),
  },
  { name: 'undo', description: 'Undo the last change(s).', inputSchema: obj({ steps: N('How many (default 1).') }) },
  { name: 'redo', description: 'Redo the last undone change.', inputSchema: obj({}) },
  { name: 'list_versions', description: 'Saved versions of the edit, newest first.', inputSchema: obj({}), annotations: RO },
  { name: 'restore_version', description: 'Go back to a saved version (the current edit is kept as a version too).', inputSchema: obj({ revision: N('From list_versions.'), label: S('From list_versions.') }, ['revision']) },
  {
    name: 'export_video',
    description: 'Render the finished video to a file (MP4, or a GIF). Returns its path. Takes about as long as the video, sometimes less.',
    inputSchema: obj({ format: S('mp4 (default) or gif.', { enum: ['mp4', 'gif'] }), path: S('Where to save it (absolute path). Default: the creator’s exports folder.'), folder: S('Or just the folder.') }),
  },
  { name: 'show', description: 'Bring Cutaway forward on the editor (or the library) so the creator can look.', inputSchema: obj({ view: S('editor (default) or library.', { enum: ['editor', 'library'] }) }), annotations: RO },
];

const INSTRUCTIONS = `Cutaway is a Mac video editor. These tools drive the copy running on this Mac; everything you do appears live in its window and stays editable by hand, with undo and saved versions.

A typical video:
1. status, then create_project (or open_project).
2. import_media with the creator's footage, or build from scratch with add_photos / generate (images, voice, music).
3. prepare, then get_transcript, to read what is said (with times).
4. first_cut for an automatic pass, then apply_edits to cut, speed up, zoom, change layouts, add graphics and B-roll. Check refusals in the reply.
5. add_text, add_animation (templates or your own HTML), add_audio / generate for music and voice, set_captions, set_look.
6. get_frame at a few moments to look at the result; fix what looks wrong.
7. export_video, and tell the creator where the file is. They can open the project in Cutaway to keep editing.

Times: edit decisions, transcript, text and animations use recording seconds; audio, frames and exports use video seconds. get_project's keptStretches maps one to the other. generate spends the creator's own credits: only use it when asked to make media.`;

// ───────────────────────────── talking to Cutaway ─────────────────────────────

interface Control {
  port: number;
  token: string;
}
const controlFile = () => process.env.CUTAWAY_CONTROL_FILE || path.join(os.homedir(), 'Library', 'Application Support', 'Cutaway', 'control.json');
const readControl = (): Control | null => {
  try {
    const c = JSON.parse(fs.readFileSync(controlFile(), 'utf8')) as Control;
    return c.port && c.token ? c : null;
  } catch {
    return null;
  }
};

function post(c: Control, method: string, params: unknown, timeoutMs = 0): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const body = JSON.stringify({ method, params });
  return new Promise((done, fail) => {
    // its own connection, with no idle timeout: a transcription or an export can take many minutes
    const req = http.request({ host: '127.0.0.1', port: c.port, path: '/call', method: 'POST', agent: false, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d: string) => (text += d)).on('end', () => {
        try {
          done(JSON.parse(text));
        } catch {
          fail(new Error(`Cutaway answered with something unexpected (HTTP ${res.statusCode}).`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    req.end(body);
  });
}

/** The Cutaway.app this script lives in, if any. */
function appBundle(): string | null {
  if (process.env.CUTAWAY_APP) return process.env.CUTAWAY_APP;
  const m = /^(.*?\.app)\/Contents\//.exec(process.execPath) ?? /^(.*?\.app)\/Contents\//.exec(__filename);
  return m ? m[1]! : null;
}

let opening: Promise<Control> | null = null;
/** A live connection to Cutaway, opening the app when it is not running. */
async function connect(): Promise<Control> {
  const c = readControl();
  if (c && (await post(c, 'ping', {}, 3000).then((r) => r.ok).catch(() => false))) return c;
  if (opening) return opening;
  opening = (async () => {
    const bundle = appBundle();
    if (!bundle) throw new Error('Cutaway is not running. Open Cutaway, then try again.');
    // launched without the variable that makes this script's runtime act as plain Node, or Cutaway would too
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((ok) => execFile('/usr/bin/open', [bundle], { env }, () => ok()));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const n = readControl();
      if (n && (await post(n, 'ping', {}, 2000).then((r) => r.ok).catch(() => false))) return n;
    }
    throw new Error('Cutaway did not start accepting commands. If "Let AI tools control Cutaway" is off in Cutaway › Settings › AI tools, turn it on.');
  })().finally(() => (opening = null));
  return opening;
}

async function call(name: string, args: unknown): Promise<{ content: unknown[]; isError?: boolean }> {
  let c: Control;
  try {
    c = await connect();
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
  const r = await post(c, name, args ?? {}).catch((e: Error) => ({ ok: false, error: `Lost touch with Cutaway: ${e.message}` }) as { ok: boolean; error?: string; result?: unknown });
  if (!r.ok) return { content: [{ type: 'text', text: r.error ?? 'Cutaway could not do that.' }], isError: true };
  const result = r.result as Record<string, unknown> | undefined;
  // a frame comes back as a picture the model can look at
  if (result && typeof result.image === 'string' && result.image.startsWith('data:image/')) {
    const [head, data] = result.image.split(',');
    const { image: _image, ...rest } = result;
    return { content: [{ type: 'image', data, mimeType: /data:(.*?);/.exec(head!)?.[1] ?? 'image/png' }, { type: 'text', text: JSON.stringify(rest) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 1) }] };
}

// ───────────────────────────── MCP over stdio ─────────────────────────────

type Id = string | number | null;
const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id: Id, result: unknown) => write({ jsonrpc: '2.0', id, result });
const error = (id: Id, code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function onMessage(msg: { id?: Id; method?: string; params?: Record<string, unknown> }) {
  const { id = null, method, params } = msg;
  const isRequest = msg.id !== undefined;
  switch (method) {
    case 'initialize': {
      const asked = String(params?.protocolVersion ?? '');
      return reply(id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cutaway', title: 'Cutaway', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      if (!TOOLS.some((t) => t.name === name)) return error(id, -32602, `Unknown tool: ${name}`);
      return reply(id, await call(name, params?.arguments ?? {}));
    }
    default:
      if (isRequest && method && !method.startsWith('notifications/')) return error(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      error(null, -32700, 'Parse error');
      continue;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      inFlight++;
      void onMessage(m as Parameters<typeof onMessage>[0])
        .catch((e: Error) => error((m as { id?: Id }).id ?? null, -32603, e.message))
        .finally(() => {
          inFlight--;
          if (ended && inFlight === 0) process.exit(0);
        });
    }
  }
});
// when the client closes its side, finish the calls still running (an export, say), then stop
let inFlight = 0;
let ended = false;
process.stdin.on('end', () => {
  ended = true;
  if (inFlight === 0) process.exit(0);
});
