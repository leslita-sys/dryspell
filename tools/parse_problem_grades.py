#!/usr/bin/env python3
"""Annotate data/problems.json with per-problem V-grades by scanning guidebook
body pages for "Name V<g>" problem headers and joining on (name, page).
Falls back to name-only join when the name is unique book-wide. Problems that
don't match keep no 'g' key and render ungraded. Run with guidebook.txt path."""
import json, re, sys, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
PROBLEMS = os.path.join(HERE, '..', 'data', 'problems.json')

gb = sys.argv[1] if len(sys.argv) > 1 else 'guidebook.txt'
pages = open(gb, encoding='utf-8', errors='replace').read().split('\f')

def norm(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())

# body problem header inside a column cell: junk-prefixed name, then a grade token
cell_grade = re.compile(
    r"([A-Za-z][A-Za-z0-9'’&!?\.,:()\-– ]{1,60}?)\s+(V\d{1,2}[+-]?|VH|VB)(?![\d–→])\b")

by_name_page = {}
by_name = defaultdict(set)
page_entries = defaultdict(list)   # book_page -> [(norm_name, grade)]
FIRST, LAST = 62, 549
for i, page in enumerate(pages):
    book_page = i - 1
    if not (FIRST <= book_page <= LAST):
        continue
    for line in page.split('\n'):
        if 'V0–2' in line or 'INDEX' in line.upper():
            continue
        for cell in re.split(r'\s{3,}', line):
            for m in cell_grade.finditer(cell):
                name, grade = m.group(1).strip(' .·'), m.group(2)
                n = norm(name)
                if len(n) < 3:
                    continue
                by_name_page[(n, book_page)] = grade
                by_name[n].add(grade)
                page_entries[book_page].append((n, grade))

problems = json.load(open(PROBLEMS))
hit = 0
for p in problems:
    n = norm(p['n'])
    g = None
    # exact page, then neighbors (headers sometimes land a page off the index)
    for pg in (p['p'], p['p'] + 1, p['p'] - 1):
        g = by_name_page.get((n, pg))
        if g:
            break
    if not g and len(by_name.get(n, ())) == 1:
        g = next(iter(by_name[n]))
    if not g:
        # icon glyphs glue onto body names ("mthelegend"); match by suffix on
        # the same page, and let truncated index names ("The Lessons of Se...")
        # match body names that start with the untruncated part
        stem = n.rstrip('.')
        for pg in (p['p'], p['p'] + 1, p['p'] - 1):
            for en, eg in page_entries.get(pg, ()):
                if en.endswith(n) or (len(stem) >= 8 and en.startswith(stem[:12])):
                    g = eg
                    break
            if g:
                break
    if g:
        p['g'] = g
        hit += 1

json.dump(problems, open(PROBLEMS, 'w'), separators=(',', ':'))
print(f"graded {hit}/{len(problems)} problems ({hit * 100 // len(problems)}%)")
