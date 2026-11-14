/**
 * Settings › AI tools: let Claude Code or Codex make videos in Cutaway through its MCP server, connect them in
 * one click, or copy the command to add it anywhere else.
 */
import { useEffect, useState } from 'react';
import type { ControlStatus } from '@shared/api';
import { useApp } from '../../state/store';
import { Banner, Button, Toggle } from '../../ui/kit';

const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function AiToolsSection() {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [busy, setBusy] = useState<'claude' | 'codex' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const refresh = () => void window.cutaway.control.status().then(setStatus).catch(() => {});
  useEffect(refresh, []);
  if (!status) return null;
  const cmd = [status.command, ...status.args].map(quote).join(' ');
  const claudeCmd = `claude mcp add --scope user cutaway -e ELECTRON_RUN_AS_NODE=1 -- ${cmd}`;
  const codexCmd = `codex mcp add cutaway --env ELECTRON_RUN_AS_NODE=1 -- ${cmd}`;
  const connect = async (tool: 'claude' | 'codex') => {
    setBusy(tool);
    setResult(null);
    try {
      setResult(await window.cutaway.control.connect(tool));
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => useApp.getState().toast('Copied.'));
  const tool = (id: 'claude' | 'codex', name: string, state: boolean | null) => (
    <div className="row between" style={{ gap: 12, minHeight: 34 }} data-testid={`aitools-${id}`}>
      <div className="col" style={{ gap: 1 }}>
        <span style={{ fontWeight: 520, fontSize: 12.5 }}>{name}</span>
        <span className="tiny dim">{state === null ? 'Not installed on this Mac.' : state ? 'Connected. Ask it to make a video with Cutaway.' : 'Not connected yet.'}</span>
      </div>
      {state !== null ? (
        <Button size="sm" variant={state ? 'ghost' : 'primary'} busy={busy === id} disabled={!status.enabled || !!busy} onClick={() => void connect(id)} data-testid={`aitools-connect-${id}`}>
          {state ? 'Connect again' : 'Connect'}
        </Button>
      ) : null}
    </div>
  );
  return (
    <>
      <section className="card set-section">
        <div>
          <div className="set-title">Make videos from Claude Code or Codex</div>
          <div className="tiny dim set-hint">
            Cutaway includes an MCP server, so the AI tool you already use can make videos here from a text request: import footage, cut it, add text, animations, music and captions, and export. You see every change in Cutaway as it happens, and you can keep editing by hand afterwards.
          </div>
        </div>
        <Toggle
          label="Let AI tools control Cutaway"
          hint="Only programs on this Mac that hold Cutaway’s private key can connect; nothing is reachable from the network."
          checked={status.enabled}
          onChange={(v) => void window.cutaway.control.setEnabled(v).then(setStatus)}
        />
        {tool('claude', 'Claude Code', status.claude)}
        {tool('codex', 'Codex', status.codex)}
        {result ? <Banner tone={result.ok ? 'info' : 'warn'}>{result.message}</Banner> : null}
      </section>
      <section className="card set-section">
        <div>
          <div className="set-title">Add it by hand</div>
          <div className="tiny dim set-hint">For other MCP clients, start this command (stdio) with the environment variable ELECTRON_RUN_AS_NODE=1. It opens Cutaway when it is not running.</div>
        </div>
        {[
          ['Claude Code', claudeCmd],
          ['Codex', codexCmd],
        ].map(([name, text]) => (
          <div key={name} className="col" style={{ gap: 4 }}>
            <span className="tiny dim">{name}</span>
            <div className="row" style={{ gap: 6 }}>
              <code className="input mono grow" style={{ fontSize: 11, overflowX: 'auto', whiteSpace: 'nowrap', padding: '6px 8px' }}>{text}</code>
              <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(text!)} aria-label={`Copy the ${name} command`} />
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
