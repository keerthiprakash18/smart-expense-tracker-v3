#!/usr/bin/env python3
import pathlib
import re
import sys

ROOT=pathlib.Path(__file__).resolve().parents[1]
SKIP_PARTS={".git","node_modules","dist","build","__pycache__"}
SKIP_NAMES={"package-lock.json"}
PATTERNS={
    "private key":re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token":re.compile(r"\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b"),
    "OpenAI-style secret":re.compile(r"\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b"),
    "Google API key":re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    "AWS access key":re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
}
hits=[]
for path in ROOT.rglob("*"):
    if not path.is_file() or path.name in SKIP_NAMES or any(part in SKIP_PARTS for part in path.parts):
        continue
    try:text=path.read_text(encoding="utf-8")
    except (UnicodeDecodeError,OSError):continue
    for name,pattern in PATTERNS.items():
        for match in pattern.finditer(text):
            line=text.count("\n",0,match.start())+1
            hits.append(f"{path.relative_to(ROOT)}:{line}: {name}")
if hits:
    print("Potential committed secrets detected:")
    print("\n".join(hits))
    sys.exit(1)
print("Secret scan clean.")
