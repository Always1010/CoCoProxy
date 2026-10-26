#!/usr/bin/env python3
"""AlwayRoute adapter for the public remote deploy coordinator."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import time


def need(value, code):
    if not value:
        raise RuntimeError(code)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('action', choices=['status', 'disable', 'enable'])
    options = parser.parse_args()
    path = Path(options.config)
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600, 'REMOTE_ROUTER_CONFIG_PRIVATE_REQUIRED')
    config = json.loads(path.read_text())
    need(set(config) == {'host', 'user', 'port', 'identityFile', 'knownHostsFile'}, 'REMOTE_ROUTER_CONFIG_INVALID')
    ipaddress.ip_address(config['host'])
    need(re.fullmatch('[a-z_][a-z0-9_-]{0,31}', config['user']) and type(config['port']) is int and 1 <= config['port'] <= 65535, 'REMOTE_ROUTER_CONFIG_INVALID')
    for key in ['identityFile', 'knownHostsFile']:
        need(isinstance(config[key], str) and Path(config[key]).is_absolute() and not re.search('[\x00-\x1f\x7f]', config[key]), 'REMOTE_ROUTER_CONFIG_INVALID')
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
           '-o', 'UserKnownHostsFile=' + config['knownHostsFile'], '-i', config['identityFile'], '-p', str(config['port']), config['user'] + '@' + config['host']]

    def rpc(method, body=None, deadline=None):
        command = shlex.join(['ubus', 'call', 'alwayroute', method, json.dumps(body or {}, separators=(',', ':'))])
        remaining = 30 if deadline is None else deadline - time.monotonic()
        need(remaining > 0, 'REMOTE_ROUTER_JOB_TIMEOUT')
        try:
            result = subprocess.run([*ssh, command], capture_output=True, timeout=min(30, remaining))
        except subprocess.TimeoutExpired:
            raise RuntimeError('REMOTE_ROUTER_JOB_TIMEOUT' if deadline is not None else 'REMOTE_ROUTER_SSH_TIMEOUT') from None
        need(result.returncode == 0, 'REMOTE_ROUTER_SSH_FAILED')
        reply = json.loads(result.stdout)
        need(reply.get('ok') is True, 'REMOTE_ROUTER_RPC_FAILED')
        return reply

    def status():
        need(rpc('job_status').get('busy') is False, 'REMOTE_ROUTER_BUSY')
        state = rpc('external_status')['state']
        phase = state.get('phase')
        need(phase in ['active', 'disabled'], 'REMOTE_ROUTER_UNSTABLE')
        enabled = phase == 'active'
        need(state.get('desiredEnabled') is enabled, 'REMOTE_ROUTER_UNSTABLE')
        if not enabled:
            forwarding = state.get('localForwarding', {})
            need(all(forwarding.get(key) is False for key in ['running', 'guarded', 'residual']) and state.get('dns', {}).get('running') is False, 'REMOTE_ROUTER_NOT_DISABLED')
        return {'enabled': enabled}

    if options.action != 'status':
        before = status()
        if before['enabled'] != (options.action == 'enable'):
            body = {'expectedRevision': rpc('external_get')['config']['revision']} if options.action == 'enable' else {}
            reply = rpc('external_apply' if options.action == 'enable' else 'external_disable', body)
            if reply.get('job'):
                job_id = reply['job']['id']
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    current = rpc('job_status', deadline=deadline)['job']
                    need(current['id'] == job_id and current['status'] in ['running', 'succeeded'], 'REMOTE_ROUTER_JOB_FAILED')
                    if current['status'] == 'succeeded':
                        break
                    time.sleep(min(1, max(0, deadline - time.monotonic())))
                else:
                    raise RuntimeError('REMOTE_ROUTER_JOB_TIMEOUT')
    result = status()
    if options.action != 'status':
        need(result['enabled'] == (options.action == 'enable'), 'REMOTE_ROUTER_RESULT_UNCONFIRMED')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'REMOTE_ROUTER_FAILED', file=__import__('sys').stderr)
        raise SystemExit(1)
