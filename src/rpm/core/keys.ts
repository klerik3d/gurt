// RPM — a step's key (t3v2 §6): `<executor>:<run>:<step>`. Written by the
// engine into each `step` entry and into a reviewer's `reviewerOf.key`; read
// back where a reviewer session needs to know which run it belongs to.

/** The key of step `step` of run `run` of `executor`. */
export const stepKey = (executor: string, run: number, step: number): string => `${executor}:${run}:${step}`

/** The run a step key names; undefined when `key` is not one. Read from the
 *  end: an executor id is opaque and may hold a `:` itself. */
export function runOfStepKey(key: string): number | undefined {
  const m = /:(\d+):\d+$/.exec(key)
  return m ? Number(m[1]) : undefined
}
