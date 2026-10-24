import { lstat, readlink, realpath, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNetworkCommand } from './command.ts';

const fail = (): never => { throw new Error('NETWORK_HOST_BPF_UNVERIFIED'); };
async function trusted(path: string, executable: boolean): Promise<string> {
  const actual = await realpath(path);
  if (executable ? !/^\/usr\/bin\/python3(?:\.\d{1,2})?$/.test(actual) : actual !== path) fail();
  for (let current = actual;; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.uid !== 0 || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      (current === actual ? !stat.isFile() || stat.nlink !== 1 || (executable && !(stat.mode & 0o111)) : !stat.isDirectory())) fail();
    if (current === '/') break;
  }
  return actual;
}
/** Fixed standard-library helper; never invokes bpftool's BPF-loading PID iterator. */
export async function readKernelBpf(): Promise<string> {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !['x64', 'arm64'].includes(process.arch) ||
    (await statfs('/proc')).type !== 0x9fa0) fail();
  for (const namespace of ['user', 'net', 'pid', 'cgroup', 'mnt']) {
    if (await readlink(`/proc/self/ns/${namespace}`) !== await readlink(`/proc/1/ns/${namespace}`)) fail();
  }
  const binary = await trusted('/usr/bin/python3', true);
  const helper = await trusted(fileURLToPath(new URL('./host-bpf.py', import.meta.url)), false);
  return runNetworkCommand(binary, ['-I', '-S', '-B', helper], { timeoutMs: 3000, maxOutputBytes: 4096 });
}
