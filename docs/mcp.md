# Make videos from Claude Code or Codex

Cutaway includes an [MCP](https://modelcontextprotocol.io) server, `cutaway-mcp`, so the AI tool you already use
can make videos in Cutaway from a text request:

> Make a finished clip from ~/Movies/settings-tour.mov: cut anything slow, add a title, a subscribe button near the
> end, bold captions, and export it.

Everything the AI does happens in the Cutaway window as you watch, and stays editable: open the project and keep
going by hand, undo any step, or go back to an earlier version.

## Connect it

**Easiest:** in Cutaway, open **Settings → AI tools** and click **Connect** next to Claude Code or Codex. Then start
a new session in that tool and ask it to make a video with Cutaway.

**By hand** (the same command is shown in Settings → AI tools, with your paths filled in):

```bash
claude mcp add --scope user cutaway -e ELECTRON_RUN_AS_NODE=1 -- /Applications/Cutaway.app/Contents/MacOS/Cutaway /Applications/Cutaway.app/Contents/Resources/mcp/cutaway-mcp.cjs
```

```bash
codex mcp add cutaway --env ELECTRON_RUN_AS_NODE=1 -- /Applications/Cutaway.app/Contents/MacOS/Cutaway /Applications/Cutaway.app/Contents/Resources/mcp/cutaway-mcp.cjs
```

Any other MCP client works the same way: a stdio server started with that command and the environment variable
`ELECTRON_RUN_AS_NODE=1`. It runs on Cutaway's own runtime, so nothing else needs installing, and it opens
Cutaway if it isn't running.

For long jobs in Codex (an export of a long video), you can raise its tool timeout in `~/.codex/config.toml`:

```toml
[mcp_servers.cutaway]
tool_timeout_sec = 1800
```

## How it works

- Cutaway runs a small control server on `127.0.0.1` only, behind a random key stored in
  `~/Library/Application Support/Cutaway/control.json` (readable only by you). Nothing is reachable from the
  network.
- `cutaway-mcp` reads that key and passes each tool call to Cutaway, which carries it out with the same functions
  as its own buttons. Edit decisions are validated against your footage exactly like the built-in AI's.
- Changes made through MCP are marked as AI decisions, appear in **Review**, and are saved as named versions
  ("AI tool: …") in **History**.
- Turn it off any time: **Settings → AI tools → Let AI tools control Cutaway**.
- Media generation (`generate`) uses your own ElevenLabs or fal.ai key and spends your credits; the AI is told
  to use it only when you ask for generated media.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Whether Cutaway is running, the open project, and whether it is busy |
| `list_projects`, `create_project`, `open_project` | Your Cutaway library |
| `get_project` | Sources, clips, lengths, every edit decision with its id, how recording time maps to video time |
| `import_media` | Add footage, audio or pictures |
| `prepare` | Transcribe and analyse on your Mac, without changing the edit |
| `get_transcript` | What is said, as timed lines (and words) |
| `get_frame` | A picture of the finished video at a moment, so the AI can check its work |
| `first_cut` | Automatic pass: pauses, fillers, retakes, layouts, zooms (built-in rules by default) |
| `apply_edits` | Cuts, speed-ups, zooms, layouts, graphics and B-roll, validated, in one undoable step |
| `remove_items` | Take decisions, text, animations or audio out by id |
| `add_text` | Text and titles from Cutaway's templates |
| `add_audio` | Music, a voiceover or a sound effect from a file |
| `add_photos` | Pictures as clips on the video row |
| `list_animation_templates`, `get_animation_guide`, `add_animation` | Motion graphics: templates, or the AI's own HTML animation (tested before it is added) |
| `generate` | Voice, music, sound effects, pictures or video with your own ElevenLabs or fal.ai key |
| `set_captions`, `set_look` | Captions, video shape, background and frame |
| `undo`, `redo`, `list_versions`, `restore_version` | History |
| `export_video` | Render an MP4 or GIF and return its path |
| `show` | Bring Cutaway forward so you can look |

**Times.** Edit decisions, the transcript, text and animations use *recording seconds* (the footage's own
timeline); audio, frames and exports use *video seconds* (the finished video). `get_project` lists how the two
line up.

**A cut that removes speech** needs `confidence: "high"`; otherwise Cutaway keeps it as a suggestion for you to
approve in Review.
