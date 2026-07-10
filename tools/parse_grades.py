#!/usr/bin/env python3
"""Count problems per V-grade band per area by scanning guidebook body pages
for problem-header grade tokens (e.g. "Crackhead V3"). Bands follow the book's
own header bar: V0-2, V3-6, V7-9, V10+. Estimates, not gospel — prose mentions
add a little noise, but filtering only needs "does this area have V2s".
Run with the pdftotext -layout output as argv[1]."""
import json, re, sys, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
AREAS = json.load(open(os.path.join(HERE, '..', 'data', 'squamish_areas.json')))
OUT = os.path.join(HERE, '..', 'data', 'area_grades.json')

gb = sys.argv[1] if len(sys.argv) > 1 else 'guidebook.txt'
pages = open(gb, encoding='utf-8', errors='replace').read().split('\f')

areas_sorted = sorted([a for a in AREAS if a.get('book_page')], key=lambda a: a['book_page'])

def area_for(book_page):
    cur = None
    for a in areas_sorted:
        if a['book_page'] <= book_page:
            cur = a
        else:
            break
    return cur

def band(g):
    if g in ('VH',): return 'V10+'
    if g in ('VB',): return 'V0-2'
    n = int(g[1:])
    if n <= 2: return 'V0-2'
    if n <= 6: return 'V3-6'
    if n <= 9: return 'V7-9'
    return 'V10+'

# grade token not part of the header bar ("V0–2 V3–6 V7–9 V10→") or a range
tok = re.compile(r'\b(V\d{1,2}|VH|VB)(?![\d–—→])[+-]?(?=[\s,.)★]|$)')

counts = defaultdict(lambda: defaultdict(int))
FIRST, LAST = 62, 549  # body pages (book numbering)
for i, page in enumerate(pages):
    book_page = i - 1
    if not (FIRST <= book_page <= LAST):
        continue
    a = area_for(book_page)
    if not a:
        continue
    for line in page.split('\n'):
        if 'V0–2' in line or 'INDEX' in line.upper():
            continue
        for m in tok.finditer(line):
            counts[a['name']][band(m.group(1))] += 1

out = {name: dict(bands) for name, bands in counts.items()}
total = sum(sum(b.values()) for b in out.values())
json.dump(out, open(OUT, 'w'), indent=0)
print(f"{len(out)} areas, {total} grade tokens (book has 3,590 problems) -> {OUT}")
