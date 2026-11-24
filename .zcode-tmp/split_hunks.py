import subprocess, sys, re

def hunks_of(path):
    diff = subprocess.run(["git","diff","--",path],capture_output=True,text=True).stdout
    lines = diff.splitlines(keepends=True)
    header, hunks, cur = [], [], None
    for ln in lines:
        if ln.startswith("@@"):
            if cur: hunks.append(cur)
            cur = [ln]
        elif cur is not None:
            cur.append(ln)
        else:
            header.append(ln)
    if cur: hunks.append(cur)
    return header, hunks

def select(path, markers):
    header, hunks = hunks_of(path)
    out = ["".join(header)]
    for h in hunks:
        body = "".join(h)
        if any(m in body for m in markers):
            out.append(body)
    return "".join(out)

LR = "agent/crates/bbrt-session/src/loop_runner.rs"
SA = "agent/crates/bbrt-session/src/subagent.rs"
MW = "agent/crates/bbrt-tools/src/builtin/memory.rs"

p1 = select(LR, ["等待期响应 interrupt", "已请求取消后台任务"])
open(".zcode-tmp/p1_loop.patch","w").write(p1)
p2lr = select(LR, ["from_secs(600)", "同步等窗内 join", "缺省对齐 SUBAGENT_WAIT_WINDOW"])
p2sa = select(SA, ["缺省 SUBAGENT_WAIT_WINDOW=600s"])
p2mw = select(MW, ["默认 600，上限 3600"])
open(".zcode-tmp/p2.patch","w").write(p2lr+p2sa+p2mw)

for name, p in [("p1_loop",p1),("p2",p2lr+p2sa+p2mw)]:
    n = len(re.findall(r"^@@", p, re.M))
    print(name, "hunks:", n)
    assert n > 0, f"{name} 为空！标记未命中"
