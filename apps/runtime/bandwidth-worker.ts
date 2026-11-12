import { fstatSync } from 'node:fs';
import { loadBandwidthWorkerSettings, createBandwidthWorkerHost, createBandwidthWorkerServer, listenBandwidthWorkerSocket } from '../../packages/runtime/bandwidth-worker.ts';

async function main() {
  const args = process.argv.slice(2);
  if (process.platform !== 'linux' || args.length !== 2 || args[0] !== '--settings'
      || process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1' || !fstatSync(3).isSocket()) throw new Error();
  const settings = await loadBandwidthWorkerSettings(args[1]);
  if (process.getuid?.() !== settings.runtime.serviceUid) throw new Error();
  const worker = createBandwidthWorkerServer(createBandwidthWorkerHost(settings), { singleTask: true });
  listenBandwidthWorkerSocket(worker.server, 3);
  let closing = false;
  const close = () => {
    if (closing) return; closing = true; clearInterval(idle);
    void worker.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  let quietSince = Date.now();
  const idle = setInterval(() => {
    if (worker.busy()) quietSince = Date.now();
    else if (Date.now() - quietSince > 3000) close();
  }, 500);
  worker.server.once('close', () => { clearInterval(idle); process.exitCode = 0; });
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
void main().catch(() => { process.exitCode = 1; });
