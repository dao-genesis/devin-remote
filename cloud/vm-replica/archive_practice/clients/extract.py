import os, json
d = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(d,'project_snapshot.json'), encoding='utf-8'))
out = os.path.join(d, 'mirror')
for f in data['files']:
    rel = f['rel'].lstrip('\\').replace('\\','/')
    if f['dir'] or not rel:
        continue
    p = os.path.join(out, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8', newline='') as fh:
        fh.write(f['content'])
    print('wrote', rel, f['len'])
