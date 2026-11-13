// Re-signs the packaged app with a real code-signing identity, so macOS keeps
// its privacy permissions (Screen Recording, Camera, Microphone…) across
// rebuilds. An ad-hoc signature is tied to the exact build; an identity is not.
//
//   node scripts/sign.mjs [path/to/Cutaway.app]
//
// The identity comes from CUTAWAY_SIGN_IDENTITY or apps/desktop/.signing.local.json
// ({"identity": "<SHA-1 or name from `security find-identity -v -p codesigning`>"}),
// which is git-ignored. Without one the app stays ad-hoc signed and this says so.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.resolve(process.argv[2] ?? path.join(root, 'release/mac-arm64/Cutaway.app'));
const local = path.join(root, '.signing.local.json');
const identity = process.env.CUTAWAY_SIGN_IDENTITY || (fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8')).identity : '');
if (!fs.existsSync(app)) {
  console.error(`No app at ${app}. Run "pnpm package" first.`);
  process.exit(1);
}
if (!identity) {
  console.log('No signing identity configured: the app stays ad-hoc signed (permissions reset on every rebuild).');
  process.exit(0);
}
const sign = (target, extra = []) => execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp=none', ...extra, target], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 180000 });
// Inside out: the capture helper, then every nested bundle, then the app itself.
const helper = path.join(app, 'Contents/Resources/bin/cutaway-native');
if (fs.existsSync(helper)) sign(helper);
sign(app, ['--deep']);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const dv = spawnSync('/usr/bin/codesign', ['-dv', app], { encoding: 'utf8' });
const info = `${dv.stdout}${dv.stderr}`;
if (/Signature=adhoc/.test(info)) {
  console.error('The app is still ad-hoc signed.');
  process.exit(1);
}
console.log(`Signed ${path.basename(app)} with a code-signing identity (no longer ad-hoc).`);
