#!/usr/bin/env python3
"""Extract IpcHandler blocks from a QML file and emit a synthetic
shell.qml suitable for offscreen IPC testing.

The synthetic shell wraps each block in a ShellRoot and re-emits the
source file's `import` lines so the handlers' types resolve. With
`--inject-marker` (default on), each handler function body gets a
`console.log("IPCMARK <target> <function> ...args")` prepended so a
test harness can grep the instance log to prove the handler actually
ran with the expected arguments.

Usage:
    extract-ipc-handlers.py FILE [-o OUT] [--no-marker]

Reads from FILE (or stdin if `-`). Writes the synthetic shell.qml to
OUT (or stdout). Exit 0 = blocks found, 2 = no IpcHandler in input.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def find_blocks(src: str, keyword: str) -> list[str]:
    """Return each `keyword { ... }` block, brace-balanced."""
    out: list[str] = []
    i = 0
    while True:
        j = src.find(keyword, i)
        if j == -1:
            return out
        # Find the opening `{` after the keyword.
        k = src.find("{", j)
        if k == -1:
            return out
        depth = 0
        m = k
        while m < len(src):
            c = src[m]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    out.append(src[j:m + 1])
                    break
            m += 1
        else:
            return out  # unbalanced; bail
        i = m + 1


def extract_imports(src: str) -> list[str]:
    """Top-of-file `import ...` lines (until first non-import/non-blank).
    Drops config-relative `import qs.*` lines — the synthetic shell.qml
    lives outside the real config and cannot resolve them, and qs will
    refuse to load the whole file on an unresolvable import."""
    out: list[str] = []
    for line in src.splitlines():
        s = line.strip()
        if s.startswith("import"):
            if "qs." in s.split("//", 1)[0]:
                # Skip config-relative imports; their types aren't used by
                # the stubbed handler bodies anyway.
                continue
            out.append(line)
        elif s == "" or s.startswith("//"):
            continue
        else:
            break
    return out


def inject_markers(blocks: list[str], target_names: dict[str, str],
                   stub_body: bool = True) -> list[str]:
    """Prepend a console.log marker to each function body inside the
    blocks. With stub_body=True (default) the original body is replaced
    with a comment — the synthetic shell.qml is for IPC plumbing checks,
    not for testing the handler's real work, and stubbing keeps the log
    clean of Hyprland/IPC errors that the real bodies would produce
    under offscreen-with-no-Hyprland."""
    out = []
    for block in blocks:
        tm = re.search(r'target:\s*"([^"]+)"', block)
        target = tm.group(1) if tm else "?"

        def repl(m: re.Match[str]) -> str:
            head = m.group("head")   # `function NAME(args) {`
            args_part = m.group("args") or ""
            fname = m.group("name")
            arg_names = [a.strip().split(":")[0].split("=")[0].strip()
                         for a in args_part.split(",") if a.strip()]
            # Flat key=value pairs so the marker is grep-friendly:
            # IPCMARK <target> <function> [arg1=val1 arg2=val2 ...]
            # Concatenate so the actual argument VALUES appear in the log,
            # not the parameter names twice.
            parts = [f'"{target}"', f'"{fname}"']
            for n in arg_names:
                parts.append(f'"{n}=" + {n}')
            marker = (
                f'            console.log("IPCMARK", ' + ", ".join(parts) + ')\n'
            )
            if stub_body:
                body = "\n            // (body stubbed — see --keep-body)\n"
            else:
                body = m.group("body")
            closing = m.group("close")
            return head + "\n" + marker + body + closing

        new_block = re.sub(
            r"(?P<head>function\s+(?P<name>\w+)\s*\((?P<args>[^)]*)\)\s*(?::\s*\w+\s*)?\{)"
            r"(?P<body>.*?)"
            r"(?P<close>\n\s*\})",
            repl, block, flags=re.DOTALL,
        )
        out.append(new_block)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file", help="QML file (use - for stdin)")
    ap.add_argument("-o", "--output", default="-", help="output file (- = stdout)")
    ap.add_argument("--keep-body", action="store_true",
                    help="preserve the handler body (default: stub it)")
    ap.add_argument("--keep-config-imports", action="store_true",
                    help="keep `import qs.*` lines (default: drop them — "
                         "they can't resolve outside the real config)")
    ap.add_argument("--raw", action="store_true",
                    help="emit IpcHandler blocks without a ShellRoot wrapper "
                         "(for concatenating handlers from many files)")
    ap.add_argument("--no-marker", action="store_true",
                    help="don't inject IPCMARK log lines into handler bodies")
    args = ap.parse_args()

    src = sys.stdin.read() if args.file == "-" else Path(args.file).read_text()
    blocks = find_blocks(src, "IpcHandler")
    if not blocks:
        return 2

    imports = extract_imports(src)  # already filters qs.* by default
    if not args.no_marker:
        blocks = inject_markers(blocks, {}, stub_body=not args.keep_body)

    out = []
    if not args.raw:
        out.extend(imports)
        out.append("")
        out.append("// Synthesized by extract-ipc-handlers.py for offscreen IPC testing.")
        out.append("ShellRoot {")
    for b in blocks:
        for line in b.splitlines():
            out.append("    " + line if line.strip() else line)
    if not args.raw:
        out.append("}")
    out.append("")

    out_text = "\n".join(out)
    if args.output == "-":
        sys.stdout.write(out_text)
    else:
        Path(args.output).write_text(out_text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
