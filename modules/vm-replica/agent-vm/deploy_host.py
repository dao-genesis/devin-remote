# -*- coding: utf-8 -*-
"""deploy_host.py - prepare a Windows host to run the vm-replica stack.

Run once, as Administrator, in the host's interactive console session:

    python deploy_host.py

It performs the host-side prerequisites that were validated end-to-end:

  1. Copy vm_inner_agent.py to the machine-wide deploy dir (C:\\dao_vm) so the
     per-account scheduled task can launch it inside each "VM" session.
  2. Set the **AllowSavedCredentials** delegation policy for TERMSRV/* so an
     unattended loopback `mstsc` can actually send the saved cmdkey credential.
     Without this, the session is created but no one logs in and the RDP
     handshake is dropped pre-logon (event "reason=1800").
  3. Ensure RDP is enabled (fDenyTSConnections=0) + firewall rule on.

It does NOT touch ServiceDll and never installs an at-logon auto-start task on
the host account -- those are exactly the two things that caused the boot
lockout documented in README.md. Multi-session here relies on the OS:
  * Windows Server  -> native multi-session, no patch needed.
  * Windows 10/11   -> RDP Wrapper, loaded ON-DEMAND only (never as ServiceDll).
"""
import os, sys, shutil, winreg, subprocess

DEPLOY_DIR = r"C:\dao_vm"
HERE = os.path.dirname(os.path.abspath(__file__))


def deploy_inner_agent():
    os.makedirs(DEPLOY_DIR, exist_ok=True)
    src = os.path.join(HERE, "vm_inner_agent.py")
    dst = os.path.join(DEPLOY_DIR, "vm_inner_agent.py")
    shutil.copyfile(src, dst)
    print("[1] inner agent ->", dst)


def set_cred_delegation():
    base = r"SOFTWARE\Policies\Microsoft\Windows\CredentialsDelegation"
    k = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, base, 0, winreg.KEY_ALL_ACCESS)
    for n in ("AllowSavedCredentials", "AllowSavedCredentialsWhenNTLMOnly",
              "ConcatenateDefaults_AllowSaved", "ConcatenateDefaults_AllowSavedNTLMOnly"):
        winreg.SetValueEx(k, n, 0, winreg.REG_DWORD, 1)
    for sub in ("AllowSavedCredentials", "AllowSavedCredentialsWhenNTLMOnly"):
        sk = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, base + "\\" + sub, 0, winreg.KEY_ALL_ACCESS)
        winreg.SetValueEx(sk, "1", 0, winreg.REG_SZ, "TERMSRV/*")
        winreg.CloseKey(sk)
    winreg.CloseKey(k)
    print("[2] AllowSavedCredentials delegation -> TERMSRV/*")


def enable_rdp():
    ts = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE,
                            r"SYSTEM\CurrentControlSet\Control\Terminal Server", 0, winreg.KEY_ALL_ACCESS)
    winreg.SetValueEx(ts, "fDenyTSConnections", 0, winreg.REG_DWORD, 0)
    winreg.CloseKey(ts)
    subprocess.run(["netsh", "advfirewall", "firewall", "set", "rule",
                    "group=remote desktop", "new", "enable=Yes"], capture_output=True)
    print("[3] RDP enabled + firewall rule on")


if __name__ == "__main__":
    if sys.platform != "win32":
        sys.exit("deploy_host.py must run on Windows")
    deploy_inner_agent()
    set_cred_delegation()
    enable_rdp()
    print("DONE - now run:  python vm_host_daemon.py")
