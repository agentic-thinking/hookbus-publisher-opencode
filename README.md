# hookbus-publisher-opencode

Publishes OpenCode runtime events to **HookBus**, the reference event bus for AgentHook runtime evidence.

This publisher has two parts:

- OpenCode server plugin: registers in the user-level OpenCode config by default, so the normal `opencode` user path emits AgentHook events.
- `opencode-agenthook`: an optional wrapper around `opencode run --format json` for deterministic smoke tests and CI flight tests.

## Status

Usable publisher, tested against OpenCode `1.2.26`.

OpenCode is Gold-capable based on source audit. This package includes the native plugin path needed for the normal OpenCode user experience. Formal conformance still depends on running the AgentHook conformance suite against a configured OpenCode installation.

## Coverage

| AgentHook event | Status | Source |
|---|---|---|
| `SessionStart` | supported | OpenCode server plugin `event` |
| `UserPromptSubmit` | supported | OpenCode server plugin `chat.message` |
| `PreLLMCall` | supported | OpenCode server plugin `chat.params` |
| `PostLLMCall` | supported | OpenCode server plugin `event` plus wrapper flight test |
| `ModelResponse` | supported | OpenCode server plugin `event` plus wrapper flight test |
| `PreToolUse` | supported | OpenCode server plugin `tool.execute.before` |
| `PostToolUse` | supported | OpenCode `tool_use` |
| `AgentHandoff` | partial | OpenCode `task` tool metadata |
| `ErrorOccurred` | supported | OpenCode `error` |
| `SessionEnd` | partial | wrapper flight test; native TUI session-close event is not exposed consistently |

## Install

```bash
git clone https://github.com/agentic-thinking/hookbus-publisher-opencode
cd hookbus-publisher-opencode
./install.sh
```

The installer copies the wrapper to `~/.local/bin/opencode-agenthook`, copies the server plugin to `~/.local/share/opencode-agenthook/server.js`, writes `~/.local/share/opencode-agenthook/hookbus.env`, and registers the plugin in the user-level OpenCode config at `~/.config/opencode/opencode.json`.

To patch a specific project config instead:

```bash
OPENCODE_CONFIG_FILE=/path/to/opencode.json ./install.sh
```

## Run

```bash
opencode-agenthook run -m kimi-coding/kimi-for-coding --thinking "Reply OK"
```

Any OpenCode arguments after `run` are passed through. The wrapper reads HookBus settings from `~/.local/share/opencode-agenthook/hookbus.env`, written by the installer.

For normal user testing, launch OpenCode normally after install:

```bash
opencode
```

After install, the normal `opencode` command reads HookBus settings from the plugin-local `hookbus.env`, so it should apply across projects unless a custom `OPENCODE_CONFIG` or `OPENCODE_CONFIG_DIR` bypasses the normal config chain.

You can also install with npm from a local checkout:

```bash
npm install -g .
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `HOOKBUS_URL` | `http://localhost:18800/event` | HookBus endpoint |
| `HOOKBUS_TOKEN` | empty | Bearer token |
| `HOOKBUS_SOURCE` | `opencode-agenthook` | Dashboard source label |
| `HOOKBUS_FAIL_MODE` | `open` | Set `closed` to fail on publish errors |
| `HOOKBUS_DEBUG` | empty | Print publish failures |
| `OPENCODE_AGENTHOOK_PLUGIN_TOOLS` | enabled | Set `0` to make the wrapper emit observed tool events when the server plugin is not loaded |

When HookBus returns `deny` or `ask` to a plugin `PreToolUse` event, the plugin raises an error before the tool executes. In fail-open mode, bus connectivity failures do not block OpenCode.

## Test

```bash
npm test
```

## Security

The installer stores the HookBus bearer token in `~/.local/share/opencode-agenthook/hookbus.env` with user-only permissions. The publisher sends that token only as a bearer token to HookBus.

Do not commit `.env` files, HookBus bearer tokens, model provider keys, private hostnames, or logs containing prompts.

## Trademarks

OpenCode is a trademark of its respective owner. Used here nominatively to identify the runtime this publisher integrates with. No affiliation with, endorsement by, or sponsorship from OpenCode is claimed or implied.

HookBus is a trademark of Agentic Thinking Limited.

## License

MIT.
