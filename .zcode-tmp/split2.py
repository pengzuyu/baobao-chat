import subprocess, re
def select(path, markers):
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
    out = ["".join(header)]
    for h in hunks:
        body = "".join(h)
        if any(m in body for m in markers):
            out.append(body)
    return "".join(out)
LR = "agent/crates/bbrt-session/src/loop_runner.rs"
SA = "agent/crates/bbrt-session/src/subagent.rs"
MW = "agent/crates/bbrt-tools/src/builtin/memory.rs"
p = select(LR,["from_secs(600)","同步等窗内 join","缺省对齐 SUBAGENT_WAIT_WINDOW"])
p += select(SA,["缺省 SUBAGENT_WAIT_WINDOW=600s"])
p += select(MW,["默认 600，上限 3600"])
open(".zcode-tmp/p2b.patch","w").write(p)
n = len(re.findall(r"^@@", p, re.M))
print("p2b hunks:", n); assert n == 5, f"期望 5 个 hunk，实际 {n}"
assert "risk_of" not in p, "混入用户 WIP"
