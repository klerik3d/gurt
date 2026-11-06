// The built-in agent plugins, main half — the hooks only the main process runs
// (through src/main/agentPlugins.ts). Never imported by the renderer or by
// src/shared: their list is ./index.ts.
//
// An agent with no main.ts has no line here; one with a main.ts has its import
// and its entry below. Order follows ./index.ts.
import type { AgentMainPlugin } from '../../shared/agentPlugin'
import { main as claudeCode } from './claude-code/main'
import { main as codex } from './codex/main'
import { main as gemini } from './gemini/main'
import { main as opencode } from './opencode/main'
import { main as pi } from './pi/main'

export const AGENT_MAIN_PLUGINS: readonly AgentMainPlugin[] = [claudeCode, codex, gemini, opencode, pi]
