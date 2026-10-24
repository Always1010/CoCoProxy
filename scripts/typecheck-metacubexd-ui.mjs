import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--directory' || !isAbsolute(args[1])) throw new Error('UI_DIRECTORY_REQUIRED');
const directory = resolve(args[1], 'packages/ui');
const upstream = createRequire(resolve(directory, 'package.json'));
if (upstream('vue-tsc/package.json').version !== '3.3.10') throw new Error('UI_CHECKER_VERSION_MISMATCH');
const tsc = fileURLToPath(new URL('../tooling/node_modules/typescript/lib/tsc.js', import.meta.url));
// vue-tsc's supported run(tscPath) API avoids its incompatible upstream TS 7.
process.chdir(directory);
process.argv = [process.argv[0], process.argv[1], '--noEmit'];
upstream('vue-tsc').run(tsc);
