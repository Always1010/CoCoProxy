#!/usr/bin/env python3
"""Exercise native gateway artifacts in isolated user/network namespaces only."""
import importlib.util
import json
import ctypes
import os
import signal
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


# The parent must install a full UID map: a single-UID user namespace cannot
# represent the production all-UID exclusion rule. Only the child netns mutates.
if sys.argv[1] == '--launch':
    signal.signal(signal.SIGALRM, lambda *_: os.killpg(os.getpgrp(), signal.SIGKILL))
    signal.alarm(60)
    ready_r, ready_w = os.pipe()
    go_r, go_w = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(ready_r)
        os.close(go_w)
        if ctypes.CDLL(None, use_errno=True).unshare(0x10000000 | 0x40000000) != 0:
            os._exit(2)
        os.write(ready_w, b'1')
        os.close(ready_w)
        if os.read(go_r, 1) != b'1':
            os._exit(3)
        os.close(go_r)
        os.execv(sys.executable, [sys.executable, __file__, *sys.argv[2:]])
    os.close(ready_w)
    os.close(go_r)
    try:
        if os.read(ready_r, 1) != b'1':
            raise RuntimeError('CHILD_NAMESPACE_FAILED')
        Path(f'/proc/{child}/uid_map').write_text('0 0 4294967295')
        Path(f'/proc/{child}/setgroups').write_text('deny')
        Path(f'/proc/{child}/gid_map').write_text('0 0 4294967295')
        os.write(go_w, b'1')
    finally:
        os.close(ready_r)
        os.close(go_w)
    _, status = os.waitpid(child, 0)
    sys.exit(os.waitstatus_to_exitcode(status))

fixture = module('kernel_fixture', Path(__file__).with_name('gateway-kernel.py'))
network = module('gateway_network', Path(__file__).resolve().parents[2] / 'apps/gateway/network.py')
f = fixture


def driver(root):
    f.isolated()
    data = json.loads((root / 'input.json').read_text())
    n = data['network']
    f.check(network.guard(n) == data['guardRules'], 'GUARD_RENDERERS_DIFFER')
    roles = {}
    try:
        for name in ['first', 'second', 'router', 'gateway', 'origin']:
            roles[name] = f.Worker(name, root)
        first, second, router, gateway, origin = roles.values()
        f.check(len({r.net for r in roles.values()}) == 5, 'DISTINCT_NAMESPACES_REQUIRED')
        f.execute(['ip', 'link', 'add', 'br-fixture', 'type', 'bridge'])
        f.execute(['ip', 'link', 'set', 'br-fixture', 'up'])
        for index, (role, address, mac) in enumerate([(first, '192.0.2.10', '10'), (second, '192.0.2.20', '20'),
                (router, '192.0.2.1', '01'), (gateway, '192.0.2.2', '02')]):
            left, right = 'bridge' + str(index), 'peer' + str(index)
            f.execute(['ip', 'link', 'add', left, 'type', 'veth', 'peer', 'name', right])
            f.execute(['ip', 'link', 'set', left, 'master', 'br-fixture'])
            f.execute(['ip', 'link', 'set', left, 'up'])
            f.execute(['ip', 'link', 'set', right, 'netns', str(role.process.pid)])
            role.ip('link', 'set', right, 'name', 'lan-test')
            role.ip('link', 'set', 'lan-test', 'address', '02:00:00:00:00:' + mac)
            role.ip('addr', 'add', address + '/24', 'dev', 'lan-test')
            role.ip('link', 'set', 'lan-test', 'up')
        f.execute(['ip', 'link', 'add', 'wan-router', 'type', 'veth', 'peer', 'name', 'wan-origin'])
        for role, interface, address in [(router, 'wan-router', '198.51.100.1'), (origin, 'wan-origin', '198.51.100.2')]:
            f.execute(['ip', 'link', 'set', interface, 'netns', str(role.process.pid)])
            role.ip('addr', 'add', address + '/24', 'dev', interface)
            role.ip('link', 'set', interface, 'up')
        for address in ['198.51.100.77', '198.51.100.78']:
            origin.ip('addr', 'add', address + '/32', 'dev', 'wan-origin')
        for role in [router, gateway]:
            role.call('exec', args=['python3', '-c', "from pathlib import Path; Path('/proc/sys/net/ipv4/ip_forward').write_text('1')"])
        for role in roles.values():
            role.ip('link', 'set', 'lo', 'up')
            role.call('exec', args=['python3', '-c', "from pathlib import Path; [p.write_text('0') for k in ['rp_filter','send_redirects','accept_redirects'] for p in Path('/proc/sys/net/ipv4/conf').glob('*/'+k)]"])
        for client in [first, second]:
            client.ip('route', 'add', 'default', 'via', '192.0.2.1')
        gateway.ip('route', 'add', 'default', 'via', '192.0.2.1')
        gateway.ip('neigh', 'replace', '192.0.2.1', 'lladdr', n['routerMAC'], 'nud', 'permanent', 'dev', 'lan-test')
        origin.ip('route', 'add', '192.0.2.0/24', 'via', '198.51.100.1')
        router.ip('rule', 'add', 'priority', '100', 'from', '192.0.2.0/24', 'iif', 'lan-test', 'to', '198.51.100.0/24', 'table', '200')
        # Gateway egress is deliberately excluded from router recapture.
        router.ip('rule', 'add', 'priority', '99', 'from', '192.0.2.2', 'table', 'main')
        router.ip('route', 'add', '198.51.100.0/24', 'via', '192.0.2.2', 'dev', 'lan-test', 'table', '200')
        router.nft("""table inet auto_observe {
 counter first_return { }
 counter second_return { }
 chain forward {
  type filter hook forward priority 0; policy accept;
  iifname "lan-test" oifname "lan-test" ether saddr 02:00:00:00:00:02 ip saddr 198.51.100.2 ip daddr 192.0.2.10 counter name first_return
  iifname "lan-test" oifname "lan-test" ether saddr 02:00:00:00:00:02 ip saddr 198.51.100.2 ip daddr 192.0.2.20 counter name second_return
 }
}
""")
        snapshot_code = ("import json, runpy; h=runpy.run_path(" + repr(str(Path(network.__file__))) + " ); "
                         + "n=json.load(open(" + repr(str(root / 'input.json')) + "))['network']; print(json.dumps(h['snapshot'](n),sort_keys=True))")
        empty_snapshot = json.loads(gateway.call('exec', args=['python3', '-c', snapshot_code]))
        f.check(empty_snapshot == {'guard': None, 'egress': [], 'return': [], 'rule': [], 'capture': []}, 'EMPTY_NETWORK_SNAPSHOT_FAILED')

        def helper(operation, receipt=None, boot='fixture-boot', interrupt=None):
            # The journal is serialized exactly as a durable receipt would be.
            # Only its writer is injected; all actual ip/nft commands stay real.
            code = ("import json,importlib.util; s=importlib.util.spec_from_file_location('gateway',"
                    + repr(str(Path(network.__file__))) + "); h=importlib.util.module_from_spec(s); s.loader.exec_module(h); "
                    + "n=json.load(open(" + repr(str(root / 'input.json')) + "))['network']; "
                    + "existing=json.loads(" + repr(json.dumps(receipt)) + "); records=[]; "
                    + "interrupt=json.loads(" + repr(json.dumps(interrupt)) + ")\n"
                    + "def journal(path,record):\n records.append(json.loads(json.dumps(record)))\n"
                    + " if interrupt and all(record.get(k)==v for k,v in interrupt.items()): raise RuntimeError('SIMULATED_POWER_LOSS')\n"
                    + "h.store=journal\ntry:\n ")
            call = ("h.establish_guard({'network':n,'guardRules':h.guard(n)},None,existing,"
                    if operation == 'guard' else "h.prepare({'network':n,'guardRules':h.guard(n)},None,existing,")
            code += call + repr(boot) + ",'fixture-input'" + (")" if operation == 'guard' else ",0)")
            code += ("\nexcept RuntimeError:\n rejected=True\nelse:\n rejected=False\n"
                     + "print(json.dumps({'rejected':rejected,'record':records[-1] if records else existing,'resources':h.snapshot(n)}))")
            return json.loads(gateway.call('exec', args=['python3', '-c', code]))

        # Even non-waiting reconcile must install a durable guard before LAN
        # address readiness can fail. The guard-only journal can be resumed.
        gateway.ip('addr', 'del', '192.0.2.2/24', 'dev', 'lan-test')
        guarded = helper('prepare')
        f.check(guarded['rejected'] and guarded['resources']['guard'] and
                all(not guarded['resources'][key] for key in ['egress', 'return', 'rule', 'capture']) and
                guarded['record'].get('stage') == 'guarded', 'LAN_NOT_READY_WITHOUT_EARLY_GUARD')
        same_boot_guard = helper('guard', guarded['record'])
        f.check(not same_boot_guard['rejected'] and same_boot_guard['resources'] == guarded['resources'], 'GUARD_ONLY_REENTRY_FAILED')
        gateway.ip('addr', 'add', '192.0.2.2/24', 'dev', 'lan-test')
        gateway.ip('route', 'replace', 'default', 'via', '192.0.2.1')
        interrupted = helper('prepare', guarded['record'], interrupt={'stage': 'resources'})
        f.check(interrupted['rejected'] and interrupted['record']['operation'] == 'prepare' and
                interrupted['record']['stage'] == 'resources', 'INITIAL_PREPARE_INTERRUPT_NOT_RECORDED')
        gateway.nft('delete table inet cocoproxy_auto_guard')  # Simulated new boot kernel reset.
        first_recovered = helper('prepare', interrupted['record'], 'fixture-next-boot')
        f.check(not first_recovered['rejected'] and first_recovered['record']['status'] == 'complete', 'INITIAL_PREPARE_BOOT_RECOVERY_FAILED')
        # A repair intent retains the full previous expected resource receipt.
        gateway.call('exec', args=network.route_args(n, 'del', True))
        repair_interrupted = helper('prepare', first_recovered['record'], 'fixture-next-boot', {'operation': 'repair', 'status': 'incomplete'})
        f.check(repair_interrupted['rejected'] and repair_interrupted['record']['resources'] == first_recovered['record']['resources'],
                'REPAIR_LOST_EXPECTED_RESOURCES')
        for args in [network.capture_args(n, 'del', False), network.capture_args(n, 'del', True),
                     network.return_rule_args(n, 'del'), network.rule_args(n, 'del'), network.route_args(n, 'del', False)]:
            gateway.call('exec', args=args)
        gateway.nft('delete table inet cocoproxy_auto_guard')
        # An interrupted remove has opposite intent and must never auto-enable.
        removing = dict(repair_interrupted['record'], operation='remove')
        rejected_remove = helper('guard', removing, 'fixture-third-boot')
        f.check(rejected_remove['rejected'] and rejected_remove['resources'] == empty_snapshot, 'REMOVE_INTENT_REVIVED')
        repair_recovered = helper('prepare', repair_interrupted['record'], 'fixture-third-boot')
        f.check(not repair_recovered['rejected'] and repair_recovered['record']['status'] == 'complete', 'REPAIR_BOOT_RECOVERY_FAILED')
        snapshot_before = gateway.call('exec', args=['python3', '-c', snapshot_code])
        main_before = gateway.ip('-j', '-4', 'route', 'show', 'table', 'main', 'dev', 'lan-test')
        origin.call('origin')
        gateway.call('start', label='core', binary=data['core'], args=['-d', '@ROOT', '-f', '@CONFIG'], config=data['config'])
        for _ in range(40):
            f.check(gateway.call('alive', label='core'), 'CORE_EXITED')
            if 'cocoproxy-tun' in gateway.ip('-j', 'link', 'show'):
                break
            time.sleep(.1)
        else:
            raise RuntimeError('TUN_MISSING')
        time.sleep(.3)  # TUN creation precedes completion of upstream route/nft installation.
        f.check(gateway.call('exec', args=['python3', '-c', snapshot_code]) == snapshot_before, 'RESOURCE_RECEIPT_CHANGED_ON_TUN_CREATION')
        for client in [first, second]:
            http_ok, udp_ok = client.call('http'), client.call('udp')
            f.check(http_ok and udp_ok, 'MULTI_CLIENT_TCP_UDP_FAILED')
        counters = json.loads(router.call('exec', args=['nft', '-j', 'list', 'table', 'inet', 'auto_observe']))['nftables']
        f.check(all(next(item['counter']['packets'] for item in counters if item.get('counter', {}).get('name') == name) > 0 for name in ['first_return', 'second_return']), 'REAL_RETURN_DID_NOT_TRAVERSE_ROUTER')
        f.check(router.call('dns') and router.call('dns_tcp'), 'ROUTER_DNS_FAILED')
        f.check(not first.call('dns') and not second.call('dns_tcp'), 'CLIENT_DNS_EXPOSED')
        for address in ['192.0.2.10', '192.0.2.20']:
            returned = json.loads(gateway.ip('-j', 'route', 'get', address, 'from', '198.51.100.2', 'iif', 'cocoproxy-tun'))[0]
            f.check(returned.get('gateway') == n['routerIPv4'] and str(returned.get('table')) == str(n['egressTable'] + 20000), 'RETURN_POLICY_NOT_USED')
            local = json.loads(gateway.ip('-j', 'route', 'get', address))[0]
            f.check('gateway' not in local and local.get('dev') == 'lan-test', 'MANAGEMENT_ROUTE_CHANGED')
        f.check(gateway.ip('-j', '-4', 'route', 'show', 'table', 'main', 'dev', 'lan-test') == main_before, 'MAIN_ROUTES_CHANGED')
        # A valid LAN source delivered directly rather than by the router must fail.
        for client in [first, second]:
            client.ip('route', 'add', '198.51.100.2/32', 'via', '192.0.2.2')
            f.check(not client.call('http') and not client.call('udp'), 'WRONG_MAC_ACCEPTED')
            client.ip('route', 'del', '198.51.100.2/32')
        # A newly assigned DHCP-like address needs no gateway configuration edit.
        second.ip('addr', 'del', '192.0.2.20/24', 'dev', 'lan-test')
        second.ip('addr', 'add', '192.0.2.99/24', 'dev', 'lan-test')
        second.ip('route', 'replace', 'default', 'via', '192.0.2.1')
        f.check(second.call('http') and second.call('udp'), 'NEW_CLIENT_ADDRESS_FAILED')
        # Exercise the real helper inside the gateway namespace while the core
        # remains live. Only its durable receipt writer is replaced in this
        # disposable fixture; every ip/nft operation is the production command.
        receipt = {'schemaVersion': 1, 'status': 'complete', 'bootID': 'fixture-boot',
                   'inputHash': 'fixture-input', 'resources': json.loads(snapshot_before)}
        recovery_prefix = ("import json,importlib.util; s=importlib.util.spec_from_file_location('gateway',"
                           + repr(str(Path(network.__file__))) + "); h=importlib.util.module_from_spec(s); s.loader.exec_module(h); "
                           + "n=json.load(open(" + repr(str(root / 'input.json')) + "))['network']; "
                           + "h.store=lambda *args:None; ")
        recovery_call = ("h.prepare({'network':n,'guardRules':h.guard(n)},None," + repr(receipt)
                         + ",'fixture-boot','fixture-input',0)")
        recovery_code = recovery_prefix + recovery_call
        gateway.ip('link', 'set', 'lan-test', 'down')
        gateway.ip('addr', 'del', '192.0.2.2/24', 'dev', 'lan-test')
        gateway.ip('link', 'set', 'lan-test', 'up')
        gateway.ip('addr', 'add', '192.0.2.2/24', 'dev', 'lan-test')
        # An address cycle removes the main DHCP/default route. The network
        # helper intentionally restores only its own marked egress table; the
        # fixture must model the address manager restoring the host route too.
        gateway.ip('route', 'replace', 'default', 'via', '192.0.2.1')
        # A DHCP/address cycle can lose host-specific routes. Remove a known
        # route and guard as well to verify precise missing-resource repair.
        present = json.loads(gateway.call('exec', args=['python3', '-c', snapshot_code]))
        if present['egress']:
            gateway.call('exec', args=network.route_args(n, 'del', True))
        gateway.nft('delete table inet cocoproxy_auto_guard')
        gateway.call('exec', args=['python3', '-c', recovery_code])
        f.check(first.call('http') and second.call('udp'), 'ADDRESS_AND_RESOURCE_RECOVERY_FAILED')
        receipt['resources'] = json.loads(gateway.call('exec', args=['python3', '-c', snapshot_code]))
        recovery_call = ("h.prepare({'network':n,'guardRules':h.guard(n)},None," + repr(receipt)
                         + ",'fixture-boot','fixture-input',0)")
        # Unknown resources are rejected before any mutation, even with an
        # otherwise valid complete receipt and live core.
        gateway.ip('route', 'add', '203.0.113.0/24', 'table', str(n['egressTable']), 'dev', 'lan-test')
        conflict_before = gateway.call('exec', args=['python3', '-c', snapshot_code])
        reject_code = (recovery_prefix + "\ntry:\n " + recovery_call
                       + "\nexcept RuntimeError:\n print('rejected')\nelse:\n raise RuntimeError('CONFLICT_ACCEPTED')")
        f.check(gateway.call('exec', args=['python3', '-c', reject_code]).strip() == 'rejected', 'UNKNOWN_RESOURCE_NOT_REJECTED')
        f.check(gateway.call('exec', args=['python3', '-c', snapshot_code]) == conflict_before, 'CONFLICT_MUTATED_RESOURCES')
        gateway.ip('route', 'del', '203.0.113.0/24', 'table', str(n['egressTable']), 'dev', 'lan-test')
        snapshot_before = gateway.call('exec', args=['python3', '-c', snapshot_code])
        gateway.call('stop', label='core')
        f.check(gateway.call('exec', args=['python3', '-c', snapshot_code]) == snapshot_before, 'RESOURCE_RECEIPT_CHANGED_ON_TUN_REMOVAL')
        before = origin.call('stats')
        for client in [first, second]:
            f.check(not client.call('http') and not client.call('udp'), 'CORE_STOP_LEAKED')
        f.check(origin.call('stats') == before, 'STOPPED_CORE_TOUCHED_ORIGIN')

        # Exercise the same persistent production helper used by the launcher.
        # Only its path contract is adapted: the disposable fixture is under
        # /tmp, whereas installed service state has root-controlled ancestors.
        host_state = root / 'host-state'
        host_state.mkdir(mode=0o700)
        owner = root.stat()
        os.chown(host_state, owner.st_uid, owner.st_gid)
        host_path = Path(network.__file__).with_name('host_proxy.py')
        host_prefix = ("import json,importlib.util,os; from pathlib import Path; "
                       + "s=importlib.util.spec_from_file_location('host_guard'," + repr(str(host_path)) + "); "
                       + "h=importlib.util.module_from_spec(s); s.loader.exec_module(h); "
                       + "n=json.load(open(" + repr(str(root / 'input.json')) + "))['network']; "
                       + "h.checked_state=lambda path,uid:Path(path); ")

        def host_helper(enabled, early=False, reject=False):
            call = "h.apply(n,Path(" + repr(str(host_state)) + ")," + repr(enabled) + ",os.geteuid(),early=" + repr(early) + ")"
            if reject:
                call = "\ntry:\n " + call + "\nexcept RuntimeError:\n print('rejected')\nelse:\n raise RuntimeError('HOST_CONFLICT_ACCEPTED')"
            return gateway.call('exec', args=['python3', '-c', host_prefix + call])

        host_tcp, host_udp = gateway.call('http'), gateway.call('udp')
        if not host_tcp or not host_udp:
            raise RuntimeError('DISABLED_HOST_ROUTES_CHANGED_' + json.dumps({
                'tcp': host_tcp, 'udp': host_udp, 'routes': json.loads(gateway.ip('-j', 'route', 'show', 'table', 'main')),
                'rules': json.loads(gateway.ip('-j', '-4', 'rule', 'show'))}, separators=(',', ':')))
        host_helper(True)
        before = origin.call('stats')
        f.check(not gateway.call('http') and not gateway.call('udp'), 'HOST_PRESTART_LEAKED')
        f.check(origin.call('stats') == before, 'HOST_PRESTART_TOUCHED_ORIGIN')
        gateway.call('start', label='host-core', binary=data['core'], args=['-d', '@ROOT', '-f', '@CONFIG'], config=data['hostConfig'])
        for _ in range(40):
            f.check(gateway.call('alive', label='host-core'), 'HOST_CORE_EXITED')
            if 'cocoproxy-tun' in gateway.ip('-j', 'link', 'show'):
                break
            time.sleep(.1)
        time.sleep(.3)
        host_tcp, host_udp = gateway.call('http'), gateway.call('udp', key='host-established')
        if not host_tcp or not host_udp:
            # Probe tools in a child without check=True: a missing nft table
            # must not kill the namespace worker and hide the original failure.
            probes = [['ip', '-j', '-4', 'rule', 'show'], ['ip', '-j', 'route', 'get', '198.51.100.2'],
                      ['nft', '-nn', 'list', 'tables'], ['nft', '-nn', 'list', 'table', 'inet', 'mihomo'],
                      ['nft', '-nn', 'list', 'table', 'inet', 'cocoproxy_host_guard']]
            probe_code = ("import subprocess,json; commands=json.loads(" + repr(json.dumps(probes)) + "); result=[]\n"
                          + "for command in commands:\n"
                          + " try:\n  p=subprocess.run(command,text=True,capture_output=True,timeout=2); result.append({'command':command,'code':p.returncode,'out':p.stdout[:4096],'err':p.stderr[:512]})\n"
                          + " except Exception as error:\n  result.append({'command':command,'error':type(error).__name__})\n"
                          + "print(json.dumps(result))")
            core_log = (root / 'host-core.log').read_text(errors='replace')[-1024:]
            raise RuntimeError('HOST_TCP_UDP_FAILED_' + json.dumps({
                'tcp': host_tcp, 'udp': host_udp, 'coreLog': core_log,
                'probes': json.loads(gateway.call('exec', args=['python3', '-c', probe_code]))}, separators=(',', ':')))
        f.check(not gateway.call('udp', address='198.51.100.78') and
                not first.call('udp', address='198.51.100.78'), 'HOST_CLIENT_POLICY_DIVERGED')
        for address in ['198.51.100.2', '192.0.2.1', '127.0.0.53']:
            f.check(gateway.call('dns', dnsAddress=address, dnsPort=53), 'HOST_DNS_NOT_SHARED_' + address)
        f.check(gateway.call('dns_tcp', dnsAddress='127.0.0.53', dnsPort=53), 'HOST_TCP_DNS_NOT_SHARED')

        # A second private connected network and both management entry paths
        # must keep their original direct route before and after core failure.
        f.execute(['ip', 'link', 'add', 'private-gw', 'type', 'veth', 'peer', 'name', 'private-peer'])
        for role, interface, address in [(gateway, 'private-gw', '10.23.0.2'), (origin, 'private-peer', '10.23.0.3')]:
            f.execute(['ip', 'link', 'set', interface, 'netns', str(role.process.pid)])
            role.ip('addr', 'add', address + '/24', 'dev', interface)
            role.ip('link', 'set', interface, 'up')
        server = "import socket; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('0.0.0.0',18080)); s.listen(8)\nwhile True:\n c,_=s.accept(); c.sendall(b'ok'); c.close()"
        gateway.call('start', label='management', binary='/usr/bin/python3', args=['-c', server], config={})
        time.sleep(.15)

        def management():
            for role, address in [(first, '192.0.2.2'), (origin, '10.23.0.2'), (gateway, '127.0.0.1')]:
                code = "import socket; s=socket.create_connection((" + repr(address) + ",18080),1); assert s.recv(2)==b'ok'; print('ok')"
                f.check(role.call('exec', args=['python3', '-c', code]).strip() == 'ok', 'HOST_PRIVATE_MANAGEMENT_FAILED')
        management()
        f.check('private-gw' in gateway.ip('-j', 'route', 'get', '10.23.0.3'), 'SECOND_PRIVATE_ROUTE_CHANGED')
        gateway.call('stop', label='host-core')
        before = origin.call('stats')
        f.check(not gateway.call('http') and not gateway.call('udp') and
                not gateway.call('udp', key='host-established'), 'HOST_CORE_STOP_LEAKED')
        f.check(origin.call('stats') == before, 'HOST_STOPPED_CORE_TOUCHED_ORIGIN')
        management()
        # Simulate a boot with no kernel table, then restore from the durable
        # receipt. Kernel handles differ; every owned expression must agree.
        gateway.nft('delete table inet cocoproxy_host_guard')
        host_helper(False, early=True)
        f.check(not gateway.call('udp'), 'HOST_EARLY_GUARD_FAILED')
        gateway.nft('add rule inet cocoproxy_host_guard output ip daddr 203.0.113.9 accept')
        f.check(host_helper(False, reject=True).strip() == 'rejected', 'HOST_UNKNOWN_RESOURCE_ACCEPTED')
        # Remove only the fixture's injected rule by its actual kernel handle.
        entries = json.loads(gateway.call('exec', args=['nft', '-j', '-a', 'list', 'chain', 'inet', 'cocoproxy_host_guard', 'output']))['nftables']
        handle = [item['rule']['handle'] for item in entries if 'rule' in item][-1]
        gateway.nft('delete rule inet cocoproxy_host_guard output handle ' + str(handle))
        host_helper(False)
        f.check(gateway.call('http') and gateway.call('udp'), 'HOST_DISABLED_NOT_RESTORED')
        host_helper(False, early=True)
        f.check(gateway.call('udp'), 'DISABLED_INTENT_REENABLED_ON_BOOT')
        return {'multiClientTcpUdp': True, 'newClientAddress': True, 'routerOnlyDns': True,
                'tunReturnViaRouter': True, 'hostRoutesPreserved': True, 'wrongMacRejected': True, 'coreStopBlocked': True,
                'addressAndResourceRecovery': True, 'unknownResourceRejected': True, 'earlyGuardBeforeLan': True,
                'initialPrepareBootRecovery': True, 'repairBootRecovery': True, 'interruptedRemoveRejected': True,
                'hostTcpUdpPolicy': True, 'hostDnsPolicy': True, 'hostPrivateManagement': True,
                'hostCoreStopBlocked': True, 'hostDisabledRecovery': True, 'hostEarlyRecovery': True,
                'hostGuardOwnership': True}
    finally:
        for role in reversed(list(roles.values())):
            role.close()


if __name__ == '__main__':
    try:
        print(json.dumps(driver(Path(sys.argv[1]))), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__}), flush=True)
        sys.exit(1)
