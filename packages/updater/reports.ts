import type { Readable } from 'node:stream';

export interface CoordinatorReport {
  event: 'failure';
  code: string;
}

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

/** The report pipe carries only short, newline-delimited records from trusted deployment code. */
export function readCoordinatorReports(stream: Readable, report: (value: CoordinatorReport) => void): void {
  let line = '', oversized = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = chunk.split('\n');
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        if (!oversized && line.startsWith('{')) {
          let value;
          try { value = JSON.parse(line); } catch { /* Ignore malformed records. */ }
          if (value?.event === 'failure' && typeof value.code === 'string' && nativeCode.test(value.code)
            && Object.keys(value).length === 2) report({ event: 'failure', code: value.code });
        }
        line = ''; oversized = false;
      }
      if (oversized || line.length + part.length > 512) { line = ''; oversized = true; }
      else line += part;
    }
  });
  stream.on('error', () => { /* Optional telemetry must not affect deployment. */ });
}
