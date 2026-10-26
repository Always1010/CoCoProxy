import { capturePreservation } from '../../packages/deployment/preservation.ts';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--management-settings') throw new Error();
  process.stdout.write(JSON.stringify(await capturePreservation(args[1])) + '\n');
} catch {
  process.stderr.write('REMOTE_PRESERVATION_SNAPSHOT_UNAVAILABLE\n');
  process.exitCode = 1;
}
