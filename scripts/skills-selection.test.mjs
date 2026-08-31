// Per-session skill selection (docs/requirements-skills.md).
//
// A skill is a directory under `~/.gurt/<ws>/skills/`; a session records which
// of them it was given; the start path copies exactly those into the session's
// scratch dir, from where they are bind-mounted read-only. This file covers
// everything on that path except the mount itself, which needs docker.
//
// The properties, in the order they matter:
//
//   1. The registry is the directory listing — including a directory that does
//      not parse, which is reported rather than hidden.
//   2. A selection is persisted verbatim, and an id that stops resolving is
//      *kept*: "not selected" and "selected, unavailable" are different answers.
//   3. `defaultSkills` seeds a *new* draft and does not overwrite a deliberate
//      "none" — the distinction the absent-vs-empty record exists for.
//   4. `create_session` inherits the spawner's skills unless it names its own.
//   5. Materializing copies only what resolves, and reports the rest.
//   6. A skill a session selects cannot be deleted out from under it.
//
// No docker and no agent: every session here stays a draft.
//
//   node scripts/skills-selection.test.mjs
import { test, after } from 'node:test'
import { bundle } from './lib/bundle.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(os.tmpdir(), `gurt-skills-selection-${process.pid}.mjs`)
const S = (rel) => JSON.stringify(path.join(ROOT, rel))

// store.ts reads GURT_ROOT at module load — set it before the import.
const GURT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gurt-skills-selection-'))
process.env.GURT_ROOT = GURT_ROOT

await bundle({
  stdin: {
    contents: `
      export { createKernel } from ${S('src/main/kernel.ts')}
      export { skillEntries, resolveSkillSelection, sanitizeSkillSelection, validateSkillDoc, skillNameProblem } from ${S('src/shared/skills.ts')}
      export {
        addSkill, getSkills, getSkillDoc, updateSkill, removeSkill, setDefaultSkills,
        tasksUsingSkill, materializeSessionSkills, readSessions, sessionSkillsDir, getWorkspace
      } from ${S('src/main/store.ts')}
    `,
    resolveDir: ROOT,
    loader: 'ts',
    sourcefile: 'entry.ts'
  },
  external: ['electron'],
  outfile
})

const m = await import(pathToFileURL(outfile).href)

const ws = 'w'
const task = 't'
const ref = { workspace: ws, task, env: 'dev' }
const workspaceFile = path.join(GURT_ROOT, ws, 'workspace.json')

fs.mkdirSync(path.join(GURT_ROOT, ws, task), { recursive: true })
fs.writeFileSync(
  workspaceFile,
  JSON.stringify({
    repos: [{ name: 'alpha', url: 'https://github.com/o/alpha.git' }],
    envs: [{ name: 'dev', devcontainer: '{"image":"x"}', repo: 'alpha' }]
  })
)
fs.writeFileSync(path.join(GURT_ROOT, ws, task, 'task.json'), JSON.stringify({}))
fs.writeFileSync(path.join(GURT_ROOT, ws, 'agents.json'), JSON.stringify({}))

/** A valid SKILL.md for `name`. */
const doc = (name, description = `use ${name} when the task calls for it`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nsteps.\n`

await m.addSkill(ws, 'review-checklist', doc('review-checklist', 'walk the review checklist'))
await m.addSkill(ws, 'house-style', doc('house-style', 'apply the house style'))

const kernel = m.createKernel()

after(() => {
  fs.rmSync(outfile, { force: true })
  fs.rmSync(GURT_ROOT, { recursive: true, force: true })
})

/** The persisted record of a session, straight off disk. */
const persisted = async (id) =>
  (await m.readSessions(ws, task)).find((r) => r.info.id === id)?.info

/**
 * Retry `check` until it holds, or give up after `deadlineMs` with whatever it
 * last threw. `sessions.json` is written on a 300ms debounce and the write
 * itself is async, so waiting a fixed delay is a race the moment the machine is
 * busy — which it always is here, `node --test` running every file at once.
 */
const eventually = async (check, deadlineMs = 5000) => {
  const until = Date.now() + deadlineMs
  for (;;) {
    try {
      return await check()
    } catch (e) {
      if (Date.now() >= until) throw e
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

/** The composer's create call, minus everything this file does not vary. */
const draft = (skills, role = 'executor') =>
  kernel.sessions.createSession(ref, ['alpha'], 'a1', 'do the thing', 'draft', [], true, {}, role, skills)

/** A spawner: only a researcher may draft an executor (session roles §2), and
 *  `create_session` is the only path skills are inherited on. */
const spawner = (skills) => draft(skills, 'researcher')

let session

// --- what the picker is offered -----------------------------------------

test('the registry is the directory listing, in name order', async () => {
  assert.deepEqual(
    (await m.getSkills(ws)).map((s) => [s.name, s.description, s.files]),
    [
      ['house-style', 'apply the house style', []],
      ['review-checklist', 'walk the review checklist', []]
    ]
  )
})

test('supporting files travel with the skill and are listed', async () => {
  fs.mkdirSync(path.join(GURT_ROOT, ws, 'skills', 'house-style', 'references'))
  fs.writeFileSync(
    path.join(GURT_ROOT, ws, 'skills', 'house-style', 'references', 'naming.md'),
    'names\n'
  )
  const entry = (await m.getSkills(ws)).find((s) => s.name === 'house-style')
  assert.deepEqual(entry.files, ['references/'])
})

test('a directory that does not parse is reported, not hidden', async () => {
  const dir = path.join(GURT_ROOT, ws, 'skills', 'broken')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# no frontmatter at all\n')
  const entry = (await m.getSkills(ws)).find((s) => s.name === 'broken')
  assert.match(entry.problem, /frontmatter/)
  // Still offered: the picker is where the user finds out, Settings is where
  // they fix it. Hiding it would make it unfixable from inside gurt.
  assert.ok(m.skillEntries(await m.getSkills(ws)).some((s) => s.name === 'broken'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the frontmatter name has to be the directory name', () => {
  assert.equal(m.validateSkillDoc('house-style', doc('house-style')).error, undefined)
  assert.match(
    m.validateSkillDoc('house-style', doc('something-else')).error,
    /has to match the skill's own name/
  )
})

test('a name that could not be a directory is refused where it arrives', () => {
  assert.equal(m.skillNameProblem('review-checklist'), null)
  for (const bad of ['../escape', 'Upper', 'has space', 'trailing-', ''])
    assert.ok(m.skillNameProblem(bad), `"${bad}" should be refused`)
  assert.throws(() => m.sanitizeSkillSelection(['../escape']), /not a valid skill name/)
  // Trimmed and de-duplicated, in the user's order.
  assert.deepEqual(m.sanitizeSkillSelection([' house-style ', 'house-style', 'review-checklist']), [
    { name: 'house-style' },
    { name: 'review-checklist' }
  ])
})

// --- resolving a selection against what is offered now -------------------

test('a selection resolves in the user’s order, deduplicated, orphans kept', async () => {
  const entries = m.skillEntries(await m.getSkills(ws))
  const resolved = m.resolveSkillSelection(
    [{ name: 'review-checklist' }, { name: 'ghost' }, { name: 'review-checklist' }],
    entries
  )
  assert.deepEqual(
    resolved.map((r) => [r.selection.name, r.entry?.description]),
    [
      ['review-checklist', 'walk the review checklist'],
      // Kept, not dropped: the draft still names it, and the start reports it.
      ['ghost', undefined]
    ]
  )
})

// --- persistence ---------------------------------------------------------

test('a selection is persisted verbatim', async () => {
  session = draft([{ name: 'review-checklist' }, { name: 'house-style' }])
  await eventually(async () =>
    assert.deepEqual((await persisted(session.id)).skills, [
      { name: 'review-checklist' },
      { name: 'house-style' }
    ])
  )
})

test('editing the draft rewrites the selection', async () => {
  kernel.sessions.editDraft(session.id, { skills: [{ name: 'house-style' }] })
  await eventually(async () =>
    assert.deepEqual((await persisted(session.id)).skills, [{ name: 'house-style' }])
  )
})

test('a duplicate carries the whole selection, copied not shared', () => {
  const copy = kernel.sessions.duplicateSession(session.id)
  assert.deepEqual(copy.skills, [{ name: 'house-style' }])
  kernel.sessions.editDraft(copy.id, { skills: [] })
  assert.deepEqual(kernel.sessions.sessionInfo(session.id).skills, [{ name: 'house-style' }])
  // "none" survives the copy as "none" — not as "never chosen", which would
  // have the config tab seed the workspace's defaults back into it.
  assert.deepEqual(kernel.sessions.duplicateSession(copy.id).skills, [])
})

test('a restart restores the selection', async () => {
  await eventually(async () =>
    assert.deepEqual((await persisted(session.id)).skills, [{ name: 'house-style' }])
  )
  const next = m.createKernel()
  await next.ready
  assert.deepEqual(next.sessions.sessionInfo(session.id).skills, [{ name: 'house-style' }])
})

// --- defaultSkills: what a new draft starts with -------------------------

test('defaultSkills is workspace data, and rejects a name nothing resolves to', async () => {
  await assert.rejects(
    m.setDefaultSkills(ws, ['ghost']),
    /is not in this workspace's registry/
  )
  await m.setDefaultSkills(ws, ['review-checklist'])
  assert.deepEqual((await m.getWorkspace(ws)).defaultSkills, ['review-checklist'])
})

test('a bare draft records no selection at all, so the defaults can seed it', () => {
  // The seeding itself lives in the config tab (ConfigTab.tsx), which is where
  // a default becomes a *visible* choice before Run. What main has to get right
  // is the distinction it keys on: a fresh draft is `undefined`, an emptied one
  // is `[]` (docs/requirements-skills.md §4.3).
  const fresh = draft(undefined)
  assert.equal(fresh.skills, undefined, 'never chosen')
  kernel.sessions.editDraft(fresh.id, { skills: [] })
  assert.deepEqual(kernel.sessions.sessionInfo(fresh.id).skills, [], 'chosen to be none')
})

test('the tree carries defaultSkills to the renderer', async () => {
  const tree = await kernel.tree()
  assert.deepEqual(
    tree.workspaces.find((w) => w.name === ws).defaultSkills,
    ['review-checklist']
  )
})

// --- create_session inheritance ------------------------------------------

test('a drafted session inherits the spawner’s skills', async () => {
  const from = spawner([{ name: 'house-style' }, { name: 'review-checklist' }])
  const { sessionId } = await kernel.sessions.createAgentDraft(from.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'go'
  })
  assert.deepEqual(kernel.sessions.sessionInfo(sessionId).skills, [
    { name: 'house-style' },
    { name: 'review-checklist' }
  ])
  // Copied, not shared.
  kernel.sessions.editDraft(sessionId, { skills: [] })
  assert.equal(kernel.sessions.sessionInfo(from.id).skills.length, 2)
})

test('a request that names skills replaces them, including with none', async () => {
  const from = spawner([{ name: 'house-style' }])
  const narrowed = await kernel.sessions.createAgentDraft(from.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'go',
    skills: ['review-checklist']
  })
  assert.deepEqual(kernel.sessions.sessionInfo(narrowed.sessionId).skills, [
    { name: 'review-checklist' }
  ])
  const none = await kernel.sessions.createAgentDraft(from.id, {
    role: 'executor',
    repos: ['alpha'],
    prompt: 'go',
    skills: []
  })
  assert.deepEqual(kernel.sessions.sessionInfo(none.sessionId).skills, [])
})

test('an agent cannot name a skill that could not be a directory', async () => {
  const from = spawner([])
  await assert.rejects(
    kernel.sessions.createAgentDraft(from.id, {
      role: 'executor',
      repos: ['alpha'],
      prompt: 'go',
      skills: ['../../etc']
    }),
    /not a valid skill name/
  )
})

// --- materialization: what actually reaches the container ---------------

test('only what resolves is copied, and the rest is reported', async () => {
  const s = draft([{ name: 'house-style' }, { name: 'ghost' }])
  const { missing } = await m.materializeSessionSkills(ws, task, s.id, s.skills)
  assert.deepEqual(missing, ['ghost'])
  const dir = m.sessionSkillsDir(ws, task, s.id)
  assert.deepEqual(fs.readdirSync(dir), ['house-style'])
  // The whole directory, supporting files included.
  assert.ok(fs.existsSync(path.join(dir, 'house-style', 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(dir, 'house-style', 'references', 'naming.md')))

  // Re-materializing is the whole set again, not a merge: a skill switched off
  // between two starts has to be physically absent (§2).
  kernel.sessions.editDraft(s.id, { skills: [{ name: 'review-checklist' }] })
  await m.materializeSessionSkills(ws, task, s.id, kernel.sessions.sessionInfo(s.id).skills)
  assert.deepEqual(fs.readdirSync(dir), ['review-checklist'])
})

// --- deleting a skill someone selected ----------------------------------

test('a skill a session selects cannot be deleted', async () => {
  assert.deepEqual(await m.tasksUsingSkill(ws, 'house-style'), [task])
  await assert.rejects(m.removeSkill(ws, 'house-style'), /unselect it there first/)
})

test('a skill nothing selects is deleted with its directory, and drops off the defaults', async () => {
  await m.addSkill(ws, 'temporary', doc('temporary'))
  await m.setDefaultSkills(ws, ['review-checklist', 'temporary'])
  await m.removeSkill(ws, 'temporary')
  assert.equal(fs.existsSync(path.join(GURT_ROOT, ws, 'skills', 'temporary')), false)
  assert.deepEqual((await m.getWorkspace(ws)).defaultSkills, ['review-checklist'])
})

test('an update rewrites SKILL.md and leaves the supporting files alone', async () => {
  await m.updateSkill(ws, 'house-style', doc('house-style', 'the revised house style'))
  assert.equal(
    (await m.getSkills(ws)).find((s) => s.name === 'house-style').description,
    'the revised house style'
  )
  assert.match(await m.getSkillDoc(ws, 'house-style'), /the revised house style/)
  assert.ok(
    fs.existsSync(path.join(GURT_ROOT, ws, 'skills', 'house-style', 'references', 'naming.md'))
  )
  // The name is immutable: a document that renames itself is refused, because
  // every session's selection stores the directory name.
  await assert.rejects(
    m.updateSkill(ws, 'house-style', doc('renamed')),
    /has to match the skill's own name/
  )
})

test('a duplicate name is refused', async () => {
  await assert.rejects(m.addSkill(ws, 'house-style', doc('house-style')), /already exists/)
})
