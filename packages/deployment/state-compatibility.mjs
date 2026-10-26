/** Candidate reader contract; no automatic data migration or downgrade guarantee. */
export const DEPLOYMENT_STATE_COMPATIBILITY = Object.freeze({ schemaVersion: 1,
  stateSchemas: Object.freeze({ transaction: 1, lifecycle: 1, trustedDevices: 1,
    draft: 1, workspace: 1, siteProbes: 1, automaticSelections: 1, selection: 1, subscription: 1 }),
  contentReaders: Object.freeze({ transaction: 'cocoproxy.transaction.v1', lifecycle: 'cocoproxy.lifecycle.v1',
    trustedDevices: 'cocoproxy.trustedDevices.v1', draft: 'cocoproxy.draft.v1',
    workspace: 'cocoproxy.workspace.v1', siteProbes: 'cocoproxy.siteProbes.v1', automaticSelections: 'cocoproxy.automaticSelections.v1',
    selection: 'cocoproxy.selection.v1', subscription: 'cocoproxy.subscription.v1' }),
  configurationReader: 'deployment-v1', candidateReader: 'canonical-compiled-v1' });
