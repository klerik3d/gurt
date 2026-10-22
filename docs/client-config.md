# Client JSON configuration

In **Settings → Clients**, open a Claude Code, OpenCode, or Pi profile and edit
**Config JSON**. Each profile has its own native JSON object, stored under
`config` in `~/.gurt/agents.json`. Invalid JSON and non-object values cannot
be saved. Other client kinds do not yet expose this field.

On the next session start/restart, gurt writes this object to the native
user config inside that session’s container:

| Client | Container file |
| --- | --- |
| Claude Code | `~/.claude/settings.json` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Pi | `~/.pi/agent/settings.json` |

The profile owns the complete contents of this file. Clearing a previously
saved config writes `{}` on the next launch, removing its previous settings.
Profiles that have never configured JSON do not write a file. Running clients
need a restart. Native project/managed settings and explicit session model
selections can override these user defaults. Custom config-directory environment
variables can redirect the client away from these standard paths.

## Claude Code: no attribution

Use the **Example: no attribution** button, or paste:

```json
{
  "attribution": {
    "commit": "",
    "pr": "",
    "sessionUrl": false
  }
}
```

See [Claude Code settings](https://code.claude.com/docs/en/settings).

## OpenCode through OpenRouter

Link an API key from **Credentials**, set **Secret env var** to
`OPENROUTER_API_KEY`, and use **Example: OpenRouter** (which also sets this
environment variable name). For example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openrouter/anthropic/claude-sonnet-4.5",
  "provider": {
    "openrouter": {
      "options": { "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": { "anthropic/claude-sonnet-4.5": {} }
    }
  }
}
```

Replace the example model ID with your OpenRouter model ID; add more entries
under `provider.openrouter.models` for additional models. The `model` value
includes the `openrouter/` prefix. Keep the actual key in Credentials, since
client config is stored in the configuration journal. Ensure your environment’s
network policy allows the provider endpoint.

See [OpenCode config](https://opencode.ai/docs/config/) and
[OpenRouter provider settings](https://opencode.ai/docs/providers/#openrouter).

## Pi through OpenRouter

Link your OpenRouter key from **Credentials** and set **Secret env var** to
`OPENROUTER_API_KEY`. The **Example: OpenRouter** button sets this variable
name and inserts:

```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "anthropic/claude-sonnet-4.5"
}
```

Replace `defaultModel` with the desired model ID from Pi's provider catalog.
Pi uses the provider in a separate field; do not add `openrouter/` to this model
ID. Other Pi settings, such as `defaultThinkingLevel` and `enabledModels`, can
be included in the same object. Custom model definitions belong to Pi's separate
`models.json`; this editor writes `settings.json` only. `PI_CODING_AGENT_DIR`
redirects Pi away from the default agent directory.
