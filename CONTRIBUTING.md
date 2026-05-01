# Contributing

Issues and pull requests are welcome.

Keep this publisher small and runtime-focused:

- Do not commit API keys, bearer tokens, private hostnames, or local logs.
- Keep HookBus credentials in environment variables.
- Add tests for any event mapping changes.
- Be explicit about OpenCode hook-surface limitations in docs and manifest.

Run before submitting:

```bash
npm test
```
