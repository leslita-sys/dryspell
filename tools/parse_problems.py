#!/usr/bin/env python3
"""Extract problem name -> book page pairs from the guidebook's Index by Name
(book p550-567), then map each page to its sub-area from squamish_areas.json.
Run with the pdftotext -layout output as argv[1]."""
import json, re, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
AREAS = json.load(open(os.path.join(HERE, '..', 'data', 'squamish_areas.json')))
OUT = os.path.join(HERE, '..', 'data', 'problems.json')

gb = sys.argv[1] if len(sys.argv) > 1 else 'guidebook.txt'
pages = open(gb, encoding='utf-8', errors='replace').read().split('\f')

# The name index and grade index both sit under "INDEXES" page headers, but the
# running header only prints on left-hand pages; take the full contiguous range.
marked = [i for i, p in enumerate(pages) if 'INDEXES' in p]
idx_pages = range(min(marked) - 1, min(max(marked) + 2, len(pages)))

areas_sorted = sorted([a for a in AREAS if a.get('book_page')], key=lambda a: a['book_page'])

def area_for(page):
    cur = None
    for a in areas_sorted:
        if a['book_page'] <= page:
            cur = a
        else:
            break
    return cur

cell_re = re.compile(r'^(.+?)\s+(\d{2,3}(?:\s*,\s*\d{2,3})*)$')

problems, seen = [], set()
for pi in idx_pages:
    for line in pages[pi].split('\n'):
        if '¢' in line:            # grade-index page: names repeat, skip
            continue
        for cell in re.split(r'\s{3,}', line.strip()):
            m = cell_re.match(cell.strip())
            if not m:
                continue
            name = m.group(1).strip(' .·')
            if len(name) < 3 or name.isupper() or 'INDEX' in name.upper():
                continue
            for pg in re.findall(r'\d{2,3}', m.group(2)):
                page = int(pg)
                if not (60 <= page <= 549):
                    continue
                key = (name.lower(), page)
                if key in seen:
                    continue
                seen.add(key)
                a = area_for(page)
                if a:
                    problems.append({'n': name, 'p': page, 'a': a['name'], 'c': a['chapter']})

problems.sort(key=lambda x: x['n'].lower())
json.dump(problems, open(OUT, 'w'), separators=(',', ':'))
print(f"{len(problems)} problem entries -> {OUT}")
