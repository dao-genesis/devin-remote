# -*- coding: utf-8 -*-
import sys, os, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
print(d.dao(r'"C:\ProgramData\anaconda3\python.exe" "C:\dao_vm\fullchain_zhou.py"',
            agent='DESKTOP-MASTER', timeout=180))
