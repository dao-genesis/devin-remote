import sys,time,statistics as st; sys.path.insert(0,"."); import osctl
VX,VY,VW,VH=288,245,995,746
def grab():
    w,h,rgb=osctl.capture_rgb(VX,VY,VW,VH); return bytes(rgb)
def cut(rgb,w,cx,cy,pw,ph):
    x0,y0=cx-pw//2,cy-ph//2; out=bytearray(pw*ph*3)
    for ry in range(ph):
        s=((y0+ry)*w+x0)*3; out[ry*pw*3:(ry+1)*pw*3]=rgb[s:s+pw*3]
    return bytes(out)
osctl.focus_window("ioquake3"); time.sleep(0.4); osctl.click(VX+VW//2,VY+VH//2); time.sleep(0.3)
PW=PH=48; MS=70
A=grab(); osctl.move_rel(80,0,steps=5,delay=0.003); time.sleep(0.06); B=grab()
dxs=[]; dys=[]
for gx in range(3):
    for gy in range(3):
        cx=int(VW*(0.25+0.25*gx)); cy=int(VH*(0.25+0.22*gy))
        p=cut(A,VW,cx,cy,PW,PH)
        sr=(cx-MS,cy-MS,cx+MS,cy+MS)
        m=osctl.match_template(p,PW,PH,rgb=B,size=(VW,VH),search=sr,step=2)
        if not m: continue
        dx,dy=m["x"]-cx,m["y"]-cy; dxs.append(dx); dys.append(dy)
        print(f"block({cx:>3},{cy:>3}) -> shift ({dx:>4},{dy:>3}) score={m['score']}")
mdx,mdy=int(st.median(dxs)),int(st.median(dys))
print(f"\nMEDIAN shift = ({mdx},{mdy}) from {len(dxs)} blocks; raw dx spread {min(dxs)}..{max(dxs)}")
# compensate: shift A by (mdx,mdy) and diff overlap with B
raw=osctl.region_diff(A,B,tol=18)["frac"]
# build shifted A into a buffer (only overlap region compared via crop)
def shift_diff(A,B,dx,dy):
    cnt=tot=0
    for y in range(0,VH,2):
        sy=y+dy
        if sy<0 or sy>=VH: continue
        for x in range(0,VW,2):
            sx=x+dx
            if sx<0 or sx>=VW: continue
            ia=(y*VW+x)*3; ib=(sy*VW+sx)*3
            d=abs(A[ia]-B[ib])+abs(A[ia+1]-B[ib+1])+abs(A[ia+2]-B[ib+2])
            tot+=1
            if d>54: cnt+=1
    return cnt/max(tot,1)
comp=shift_diff(A,B,mdx,mdy)
print(f"raw diff frac={raw:.3f}  ->  after compensating ({mdx},{mdy}): {comp:.3f}")
