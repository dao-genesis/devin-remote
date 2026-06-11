# -*- coding: utf-8 -*-
import sys, os, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
remote = sys.argv[1]
print(d.dao(f'"C:\\ProgramData\\anaconda3\\python.exe" "{remote}"', agent='DESKTOP-MASTER', timeout=150))
