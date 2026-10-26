#!/usr/bin/env python3
"""AlwayRoute adapter for the public remote deploy coordinator."""
import argparse
import copy
import hashlib
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


def declaration():
    return json.loads((Path(__file__).resolve().parents[1] / 'packages/setup/router-adapter.json').read_text())


def private_json(path):
    path = Path(path)
    info = path.lstat()
    need(path.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
         and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 128 * 1024, 'REMOTE_ROUTER_CONFIG_PRIVATE_REQUIRED')
    return json.loads(path.read_text())


def validate_parameters(value, adapter):
    invalid = 'REMOTE_ROUTER_PARAMETERS_INVALID'
    need(isinstance(value, dict) and type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1 and value.get('contract') == adapter['contract']
         and value.get('adapter') == {'id': adapter['id'], 'version': adapter['version']}, invalid)
    template = value.get('configTemplate')
    need(isinstance(template, dict) and set(template) == {'schema', 'enabled', 'family', 'faultPolicy', 'link', 'clientMode',
         'clientCIDR', 'clients', 'dns', 'bypass4'}, invalid)
    need(type(template['schema']) is int and template['schema'] == adapter['configurationSchema'] and type(template['enabled']) is bool
         and template['family'] == 'ipv4' and template['faultPolicy'] == 'block' and template['clientMode'] == 'lan'
         and template['clients'] == [] and template['bypass4'] == [], invalid)
    link, dns = template['link'], template['dns']
    need(isinstance(link, dict) and set(link) == {'interface', 'routerAddress', 'gatewayAddress', 'gatewayMac'}
         and isinstance(dns, dict) and set(dns) == {'gatewayPort', 'listenPort', 'localDomains'}, invalid)
    need(isinstance(link['interface'], str) and re.fullmatch('[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}', link['interface'])
         and link['interface'] != 'lo' and all(isinstance(link[key], str) for key in ['routerAddress', 'gatewayAddress'])
         and isinstance(template['clientCIDR'], str), invalid)
    network = ipaddress.IPv4Network(template['clientCIDR'], strict=True)
    router = ipaddress.IPv4Address(link['routerAddress'])
    gateway = ipaddress.IPv4Address(link['gatewayAddress'])
    need(1 <= network.prefixlen <= 29 and not network.overlaps(ipaddress.IPv4Network('198.18.0.0/30')) and router != gateway and all(address in network and address not in
         [network.network_address, network.broadcast_address] and not address.is_multicast and not address.is_loopback
         and not address.is_link_local and 0 < int(address) >> 24 < 224 for address in [router, gateway]), invalid)
    for mac in [link['gatewayMac'], value.get('deliveryMAC')]:
        need(isinstance(mac, str) and re.fullmatch('[0-9a-f]{2}(:[0-9a-f]{2}){5}', mac) and int(mac[:2], 16) & 1 == 0
             and mac != '00:00:00:00:00:00', invalid)
    need(link['gatewayMac'] != value['deliveryMAC'] and value.get('managedIPv4') == template['clientCIDR']
         and value.get('routerIPv4') == link['routerAddress'] and value.get('nextHopIPv4') == link['gatewayAddress']
         and value.get('dnsPort') == dns['gatewayPort'] and value.get('preserveClientSource') is True
         and value.get('managedPublicIPv6') == 'block' and value.get('independentDisableRequired') is True, invalid)
    need(type(dns['gatewayPort']) is int and 1024 <= dns['gatewayPort'] <= 65535 and type(dns['listenPort']) is int
         and 1 <= dns['listenPort'] <= 65535 and dns['listenPort'] != 53, invalid)
    domains = dns['localDomains']
    need(isinstance(domains, list) and 1 <= len(domains) <= 16 and all(isinstance(domain, str) and len(domain) <= 253
         and all(re.fullmatch('[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?', label) for label in domain.split('.')) for domain in domains)
         and len(set(domains)) == len(domains), invalid)
    pre = value.get('prerequisites', {})
    need(isinstance(pre, dict) and pre.get('baseDNSIndependentConfirmed') is True and pre.get('verification') == 'operator-confirmation'
         and pre.get('endToEnd') == 'unverified' and pre.get('baseDNS') == {**adapter['baseDNS'], 'localDomains': domains,
         'unqualifiedNames': True}, invalid)
    resolvers = pre.get('bootstrapResolvers')
    need(isinstance(resolvers, list) and 1 <= len(resolvers) <= 16, invalid)
    for resolver in resolvers:
        need(isinstance(resolver, str), invalid)
        address = ipaddress.ip_address(resolver)
        need(address != gateway and (address.version != 4 or address not in network or address == router), invalid)
    return copy.deepcopy(template)


def differences(before, after, prefix=''):
    if isinstance(before, dict) and isinstance(after, dict):
        result = []
        for key in sorted(set(before) | set(after)):
            result.extend(differences(before.get(key), after.get(key), prefix + '.' + key if prefix else key))
        return result
    return [] if before == after else [{'field': prefix, 'before': before, 'after': after}]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--parameters', help='Private output from configure --router-output')
    parser.add_argument('--apply', action='store_true', help='Explicitly save the reviewed configuration; never enables it')
    parser.add_argument('--reviewed-plan-sha256')
    parser.add_argument('action', choices=['status', 'disable', 'enable', 'check-adapter', 'preview-config', 'check-config', 'save-config'])
    options = parser.parse_args()
    need(not (options.apply or options.reviewed_plan_sha256) or options.action == 'save-config', 'REMOTE_ROUTER_ARGUMENTS_INVALID')
    need(not options.reviewed_plan_sha256 or options.apply, 'REMOTE_ROUTER_ARGUMENTS_INVALID')
    need(options.action not in ['preview-config', 'check-config', 'save-config'] or options.parameters, 'REMOTE_ROUTER_PARAMETERS_REQUIRED')
    config = private_json(options.config)
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

    def observed_state():
        need(rpc('job_status').get('busy') is False, 'REMOTE_ROUTER_BUSY')
        state = rpc('external_status')['state']
        phase = state.get('phase')
        need(phase in ['active', 'disabled'], 'REMOTE_ROUTER_UNSTABLE')
        enabled = phase == 'active'
        need(state.get('desiredEnabled') is enabled, 'REMOTE_ROUTER_UNSTABLE')
        if not enabled:
            forwarding = state.get('localForwarding', {})
            need(all(forwarding.get(key) is False for key in ['running', 'guarded', 'residual']) and forwarding.get('bootGuarded') is not True
                 and state.get('dns', {}).get('running') is False, 'REMOTE_ROUTER_NOT_DISABLED')
        return state

    def wait_job(reply):
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

    # Independent close is not gated by degraded status, capabilities or mapping.
    if options.action == 'disable':
        wait_job(rpc('external_disable'))
        need(observed_state()['desiredEnabled'] is False, 'REMOTE_ROUTER_RESULT_UNCONFIRMED')
        print(json.dumps({'enabled': False}))
        return
    if options.action == 'status':
        print(json.dumps({'enabled': observed_state()['desiredEnabled']}))
        return

    adapter = declaration()
    capabilities = rpc('capabilities')
    proxy = capabilities.get('externalProxy', {})
    required = adapter['requiredExternalProxy']
    need(isinstance(proxy, dict) and type(proxy.get('schema')) is int and isinstance(proxy.get('clientModes'), list)
         and type(capabilities.get('schema')) is int and capabilities['schema'] == 1 and capabilities.get('backend') == 'external'
         and all(proxy.get(key) == value for key, value in required.items() if key != 'clientMode')
         and required['clientMode'] in proxy.get('clientModes', []), 'REMOTE_ROUTER_CAPABILITIES_INCOMPATIBLE')
    current = rpc('external_get')['config']
    need(isinstance(current, dict) and type(current.get('schema')) is int and current['schema'] == adapter['configurationSchema']
         and type(current.get('revision')) is int and 0 <= current['revision'] <= 2147483645, 'REMOTE_ROUTER_SCHEMA_INCOMPATIBLE')
    if options.action == 'check-adapter':
        print(json.dumps({'schemaVersion': 1, 'adapter': {'id': adapter['id'], 'version': adapter['version']},
                          'compatible': True, 'configurationSchema': current['schema'],
                          'scope': 'capabilities-and-readable-configuration-schema', 'endToEnd': 'unverified'}))
        return
    parameters = private_json(options.parameters) if options.parameters else None
    template = validate_parameters(parameters, adapter) if options.parameters else None
    state = observed_state()
    candidate = {**template, 'revision': current['revision']} if template else None

    if options.action in ['preview-config', 'save-config']:
        need(state['desiredEnabled'] is False, 'REMOTE_ROUTER_DISABLE_BEFORE_SAVE')
        need(current['revision'] < 2147483645, 'REMOTE_ROUTER_REVISION_EXHAUSTED')
        plan = {'schemaVersion': 1, 'adapter': {'id': adapter['id'], 'version': adapter['version']}, 'target': config,
                'expectedRevision': current['revision'], 'currentConfiguration': current, 'configuration': candidate,
                'parameters': parameters,
                'changes': differences(current, candidate), 'persistentIntentEnabled': False,
                'candidateEnabled': candidate['enabled'], 'networkApplied': False}
        digest = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
        if options.action == 'save-config' and options.apply:
            need(options.reviewed_plan_sha256 == digest, 'REMOTE_ROUTER_PLAN_REVIEW_REQUIRED')
            # Recheck disabled immediately before CAS; the router serializes the save.
            need(observed_state()['desiredEnabled'] is False, 'REMOTE_ROUTER_DISABLE_BEFORE_SAVE')
            reply = rpc('external_save', {'expectedRevision': current['revision'], 'config': candidate})
            saved = {**candidate, 'revision': current['revision'] + 1}
            need(reply.get('config') == saved and rpc('external_get').get('config') == saved,
                 'REMOTE_ROUTER_SAVE_UNCONFIRMED')
            need(observed_state()['desiredEnabled'] is False, 'REMOTE_ROUTER_RESULT_UNCONFIRMED')
            print(json.dumps({'schemaVersion': 1, 'saved': True, 'savedRevision': saved['revision'],
                              'candidateEnabled': saved['enabled'], 'persistentIntentEnabled': False, 'networkApplied': False}))
        else:
            print(json.dumps({**plan, 'planSha256': digest}))
        return

    if template:
        need(current == candidate, 'REMOTE_ROUTER_CONFIGURATION_MISMATCH')
    if options.action == 'check-config':
        print(json.dumps({'schemaVersion': 1, 'configurationMatches': True, 'savedRevision': current['revision'],
                          'enabled': state['desiredEnabled'], 'appliedRevision': state.get('appliedRevision'),
                          'appliedConfigurationMatches': state['desiredEnabled'] is True and state.get('appliedRevision') == current['revision'],
                          'endToEnd': 'unverified'}))
        return
    need(current.get('enabled') is True, 'REMOTE_ROUTER_CANDIDATE_DISABLED')
    if not state['desiredEnabled']:
        wait_job(rpc('external_apply', {'expectedRevision': current['revision']}))
    final = observed_state()
    need(final['desiredEnabled'] is True, 'REMOTE_ROUTER_RESULT_UNCONFIRMED')
    if template:
        need(rpc('external_get')['config'] == candidate and final.get('appliedRevision') == current['revision'],
             'REMOTE_ROUTER_CONFIGURATION_MISMATCH')
    print(json.dumps({'enabled': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'REMOTE_ROUTER_FAILED', file=__import__('sys').stderr)
        raise SystemExit(1)
