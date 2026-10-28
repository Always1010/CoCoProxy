import { capturePreservation } from '../../packages/deployment/preservation.ts';

try {
  const args = process.argv.slice(2);
  if (![2, 3].includes(args.length) || args[0] !== '--management-settings' || args.length === 3 && args[2] !== '--frozen') throw new Error();
  process.stdout.write(JSON.stringify(await capturePreservation(args[1], args.length === 3)) + '\n');
} catch {
  process.stderr.write('REMOTE_PRESERVATION_SNAPSHOT_UNAVAILABLE\n');
  process.exitCode = 1;
}
