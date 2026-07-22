// Pure-logic test for the turn-contract enforcement decision (§7.2 of
// docs/requirements-turn-contract.md): the `postTurnDecision` matrix out of the
// session manager. No docker, no electron.
import { it } from 'vitest'
import assert from 'node:assert/strict'

import { NUDGE_PROMPT, postTurnDecision } from '../src/main/sessions'

const decide = (o: Partial<Parameters<typeof postTurnDecision>[0]>) =>
  postTurnDecision({ threw: false, isNudge: false, stopReason: 'end_turn', turnComplete: false, ...o })

it('end_turn with complete → none', () => {
  assert.equal(decide({ turnComplete: true }), 'none')
})

it('end_turn without complete → exactly one nudge', () => {
  assert.equal(decide({ turnComplete: false }), 'nudge')
})

it('nudge turn without complete → incomplete, no second nudge', () => {
  assert.equal(decide({ turnComplete: false, isNudge: true }), 'incomplete')
})

it('complete arriving during the nudge turn → clean, no incomplete', () => {
  assert.equal(decide({ turnComplete: true, isNudge: true }), 'none')
})

it('a non-end_turn stop (cancel) never nudges, complete or not', () => {
  assert.equal(decide({ stopReason: 'cancelled', turnComplete: false }), 'none')
  assert.equal(decide({ stopReason: 'max_tokens', turnComplete: false }), 'none')
  assert.equal(decide({ stopReason: undefined, turnComplete: false }), 'none')
})

it('a thrown prompt never nudges (the error line is already surfaced)', () => {
  assert.equal(decide({ threw: true, turnComplete: false }), 'none')
  // a thrown *nudge* turn does not mark incomplete either
  assert.equal(decide({ threw: true, turnComplete: false, isNudge: true }), 'none')
})

it('nudge prompt asks for `complete`', () => {
  assert.match(NUDGE_PROMPT, /complete/)
})
