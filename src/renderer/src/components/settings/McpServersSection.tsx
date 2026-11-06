import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CredentialEntry } from '../../../../shared/credentials'
import {
  credentialKindLabel,
  mcpCredentials,
  liftLegacyMcpCredential,
  resolveMcpSecret
} from '../../../../shared/credentials'
import type {
  McpDef,
  McpEntryDraft,
  McpEntryKind,
  McpEnvRow,
  McpProbeResult,
  McpRegistryEntry,
  McpSnippetResult,
  McpValue
} from '../../../../shared/mcp'
import {
  LOCAL_MCP_NOTICE,
  isEnvName,
  isHttpMcpEntry,
  isLocalMcpEntry,
  isMcpCredentialRef,
  mcpCredentialIds,
  mcpEntryDetail,
  mcpEntryKind,
  mcpEnvRecord,
  mcpEnvRows,
  mcpLabel,
  normalizeMcpEntry,
  parseMcpSnippet,
  pastedSecret,
  validateMcpEntry
} from '../../../../shared/mcp'
import { useOutsideClose } from '../../hooks'
import { confirmDialog } from '../../dialog'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { run } from '../../async'

// ---- MCP servers (docs/requirements-mcp-proxy.md §3, §11 ·
//      docs/requirements-mcp-stdio.md §3, §5, §8.2) ----

/** The three transports, in the order the picker offers them: what the
 *  ecosystem publishes first, the original remote shape second, the escape
 *  hatch last (docs/requirements-mcp-stdio.md §3). */
const MCP_KINDS: { kind: McpEntryKind; label: string; hint: string }[] = [
  { kind: 'npm', label: 'npm package', hint: 'gurt installs it and runs it on this machine' },
  { kind: 'http', label: 'Remote URL', hint: 'an http(s) endpoint the session proxy calls' },
  { kind: 'command', label: 'Command (advanced)', hint: 'uvx, docker, a script — run as written' }
]

/** argv as text: one argument per line, so a value containing a space needs no
 *  quoting rules of gurt's own invention. */
const argsToText = (args?: readonly string[]): string => (args ?? []).join('\n')
const textToArgs = (text: string): string[] =>
  text
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean)

/** The workspace's MCP registry, plus the built-ins listed read-only so both
 *  sources of the composer's picker are visible in one place (§11). */
export function McpServersSection({ ws }: { ws: string | null }) {
  const [servers, setServers] = useState<McpRegistryEntry[]>([])
  const [builtins, setBuiltins] = useState<McpDef[]>([])
  const [editing, setEditing] = useState<McpRegistryEntry | null>(null)
  /** The kind a `+ Add` pick chose, i.e. "a new entry of this shape". */
  const [adding, setAdding] = useState<McpEntryKind | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [error, setError] = useState('')
  const addRef = useRef<HTMLDivElement>(null)
  useOutsideClose(addMenu, addRef, () => setAddMenu(false))

  const refresh = useCallback(() => {
    if (!ws) {
      setServers([])
      return
    }
    window.gurt
      .getMcpServers(ws)
      .then(setServers)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [ws])

  // Mutations elsewhere (another window, a workspace switch) announce over
  // tree.changed, the same signal the repo/env lists ride.
  useEffect(() => {
    refresh()
    return window.gurt.onTreeChanged(refresh)
  }, [refresh])

  useEffect(() => {
    window.gurt.getMcpDefs().then(setBuiltins).catch(() => {})
  }, [])

  return (
    <>
      <div className="set-head">
        <div className="set-title-wrap">
          <span className="set-title">MCP servers</span>
          <span className="set-count mono">
            {servers.length} server{servers.length === 1 ? '' : 's'}
            {ws ? ` · ${ws}` : ''}
          </span>
        </div>
        <span className="spacer" />
        {/* Three transports, so the transport is chosen before the form rather
            than as a field inside one shape's editor. */}
        <div className="pick-wrap" ref={addRef}>
          <button
            className="btn btn-primary"
            disabled={!ws}
            onClick={() => setAddMenu((o) => !o)}
          >
            + Add
            <Icon name="chevron" size={11} />
          </button>
          {addMenu && (
            <div className="menu pick-menu right">
              {MCP_KINDS.map((k) => (
                <div
                  key={k.kind}
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setAddMenu(false)
                    setAdding(k.kind)
                  }}
                >
                  {k.label}
                  <span className="menu-hint">{k.hint}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="set-list">
        {servers.map((m) => (
          <div key={m.id} className="set-row">
            <span className="set-row-label">{mcpLabel(m)}</span>
            <span className="set-row-url mono">{mcpEntryDetail(m)}</span>
            {mcpCredentialIds(m).length > 0 && (
              <Icon name="key" size={11} style={{ color: 'var(--yellow)', flex: 'none' }} />
            )}
            {/* Said here, in the editor and in the composer's picker — every
                surface that offers a local entry carries the same line
                (docs/requirements-mcp-stdio.md §2). */}
            {isLocalMcpEntry(m) && <span className="mcp-local-note">{LOCAL_MCP_NOTICE}</span>}
            <button className="btn-link" onClick={() => setEditing(m)}>
              edit
            </button>
          </div>
        ))}
        {servers.length === 0 && (
          <div className="tp-dashed">
            no MCP servers yet — add one to offer it to this workspace&apos;s sessions
          </div>
        )}
        {builtins.length > 0 && (
          <>
            <div className="set-sub">Built-in · provided by gurt, not editable</div>
            {builtins.map((def) => (
              <div key={def.id} className="set-row faint" title={def.description}>
                <span className="set-row-label">{def.label}</span>
                <span className="set-row-url">{def.description}</span>
              </div>
            ))}
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
      {(editing || adding) && ws && (
        <McpServerModal
          key={editing?.id ?? `__new:${adding}`}
          ws={ws}
          taken={servers.filter((m) => m.id !== editing?.id).map((m) => m.id)}
          initial={editing ?? undefined}
          initialKind={adding ?? 'npm'}
          onClose={() => {
            setEditing(null)
            setAdding(null)
            refresh()
          }}
        />
      )}
    </>
  )
}

/** A secret lifted out of a pasted value and held here until Save (§5): it goes
 *  into the credential store, never into `workspace.json`. Until then its row
 *  links it under a {@link PENDING_PREFIX} id, so the draft the user sees
 *  validated is the draft that will be written. */
interface PendingSecret {
  /** The header or variable it was found in — the credential's label on Save. */
  name: string
  value: string
}

/** Stands in for a credential Save is going to create. It never leaves this
 *  modal: Save swaps it for the real id, the probe for the value itself. */
const PENDING_PREFIX = '__pending__:'
const isPending = (credentialId: string): boolean => credentialId.startsWith(PENDING_PREFIX)

/** What a newly linked value is prefixed with: `Bearer ` for an
 *  `Authorization` header, which is nearly always what it wants, and nothing
 *  for anything else. Editable on the row either way. */
const defaultPrefix = (kind: 'header' | 'env', name: string): string =>
  kind === 'header' && /^authorization$/i.test(name.trim()) ? 'Bearer ' : ''

/** One header or environment row. Same shape for both — `McpHeader` and
 *  `McpEnvRow` differ only in where the value goes. */
type McpRow = McpEnvRow

/**
 * One header or environment variable: a name, and a value that is either typed
 * in — stored in workspace.json, sent verbatim — or linked to a credential,
 * resolved on this machine when it is used and never written to the workspace.
 */
function McpValueRowEditor({
  kind,
  row,
  credentials,
  pending,
  onChange,
  onLift,
  onUnlink,
  onRemove
}: {
  kind: 'header' | 'env'
  row: McpRow
  credentials: CredentialEntry[]
  pending: Record<string, PendingSecret>
  onChange: (patch: Partial<McpRow>) => void
  onLift: () => void
  onUnlink: () => void
  onRemove: () => void
}): JSX.Element {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useOutsideClose(menu, menuRef, () => setMenu(false))
  const { name, value } = row
  const linked = isMcpCredentialRef(value) ? value : null
  const pend = linked && isPending(linked.credentialId) ? pending[linked.credentialId] : undefined
  const cred = linked ? credentials.find((c) => c.id === linked.credentialId) : undefined
  const lift = typeof value === 'string' ? pastedSecret(kind, name, value) : null
  const badName = kind === 'env' && !!name.trim() && !isEnvName(name.trim())
  const options = mcpCredentials(credentials)

  const link = (credentialId: string) => {
    const prefix = linked ? (linked.prefix ?? '') : defaultPrefix(kind, name)
    onChange({ value: { credentialId, ...(prefix ? { prefix } : {}) } })
    setMenu(false)
  }

  return (
    <div>
      <div className="mcp-hdr">
        <input
          className="input mono"
          placeholder={kind === 'env' ? 'KUBECONFIG' : 'X-Workspace'}
          value={name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {linked ? (
          <div className="mcp-ref">
            <input
              className="input mono mcp-prefix"
              placeholder="prefix"
              title="sent in front of the secret, verbatim — “Bearer ” for most Authorization headers"
              value={linked.prefix ?? ''}
              onChange={(e) =>
                onChange({
                  value: {
                    credentialId: linked.credentialId,
                    ...(e.target.value ? { prefix: e.target.value } : {})
                  }
                })
              }
            />
            <span className="chip-tag mcp-ref-chip">
              <Icon name="key" size={11} style={{ color: 'var(--yellow)', flex: 'none' }} />
              <span className="menu-item-name">
                {pend ? `new credential · ${pend.name}` : (cred?.label ?? 'missing credential')}
              </span>
              <span
                className="chip-x"
                title={pend ? 'keep it inline instead' : 'unlink'}
                onClick={onUnlink}
              >
                ×
              </span>
            </span>
          </div>
        ) : (
          <input
            className="input mono"
            placeholder="value"
            value={value as string}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        )}
        <div className="pick-wrap" ref={menuRef}>
          <button
            className="btn-link"
            title="take the value from a credential"
            onClick={() => setMenu((o) => !o)}
          >
            <Icon name="key" size={11} />
          </button>
          {menu && (
            <div className="menu pick-menu right">
              {options.map((c) => (
                <div
                  key={c.id}
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    link(c.id)
                  }}
                >
                  <Icon name="key" size={11} className="faint" />
                  {c.label} · {credentialKindLabel(c.kind)}
                </div>
              ))}
              {options.length === 0 && (
                <div className="menu-item faint">no mcp token — add one in Credentials</div>
              )}
            </div>
          )}
        </div>
        <button
          className="btn-link"
          title={kind === 'env' ? 'remove variable' : 'remove header'}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {badName && <span className="error">{name.trim()} is not an environment variable name</span>}
      {lift && (
        <span className="mcp-local-note">
          that value looks like a secret — workspace.json is a plain file{' '}
          <button className="btn-link" onClick={onLift}>
            store it as a credential
          </button>
        </span>
      )}
    </div>
  )
}

function McpServerModal({
  ws,
  taken,
  initial,
  initialKind,
  onClose
}: {
  ws: string
  /** Ids of the other entries — id uniqueness is previewed here and enforced
   *  in the store validator (§3.3). */
  taken: string[]
  initial?: McpRegistryEntry | undefined
  /** Shape of a *new* entry, as the `+ Add` menu chose it. Ignored when editing:
   *  an existing entry's kind comes from the entry, and the picker below can
   *  still change it. */
  initialKind: McpEntryKind
  onClose: () => void
}) {
  const editing = !!initial
  const http = initial && isHttpMcpEntry(initial) ? initial : undefined
  const local = initial && isLocalMcpEntry(initial) ? initial : undefined
  const [kind, setKind] = useState<McpEntryKind>(initial ? mcpEntryKind(initial) : initialKind)
  const [id, setId] = useState(initial?.id ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [url, setUrl] = useState(http?.url ?? '')
  const [headers, setHeaders] = useState<McpRow[]>(http?.headers?.map((h) => ({ ...h })) ?? [])
  const [pkg, setPkg] = useState(local?.kind === 'npm' ? local.package : '')
  const [version, setVersion] = useState((local?.kind === 'npm' && local.version) || '')
  const [command, setCommand] = useState(local?.kind === 'command' ? local.command : '')
  const [cwd, setCwd] = useState((local?.kind === 'command' && local.cwd) || '')
  const [argsText, setArgsText] = useState(argsToText(local?.args))
  const [envRows, setEnvRows] = useState<McpRow[]>(mcpEnvRows(local?.env))
  /** An http entry's legacy single link, until the credentials arrive to lift
   *  it into the header row it means — kept in the draft until then, so a save
   *  in that instant does not drop it. */
  const [legacy, setLegacy] = useState(http?.credentialId ? http : undefined)
  const [pending, setPending] = useState<Record<string, PendingSecret>>({})
  const [snippet, setSnippet] = useState('')
  const [snippetError, setSnippetError] = useState('')
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [probing, setProbing] = useState(false)
  /** The last probe, keyed by the entry it was run against — an edit made after
   *  it invalidates it, and a stale green tick is worse than none. */
  const [probed, setProbed] = useState<{ key: string; result: McpProbeResult } | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt
      .getCredentials()
      .then((f) => {
        setCredentials(f.credentials)
        if (!legacy) return
        // The form only ever saves the lifted shape: the header name and scheme
        // that used to live on the token become this entry's header row.
        setHeaders(
          (prev) => liftLegacyMcpCredential(f.credentials, { ...legacy, headers: prev }).headers ?? []
        )
        setLegacy(undefined)
      })
      .catch(() => {})
  }, [legacy])

  const isLocal = kind !== 'http'

  /**
   * The entry the form currently describes.
   *
   * `inline` is the probe's version of it (§4.6): a lifted-but-unsaved secret
   * goes back into its row as text, because there is no credential to link to
   * until Save — and a probe that always failed on "linked credential no
   * longer exists" would be useless in exactly the flow it exists for.
   * `relink` is Save's: pending ids swapped for the credentials just created.
   */
  const buildDraft = ({
    inline = false,
    relink = {}
  }: { inline?: boolean; relink?: Record<string, string> } = {}): McpEntryDraft => {
    const resolve = (value: McpValue): McpValue => {
      if (!isMcpCredentialRef(value)) return value
      const secret = pending[value.credentialId]
      if (inline && secret) return `${value.prefix ?? ''}${secret.value}`
      const real = relink[value.credentialId]
      return real ? { ...value, credentialId: real } : value
    }
    const rows = (list: McpRow[]): McpRow[] => list.map((r) => ({ name: r.name, value: resolve(r.value) }))
    const tail = { id: id.trim(), label }
    const localTail = { args: textToArgs(argsText), env: mcpEnvRecord(rows(envRows)) }
    return kind === 'http'
      ? {
          ...tail,
          url,
          headers: rows(headers),
          ...(legacy?.credentialId ? { credentialId: legacy.credentialId } : {})
        }
      : kind === 'npm'
        ? { kind: 'npm', ...tail, ...localTail, package: pkg, version }
        : { kind: 'command', ...tail, ...localTail, command, cwd }
  }

  const entry = normalizeMcpEntry(buildDraft())
  const probeEntry = normalizeMcpEntry(buildDraft({ inline: true }))
  const probeKey = JSON.stringify(probeEntry)
  // The same validator the store runs — the modal only previews its verdict.
  const invalid = validateMcpEntry(entry, { takenIds: taken })
  // A pending secret has no stored credential to resolve yet; it is checked by
  // being created, at save time. The renderer holds masks only, so whether a
  // secret can be *carried* is main's check, on save.
  const credError = mcpCredentialIds(entry)
    .filter((cid) => !isPending(cid))
    .map((cid) => resolveMcpSecret(credentials, cid).error)
    .find(Boolean)

  const setRows = (k: 'header' | 'env') => (k === 'header' ? setHeaders : setEnvRows)
  const patchRow = (k: 'header' | 'env', i: number, patch: Partial<McpRow>) =>
    setRows(k)((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  /** Rows with every value that looks like a secret moved into a pending
   *  credential — nothing is written to the credential store by looking at a
   *  form; Save does that. */
  const liftRows = (k: 'header' | 'env', list: McpRow[]): McpRow[] => {
    const fresh: Record<string, PendingSecret> = {}
    const out = list.map((r) => {
      const found = typeof r.value === 'string' ? pastedSecret(k, r.name, r.value) : null
      if (!found) return r
      const pid = `${PENDING_PREFIX}${crypto.randomUUID()}`
      fresh[pid] = { name: r.name.trim(), value: found.secret }
      return { name: r.name, value: { credentialId: pid, ...(found.prefix ? { prefix: found.prefix } : {}) } }
    })
    setPending((prev) => ({ ...prev, ...fresh }))
    return out
  }

  const liftRow = (k: 'header' | 'env', i: number) => {
    const list = k === 'header' ? headers : envRows
    const row = list[i]
    if (!row) return
    const [lifted] = liftRows(k, [row])
    patchRow(k, i, { value: lifted!.value })
  }

  /** Unlink a row. A pending secret goes back where the paste had it — the
   *  user's call, and the only way back to an inline value; a stored credential
   *  just leaves an empty value to type into. */
  const unlinkRow = (k: 'header' | 'env', i: number) => {
    const row = (k === 'header' ? headers : envRows)[i]
    if (!row || !isMcpCredentialRef(row.value)) return
    const secret = pending[row.value.credentialId]
    patchRow(k, i, { value: secret ? `${row.value.prefix ?? ''}${secret.value}` : '' })
  }

  const rowEditor = (k: 'header' | 'env', row: McpRow, i: number) => (
    <McpValueRowEditor
      key={i}
      kind={k}
      row={row}
      credentials={credentials}
      pending={pending}
      onChange={(patch) => patchRow(k, i, patch)}
      onLift={() => liftRow(k, i)}
      onUnlink={() => unlinkRow(k, i)}
      onRemove={() => setRows(k)((prev) => prev.filter((_, j) => j !== i))}
    />
  )

  /**
   * A published snippet, straight into the form (§5). `parseMcpSnippet` does all
   * of the reading — the kind, the id, the package and version, the argv, the
   * env — so a `uvx` or `docker` snippet switches this form to `command` rather
   * than being refused. Its error is a sentence written for the user; it is
   * shown as it is.
   */
  const applySnippet = (text: string) => {
    if (!text.trim()) return
    const result: McpSnippetResult = parseMcpSnippet(text)
    if (!result.entry) {
      setSnippetError(result.error ?? 'that snippet could not be read')
      return
    }
    const parsed = result.entry
    setSnippetError('')
    setNote('')
    setKind(mcpEntryKind(parsed))
    // The id is a route segment and a selection key, so an existing entry keeps
    // the one its sessions already name.
    if (!editing) setId(parsed.id)
    if (parsed.label) setLabel(parsed.label)
    // A snippet's `env` and `headers` are where READMEs put a real token, and
    // `workspace.json` is a plain file meant to be shared and committed. So a
    // value that looks like a secret is lifted out here, by default, rather
    // than being saved inline and warned about afterwards (§5).
    if (isHttpMcpEntry(parsed)) {
      setUrl(parsed.url)
      setHeaders(liftRows('header', parsed.headers?.map((h) => ({ ...h })) ?? []))
      return
    }
    setPkg(parsed.kind === 'npm' ? parsed.package : '')
    setVersion((parsed.kind === 'npm' && parsed.version) || '')
    setCommand(parsed.kind === 'command' ? parsed.command : '')
    setCwd((parsed.kind === 'command' && parsed.cwd) || '')
    setArgsText(argsToText(parsed.args))
    setEnvRows(liftRows('env', mcpEnvRows(parsed.env)))
  }

  /** Store every pending secret the entry still links as an `mcp-token`, in one
   *  write, and return pending id → real id. Written before the entry, so a
   *  failure here leaves no entry pointing at a credential that does not
   *  exist; and swapped into the rows at once, so a retry after the entry's
   *  own save fails does not store them twice. */
  const createCredentials = async (): Promise<Record<string, string>> => {
    const used = mcpCredentialIds(entry).filter((cid) => isPending(cid) && pending[cid])
    if (!used.length) return {}
    const fresh: CredentialEntry[] = used.map((pid) => ({
      id: crypto.randomUUID(),
      label: `${id.trim() || 'mcp'} ${pending[pid]!.name}`,
      kind: 'mcp-token',
      hosts: [],
      data: { secret: pending[pid]!.value }
    }))
    const file = await window.gurt.getCredentials()
    await window.gurt.setCredentials({ credentials: [...file.credentials, ...fresh] })
    const relink = Object.fromEntries(used.map((pid, k) => [pid, fresh[k]!.id]))
    const swap = (list: McpRow[]): McpRow[] =>
      list.map((r) =>
        isMcpCredentialRef(r.value) && relink[r.value.credentialId]
          ? { ...r, value: { ...r.value, credentialId: relink[r.value.credentialId]! } }
          : r
      )
    setHeaders(swap)
    setEnvRows(swap)
    setCredentials((await window.gurt.getCredentials()).credentials)
    return relink
  }

  const save = async () => {
    setError('')
    try {
      const relink = await createCredentials()
      const saved = normalizeMcpEntry(buildDraft({ relink }))
      await (editing
        ? window.gurt.updateMcpServer(ws, saved)
        : window.gurt.addMcpServer(ws, saved))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Run it. For a local entry that means installing the package if it is not
   * installed, spawning the process on this machine, doing the MCP handshake,
   * listing what it offers and stopping it again (§4.6) — every failure the
   * static checks cannot see, moved to a button the user presses while the form
   * that caused it is still open.
   *
   * Only ever from here. Nothing about saving an entry runs it: a local entry
   * is third-party code with the user's privileges, which is what the notice
   * above this form says, and "I typed a package name" must not quietly mean
   * "I ran it" (§2).
   */
  const probe = async () => {
    setError('')
    setNote('')
    setProbing(true)
    const key = probeKey
    try {
      setProbed({ key, result: await window.gurt.probeMcpServer(ws, probeEntry) })
    } catch (e) {
      // The probe answers rather than throws, so this is the call itself
      // failing — shown in the same place, so the button always resolves.
      setProbed({ key, result: { ok: false, kind, error: e instanceof Error ? e.message : String(e) } })
    } finally {
      setProbing(false)
    }
  }

  /** Forget what is installed, so the next session start installs it again —
   *  the button behind a pinned `latest` (§4.2). A running process keeps
   *  running: gurt does not restart a local server under its holders (§10). */
  const reinstall = async () => {
    setError('')
    try {
      await window.gurt.reinstallMcpServer(ws, initial!.id)
      setNote('will be installed again the next time a session starts it')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const del = async () => {
    if (
      !(await confirmDialog(`Delete MCP server "${mcpLabel(initial!)}"?`, {
        title: 'Delete MCP server',
        confirmText: 'Delete',
        danger: true
      }))
    )
      return
    try {
      await window.gurt.removeMcpServer(ws, initial!.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const filledIn = id.trim() || url.trim() || pkg.trim() || command.trim()

  return (
    <Modal title={editing ? 'Edit MCP server' : 'New MCP server'} width={520} onClose={onClose}>
      <div className="modal-body env-modal">
        <div className="fld">
          <span className="seclabel">TRANSPORT</span>
          <div className="seg">
            {MCP_KINDS.map((k) => (
              <button
                key={k.kind}
                className={`seg-btn ${kind === k.kind ? 'active' : ''}`}
                title={k.hint}
                onClick={() => setKind(k.kind)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {/* Every surface that offers a local entry says this, in these words
            (docs/requirements-mcp-stdio.md §2). */}
        {isLocal && (
          <div className="mcp-notice">
            <Icon name="key" size={12} />
            <span>
              {LOCAL_MCP_NOTICE} The session container still sees nothing but a proxy URL — this
              process does not run in it.
            </span>
          </div>
        )}

        {isLocal && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">PASTE FROM README</span>
              <span className="spacer" />
              <button className="btn-link" onClick={() => applySnippet(snippet)}>
                fill the form
              </button>
            </div>
            <textarea
              className="input mono snippet-input"
              rows={4}
              spellCheck={false}
              placeholder={'{"mcpServers": {"kubernetes": {"command": "npx", "args": ["-y", "kubernetes-mcp-server@latest", "--read-only"]}}}'}
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              onPaste={(e) => {
                // Applied from the clipboard rather than from state: the paste
                // event fires before React has the new value.
                const text = e.clipboardData.getData('text')
                if (!text.trim()) return
                e.preventDefault()
                setSnippet(text)
                applySnippet(text)
              }}
            />
            {snippetError ? (
              <span className="error">{snippetError}</span>
            ) : (
              <span className="fld-hint">
                The block a README gives you — `mcpServers`, `servers`, or the bare body. A `uvx`
                or `docker` invocation fills in the command form instead. <b>Test</b> then runs
                exactly what it filled in, so you can see what the snippet meant before saving it.
              </span>
            )}
          </div>
        )}

        <div className="cred-grid">
          <label className="fld">
            <span className="seclabel">ID</span>
            <input
              className="input mono"
              autoFocus={!editing}
              placeholder="linear"
              value={id}
              disabled={editing}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label className="fld">
            <span className="seclabel">NAME (OPTIONAL)</span>
            <input
              className="input"
              placeholder={id.trim() || 'Linear'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
        </div>

        {kind === 'http' && (
          <div className="fld">
            <span className="seclabel">ENDPOINT URL</span>
            <input
              className="input mono"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <span className="fld-hint">
              A remote http(s) endpoint the session proxy calls — nothing runs on this machine.
            </span>
          </div>
        )}

        {kind === 'npm' && (
          <div className="cred-grid">
            <label className="fld">
              <span className="seclabel">PACKAGE</span>
              <input
                className="input mono"
                placeholder="kubernetes-mcp-server"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
              />
            </label>
            <label className="fld cred-type">
              <span className="seclabel">VERSION</span>
              <input
                className="input mono"
                placeholder="latest"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
          </div>
        )}
        {kind === 'npm' && (
          <span className="fld-hint">
            Installed once under ~/.gurt/mcp/{id.trim() || '<id>'} and pinned to what it resolved
            to — a version or dist-tag here, never <span className="mono">name@version</span> in
            the package field.
          </span>
        )}

        {kind === 'command' && (
          <div className="cred-grid">
            <label className="fld">
              <span className="seclabel">COMMAND</span>
              <input
                className="input mono"
                placeholder="uvx"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </label>
            <label className="fld cred-type">
              <span className="seclabel">WORKING DIR</span>
              <input
                className="input mono"
                placeholder="(optional)"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
            </label>
          </div>
        )}
        {kind === 'command' && (
          <span className="fld-hint">
            A name is resolved against your PATH when this is saved, so a missing tool is an error
            here rather than an hour later; an absolute path is used as given.
          </span>
        )}

        {isLocal && (
          <div className="fld">
            <span className="seclabel">ARGUMENTS</span>
            <textarea
              className="input mono snippet-input"
              rows={3}
              spellCheck={false}
              placeholder={'--read-only'}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
            <span className="fld-hint">
              One per line, passed verbatim. A server&apos;s own read-only flag lives here — gurt
              reports the argv, and does not claim to enforce what it means.
            </span>
          </div>
        )}

        {kind === 'http' && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">HEADERS</span>
              <span className="spacer" />
              <button
                className="btn-link"
                onClick={() => setHeaders((prev) => [...prev, { name: '', value: '' }])}
              >
                + header
              </button>
            </div>
            {headers.map((h, i) => rowEditor('header', h, i))}
            <span className="fld-hint">
              A typed value is stored in workspace.json and sent verbatim. A secret is taken from a
              credential (<Icon name="key" size={10} />) — the proxy adds it upstream; it is never
              written here and the container never sees it.
            </span>
          </div>
        )}

        {isLocal && (
          <div className="fld">
            <div className="fld-head">
              <span className="seclabel">ENVIRONMENT</span>
              <span className="spacer" />
              <button
                className="btn-link"
                onClick={() => setEnvRows((prev) => [...prev, { name: '', value: '' }])}
              >
                + variable
              </button>
            </div>
            {envRows.map((row, i) => rowEditor('env', row, i))}
            <span className="fld-hint">
              A typed value is stored in workspace.json and given to the process verbatim. A secret
              is taken from a credential (<Icon name="key" size={10} />) — resolved on this machine
              when the process starts, never written here.
            </span>
          </div>
        )}

        {Object.keys(pending).some((pid) => mcpCredentialIds(entry).includes(pid)) && (
          <div className="fld-hint">
            New credentials are saved to the credential store on Save, not to workspace.json.
          </div>
        )}
        {credError && <div className="error">⚠ {credError}</div>}

        {/* Idle shows nothing: the probe has a button, and a form that
            volunteered a verdict it did not earn would read as one. */}
        {probing ? (
          <div className="mcp-probe">
            <span className="fld-hint">
              {isLocal
                ? 'starting it on this machine — an npm entry installs its package the first time…'
                : 'connecting to the endpoint…'}
            </span>
          </div>
        ) : (
          probed?.key === probeKey && <McpProbeReport result={probed.result} />
        )}
        {note && <div className="fld-hint">{note}</div>}
        {(error || (invalid && filledIn)) && <div className="error">{error || invalid}</div>}
      </div>
      <div className="modal-foot">
        {editing && (
          <button className="btn btn-danger-text" onClick={run(del)}>
            Delete
          </button>
        )}
        {editing && local?.kind === 'npm' && kind === 'npm' && (
          <button
            className="btn btn-text"
            title="forget what is installed, so the next start installs the package again"
            onClick={run(reinstall)}
          >
            Reinstall
          </button>
        )}
        <button
          className="btn btn-text"
          title={
            isLocal
              ? 'start this server on your machine now, do the MCP handshake, list its tools and stop it again'
              : 'do the MCP handshake against this endpoint, with the headers a session would send'
          }
          disabled={probing || !!invalid || !!credError}
          onClick={run(probe)}
        >
          {probing ? 'Testing…' : 'Test'}
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!!invalid || !!credError}
          onClick={run(save)}
        >
          Save
        </button>
      </div>
    </Modal>
  )
}

/** Tool names shown before the list is cut short. A server with a hundred tools
 *  is a real thing; a dialog listing all hundred is not. What is dropped is
 *  counted out loud. */
const PROBE_TOOLS_SHOWN = 24

/**
 * What the probe found (§4.6) — the success and failure halves of the button's
 * four states; idle and in-flight are rendered by the caller.
 *
 * The tool list is here to be *read*. It narrows nothing: `mcpHasModes` still
 * says a registry entry has no read-only mode, because a name does not say
 * whether the tool writes (§3.3).
 */
function McpProbeReport({ result }: { result: McpProbeResult }): JSX.Element {
  // Open when it failed, because that is the question the reader now has;
  // folded when it worked, because then the answer is the line above it.
  const [openLog, setOpenLog] = useState(!result.ok)
  const launchLog = <McpProbeLog result={result} open={openLog} onToggle={() => setOpenLog((o) => !o)} />

  if (!result.ok)
    return (
      <div className="mcp-probe">
        <span className="error">
          {result.error || 'it did not come up, and said nothing about why'}
        </span>
        {launchLog}
      </div>
    )
  const tools = result.tools ?? []
  const shown = tools.slice(0, PROBE_TOOLS_SHOWN)
  return (
    <div className="mcp-probe">
      <span className="mcp-probe-head">
        <Icon name="plug" size={12} />
        {result.kind === 'http'
          ? 'the endpoint answered the MCP handshake'
          : 'it started and answered the MCP handshake'}
        {result.server ? ` · ${result.server}` : ''}
      </span>
      {result.tools &&
        (tools.length ? (
          <span className="mcp-probe-tools">
            {shown.map((t, i) => (
              // Keyed by position: nothing stops a server listing a name twice.
              <span key={`${t.name}:${i}`} className="mono" title={t.summary}>
                {t.name}
              </span>
            ))}
            {tools.length > shown.length && (
              <span className="faint">+{tools.length - shown.length} more</span>
            )}
          </span>
        ) : (
          <span className="fld-hint">it offers no tools</span>
        ))}
      {result.toolsError && (
        <span className="fld-hint">it did not list its tools — {result.toolsError}</span>
      )}
      <span className="fld-hint">
        {result.kind === 'http'
          ? 'Checked from gurt, on this machine. A session reaches this endpoint through its own proxy, from the container — so this says the URL, the headers and the credential are right, not that a session can get there.'
          : 'Started and stopped again just now. The list is what the server offers; gurt does not know which of them write, so it reports them and does not restrict them.'}
      </span>
      {launchLog}
    </div>
  )
}

/**
 * The launch itself, line by line: what was installed, what argv was spawned,
 * what the process printed, which MCP calls were made, how it ended.
 *
 * This is the server's *own* output, shown where the person who started it is
 * standing. gurt keeps no copy of it — closing the dialog is the end of it (see
 * §4.6) — so **copy** is not a convenience here, it is the only way to carry it
 * into an issue.
 */
function McpProbeLog({
  result,
  open,
  onToggle
}: {
  result: McpProbeResult
  open: boolean
  onToggle: () => void
}): JSX.Element | null {
  const lines = result.transcript ?? []
  if (!lines.length) return null
  const text = lines.map((l) => `+${l.at}ms ${l.stream}\t${l.line}`).join('\n')
  return (
    <div className="mcp-probe-log">
      <div className="fld-head">
        <button className="btn-link" onClick={onToggle}>
          {open ? 'hide' : 'show'} launch log ({lines.length} lines)
        </button>
        <span className="spacer" />
        {open && (
          <button className="btn-link" onClick={() => void navigator.clipboard.writeText(text)}>
            copy
          </button>
        )}
      </div>
      {open && (
        <div className="mcp-probe-lines mono">
          {lines.map((l, i) => (
            <div key={i} className={`mcp-probe-row ${l.stream}`}>
              <span className="faint">+{l.at}ms</span>
              <span className="faint">{l.stream}</span>
              <span>{l.line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
