"""Bounded, read-only Mihomo connection observation; invoked over SSH stdin.

This module never writes remote files. Controller credentials and unfiltered
connection/proxy responses remain in this process and are never printed.
"""
import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
import threading
import time
import urllib.request


LIMIT = 4 * 1024 * 1024
GROUPS = {"selector", "urltest", "fallback", "loadbalance", "relay"}
PROXY_TYPES = {"shadowsocks", "shadowsocksr", "snell", "socks5", "http",
               "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic",
               "wireguard", "ssh", "mieru", "anytls", "sudoku", "masque"}


def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def read_json(path, maximum=LIMIT):
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("INVALID_PATH")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("INVALID_FILE")
        data = handle.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("FILE_LIMIT")
    return json.loads(data), data


def normalized_type(value):
    return re.sub(r"[-_\s]", "", str(value)).lower()


def chain_evidence(chains, proxies):
    """Use actual connection chains, never infer a route from a group/name."""
    if not isinstance(chains, list) or not chains or len(chains) > 64:
        return "unknown", [], []
    types, leaves = [], []
    for name in chains:
        if not isinstance(name, str) or not isinstance(proxies.get(name), dict):
            return "unknown", [], []
        kind = normalized_type(proxies[name].get("type", ""))
        types.append(kind)
        if kind in GROUPS:
            continue
        if kind == "direct":
            leaves.append("direct")
        elif kind in {"reject", "rejectdrop"}:
            leaves.append("reject")
        elif kind in PROXY_TYPES:
            leaves.append("proxy")
        else:
            return "unknown", [], []
    # A chain made solely of policy groups is incomplete evidence.
    route = "reject" if "reject" in leaves else "proxy" if "proxy" in leaves else "direct" if leaves else "unknown"
    return route, [digest(name) for name in chains], types


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("CONTROLLER_REDIRECT")


def controller(settings_path):
    settings, _ = read_json(settings_path, 65536)
    state = settings.get("stateDirectory")
    if not isinstance(state, str) or not os.path.isabs(state):
        raise ValueError("INVALID_STATE")
    selection, _ = read_json(os.path.join(state, "selection.json"), 4096)
    generation = selection.get("generation")
    if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9]{64}", generation):
        raise ValueError("INVALID_GENERATION")
    candidate, data = read_json(os.path.join(state, "candidates", generation + ".json"))
    if hashlib.sha256(data).hexdigest() != generation:
        raise ValueError("CANDIDATE_DIGEST")
    address = candidate.get("external-controller", "")
    match = re.fullmatch(r"127\.0\.0\.1:([1-9][0-9]{0,4})", address) if isinstance(address, str) else None
    secret = candidate.get("secret")
    if not match or int(match.group(1)) > 65535 or not isinstance(secret, str) or not secret or any(ord(c) < 32 for c in secret):
        raise ValueError("INVALID_CONTROLLER")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def get(path):
        # Only these fixed GET endpoints can be requested. No controller writes.
        if path not in {"/connections", "/proxies"}:
            raise ValueError("INVALID_ENDPOINT")
        request = urllib.request.Request("http://" + address + path, headers={"Authorization": "Bearer " + secret}, method="GET")
        with opener.open(request, timeout=1) as response:
            data = response.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("RESPONSE_LIMIT")
        return json.loads(data)

    return generation, state, get


def filtered_connections(rows, proxies, source_ips, hosts, fingerprint):
    result = []
    if not isinstance(rows, list):
        raise ValueError("INVALID_CONNECTIONS")
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("metadata"), dict):
            continue
        meta = row["metadata"]
        host = str(meta.get("host", "")).rstrip(".").lower()
        try:
            source_ip = str(ipaddress.ip_address(meta.get("sourceIP", "")))
            destination_ip = str(ipaddress.ip_address(meta.get("destinationIP", "")))
            source_port, destination_port = int(meta.get("sourcePort", 0)), int(meta.get("destinationPort", 0))
        except (ValueError, TypeError):
            continue
        if source_ip not in source_ips or host not in hosts or not (0 < source_port <= 65535 and 0 < destination_port <= 65535):
            continue
        if not isinstance(row.get("id"), str) or not row["id"]:
            continue
        route, chains, types = chain_evidence(row.get("chains"), proxies)
        result.append({"sourceIp": source_ip, "sourcePort": source_port,
                       "destinationIp": destination_ip, "destinationPort": destination_port,
                       "host": host, "connectionFingerprint": digest(row["id"]),
                       "route": route, "fingerprint": fingerprint,
                       "chainFingerprints": chains, "chainTypes": types,
                       "ruleFingerprint": digest(row.get("rule")),
                       "rulePayloadFingerprint": digest(row.get("rulePayload"))})
        if len(result) >= 256:
            raise ValueError("MATCH_LIMIT")
    return result


def main():
    config = json.loads(sys.stdin.buffer.readline(65537))
    seconds = config.get("seconds")
    if not isinstance(seconds, (int, float)) or not 1 <= seconds <= 7200:
        raise ValueError("INVALID_DURATION")
    source_ips = {str(ipaddress.ip_address(value)) for value in config["sourceIps"]}
    hosts = {value.rstrip(".").lower() for value in config["hosts"]}
    if not source_ips or len(source_ips) > 32 or not hosts or len(hosts) > 100:
        raise ValueError("INVALID_FILTER")
    stopped = threading.Event()

    def watch_stdin():
        # stdin is the SSH lifetime channel, not an interactive command channel.
        while sys.stdin.buffer.read(1):
            pass
        stopped.set()
        # Abort even a controller response that is trickling indefinitely.
        os._exit(0)

    threading.Thread(target=watch_stdin, daemon=True).start()
    lifetime = threading.Timer(seconds, lambda: os._exit(0))
    lifetime.daemon = True
    lifetime.start()
    deadline = time.monotonic() + seconds
    previous = None
    failures = 0
    while not stopped.is_set() and time.monotonic() < deadline:
        started = time.monotonic()
        try:
            generation, state, get = controller(config["runtimeSettingsPath"])
            proxies_response = get("/proxies")
            proxies = proxies_response.get("proxies")
            if not isinstance(proxies, dict):
                raise ValueError("INVALID_PROXIES")
            connections = get("/connections").get("connections")
            selection_after, _ = read_json(os.path.join(state, "selection.json"), 4096)
            if selection_after.get("generation") != generation:
                raise ValueError("GENERATION_CHANGED_DURING_SAMPLE")
            picks = {name: value.get("now") for name, value in proxies.items()
                     if isinstance(value, dict) and normalized_type(value.get("type")) in GROUPS}
            fingerprint = digest({"generation": generation, "selections": picks})
            filtered = filtered_connections(connections, proxies, source_ips, hosts, fingerprint)
            if stopped.is_set():
                break
            emit({"kind": "snapshot", "fingerprint": fingerprint,
                  "generationFingerprint": digest(generation), "selectionFingerprint": digest(picks),
                  "changed": previous is not None and previous != fingerprint, "connections": filtered})
            previous = fingerprint
            failures = 0
        except Exception:
            # Exception text may contain paths, credentials or other connection data.
            emit({"kind": "unavailable", "reason": "READ_ONLY_OBSERVATION_FAILED"})
            failures += 1
            if failures >= 3:
                break
        stopped.wait(max(0, min(1 - (time.monotonic() - started), deadline - time.monotonic())))


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception:
        emit({"kind": "unavailable", "reason": "READ_ONLY_OBSERVATION_FAILED"})
