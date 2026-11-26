// rpm/ui — the only public entry for the renderer (t3v2 §1, §3.3). React: the
// Review tab, the badge, useRpm, and the host the app provides (IPC, links,
// app components rpm/ui may not import).
export { ReviewTab } from './ReviewTab'
export { ReviewBadge, badgeCount } from './ReviewBadge'
export { useRpm, type RpmData } from './useRpm'
export { RpmHostProvider, useRpmHost, type RpmApi, type RpmHost, type ReviewerFieldsProps, type ReviewFocus } from './host'
export { RpmChatLine } from './ChatLine'
export { FindingPopup, FindingRef, FindingText, useFindingHover } from './FindingPopup'
export { statusLine, markFiles, type StatusLine, type Filter } from './labels'
export { INFO as SETTINGS_INFO } from './Settings'
// Which run a reviewer session belongs to (its `reviewerOf.key`).
export { runOfStepKey } from '../core'
