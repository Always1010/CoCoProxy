import type { Readable } from 'node:stream';
import type { UpdateStep } from './types.ts';

export const coordinatorSteps = {
  'verify-payload': 'preparing',
  'check-state': 'preparing',
  'check-pinned-state': 'preparing',
  'check-router': 'preparing',
  'stage-release': 'staging',
  'stop-services': 'installing',
  'apply-release': 'installing',
  'restore-services': 'finishing',
  'verify-services': 'finishing',
  'restore-router': 'finishing',
  'recover-services': 'recovering',
} as const satisfies Record<string, UpdateStep | 'recovering'>;

export type CoordinatorReport = { event: 'failure'; code: string }
  | { event: 'step'; step: keyof typeof coordinatorSteps }
  | { event: 'candidates'; completed: number; total: number };

const nativeCode = /^(?:REMOTE|INSTALL|SETUP|RUNTIME|UPGRADE|DEPLOYMENT_STATE|AUTOMATIC_GATEWAY)_[A-Z0-9_]{1,80}$/;
const aliases: Record<string, string> = {
  INSTALL_PYTHON_3_9_REQUIRED: 'UPDATER_PYTHON_VERSION_REQUIRED',
  INSTALL_NODE_22_18_REQUIRED: 'UPDATER_NODE_VERSION_REQUIRED',
  INSTALL_IPV4_FORWARDING_REQUIRED: 'UPDATER_IP_FORWARDING_REQUIRED',
};

/** Keep the existing persisted error format readable by older updater versions. */
export function coordinatorError(code: unknown, fallback: string): string {
  if (typeof code !== 'string' || !nativeCode.test(code) || code === 'REMOTE_DEPLOYMENT_FAILED') return fallback;
  return aliases[code] ?? (/^[A-Z_]+$/.test(code) ? 'UPDATER_' + code.replace(/^REMOTE_/, '') : fallback);
}

function parseReport(line: string): CoordinatorReport | null {
  if (!line.startsWith('{')) return null;
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  const fields = Object.keys(value).length;
  if (value.event === 'failure' && fields === 2 && typeof value.code === 'string' && nativeCode.test(value.code)) {
    return { event: 'failure', code: value.code };
  }
  if (value.event === 'step' && fields === 2 && typeof value.step === 'string' && Object.hasOwn(coordinatorSteps, value.step)) {
    return { event: 'step', step: value.step };
  }
  if (value.event === 'candidates' && fields === 3 && Number.isSafeInteger(value.completed) && Number.isSafeInteger(value.total)
    && value.completed >= 0 && value.completed <= value.total && value.total <= 4096) {
    return { event: 'candidates', completed: value.completed, total: value.total };
  }
  return null;
}

/** The report pipe carries only short, newline-delimited records from trusted deployment code. */
export function readCoordinatorReports(stream: Readable, report: (value: CoordinatorReport) => void): void {
  let line = '', oversized = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = chunk.split('\n');
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        const value = oversized ? null : parseReport(line);
        if (value) report(value);
        line = ''; oversized = false;
      }
      if (oversized || line.length + part.length > 512) { line = ''; oversized = true; }
      else line += part;
    }
  });
  stream.on('error', () => { /* Optional telemetry must not affect deployment. */ });
}
