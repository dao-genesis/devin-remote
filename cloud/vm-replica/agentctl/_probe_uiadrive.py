"""Standalone live reproduction of F168: drive a modern UWP app (Windows
Calculator) end-to-end purely by MEANING — uia_invoke each button by accessible
name to compute 5 + 3 = 8, then read the result element by name. No pixels, no
coordinates. Also exercises the exact-preferred matching fix (uia_find(name='Add')
must return 'Add', not the earlier-in-tree 'Memory add')."""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osctl


def main():
    subprocess.Popen(["calc.exe"])
    calc = None
    deadline = time.time() + 10
    while time.time() < deadline:
        calc = next((w for w in osctl.list_windows()
                     if "Calc" in (w.get("title") or "")), None)
        if calc and osctl.uia_find(calc["id"], name="Equals", ctype="Button"):
            break
        time.sleep(0.5)
    if not calc:
        print("[FAIL] no calculator"); return
    try:
        osctl.activate_window(calc["id"])
        time.sleep(0.8)
        add = osctl.uia_find(calc["id"], name="Add", ctype="Button")
        print(f"uia_find(name='Add') -> {add}")
        print(f"[{'PASS' if add and add.get('name') == 'Add' else 'FAIL'}] "
              f"exact-preferred match returns 'Add', not 'Memory add'")
        for nm in ("5", "Add", "3", "Equals"):
            ok = osctl.uia_invoke(calc["id"], name=nm, ctype="Button")
            print(f"  invoke {nm!r}: {ok}")
            time.sleep(0.4)
        time.sleep(0.6)
        res = osctl.uia_find(calc["id"], name="8", ctype="Text")
        print(f"result element -> {res}")
        print(f"[{'PASS' if res and res.get('name') == '8' else 'FAIL'}] "
              f"5 + 3 = 8 computed end-to-end by meaning inside a UWP app")
    finally:
        os.system("taskkill /F /IM CalculatorApp.exe >NUL 2>&1")
        os.system("taskkill /F /IM Calculator.exe >NUL 2>&1")
        os.system("taskkill /F /IM calc.exe >NUL 2>&1")


if __name__ == "__main__":
    main()
