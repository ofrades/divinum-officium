#!/usr/bin/env python3
"""Collect the texts the API serves into one directory of Worker assets.

The texts stay the repository's own files — nothing is transformed, parsed or
pre-rendered here. The Worker reads them with its assets binding, exactly as the
engine reads them from disk, so a text fix in the repository reaches the API on
the next deploy.

Usage:
  tools/sync_assets.py [--langs Latin,Portugues,English] [--out cloudflare/.assets]

Prints a file/size summary, because Workers Static Assets have limits worth
watching: 20,000 files per version on the free plan, 25 MiB per file.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

# What the engine reads to render an office and a Mass for one language.
LANGUAGE_TREES = ("horas", "missa")
# Ordinary scripts (the shape of each hour) are language-independent: they live
# at the root of `horas/`, not inside a language.
SHARED_TREES = ("Tabulae", "horas/Ordinarium")


def copy_tree(source: str, target: str, wanted: str | None) -> tuple[int, int]:
    """Copy source into target, optionally keeping only names in ``wanted``."""
    files = 0
    total = 0
    for root, dirs, names in os.walk(source):
        relative = os.path.relpath(root, source)
        for name in sorted(names):
            if wanted is not None and name not in wanted:
                continue
            src = os.path.join(root, name)
            dst = os.path.join(target, relative, name) if relative != "." else os.path.join(target, name)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            files += 1
            total += os.path.getsize(src)
    return files, total


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."),
                        help="repository root (the checkout this script lives in)")
    parser.add_argument("--out", default=None, help="asset directory (default <root>/cloudflare/.assets)")
    parser.add_argument("--langs", default="Latin,Portugues,English")
    parser.add_argument("--clean", action="store_true", help="remove the destination first")
    args = parser.parse_args(argv)

    root = os.path.abspath(args.root)
    web = os.path.join(root, "web", "www")
    out = os.path.abspath(args.out or os.path.join(root, "cloudflare", ".assets"))
    languages = [lang.strip() for lang in args.langs.split(",") if lang.strip()]

    if not os.path.isdir(web):
        print(f"no web/www under {root} — is this the Divinum Officium checkout?", file=sys.stderr)
        return 1
    if args.clean and os.path.isdir(out):
        shutil.rmtree(out)

    files = 0
    total = 0
    missing = []
    for tree in LANGUAGE_TREES:
        for language in languages:
            source = os.path.join(web, tree, language)
            if not os.path.isdir(source):
                missing.append(f"{tree}/{language}")
                continue
            copied, size = copy_tree(source, os.path.join(out, tree, language), None)
            files += copied
            total += size
            print(f"  {tree}/{language:12s} {copied:6d} files  {size/1048576:6.2f} MB")
    for tree in SHARED_TREES:
        source = os.path.join(web, tree)
        if not os.path.isdir(source):
            missing.append(tree)
            continue
        copied, size = copy_tree(source, os.path.join(out, tree), None)
        files += copied
        total += size
        print(f"  {tree:19s} {copied:6d} files  {size/1048576:6.2f} MB")

    print(f"\n{files} files, {total/1048576:.2f} MB of content → {out}")
    print("Workers Static Assets: 20,000 files free, 25 MiB each — "
          + ("inside the limit" if files <= 20000 else "OVER THE FILE LIMIT"))
    if missing:
        print("missing (skipped): " + ", ".join(missing), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
