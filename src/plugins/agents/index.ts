// The built-in agent plugins, shared half — the one place main AND the renderer
// learn which agent kinds exist (through src/shared/agents.ts). Manifests and
// pure shared hooks only: this file is bundled into the renderer, so it never
// imports a plugin's main.ts (that list is ./main.ts).
//
// Order is a persisted-looking fact: it is the order every picker lists kinds
// in, and the first entry is the default kind (Welcome, Settings → Clients).
//
// Adding an agent: a folder beside this file (manifest.ts, plus shared.ts /
// main.ts only if it needs code), its import and its entry below, and — when it
// has a main.ts — the same in ./main.ts. Nothing in the core changes.
import type { AgentPlugin } from '../../shared/agentPlugin'
import { manifest as claudeCode } from './claude-code/manifest'
import { shared as claudeCodeShared } from './claude-code/shared'
import { manifest as codex } from './codex/manifest'
import { manifest as gemini } from './gemini/manifest'
import { manifest as opencode } from './opencode/manifest'
import { manifest as pi } from './pi/manifest'

export const AGENT_PLUGINS: readonly AgentPlugin[] = [
  { manifest: claudeCode, ...claudeCodeShared },
  { manifest: codex },
  { manifest: gemini },
  { manifest: opencode },
  { manifest: pi }
]
