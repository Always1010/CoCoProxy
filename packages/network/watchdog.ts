import { setTimeout as delay } from 'node:timers/promises';
import { NetworkCoordinator, NetworkTransactionError, type NetworkObservation, type NetworkStatus } from './transaction.ts';

export class NetworkWatchdogError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NetworkWatchdogError'; this.code = code; }
}
export interface NetworkWatchdogSnapshot {
  running: boolean;
  status: Readonly<NetworkStatus> | null;
  /** Bounded-age local observation only; status is always historical. */
  observation: Readonly<NetworkObservation> | null;
  error: string | null;
}
const codes = new Set(['NETWORK_BUSY', 'NETWORK_HEALTH_FAILED', 'NETWORK_COMMAND_UNSETTLED',
  'NETWORK_RECOVERY_REQUIRED', 'NETWORK_RECOVERY_FAILED', 'NETWORK_CONTAINMENT_FAILED',
  'NETWORK_STORE_IO', 'NETWORK_STORE_CORRUPT', 'NETWORK_CLOCK_UNTRUSTED', 'NETWORK_STORE_LIMIT']);
const reason = (error: unknown) => error instanceof NetworkTransactionError && codes.has(error.code)
  ? error.code : 'NETWORK_WATCHDOG_FAILED';
const fail: (code: string) => never = code => { throw new NetworkWatchdogError(code); };

/** Same-process helper component. It never applies or reactivates a gateway.
 * The service must await start before accepting requests and reject new requests
 * before stop. Shutdown is successful only after explicit blocked recovery. */
export class NetworkWatchdog {
  private readonly coordinator: NetworkCoordinator;
  private readonly intervalMs: number;
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private changing = false;
  private needsContainment = false;
  private current: Omit<NetworkWatchdogSnapshot, 'running'> = { status: null, observation: null, error: null };
  constructor(coordinator: NetworkCoordinator, intervalMs = 2000) {
    if (!(coordinator instanceof NetworkCoordinator) || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 30_000) {
      fail('NETWORK_WATCHDOG_INPUT_INVALID');
    }
    this.coordinator = coordinator; this.intervalMs = intervalMs;
  }
  snapshot(): Readonly<NetworkWatchdogSnapshot> {
    const result = { ...this.current, running: this.task !== null };
    // A check finishing during shutdown must not republish ready while stop is
    // awaiting its task and then performing explicit containment.
    if (this.changing || this.controller?.signal.aborted) result.observation = null;
    if (result.observation) {
      const elapsed = Date.now() - result.observation.checkedAt;
      if (elapsed < 0 || elapsed > 30_000) { result.observation = null; result.error = 'NETWORK_OBSERVATION_EXPIRED'; }
    }
    return Object.freeze(result);
  }
  private save(status: NetworkStatus | null, observation: NetworkObservation | null, error: string | null): void {
    this.current = Object.freeze({ status: status && Object.freeze({ ...status }),
      observation: observation && Object.freeze({ ...observation }), error });
  }
  private async failed(error: unknown): Promise<void> {
    let status: NetworkStatus | null = null;
    try { status = await this.coordinator.status(); } catch { /* No guessed state after a failed read. */ }
    this.save(status, null, reason(error));
  }
  async start(): Promise<void> {
    if (this.changing || this.task || this.needsContainment) fail('NETWORK_WATCHDOG_BUSY');
    this.changing = true; this.needsContainment = true;
    try {
      // Saved ready cannot become permission merely because a loop restarted.
      const status = await this.coordinator.recover();
      this.save(status, null, status.fault);
      this.controller = new AbortController();
      this.task = this.run(this.controller.signal);
    } catch (error) {
      await this.failed(error); fail('NETWORK_WATCHDOG_START_FAILED');
    } finally { this.changing = false; }
  }
  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.coordinator.checkActive();
        this.save(result.status, result.observation, result.status.fault);
      } catch (error) { await this.failed(error); }
      // One check finishes before the next interval begins; no overlapping
      // setInterval callbacks and no automatic recover/apply on health failure.
      try { await delay(this.intervalMs, undefined, { signal }); }
      catch { if (!signal.aborted) { this.save(null, null, 'NETWORK_WATCHDOG_FAILED'); return; } }
    }
  }
  async stop(): Promise<void> {
    if (this.changing) fail('NETWORK_WATCHDOG_BUSY');
    if (!this.task && !this.needsContainment) return;
    this.changing = true;
    try {
      this.controller?.abort();
      await this.task; this.task = null; this.controller = null;
      const status = await this.coordinator.recover();
      this.save(status, null, status.fault); this.needsContainment = false;
    } catch (error) {
      await this.failed(error); fail('NETWORK_WATCHDOG_STOP_FAILED');
    } finally { this.changing = false; }
  }
}
