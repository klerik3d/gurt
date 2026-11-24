// The app's adapters for RPM's ports (t3v2 §4); kernel.ts assembles them.
export { createSessionsPort, type SessionsPortDeps } from './sessions'
export { createGitPort } from './git'
export { createCheckPort, readReposSync, type ReposOf } from './check'
export { createNotifyPort } from './notify'
export { createStorePort } from './store'
