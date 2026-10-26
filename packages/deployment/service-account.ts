export type ServiceAccountIdentity = { status: 'valid'; uid: number } | { status: 'required' } | { status: 'invalid' };

const nonLoginShells = new Set(['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']);
const serviceUser = (name: string) => typeof name === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(name) &&
  !['root', 'nobody'].includes(name);
const serviceUid = (uid: number) => Number.isSafeInteger(uid) && uid > 0 && uid <= 4_294_967_294;

export function validServiceAccountRequest(name: string, uid: number): boolean {
  return serviceUser(name) && serviceUid(uid);
}

/** Pure checks over a getent passwd snapshot; never reads or creates system accounts. */
export function inspectServiceAccount(accounts: string, name: string, expectedUid?: number): ServiceAccountIdentity {
  if (!serviceUser(name) || expectedUid !== undefined && !serviceUid(expectedUid)) return { status: 'invalid' };
  const entries = accounts.trim().split('\n').map(line => line.split(':'));
  const selected = entries.filter(entry => entry[0] === name);
  if (selected.length !== 1) return { status: 'required' };
  const entry = selected[0], uid = Number(entry[2]);
  if (entry.length !== 7 || !/^\d+$/.test(entry[2]) || !serviceUid(uid) ||
      expectedUid !== undefined && uid !== expectedUid || !nonLoginShells.has(entry[6]) ||
      entries.filter(other => Number(other[2]) === uid).length !== 1) return { status: 'invalid' };
  return { status: 'valid', uid };
}
