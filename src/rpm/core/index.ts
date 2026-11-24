// rpm/core — the only public entry (t3v2 §1). Pure TS: types, the finding
// machine, the journal fold, "what next", the model texts, the view.
export * from './model'
export { move, ownerOf, allowedReplies, atOrAbove, tracked } from './machine'
export { fold, nextFindingId } from './fold'
export { next } from './next'
