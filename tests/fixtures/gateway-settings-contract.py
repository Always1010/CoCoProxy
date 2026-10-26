"""Exercise actual helper schema functions without Linux operations or path trust claims."""
import ast
import ipaddress
import json
from pathlib import Path
import re
import sys

tree = ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'))
functions = {'require', 'guard', 'load_settings', 'source'}
selected = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in functions], type_ignores=[])
namespace = {'ipaddress': ipaddress, 'json': json, 're': re, 'IP': '/usr/sbin/ip', 'NFT': '/usr/sbin/nft'}
exec(compile(selected, '<gateway-schema>', 'exec'), namespace)
current = None


class Settings:
    def read_text(self):
        return json.dumps(current)


namespace['checked_path'] = lambda *args, **kwargs: Settings()
namespace['checked_executable'] = lambda *args: None
cases = json.load(sys.stdin)
for case in cases:
    current = case['settings']
    accepted = True
    try:
        namespace['load_settings']('/synthetic/settings')
    except (RuntimeError, ValueError, TypeError):
        accepted = False
    if accepted != case['accepted']:
        raise RuntimeError('GATEWAY_SCHEMA_DISAGREEMENT')
print(json.dumps({'checked': len(cases)}))
