# -*- coding: utf-8 -*-
"""Run ON 141 (detached): cold-start a BRAND-NEW Windows account as a VM via the
host daemon, then self-test the full chain. Logs every step to a file so the long
first-logon doesn't hit the relay timeout. Monitors that zhou(SID2) and
administrator(console) are NEVER bumped (互不干扰)."""
import json, base64, urllib.request, time, io, sys
LOG = r'C:\dao_vm\coldstart_demo.log'
def log(*a):
    line = '[%s] %s' % (time.strftime('%H:%M:%S'), ' '.join(str(x) for x in a))
    with io.open(LOG, 'a', encoding='utf-8') as f: f.write(line + '\n')
CFG = json.load(open(r'C:\ProgramData\dao_vm\config.json', encoding='utf-8'))
H = 'http://127.0.0.1:%d/' % CFG['host_port']; T = CFG['token']
NEWVM = 'daovm'
def call(a, to=120, **k):
    r = urllib.request.Request(H, data=json.dumps(dict(action=a, **k)).encode(),
        method='POST', headers={'Content-Type':'application/json','Authorization':'Bearer '+T})
    return json.loads(urllib.request.urlopen(r, timeout=to).read().decode())
def sessions():
    try: return call('vm.sessions').get('sessions','')
    except Exception as e: return 'ERR %s' % e
def zhou_admin_ok(s):
    return ('zhou' in s) and ('administrator' in s.lower())

io.open(LOG,'w',encoding='utf-8').close()
try:
    log('=== COLD-START DEMO: new account', NEWVM, '===')
    log('health:', call('host.health'))
    s0 = sessions(); log('sessions BEFORE:\n'+s0)
    log('PRECONDITION zhou+admin present:', zhou_admin_ok(s0))

    log('--- vm.create', NEWVM, '(account -> loopback RDP -> offscreen -> inner agent) ---')
    try: log('create result:', call('vm.create', to=150, name=NEWVM, password=CFG.get('default_password','Vm@2026dao!')))
    except Exception as e: log('create call returned/-timeout (continuing to poll):', e)

    running = False
    for i in range(50):
        time.sleep(3)
        try:
            lst = call('vm.list', to=20)
            st = (lst.get('vms',{}).get(NEWVM,{}) or {}).get('status')
            sc = sessions()
            if not zhou_admin_ok(sc):
                log('!!! ISOLATION ALERT at poll', i, '— zhou/admin not both present:\n'+sc)
            if st == 'running':
                running = True; log('VM', NEWVM, 'RUNNING after', (i+1)*3, 's'); break
            if i % 5 == 0: log('poll', i, 'status=', st)
        except Exception as e:
            log('poll', i, 'err', e)
    log('RUNNING=', running)

    s1 = sessions(); log('sessions AFTER:\n'+s1)
    log('ISOLATION zhou+admin still present:', zhou_admin_ok(s1))

    if running:
        who = call('vm.exec', vm=NEWVM, command='whoami').get('stdout','').strip()
        log('SELFTEST exec whoami ->', who)
        call('host.activate_rdp')
        shot = call('vm.screenshot', vm=NEWVM, format='png')
        open(r'C:\dao_vm\coldstart_%s.png' % NEWVM,'wb').write(base64.b64decode(shot['image_base64']))
        log('SELFTEST screenshot ->', '%dx%d %dB' % (shot['width'], shot['height'], shot.get('size',0)))
        # input roundtrip into a dedicated fresh file
        FP = r'C:\dao_vm\coldstart_typed.txt'
        call('vm.file_write', vm=NEWVM, path=FP, content_base64=base64.b64encode(b'').decode())
        call('vm.exec', vm=NEWVM, command='cmd /c start "" notepad "%s"' % FP); time.sleep(2.5)
        tt=None
        for w in call('vm.ui_info', vm=NEWVM).get('windows',[]):
            if 'coldstart_typed' in w.get('title',''): tt=w['title']; break
        if tt:
            call('vm.activate', vm=NEWVM, title=tt); time.sleep(0.8)
            call('vm.type', vm=NEWVM, text='COLD-START 道法自然 OK 无为而无不为')
            call('vm.key', vm=NEWVM, key='ctrl+s'); time.sleep(1.2)
        rb = call('vm.file_read', vm=NEWVM, path=FP)
        typed = base64.b64decode(rb.get('content_base64','')).decode('utf-8','replace')
        log('SELFTEST type roundtrip ->', json.dumps(typed, ensure_ascii=True))
        call('vm.exec', vm=NEWVM, command='taskkill /f /im notepad.exe 2>nul')
        log('SELFTEST result:', 'PASS' if ('COLD-START' in typed and '道法自然' in typed) else 'CHECK')
    log('=== DONE ===')
except Exception as e:
    import traceback; log('FATAL', traceback.format_exc())
