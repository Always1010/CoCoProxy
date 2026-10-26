/** Candidate reader contract; no automatic data migration or downgrade guarantee. */
export const DEPLOYMENT_STATE_COMPATIBILITY = Object.freeze({ schemaVersion: 1,
  stateSchemas: Object.freeze({ transaction: 1, lifecycle: 1, trustedDevices: 1, notifications: 1,
    draft: 1, workspace: 1, siteProbes: 1, automaticSelections: 1, selection: 1, subscription: 1 }) });
