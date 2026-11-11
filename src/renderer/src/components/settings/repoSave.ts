import type { GurtApi } from '../../../../shared/api'
import type { RepoConfig } from '../../../../shared/types'

/** How the Repos modal saves: edit an existing entry, register one by URL, or
 *  have gurt create a new local one. */
export type RepoSaveKind = 'update' | 'add' | 'create-local'

export type RepoSaveResult =
  | { ok: true }
  /** `created` is set when a local repo came into being but what the form
   *  collected beyond its name did not land: the repo exists, so the modal
   *  carries on as an edit of it — a retry must not create it a second time. */
  | { ok: false; error: string; created?: RepoConfig }

/**
 * Persist the Repos modal's `draft`. Creating a local repo takes its name only
 * (`createLocalRepo`), so the check command and the review defaults the form
 * collected go in as a second write — the same `updateRepo` an edit uses — on
 * the entry that creation returned (its storage url and `local` flag are
 * gurt's, not the form's). Never throws.
 */
export async function saveRepo(
  api: Pick<GurtApi, 'addRepo' | 'updateRepo' | 'createLocalRepo'>,
  ws: string,
  draft: RepoConfig,
  kind: RepoSaveKind
): Promise<RepoSaveResult> {
  let created: RepoConfig | undefined
  try {
    if (kind === 'update') await api.updateRepo(ws, draft)
    else if (kind === 'add') await api.addRepo(ws, draft)
    else {
      created = await api.createLocalRepo(ws, draft.name)
      if (draft.check || draft.review)
        await api.updateRepo(ws, {
          ...created,
          ...(draft.check ? { check: draft.check } : {}),
          ...(draft.review ? { review: draft.review } : {})
        })
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...(created ? { created } : {}) }
  }
}
