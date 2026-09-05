import { useState } from 'react'
import type { JSX } from 'react'
import type { SessionNetwork } from '../../../shared/types'
import type { SessionTraffic, TrafficHost } from '../../../shared/proxy'
import {
  BUILTIN_DENY_ENTRIES,
  BUILTIN_DENY_REASON,
  BUILTIN_DENY_SUMMARY,
  explicitAllows
} from '../../../shared/proxy'
import { useSessionTraffic } from '../useTraffic'
import { relativeTime } from '../time'
import { Icon, InfoDot } from './icons'
import { NET_INFO, networkMode, policySummary } from './tags'

// The session's view of its own egress (docs/requirements-mcp-proxy.md §8):
// what the proxy refused, and — collapsed under it — what it let through.
//
// This exists to answer one question: "why doesn't X work?". A refused host is
// otherwise invisible; the agent sees a connection error and the user sees a
// tool that failed for no stated reason. Naming the host, and saying which rule
// refused it, turns that into something the user can act on.
//
// Only what the proxy logged is here — a hostname, a port, a count and a time.
// There is no request path, header or body to show, because none is collected.

/** `host:port`, with the port left off when it is the one the scheme implies —
 *  `pastebin.com` reads better than `pastebin.com:443` in a list of them. */
const hostLabel = (h: TrafficHost): string =>
  h.port === 443 || h.port === 80 || !h.port ? h.host : `${h.host}:${h.port}`

/** Why this host was refused, in a phrase. `no-scope` is the fail-closed window
 *  before the session's scope was pushed (§5.4) — a real answer, and a
 *  different one from "your policy says no". */
function blockedWhy(h: TrafficHost, internal: boolean): string {
  // The built-in denylist is not the session's allow list and does not read as
  // one: it is what applies *because* the allow list is empty, so the fix — and
  // its cost, since one entry closes everything else — has to be said in full.
  if (h.reason === BUILTIN_DENY_REASON)
    return `gurt refuses proxied egress to ${BUILTIN_DENY_SUMMARY} by default — either directly or because the name resolved to one. Add it under the Config tab → Harness config → Network → allow list if this session is meant to reach it; note that any entry there also restricts the session to the listed destinations.`
  const by =
    h.reason === 'allowlist'
      ? "it is not on this session's allow list"
      : h.reason === 'no-scope'
        ? 'the session had no network scope yet (it was still starting)'
        : "this session's network policy refused it"
  return internal ? by : `${by} — this session is on an open network, so only its proxied traffic is refused`
}

function HostRow({ host, why }: { host: TrafficHost; why?: string }): JSX.Element {
  return (
    <div className="net-row" title={why}>
      <span className="net-host mono">{hostLabel(host)}</span>
      <span className="spacer" />
      {host.attempts > 1 && <span className="dim">×{host.attempts}</span>}
      <span className="dim">{relativeTime(host.last)}</span>
    </div>
  )
}

/**
 * Everything the proxy has been seen doing, as a block: the mode and its policy
 * on one line, blocked attempts under it, observed hosts collapsed under those.
 *
 * `traffic` is passed in rather than pulled here — the button that opens this
 * in a popup needs the same ledger for its own mark, and one subscription
 * answers both.
 */
function NetBody({
  network,
  traffic
}: {
  network?: SessionNetwork | undefined
  traffic: SessionTraffic
}): JSX.Element {
  const [showAllowed, setShowAllowed] = useState(false)
  const internal = network?.internal === true || traffic.internal

  return (
    <>
      <div className="net-head">
        <Icon name={NET_INFO[internal ? 'internal' : 'open'].icon} size={11} className="faint" />
        <span className="net-mode">{NET_INFO[internal ? 'internal' : 'open'].label}</span>
        <span className="dim">{policySummary(network?.policy)}</span>
        <span className="spacer" />
        {traffic.allowed.length > 0 && (
          <button
            type="button"
            className="btn btn-text btn-sm"
            onClick={() => setShowAllowed((v) => !v)}
            title="hosts this session's proxy let through"
          >
            {traffic.allowed.length} domain{traffic.allowed.length === 1 ? '' : 's'} seen
          </button>
        )}
      </div>

      {traffic.blocked.length > 0 && (
        <div className="net-blocked">
          {/* The sentence, not just the list: a count badge tells a user that
              something happened, this tells them what and what to do about it. */}
          <div className="net-note">
            {traffic.blocked.length === 1
              ? 'this session tried to reach a host and was blocked by its network policy'
              : `this session was blocked reaching ${traffic.blocked.length} hosts by its network policy`}
            {' — '}
            {internal
              ? 'add it under the Config tab → Harness config → Network to let it through (applies at the next start)'
              : 'nothing was actually cut off: on an open network the proxy only refuses the traffic that came through it'}
          </div>
          {traffic.blocked.map((h) => (
            <HostRow key={`${h.host}:${h.port}`} host={h} why={blockedWhy(h, internal)} />
          ))}
        </div>
      )}

      {showAllowed && (
        <div className="net-allowed">
          {traffic.allowed.map((h) => (
            <HostRow key={`${h.host}:${h.port}`} host={h} />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * The same block standing on its own, for the panes with no composer to hang a
 * button off. Renders nothing at all until the proxy has been seen doing
 * something — an empty panel on every draft would be noise, and "no traffic
 * yet" is not news when nobody asked.
 */
export function TrafficPanel({
  sessionId,
  network
}: {
  sessionId: string
  network?: SessionNetwork | undefined
}): JSX.Element | null {
  const traffic = useSessionTraffic(sessionId)
  if (!traffic.blocked.length && !traffic.allowed.length) return null
  return (
    <div className="net-panel">
      <NetBody network={network} traffic={traffic} />
    </div>
  )
}

/**
 * The composer's network mark: the session's egress mode as an icon, and the
 * traffic block behind a click.
 *
 * The block used to sit above the composer whenever there was any traffic at
 * all, which spent a permanent strip of the feed on a line most sessions never
 * need to read. Asking for it is the right default — but a *blocked* host is
 * not something to wait to be asked about, so the button carries a mark while
 * there is one, and the icon itself always says which mode the session is on.
 *
 * Open/closed is owned by the composer, like its other popups: only one of them
 * may be open, and the composer's outside-click and Esc handling closes this
 * one along with the rest.
 */
export function NetButton({
  sessionId,
  network,
  open,
  onToggle
}: {
  sessionId: string
  network?: SessionNetwork | undefined
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const traffic = useSessionTraffic(sessionId)
  const internal = network?.internal === true || traffic.internal
  const info = NET_INFO[internal ? 'internal' : 'open']
  const blocked = traffic.blocked.length

  return (
    <>
      <button
        className={`icon-sq net-btn ${open ? 'active' : ''}`}
        title={`${info.label} — ${policySummary(network?.policy)}${
          blocked ? ` · ${blocked} blocked ${blocked === 1 ? 'host' : 'hosts'}` : ''
        }`}
        onClick={onToggle}
      >
        <Icon name={info.icon} size={14} />
        {blocked > 0 && <span className="net-btn-dot" />}
      </button>
      {open && (
        <div className="cmp-menu net-pop">
          <NetBody network={network} traffic={traffic} />
          {!traffic.blocked.length && !traffic.allowed.length && (
            <div className="dim">nothing has gone through this session's proxy yet</div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * The session's network control: internal isolation as an on/off toggle, the
 * built-in denylist folded behind its label, and the one list the user edits.
 *
 * There is no mode picker beyond that toggle, because there is no mode: the
 * allow list being empty or not *is* the policy (§6.3). Empty means the open
 * internet minus this machine's own networks; one entry means that entry and
 * nothing else. That surprising half stays a visible warning under the field
 * once the list has entries — a user who adds `host.docker.internal:5173` to
 * reach their dev server has also just cut the session off from npm — while
 * the rest of the explanation sits behind the label's info dot.
 *
 * The setup caveat is not in a tooltip either. §7.3 makes surfacing it an
 * obligation, and a user choosing isolation has to read "setup runs before
 * this applies" at the moment they choose it — the note appears next to the
 * toggle the moment it is switched on.
 */
export function NetworkPicker({
  network,
  onChange
}: {
  network: SessionNetwork
  onChange: (next: SessionNetwork) => void
}): JSX.Element {
  const internal = networkMode(network) === 'internal'
  const allow = explicitAllows(network.policy)
  const [builtinOpen, setBuiltinOpen] = useState(false)
  // The whole block — the on/off toggle, the built-in denylist, the allow list
  // — is detail most sessions never touch, so the section is folded behind its
  // own label and costs one line until it is asked for. The label carries what
  // it hides: a folded block still says which mode the session is on. Opens
  // already open when there is an allow list, so an edited draft doesn't look
  // like it lost its list.
  const [open, setOpen] = useState(allow.length > 0)
  const [detailsOpen, setDetailsOpen] = useState(allow.length > 0)

  return (
    <>
      <div className="hc-block">
        <div className="seclabel-row">
          <button type="button" className="subfold" onClick={() => setOpen((o) => !o)}>
            <Icon
              name="chevron"
              size={11}
              style={{ flex: 'none', transform: open ? undefined : 'rotate(-90deg)' }}
            />
            internal network
            <span className="dim">{internal ? 'on' : 'off'}</span>
          </button>
          <InfoDot text={`On — ${NET_INFO.internal.hint} Off — ${NET_INFO.open.hint}`} />
        </div>
        {open && (
          <div className="chip-row">
            <button
              type="button"
              className={`chip-btn ${internal ? 'on' : ''}`}
              title={NET_INFO.internal.hint}
              onClick={() => onChange({ ...network, internal: true })}
            >
              on
            </button>
            <button
              type="button"
              className={`chip-btn ${!internal ? 'on' : ''}`}
              title={NET_INFO.open.hint}
              onClick={() => onChange({ ...network, internal: false })}
            >
              off
            </button>
          </div>
        )}
        {open && internal && (
          <div className="hc-note">
            Setup — image build, devcontainer features, postCreate, the agent install — still runs
            with an open network before the isolation applies. SSH git is not supported; git goes
            over HTTPS through the github MCP.
          </div>
        )}
      </div>

      {open && (
        <>
          <button type="button" className="subfold" onClick={() => setDetailsOpen((o) => !o)}>
            <Icon
              name="chevron"
              size={11}
              style={{ flex: 'none', transform: detailsOpen ? undefined : 'rotate(-90deg)' }}
            />
            allow / block list
            {allow.length > 0 && <span className="dim">{allow.length} allowed</span>}
          </button>

          {detailsOpen && (
            <>
              {/* Applies in both toggle states, because both enforce it on proxied
                  traffic: even non-internal sessions route anything honouring
                  HTTP_PROXY through the proxy. Read-only for now — editing it per
                  session is a separate task (§6.4) — and folded behind its label:
                  the list is a statement, not a decision, so it costs a click. */}
              <div className="hc-block">
                <div className="seclabel-row">
                  <button
                    type="button"
                    className="subfold"
                    onClick={() => setBuiltinOpen((o) => !o)}
                  >
                    <Icon
                      name="chevron"
                      size={11}
                      style={{
                        flex: 'none',
                        transform: builtinOpen ? undefined : 'rotate(-90deg)'
                      }}
                    />
                    blocked by default
                    <span className="dim">{BUILTIN_DENY_ENTRIES.length}</span>
                  </button>
                  <InfoDot
                    text={
                      allow.length
                        ? 'Not consulted while the allow list below has entries — what that list names is what this session can reach, and nothing else is.'
                        : 'Refused on the address a name resolves to, not just on the name. The one way to reach one of these is to name it in the allow list below.'
                    }
                  />
                </div>
                {builtinOpen && (
                  <div className="net-builtin">
                    {BUILTIN_DENY_ENTRIES.map((e) => (
                      <div className="net-row" key={e.label} title={e.detail}>
                        <span className="net-host mono">{e.label}</span>
                        <span className="spacer" />
                        <span className="dim">{e.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="hc-block">
                <div className="seclabel-row">
                  <span className="seclabel">ALLOW LIST</span>
                  <InfoDot text="Empty means open: everything outward is allowed except what is blocked by default. Add at least one entry and the session is restricted to what is listed — nothing else gets out. A bare host covers every port on it and its subdomains (example.com also covers api.example.com); host:port narrows the entry to one port. No wildcards, and an IP literal matches exactly." />
                </div>
                <HostList
                  hosts={allow}
                  placeholder={
                    'one host per line\nexample.com also covers api.example.com\nhost.docker.internal:5173'
                  }
                  onChange={(next) => onChange({ ...network, policy: { allow: next } })}
                />
                {allow.length > 0 && (
                  <div className="hc-note hc-warn">
                    Only the {allow.length === 1 ? 'entry' : `${allow.length} entries`} above can be
                    reached — everything else is refused, the rest of the internet included. Each
                    entry is connected exactly as written: dialled by name, with no address check,
                    so a name that answers with a private address is still reached. Write the IP
                    literal instead if that is not what you want.
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

/**
 * A list of hosts as free text — one per line, which is how a list of hosts is
 * pasted and read.
 *
 * The text is local state, not a render of the parsed list: a blank line the
 * user is in the middle of typing is not a domain yet, and a field that dropped
 * it on every keystroke could not be typed into at all. Main sanitizes what
 * lands (lowercase, dedupe, cap) — this only has to stay editable.
 */
function HostList({
  hosts,
  placeholder,
  onChange
}: {
  hosts: string[]
  placeholder: string
  onChange: (hosts: string[]) => void
}): JSX.Element {
  const [text, setText] = useState(hosts.join('\n'))
  return (
    <textarea
      className="net-domains mono"
      rows={3}
      spellCheck={false}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value.split('\n').map((d) => d.trim()).filter(Boolean))
      }}
    />
  )
}
