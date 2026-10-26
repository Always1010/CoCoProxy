#!/bin/sh
# Only a bounded inventory before Node is available. Never installs dependencies.
set -eu
command_name=${1:-help}
if [ "$command_name" = check ]; then
    printf '%s\n' 'CoCoProxy 基础环境盘点（只读，不安装或修改系统）'
    result=0
    for tool in uname node python3 systemctl getent ip nft; do
        if command -v "$tool" >/dev/null 2>&1; then
            printf 'PASS %s\n' "$tool"
        else
            printf 'MISSING %s\n' "$tool"
            result=1
        fi
    done
    printf '%s\n' '工具存在不代表版本、权限、内核或路由器条件通过。准备 Node 后运行 doctor。'
    exit "$result"
fi
if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'SETUP_NODE_REQUIRED: 请按对应系统说明准备 Node.js >=22.18，再运行此入口。' >&2
    exit 1
fi
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec node --experimental-strip-types "$script_directory/../apps/setup/main.ts" "$@"
