"""Standalone live reproduction of F157 on Windows: key_state(vk) reads a key's
live {down, toggled} — the read dual of key_down/key_up. Run alone."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl

VK_SHIFT = 0x10
VK_CAPITAL = 0x14


def tap(vk):
    osctl.key_down(vk)
    time.sleep(0.05)
    osctl.key_up(vk)
    time.sleep(0.15)


def main():
    # down-state tracks a held key
    osctl.key_up(VK_SHIFT)
    time.sleep(0.1)
    s0 = osctl.key_state(VK_SHIFT)["down"]
    osctl.key_down(VK_SHIFT)
    time.sleep(0.1)
    s1 = osctl.key_state(VK_SHIFT)["down"]
    osctl.key_up(VK_SHIFT)
    time.sleep(0.1)
    s2 = osctl.key_state(VK_SHIFT)["down"]
    print(f"[{'PASS' if not s0 else 'FAIL'}] Shift starts up -> down={s0}")
    print(f"[{'PASS' if s1 else 'FAIL'}] Shift reads down while held -> down={s1}")
    print(f"[{'PASS' if not s2 else 'FAIL'}] Shift reads up after release -> down={s2}")

    # toggled-state tracks the CapsLock latch
    t0 = osctl.key_state(VK_CAPITAL)["toggled"]
    tap(VK_CAPITAL)
    t1 = osctl.key_state(VK_CAPITAL)["toggled"]
    tap(VK_CAPITAL)
    t2 = osctl.key_state(VK_CAPITAL)["toggled"]
    print(f"[{'PASS' if t1 != t0 else 'FAIL'}] CapsLock toggle flips -> {t0}->{t1}")
    print(f"[{'PASS' if t2 == t0 else 'FAIL'}] second toggle restores -> {t1}->{t2}")
    if t2 != t0:  # leave it as we found it
        tap(VK_CAPITAL)


if __name__ == "__main__":
    main()
