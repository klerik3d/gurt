// gemini, main half: the Google sign-in it borrows, the native auth file that
// sign-in is delivered through, and the token probe.
import type { AgentMainPlugin } from '../../../shared/agentPlugin'
import { manifest } from './manifest'

// --- sign-in -------------------------------------------------------------------
//
// Google sign-in — Gemini subscription plans (Code Assist / Gemini accounts).
//
// BORROWED CLIENT_ID (docs/requirements-oauth-credentials.md §3): this is the
// public OAuth client of Google's own Gemini CLI. gurt launches that exact CLI
// (./manifest.ts), so the token this flow mints is consumed by the client the
// id names. The registration is NOT ours: Google can rotate, restrict or
// revoke it without notice, and this flow then breaks with no action on our
// side. That risk is accepted knowingly — if Gemini sign-in suddenly fails,
// start here.
//
// The `clientSecret` below is Google's installed-app shape, published verbatim
// in the Gemini CLI's own source: Google issues one even for clients it
// classifies as public, and it protects nothing (PKCE does). It is NOT a
// confidential-client credential — §10's "no client secrets" rule is about
// confidential clients, and this flow remains a public client with PKCE.
//
// Both values can be verified at the source in one click: Google publishes
// them verbatim as OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET in its own Gemini CLI,
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts
// — alongside Google's own comment that "it's ok to save this in git because
// this is an installed application". Google's OAuth docs say the same of
// installed-app credentials, whose client secret "is obviously not treated
// as a secret": https://developers.google.com/identity/protocols/oauth2#installed
//
// GitHub secret scanning WILL flag the GOCSPX- pattern below; that is a known
// false positive (the value is public in Google's repo above), and the alert
// is dismissed as such — the value must never be obfuscated to silence the
// scanner.

export const main: AgentMainPlugin = {
  id: manifest.id,

  // §5.2.1 of docs/requirements-oauth-credentials.md: gemini consumes a sign-in
  // through its native auth file, and its secretEnv var must stay unset — a
  // non-key value in GEMINI_API_KEY sends it down the API-key path, which is
  // the shipped bug §11 records.
  authFile: ({ credential, access }) => {
    // Verified against @google/gemini-cli@0.59.0 (bundle source, 2026-09-10):
    // the file is JSON.parse'd with no field validation and handed to
    // google-auth-library's OAuth2Client.setCredentials. `refresh_token` may
    // be omitted entirely: getAccessToken only consults it when the token is
    // missing or expiring, so an access token fresh at launch (resolveLaunch
    // guarantees >5 min, its skew window) carries the session to expiry.
    // `expiry_date` is epoch ms, compared straight to Date.now(). Startup
    // verifies the token with a live tokeninfo call — a freshly refreshed
    // access token passes it.
    const expiry = Date.parse(credential.data['expiresAt'] ?? '')
    return {
      path: '.gemini/oauth_creds.json',
      content: JSON.stringify({
        access_token: access,
        token_type: 'Bearer',
        ...(Number.isFinite(expiry) ? { expiry_date: expiry } : {})
      })
    }
  },

  oauth: {
    client: {
      id: 'google',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
      clientSecret: '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',
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
      ],
      tokenBody: 'form',
      // access_type=offline is what mints a refresh token; prompt=consent makes
      // Google mint one even for an account that consented before (it otherwise
      // omits it on re-auth, which would store a sign-in that cannot refresh).
      authParams: { access_type: 'offline', prompt: 'consent' },
      // Google allows any loopback port for installed apps — random, per RFC 8252.
      redirectHost: 'localhost',
      redirectPath: '/oauth2callback'
    },
    /** No id_token without the `openid` scope (which the borrowed
     *  registration's CLI does not request) — the account comes from the
     *  userinfo endpoint. */
    account: async (tokens, { fetch }) => {
      const access = tokens['access_token']
      if (typeof access !== 'string') return ''
      try {
        const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { authorization: `Bearer ${access}` }
        })
        if (!res.ok) return ''
        const info = (await res.json()) as Record<string, unknown>
        return typeof info['email'] === 'string' ? info['email'] : ''
      } catch {
        // The sign-in still worked; the entry just shows no account name.
        return ''
      }
    }
  },

  probeToken: (token) => ({
    label: 'Google',
    // Google's generative API takes the key in the query string; the header
    // form (`x-goog-api-key`) is equivalent and kept out of the URL for the
    // same reason a token never rides a log line.
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': token }
  })
}
