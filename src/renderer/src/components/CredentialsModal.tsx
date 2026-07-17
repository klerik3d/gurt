import { useEffect, useState } from 'react'
import type { CredentialEntry, CredentialKind } from '../../../shared/credentials'
import { CREDENTIAL_KINDS } from '../../../shared/credentials'
import { Modal } from './Modal'

const kindDef = (kind: CredentialKind) => CREDENTIAL_KINDS.find((k) => k.kind === kind)!

const hostsToText = (hosts: string[]) => hosts.join(', ')
const textToHosts = (text: string) =>
  text.split(',').map((h) => h.trim()).filter(Boolean)

function blankEntry(): CredentialEntry {
  return { id: crypto.randomUUID(), label: '', kind: 'git-token', hosts: [], data: {} }
}

export function CredentialsModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<CredentialEntry[] | null>(null)
  /** Raw hosts text per id, so partial input doesn't flicker while typing. */
  const [hostsText, setHostsText] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    window.gurt
      .getCredentials()
      .then((f) => {
        setEntries(f.credentials)
        setHostsText(Object.fromEntries(f.credentials.map((c) => [c.id, hostsToText(c.hosts)])))
      })
      .catch((e) => setError(String(e)))
  }, [])

  const patch = (id: string, p: Partial<CredentialEntry>) =>
    setEntries((prev) => prev && prev.map((c) => (c.id === id ? { ...c, ...p } : c)))

  const patchData = (id: string, key: string, value: string) =>
    setEntries(
      (prev) => prev && prev.map((c) => (c.id === id ? { ...c, data: { ...c.data, [key]: value } } : c))
    )

  const add = () => {
    const e = blankEntry()
    setEntries((prev) => [...(prev ?? []), e])
    setHostsText((prev) => ({ ...prev, [e.id]: '' }))
  }

  const remove = async (id: string) => {
    setError('')
    // Block deleting an entry a repo still links to (§9).
    const used = await window.gurt.credentialUsedBy(id).catch(() => [])
    if (used.length) {
      setError(`linked by ${used.join(', ')} — unlink it in repo settings first`)
      return
    }
    setEntries((prev) => prev && prev.filter((c) => c.id !== id))
  }

  const save = async () => {
    if (!entries) return
    setError('')
    const out = entries
      .filter((c) => c.label.trim())
      .map((c) => ({ ...c, hosts: textToHosts(hostsText[c.id] ?? '') }))
    try {
      await window.gurt.setCredentials({ credentials: out })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title="Credentials" onClose={onClose}>
      {entries && (
        <div className="form">
          {entries.map((c) => {
            const def = kindDef(c.kind)
            return (
              <div key={c.id} className="agent-block">
                <div className="row">
                  <input
                    className="agent-label"
                    placeholder="label (e.g. gh fine-grained)"
                    value={c.label}
                    onChange={(e) => patch(c.id, { label: e.target.value })}
                  />
                  <select
                    value={c.kind}
                    onChange={(e) => patch(c.id, { kind: e.target.value as CredentialKind })}
                  >
                    {CREDENTIAL_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <button className="link" onClick={() => remove(c.id)}>
                    remove
                  </button>
                </div>
                <div className="agent-fields">
                  <div className="hint">
                    {def.hint}
                    {!def.implemented && ' — stored, runtime not wired yet'}
                  </div>
                  {def.fields.map((f) => (
                    <label key={f.key}>
                      {f.label}
                      <input
                        type={f.secret ? 'password' : 'text'}
                        placeholder={f.placeholder}
                        value={c.data[f.key] ?? ''}
                        onChange={(e) => patchData(c.id, f.key, e.target.value)}
                      />
                    </label>
                  ))}
                  {c.kind === 'git-token' && c.data.gitEmail && (
                    <div className="hint">
                      verified identity: {c.data.gitName} &lt;{c.data.gitEmail}&gt;
                    </div>
                  )}
                  <label>
                    hosts (comma-separated; empty = link-only)
                    <input
                      placeholder="github.com"
                      value={hostsText[c.id] ?? ''}
                      onChange={(e) =>
                        setHostsText((prev) => ({ ...prev, [c.id]: e.target.value }))
                      }
                    />
                  </label>
                </div>
              </div>
            )
          })}
          {entries.length === 0 && <div className="hint">no credentials yet</div>}
          <button className="link" onClick={add}>
            + add credential
          </button>
          {error && <div className="error">{error}</div>}
          <button onClick={save}>Save</button>
        </div>
      )}
    </Modal>
  )
}
