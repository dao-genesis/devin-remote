r"""build_exe.py - Freeze the vm-replica stack into standalone Windows EXEs.

Produces Python-free single-file executables so the stack can be injected into ANY
user's Windows box (no Python install required):

  dao_inner_agent.exe   <- vm_inner_agent.py  (per-session screenshot/input/exec)
  dao_host_daemon.exe   <- vm_host_daemon.py   (console-session VM lifecycle manager)
  dao_mcp_server.exe    <- mcp_server.py       (stdio MCP tool layer for agents)

All three are pure-stdlib + ctypes, so they freeze cleanly with no hidden imports.

Usage:
  python build_exe.py            # build all three into ./dist
  python build_exe.py inner      # build only the inner agent
The inner-agent exe is also copied to C:\dao_vm\dao_inner_agent.exe so the daemon
(which prefers the frozen exe via config 'inner_exe') deploys it to every account.
"""
import sys, os, subprocess, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, 'dist')
WORK = os.path.join(HERE, 'build')
TARGETS = {
    'inner': ('vm_inner_agent.py', 'dao_inner_agent'),
    'host':  ('vm_host_daemon.py', 'dao_host_daemon'),
    'mcp':   ('mcp_server.py',     'dao_mcp_server'),
}

def build(key):
    src, name = TARGETS[key]
    print(f'[build] {src} -> {name}.exe')
    cmd = [sys.executable, '-m', 'PyInstaller', '--onefile', '--clean', '--noconfirm',
           '--name', name, '--distpath', DIST, '--workpath', WORK,
           '--specpath', WORK, '--console', os.path.join(HERE, src)]
    subprocess.check_call(cmd)
    return os.path.join(DIST, name + '.exe')

def main():
    keys = [a for a in sys.argv[1:] if a in TARGETS] or list(TARGETS)
    built = {k: build(k) for k in keys}
    if 'inner' in built:
        dst = r'C:\dao_vm\dao_inner_agent.exe'
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(built['inner'], dst)
        print(f'[build] deployed inner agent exe -> {dst}')
    print('[build] done:', ', '.join(f'{k}={v}' for k, v in built.items()))

if __name__ == '__main__':
    main()
