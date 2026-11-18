// Match the preparation, deployment and recovery deadlines in remote-deploy.py.
// Leave time for the coordinator to reap helpers and report the settled result.
const preparationSeconds = 660;
const deploymentSeconds = 600;
const recoverySeconds = 600;
const supervisorMarginSeconds = 30;
const recoveryMarginSeconds = 20;

export const UPDATER_PREVIEW_TIMEOUT_MS = (preparationSeconds + supervisorMarginSeconds) * 1000;
export const UPDATER_APPLY_TIMEOUT_MS = (preparationSeconds + deploymentSeconds + supervisorMarginSeconds) * 1000;
export const UPDATER_RECOVERY_GRACE_MS = (recoverySeconds + recoveryMarginSeconds) * 1000;
export const UPDATER_STOP_TIMEOUT_SECONDS = (UPDATER_APPLY_TIMEOUT_MS + UPDATER_RECOVERY_GRACE_MS) / 1000 + 30;
