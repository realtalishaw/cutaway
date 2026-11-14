# Contributing to Cutaway

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

## Report a bug or ask for a feature

Open an [issue](https://github.com/realtalishaw/cutaway/issues). For a bug,
include:

- what you did, what you expected, and what happened instead
- your macOS version and Mac model
- whether it happened while recording, editing or exporting
- a screenshot or short screen recording if you can

Please leave out anything private: no API keys, and no footage you don't want
public.

## Make a change

1. **Fork** the repo and create a branch from `main`.
2. **Set up** (Apple silicon Mac, macOS 14+, Xcode command line tools, Node 22,
   pnpm 9):

   ```bash
   pnpm install
   pnpm dev
   ```

3. **Make your change.** Keep it focused: one fix or feature per pull request.
4. **Check it:**

   ```bash
   pnpm typecheck
   pnpm test
   ```

   If you changed something you can see in the app, run the matching end-to-end
   script in `apps/desktop/e2e` (for example `node apps/desktop/e2e/clips.mjs`
   after `pnpm --filter @cutaway/desktop build`). Each script says at the top
   what it covers. Add or extend one when you add a feature.
5. **Open a pull request** that says what changed and why, and how you tested
   it. Screenshots help for anything visual.

## Ground rules

- **Privacy first.** Video and audio never leave the Mac unless the person
  explicitly asks an AI or generation service to do something. Don't add
  analytics, uploads or network calls without that.
- **No secrets in the repo.** API keys belong in the app's settings (stored
  encrypted), never in code, tests or fixtures.
- **Everything stays undoable.** Edits go through the project's undo history;
  AI changes are proposals the person accepts.
- **Plain words in the UI.** Say what something does, in the words a creator
  would use.
- **Tests don't call real AI.** End-to-end runs use the built-in stand-in
  provider. Scripts that use real accounts or record the real screen are
  opt-in and named `*-real*`.

## Where things are

See the **Repository** section of the [README](README.md), and
[docs/ENGINEERING_REPORT.md](docs/ENGINEERING_REPORT.md) for how the pieces fit
together. The native capture helper's messages are documented in
[docs/NATIVE_PROTOCOL.md](docs/NATIVE_PROTOCOL.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
