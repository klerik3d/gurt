// rpm/ui — the only public entry for the renderer (t3v2 §1, §3.3). React: the
// Review tab, the badge, useRpm, and the host the app provides (IPC, links,
// app components rpm/ui may not import).
// TODO(rpm): task 12 adds RpmChatLine, FindingPopup and useFindingHover.
export { ReviewTab } from './ReviewTab'
export { ReviewBadge, badgeCount } from './ReviewBadge'
export { useRpm, type RpmData } from './useRpm'
export { RpmHostProvider, useRpmHost, type RpmApi, type RpmHost, type ReviewerFieldsProps } from './host'
export { statusLine, type StatusLine } from './labels'
export { INFO as SETTINGS_INFO } from './Settings'
