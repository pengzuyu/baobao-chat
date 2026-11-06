#!/usr/bin/env python3
"""Helm 模板静态校验（无 helm 二进制环境的替代检查）。

对 deploy/helm/bbw/templates/ 逐文件：
1. 剔除 {{/* ... */}} 注释块后做 {{ / }} 定界符配平检查；
2. 将模板表达式替换为占位内容后按多文档 YAML 解析（捕获缩进/结构错误）。
   整行表达式（如 `{{ include ... | nindent 4 }}`）在真实渲染时可为映射/
   序列/空内容，静态检查按解析错误位置自适应切换占位形态（mapping →
   sequence → 空）重试。

局限：无法等价 `helm template` 的语义渲染（条件/循环），仅做语法级把关；
环境具备 helm 时以 `helm lint` / `helm template bbw .` 为准。
"""
import re
import sys
from pathlib import Path

import yaml

CHART = Path(__file__).resolve().parents[1] / "deploy" / "helm" / "bbw"
COMMENT = re.compile(r"\{\{/\*.*?\*/\}\}", re.DOTALL)
TMPL_EXPR = re.compile(r"\{\{[^{}]*\}\}")

MAPPING, SEQUENCE, EMPTY, SCALAR = range(4)
VARIANTS = {
    MAPPING: lambda indent: f"{indent}__placeholder__: v",
    SEQUENCE: lambda indent: f"{indent}- v",
    EMPTY: lambda indent: "",
    SCALAR: lambda indent: f'{indent}"v"',
}


def strip_comments(text: str) -> str:
    return COMMENT.sub("", text)


def check_balance(text: str, name: str) -> bool:
    ok = True
    for i, line in enumerate(text.splitlines(), 1):
        # 先剔除成对表达式，再检查是否有残留定界符（残留 = 未配平）
        rest = TMPL_EXPR.sub("", line)
        if "{{" in rest or "}}" in rest:
            print(f"[FAIL] {name}:{i} 未配平的模板定界符: {line.strip()[:80]}")
            ok = False
    return ok


def render(text: str, kinds: dict) -> str:
    out = []
    for idx, line in enumerate(text.splitlines()):
        stripped = line.strip()
        indent = line[: len(line) - len(line.lstrip())]
        if stripped.startswith("{{") and stripped.endswith("}}"):
            out.append(VARIANTS[kinds.get(idx, MAPPING)](indent))
        else:
            # 行内表达式占位：纯字母数字，保证与前缀/后缀拼接后仍是合法纯标量
            # （如 name: {{ include ... }}-app → name: TPLX-app）
            out.append(TMPL_EXPR.sub("TPLX", line))
    return "\n".join(out)


def try_parse(rendered: str):
    """返回 (ok, 错误行号或 None)。"""
    try:
        list(yaml.safe_load_all(rendered))
        return True, None
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        return False, (mark.line if mark else None)


def analyze(text: str, name: str) -> bool:
    full_lines = [
        idx
        for idx, line in enumerate(text.splitlines())
        if line.strip().startswith("{{") and line.strip().endswith("}}")
    ]
    kinds = {idx: MAPPING for idx in full_lines}
    for _ in range(3 * len(full_lines) + 3):
        ok, err_line = try_parse(render(text, kinds))
        if ok:
            return True
        if err_line is None:
            print(f"[FAIL] {name}: YAML 解析失败（无行号信息）")
            return False
        # 定位错误行之前最近的整行表达式，切换占位形态后重试
        target = None
        for idx in full_lines:
            if idx <= err_line:
                target = idx
        if target is None:
            print(f"[FAIL] {name}:{err_line + 1} 静态渲染后 YAML 非法（无整行表达式可调整）")
            return False
        nxt = {MAPPING: SEQUENCE, SEQUENCE: EMPTY, EMPTY: SCALAR, SCALAR: MAPPING}
        kinds[target] = nxt[kinds[target]]
    print(f"[FAIL] {name}: 自适应占位重试耗尽")
    return False


def main() -> int:
    failures = 0
    for f in [CHART / "Chart.yaml", *sorted(CHART.glob("values*.yaml"))]:
        try:
            yaml.safe_load(f.read_text())
            print(f"[OK]   {f.name}: YAML 合法")
        except yaml.YAMLError as e:
            print(f"[FAIL] {f.name}: {e}")
            failures += 1

    for f in sorted(CHART.glob("templates/*")):
        raw = f.read_text()
        no_comment = strip_comments(raw)
        if not check_balance(no_comment, f.name):
            failures += 1
            continue
        if f.suffix in (".tpl", ".txt"):
            print(f"[OK]   {f.name}: 定界符配平（非渲染 YAML，跳过解析）")
            continue
        if analyze(no_comment, f.name):
            print(f"[OK]   {f.name}: 静态渲染后 YAML 可解析")
        else:
            failures += 1

    print("----")
    print("结论：静态检查全部通过" if failures == 0 else f"结论：{failures} 个文件未通过")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
