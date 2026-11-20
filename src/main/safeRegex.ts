import vm from 'node:vm'

/** Longest a single regex test may run on the main thread. */
export const REGEX_TEST_MS = 50

/**
 * `re.test(input)` with an enforced execution limit. An agent-supplied pattern
 * such as `^(a+)+$` can backtrack exponentially; V8 interrupts the script when
 * the vm timeout expires, which a plain `RegExp.test` cannot be. A test that
 * runs out of time counts as "no match".
 */
export function safeRegexTest(re: RegExp, input: string, timeoutMs = REGEX_TEST_MS): boolean {
  const ctx = vm.createContext({ src: re.source, flags: re.flags.replace(/[gy]/g, ''), input })
  try {
    return vm.runInContext('new RegExp(src, flags).test(input)', ctx, { timeout: timeoutMs }) === true
  } catch {
    return false
  }
}
