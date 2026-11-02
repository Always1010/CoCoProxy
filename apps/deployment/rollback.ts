import { rollbackDeployment } from '../../packages/deployment/rollback.ts';
import { InstallError } from '../../packages/deployment/install.ts';

try {
  if (process.argv.length !== 2) throw new InstallError('INSTALL_ROLLBACK_ARGUMENTS_INVALID');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 256 * 1024) throw new InstallError('INSTALL_ROLLBACK_CONTEXT_INVALID');
    chunks.push(bytes);
  }
  const result = await rollbackDeployment(JSON.parse(Buffer.concat(chunks).toString()));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write((error instanceof InstallError ? error.code : 'INSTALL_ROLLBACK_FAILED') + '\n');
  process.exitCode = 1;
}
