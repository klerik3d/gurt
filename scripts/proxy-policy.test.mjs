// Pure-logic tests for the session proxy's decision surface
// (docs/requirements-mcp-proxy.md §4.3, §5, §6.3, §6.4): the domain matcher, the
// three rules of the allow list, the built-in denylist an entry replaces, the
// `/mcp/<token>/<id>` route parser, the `CONNECT` authority parser and the
// config validator.
//
// Nothing is bundled here: `resources/proxy/gurt-proxy.mjs` is dependency-free
// ESM that runs as-is inside a stock node:alpine, so the test imports exactly
// the file the container mounts. The live-server half is proxy-server.test.mjs.
//
//   node scripts/proxy-policy.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as proxy from '../resources/proxy/gurt-proxy.mjs'

const decide = (host, policy, port = 443) => proxy.policyDecision(host, port, policy).allowed

test('a rule covers the host and its subdomains, and nothing that merely ends in it', () => {
  assert.ok(proxy.matchesDomain('example.com', 'example.com'))
  assert.ok(proxy.matchesDomain('api.example.com', 'example.com'))
  assert.ok(proxy.matchesDomain('a.b.c.example.com', 'example.com'), 'depth is not bounded')
  // The dot is what makes the boundary a label boundary.
  assert.ok(!proxy.matchesDomain('notexample.com', 'example.com'))
  assert.ok(!proxy.matchesDomain('example.com.evil.net', 'example.com'))
  // A rule is not covered by its own subdomain — the relation has a direction.
  assert.ok(!proxy.matchesDomain('example.com', 'api.example.com'))
})

test('matching is case-insensitive and ignores the trailing root dot', () => {
  assert.ok(proxy.matchesDomain('API.Example.COM.', 'example.com'))
  assert.ok(proxy.matchesDomain('example.com', 'EXAMPLE.COM.'))
  assert.equal(proxy.normalizeHost(' [::1] '), '::1', 'CONNECT brackets are stripped')
})

test('no mid-label wildcards: a rule is a domain, never a pattern', () => {
  assert.ok(!proxy.matchesDomain('api.example.com', '*.example.com'))
  assert.ok(!proxy.matchesDomain('staging-api.example.com', 'api.example.com'))
  assert.ok(!proxy.matchesDomain('api.example.com', 'api.*'))
})

test('IP literals match exactly, and never cross into the name namespace', () => {
  assert.ok(proxy.matchesDomain('10.0.0.1', '10.0.0.1'))
  assert.ok(!proxy.matchesDomain('210.0.0.1', '10.0.0.1'), 'a literal is not a suffix rule')
  assert.ok(!proxy.matchesDomain('10.0.0.1', '0.0.1'))
  // A name rule never matches a literal and a literal rule never matches a
  // name: deciding that would take a reverse lookup — slow, and forgeable.
  assert.ok(!proxy.matchesDomain('93.184.216.34', 'example.com'))
  assert.ok(!proxy.matchesDomain('example.com', '93.184.216.34'))
  assert.ok(proxy.matchesDomain('::1', '::1'))
  assert.ok(!proxy.matchesDomain('::1', 'localhost'))
})

test('rule 1: an empty allow list permits everything, including a host nothing mentions', () => {
  assert.ok(decide('pastebin.com', { allow: [] }))
  assert.ok(decide('anything.at.all', {}), 'a policy with no list is an empty list')
  assert.ok(decide('anything.at.all', undefined), 'a missing policy is the default policy')
})

test('rule 2: one entry, and only what is listed gets out', () => {
  const policy = { allow: ['registry.npmjs.org', 'github.com'] }
  assert.ok(decide('registry.npmjs.org', policy))
  assert.ok(decide('api.github.com', policy), 'a subdomain of a listed host is listed')
  assert.ok(!decide('pastebin.com', policy))
  assert.equal(proxy.policyDecision('pastebin.com', 443, policy).rule, 'allowlist')
  assert.equal(proxy.policyDecision('github.com', 443, policy).match, 'github.com')
})

test('an entry may name a port, and then it is that port and no other', () => {
  const policy = { allow: ['host.docker.internal:5173'] }
  assert.ok(decide('host.docker.internal', policy, 5173))
  assert.ok(!decide('host.docker.internal', policy, 5174))
  // A bare host covers every port on it.
  assert.ok(decide('host.docker.internal', { allow: ['host.docker.internal'] }, 5174))
})

test('a list this process cannot read is no list at all, and parseConfig is what refuses it', () => {
  // `allowEntries` reads a malformed list as empty — which is rule 1, i.e. open.
  // That is only safe because `parseConfig` refuses such a config outright
  // rather than handing it here; the two are tested together below.
  assert.deepEqual(proxy.allowEntries({ allow: 'github.com' }), [])
  assert.ok(decide('anything.at.all', { allow: 'github.com' }))
  assert.equal(proxy.parseConfig({ ...CONFIG, network: { policy: { allow: 'github.com' } } }).config, undefined)
})

// -- the built-in denylist (§6.4) --------------------------------------------

test('an address is read as octets, not as text — every spelling of one is one address', () => {
  const bytes = (ip) => proxy.ipToBytes(ip) && [...proxy.ipToBytes(ip)]
  assert.deepEqual(bytes('127.0.0.1'), [127, 0, 0, 1])
  assert.deepEqual(bytes('::1'), [...new Array(15).fill(0), 1])
  assert.deepEqual(bytes('0:0:0:0:0:0:0:1'), bytes('::1'), 'compressed and full are one address')
  assert.deepEqual(bytes('::ffff:127.0.0.1')?.slice(10), [0xff, 0xff, 127, 0, 0, 1])
  assert.equal(proxy.ipToBytes('example.com'), null)
  assert.equal(proxy.ipToBytes('999.1.1.1'), null)
})

test('the denied ranges are this machine, in both address families', () => {
  const denied = (ip) => proxy.deniedRange(ip)
  assert.equal(denied('127.0.0.1'), 'loopback')
  assert.equal(denied('127.99.99.99'), 'loopback', 'the whole of 127/8')
  assert.equal(denied('0.0.0.0'), 'loopback', 'which is the local host by another spelling')
  assert.equal(denied('169.254.169.254'), 'link-local', 'the cloud metadata service')
  assert.equal(denied('10.0.0.1'), 'private')
  assert.equal(denied('172.16.0.1'), 'private')
  assert.equal(denied('172.31.255.254'), 'private')
  assert.equal(denied('192.168.1.1'), 'private')
  assert.equal(denied('::1'), 'loopback')
  assert.equal(denied('fe80::1'), 'link-local')
  assert.equal(denied('fd12::1'), 'private', 'unique-local is the RFC1918 of v6')
  // The bypass a text comparison would miss: the same address, wrapped.
  assert.equal(denied('::ffff:169.254.169.254'), 'link-local')
  assert.equal(denied('::ffff:10.0.0.1'), 'private')

  // 172.16/12 is twelve bits, not two octets, and the neighbours are public.
  assert.equal(denied('172.15.0.1'), null)
  assert.equal(denied('172.32.0.1'), null)
  assert.equal(denied('93.184.216.34'), null)
  assert.equal(denied('2606:4700:4700::1111'), null)
  assert.equal(denied('::ffff:8.8.8.8'), null)
  assert.equal(denied('not-an-address'), null, 'a name has no range; that is what resolution is for')
})

test('every notation that wraps a v4 address is unwrapped, not just the common one', () => {
  const denied = (ip) => proxy.deniedRange(ip)
  // v4-compatible ::/96 — deprecated, still routed by some stacks.
  assert.equal(denied('::127.0.0.1'), 'loopback')
  assert.equal(denied('::169.254.169.254'), 'link-local')
  // NAT64's well-known prefix, 64:ff9b::/96: the quad is the last four bytes.
  assert.equal(denied('64:ff9b::a9fe:a9fe'), 'link-local', 'the metadata service via NAT64')
  assert.equal(denied('64:ff9b::127.0.0.1'), 'loopback')
  assert.equal(denied('64:ff9b::8.8.8.8'), null, 'a public quad is still public through NAT64')
  // 6to4's 2002::/16 keeps its quad in bits 16-47 instead.
  assert.equal(denied('2002:a9fe:a9fe::'), 'link-local', 'the metadata service via 6to4')
  assert.equal(denied('2002:7f00:1::1'), 'loopback')
  assert.equal(denied('2002:5db8:d822::'), null, '93.184.216.34, a public quad in 6to4 clothing')
})

test('the zero and one quads are denied inside a wrapper as well as bare', () => {
  const denied = (ip) => proxy.deniedRange(ip)
  // The v4-mapped forms are real quads out of 0/8, which reaches the local host
  // on Linux — the `::`/`::1` escape hatch below must not cover them too.
  assert.equal(denied('::ffff:0.0.0.0'), 'loopback')
  assert.equal(denied('::ffff:0.0.0.1'), 'loopback')
  assert.equal(denied('64:ff9b::0.0.0.0'), 'loopback')
  assert.equal(denied('2002:0:0::'), 'loopback')

  // …while `::` and `::1` are the unspecified and loopback addresses of v6, not
  // 0.0.0.0 and 0.0.0.1 wearing a prefix. Same answer here, but by the v6 rule.
  assert.equal(denied('::'), 'loopback')
  assert.equal(denied('::1'), 'loopback')
  assert.equal(denied('::0.0.0.1'), 'loopback', 'which is ::1, spelled the long way')
  // And the unwrapping never reaches into an address that only looks nearby.
  assert.equal(denied('2001:db8::a9fe:a9fe'), null, 'the documentation range is not NAT64')
  assert.equal(denied('2606:4700:4700::1111'), null, 'a plain public v6 address')
})

test('the docker host and the loopback are denied by name as well as by address', () => {
  assert.equal(proxy.deniedName('host.docker.internal'), 'host.docker.internal')
  assert.equal(proxy.deniedName('gateway.docker.internal'), 'gateway.docker.internal')
  assert.equal(proxy.deniedName('localhost'), 'localhost')
  assert.equal(proxy.deniedName('anything.localhost'), 'localhost', 'RFC 6761 reserves the subtree')
  assert.equal(proxy.deniedName('example.com'), null)
  assert.equal(proxy.deniedName('nothost.docker.internal'), null, 'the label boundary still holds')
  // The gateway address is refused too, wherever the daemon put it.
  assert.equal(proxy.deniedAddress('203.0.113.9'), null)
  assert.equal(proxy.deniedAddress('203.0.113.9', ['203.0.113.9']), 'host-gateway')
})

test('an explicit-allow entry is a host, or a host and one port', () => {
  assert.deepEqual(proxy.parseAllowEntry('host.docker.internal'), {
    host: 'host.docker.internal',
    port: null
  })
  assert.deepEqual(proxy.parseAllowEntry('host.docker.internal:5173'), {
    host: 'host.docker.internal',
    port: 5173
  })
  assert.deepEqual(proxy.parseAllowEntry('[::1]:8443'), { host: '::1', port: 8443 })
  assert.deepEqual(proxy.parseAllowEntry('::1'), { host: '::1', port: null }, 'a v6 literal is all colons and no port')
  assert.equal(proxy.parseAllowEntry('example.com:0'), null)
  assert.equal(proxy.parseAllowEntry('example.com:https'), null)
  assert.equal(proxy.parseAllowEntry(''), null)

  // A bare host covers every port on it; an entry with one covers that one.
  assert.ok(proxy.matchesAllowEntry('host.docker.internal', 9999, 'host.docker.internal'))
  assert.ok(proxy.matchesAllowEntry('host.docker.internal', 5173, 'host.docker.internal:5173'))
  assert.ok(!proxy.matchesAllowEntry('host.docker.internal', 5174, 'host.docker.internal:5173'))
  assert.ok(proxy.matchesAllowEntry('api.internal.corp', 443, 'internal.corp'), 'subdomains, as everywhere')
  assert.ok(!proxy.matchesAllowEntry('other.corp', 443, 'internal.corp'))
})

test('the list is the whole of the explicit allows; an empty one allows nothing explicitly', () => {
  const allowed = (host, port, policy) => !!proxy.explicitAllow(host, port, policy)
  // Rule 1 is a claim about the internet, not about this machine — so an empty
  // list never *explicitly* allows anything, and 10.0.0.1 stays refused below.
  assert.ok(!allowed('10.0.0.1', 443, { allow: [] }))
  assert.ok(!allowed('10.0.0.1', 443, undefined))
  assert.ok(allowed('10.0.0.1', 443, { allow: ['10.0.0.1'] }))
  assert.ok(!allowed('10.0.0.2', 443, { allow: ['10.0.0.1'] }))
  assert.ok(!allowed('10.0.0.1', 443, { allow: 'nonsense' }))
})

test('the three rules, in order: an entry, then a non-empty list, then the built-in one', () => {
  const vet = (host, port, policy) => proxy.vetTarget(host, port, policy)

  // Rule 1: an empty list does not open this machine.
  assert.deepEqual(vet('169.254.169.254', 80, { allow: [] }), {
    allowed: false,
    rule: 'builtin-denylist',
    match: 'link-local',
    ip: '169.254.169.254'
  })
  assert.equal(vet('host.docker.internal', 443, { allow: [] }).rule, 'builtin-denylist')

  // Rule 2 + 3: the entry beats the built-in denylist, by flipping the session
  // to "only what is listed" — the same list does both jobs.
  assert.deepEqual(vet('host.docker.internal', 5173, { allow: ['host.docker.internal:5173'] }), {
    allowed: true,
    explicit: 'host.docker.internal:5173'
  })
  assert.equal(
    vet('host.docker.internal', 5174, { allow: ['host.docker.internal:5173'] }).rule,
    'allowlist',
    'and no more than its target — refused now by the list, not by the built-in one'
  )
  assert.equal(
    vet('github.com', 443, { allow: ['host.docker.internal:5173'] }).rule,
    'allowlist',
    'and the rest of the internet goes with it: that is the price of rule 2'
  )

  // Rule 2 refuses a built-in-denied target it does not name, and says so as
  // "allowlist" — the rule the user can edit — rather than as the built-in one,
  // which is not consulted at all once the list has entries.
  assert.equal(vet('127.0.0.1', 443, { allow: ['example.com'] }).rule, 'allowlist')

  // Under rule 1 a public literal needs no resolution and is pinned to itself;
  // a name is resolved once and every address it answers with is vetted.
  assert.deepEqual(vet('93.184.216.34', 443, { allow: [] }), { allowed: true, ip: '93.184.216.34' })
  assert.deepEqual(vet('example.com', 443, { allow: [] }), { allowed: true, resolve: true })
  // Rule 3: a listed name is dialled as written and never resolved into a
  // refusal — `internal.corp.com` → 192.168.x is the case the entry exists for.
  assert.deepEqual(vet('internal.corp.com', 443, { allow: ['internal.corp.com'] }), {
    allowed: true,
    explicit: 'internal.corp.com'
  })
})

test('every resolved address has to pass, not just the one that would be used', () => {
  assert.deepEqual(proxy.vetAddresses(['93.184.216.34']), { allowed: true, ip: '93.184.216.34' })
  // A name that answers with a public address *and* a private one is a name
  // this proxy will not race against.
  assert.deepEqual(proxy.vetAddresses(['93.184.216.34', '192.168.1.5']), {
    allowed: false,
    rule: 'builtin-denylist',
    match: 'private',
    ip: '192.168.1.5'
  })
  assert.equal(proxy.vetAddresses(['169.254.169.254']).match, 'link-local')
  assert.equal(proxy.vetAddresses([]).match, 'unresolvable')
  assert.equal(proxy.vetAddresses(['not-an-address']).match, 'unresolvable')
  assert.equal(proxy.vetAddresses(['203.0.113.9'], ['203.0.113.9']).match, 'host-gateway')
})

test('the MCP route is exactly /mcp/<token>/<id>', () => {
  assert.deepEqual(proxy.parseMcpRoute('/mcp/TOK/github'), { token: 'TOK', id: 'github' })
  assert.deepEqual(proxy.parseMcpRoute('/mcp/TOK/my.linear_1'), { token: 'TOK', id: 'my.linear_1' })
  // The upstream's own path replaces this one wholesale, so there is nothing a
  // suffix could mean.
  assert.equal(proxy.parseMcpRoute('/mcp/TOK/github/'), null)
  assert.equal(proxy.parseMcpRoute('/mcp/TOK/github/extra'), null)
  assert.equal(proxy.parseMcpRoute('/mcp/TOK'), null)
  assert.equal(proxy.parseMcpRoute('/mcp//github'), null)
  assert.equal(proxy.parseMcpRoute('/healthz'), null)
  assert.equal(proxy.parseMcpRoute(''), null)
})

test('the CONNECT authority parser handles names, ports and v6 literals', () => {
  assert.deepEqual(proxy.parseAuthority('example.com:443'), { host: 'example.com', port: 443 })
  assert.deepEqual(proxy.parseAuthority('Example.COM.'), { host: 'example.com', port: 443 })
  assert.deepEqual(proxy.parseAuthority('[::1]:8443'), { host: '::1', port: 8443 })
  assert.deepEqual(proxy.parseAuthority('example.com:80', 443), { host: 'example.com', port: 80 })
  assert.equal(proxy.parseAuthority('example.com:0'), null)
  assert.equal(proxy.parseAuthority('example.com:70000'), null)
  assert.equal(proxy.parseAuthority('example.com:https'), null)
  assert.equal(proxy.parseAuthority(''), null)
})

test('token comparison is length-safe and rejects the empty token', () => {
  assert.ok(proxy.tokenMatches('abc', 'abc'))
  assert.ok(!proxy.tokenMatches('abc', 'abcd'))
  assert.ok(!proxy.tokenMatches('', ''), 'no scope has an empty token, so nothing may match one')
  assert.ok(!proxy.tokenMatches(undefined, 'abc'))
})

const CONFIG = {
  version: 1,
  session: 's1',
  token: 'TOK',
  mcp: { linear: { kind: 'registry', url: 'https://api.linear.app/mcp' } },
  network: { internal: false, policy: { allow: [] } }
}

test('a well-formed config parses into a scope', () => {
  const { config, error } = proxy.parseConfig(CONFIG)
  assert.equal(error, undefined)
  assert.equal(config.session, 's1')
  assert.equal(config.mcp.linear.url, 'https://api.linear.app/mcp')
  assert.deepEqual(config.mcp.linear.headers, [], 'headers default to none, never undefined')
  assert.equal(config.network.internal, false)
})

test('a config the proxy cannot fully read is refused, not partially applied', () => {
  const bad = (patch, why) => {
    const result = proxy.parseConfig({ ...CONFIG, ...patch })
    assert.equal(result.config, undefined, why)
    assert.match(result.error, /\S/)
  }
  bad({ version: 2 }, 'an unknown version is refused rather than guessed at')
  bad({ token: '' }, 'a scope with no token would be reachable by any path')
  bad({ session: undefined }, 'the session id names the log records')
  bad({ mcp: { x: { kind: 'stdio', url: 'https://a/b' } } }, 'HTTP transport only')
  bad({ mcp: { x: { kind: 'registry', url: 'not a url' } } })
  bad({ mcp: { x: { kind: 'registry', url: 'file:///etc/passwd' } } }, 'http(s) only')
  bad({ mcp: { x: { kind: 'registry', url: 'https://a/b', headers: [{ name: 'X' }] } } })
  // The allow list decides both directions — an unreadable one would be read as
  // empty, which is an *open* session whose user thinks they wrote a list. So it
  // is refused rather than skipped, and so is any single entry in it.
  bad({ network: { policy: { allow: 'host.docker.internal' } } })
  bad({ network: { policy: { allow: ['host.docker.internal:0'] } } })
  bad({ network: { policy: { allow: [{ host: 'x' }] } } })
  bad({ network: { policy: 'open' } }, 'a policy that is not an object is not a policy')
  assert.equal(proxy.parseConfig(null).config, undefined)
  assert.equal(proxy.parseConfig('{}').config, undefined)
})

test('a config with no policy at all is rule 1, not a refusal', () => {
  const { config, error } = proxy.parseConfig({ ...CONFIG, network: { internal: true } })
  assert.equal(error, undefined)
  assert.deepEqual(config.network.policy, { allow: [] })
  assert.equal(proxy.vetTarget('example.com', 443, config.network.policy).resolve, true)
})

test('the allow list rides through the config verbatim', () => {
  const { config, error } = proxy.parseConfig({
    ...CONFIG,
    network: { internal: true, policy: { allow: ['host.docker.internal:5173'] } }
  })
  assert.equal(error, undefined)
  assert.deepEqual(config.network.policy.allow, ['host.docker.internal:5173'])
  assert.equal(proxy.vetTarget('host.docker.internal', 5173, config.network.policy).allowed, true)
  assert.equal(
    proxy.vetTarget('registry.npmjs.org', 443, config.network.policy).rule,
    'allowlist',
    'and everything the list does not name is refused — rule 2, end to end'
  )
})
