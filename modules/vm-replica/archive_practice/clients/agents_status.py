# -*- coding: utf-8 -*-
import sys, os, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dao_sdk as d
a = d.agents()
for x in a.get('agents', []):
    print(x['id'], 'status=', x['status'], 'pending=', x['pending_commands'], 'completed=', x['completed_commands'])
