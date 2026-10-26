import { request } from 'node:https';
import { cloneConfigJson, type JsonObject } from '../config/index.ts';
import { renderDeploymentPlan } from '../deployment/plan.ts';

type ProbeCode = 'SETUP_MANAGEMENT_HTTPS_REACHABLE' | 'SETUP_MANAGEMENT_HTTPS_REQUIRED' | 'SETUP_MANAGEMENT_HTTPS_FAILED'
  | 'SETUP_MANAGEMENT_HTTPS_TIMEOUT' | 'SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID';
export interface ManagementHttpsHost { now(): number; probeHttps(origin: string): Promise<ProbeCode> }

/** Fixed public GET only. No redirects, login, cookies, custom CA, TLS bypass or unbounded response. */
export async function probeManagementHttps(origin: string, transport: typeof request = request,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis): Promise<ProbeCode> {
  if (new URL(origin).protocol !== 'https:') return 'SETUP_MANAGEMENT_HTTPS_REQUIRED';
  return new Promise(resolve => {
    let settled = false;
    let outgoing: ReturnType<typeof request> | undefined;
    const finish = (code: ProbeCode) => { if (!settled) { settled = true; timers.clearTimeout(timer); resolve(code); } };
    const timer = timers.setTimeout(() => { finish('SETUP_MANAGEMENT_HTTPS_TIMEOUT'); outgoing?.destroy(); }, 5000);
    try {
      outgoing = transport(new URL('/api/cocoproxy/health', origin), {
        method: 'GET', rejectUnauthorized: true, agent: false, headers: { accept: 'application/json' },
      }, response => {
        if (response.statusCode !== 200) { finish('SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID'); response.destroy(); return; }
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 2048) { finish('SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID'); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', () => finish('SETUP_MANAGEMENT_HTTPS_FAILED'));
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(body?.responding === true && body?.scope === 'management_only' ? 'SETUP_MANAGEMENT_HTTPS_REACHABLE' : 'SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID');
          } catch { finish('SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID'); }
        });
      });
      outgoing.on('error', () => finish('SETUP_MANAGEMENT_HTTPS_FAILED'));
      outgoing.end();
    } catch { finish('SETUP_MANAGEMENT_HTTPS_FAILED'); outgoing?.destroy(); }
  });
}


export async function createManagementHttpsReport(deploymentInput: unknown, options: { probeHttps?: boolean } = {},
  host: ManagementHttpsHost = { now: Date.now, probeHttps: probeManagementHttps }) {
  const input = cloneConfigJson(deploymentInput) as JsonObject;
  renderDeploymentPlan(input);
  let code: ProbeCode | 'SETUP_MANAGEMENT_NOT_RUN' = 'SETUP_MANAGEMENT_NOT_RUN';
  if (options.probeHttps) {
    try { code = await host.probeHttps((input.management as JsonObject).origin as string); }
    catch { code = 'SETUP_MANAGEMENT_HTTPS_FAILED'; }
  }
  return { schemaVersion: 1, readOnly: true, generatedAt: host.now(),
    checks: [{ id: 'https-reachable', status: !options.probeHttps ? 'not-run' : code === 'SETUP_MANAGEMENT_HTTPS_REACHABLE' ? 'pass' : 'fail',
      code, scope: 'invoking-node', source: options.probeHttps ? 'node-https-probe' : 'none',
      reason: !options.probeHttps ? '尚未执行管理 HTTPS 检查；使用 --probe-https 显式探测。'
        : code === 'SETUP_MANAGEMENT_HTTPS_REACHABLE' ? '调用端 Node 已完成可信 TLS 及固定管理 health 响应检查。'
          : '调用端 Node 未通过可信 TLS 或固定管理 health 响应检查。',
      action: '在实际浏览器另行验收证书信任和登录；Node 检查不能证明这些终端行为。' }] };
}
