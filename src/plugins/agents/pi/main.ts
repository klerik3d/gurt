// pi, main half: the token probe.
import type { AgentMainPlugin } from '../../../shared/agentPlugin'
import { manifest } from './manifest'

export const main: AgentMainPlugin = {
  id: manifest.id,
  // The default `secretEnv` is ANTHROPIC_API_KEY, so the probe is Anthropic's
  // cheapest authenticated read. (opencode probes the same way, with its own
  // copy.)
  probeToken: (token) => ({
    label: 'Anthropic',
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
  })
}
