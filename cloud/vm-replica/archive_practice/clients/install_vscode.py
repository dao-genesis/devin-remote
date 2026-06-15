# -*- coding: utf-8 -*-
"""Runs as Administrator (session 1) on 141. Installs VS Code MACHINE-WIDE so the
zhou account gets it too. Tries winget first, falls back to the official System
installer. Writes progress to C:\\dao_vm\\vscode_install.log (polled by the client)."""
import subprocess, os, time, urllib.request, ssl

LOG = r'C:\dao_vm\vscode_install.log'
CODE = r'C:\Program Files\Microsoft VS Code\Code.exe'
CODE_CMD = r'C:\Program Files\Microsoft VS Code\bin\code.cmd'
def w(lines):
    open(LOG, 'w', encoding='utf-8').write('\n'.join(str(x) for x in lines))
def run(cmd, timeout=900):
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=timeout)
        return p.returncode, ((p.stdout or '') + (p.stderr or ''))
    except Exception as e:
        return -1, repr(e)

log = ['START %s' % time.strftime('%Y-%m-%d %H:%M:%S')]
w(log)
if not os.path.exists(CODE):
    # 1) winget machine-scope (Windows 11 has winget)
    rc, out = run('winget install -e --id Microsoft.VisualStudioCode --scope machine '
                  '--silent --accept-package-agreements --accept-source-agreements '
                  '--disable-interactivity')
    log.append('winget rc=%d' % rc); log.append(out[-1200:]); w(log)
if not os.path.exists(CODE):
    # 2) fallback: official System installer (silent)
    try:
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        url = 'https://update.code.visualstudio.com/latest/win32-x64/stable'
        dst = r'C:\dao_vm\vscode_setup.exe'
        log.append('downloading installer...'); w(log)
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        data = urllib.request.urlopen(req, timeout=300, context=ctx).read()
        open(dst, 'wb').write(data)
        log.append('downloaded %d bytes' % len(data)); w(log)
        rc2, out2 = run('"%s" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART '
                        '/MERGETASKS="!runcode,addtopath,associatewithfiles,addcontextmenufiles"' % dst)
        log.append('installer rc=%d' % rc2); log.append(out2[-600:]); w(log)
    except Exception as e:
        log.append('installer-fallback ERROR: %r' % e); w(log)

present = os.path.exists(CODE)
log.append('Code.exe present: %s' % present)
if present and os.path.exists(CODE_CMD):
    rc3, ver = run('"%s" --version' % CODE_CMD, timeout=60)
    log.append('code --version: ' + ver.strip().replace('\n', ' | '))
log.append('DONE %s' % time.strftime('%Y-%m-%d %H:%M:%S'))
w(log)
