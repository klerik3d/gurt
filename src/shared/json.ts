// The one "is this a JSON object" guard, shared by main, renderer and plugins:
// a non-null, non-array object. Imports nothing, so any layer may take it.
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
