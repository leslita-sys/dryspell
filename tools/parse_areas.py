#!/usr/bin/env python3
"""Parse Squamish Bouldering Guide V4 text layer into a per-area dataset
for the drying-energy model: sun aspect, drying icons, GPS, hike time,
and drying-related prose."""
import json, re

data = open('guidebook.txt', encoding='utf-8', errors='replace').read()
pages = data.split('\f')

SUN = {
    'y': 'morning_sun',
    '~': 'afternoon_sun',
    'z': 'tree_filtered_sun_am',
    '{': 'tree_filtered_sun_pm',
    '|': 'sunny_most_of_day',
    '}': 'shady_most_of_day',
}
DRY = {')': 'dries_fast', '*': 'climbable_in_rain'}
APPROACH = {'U': 'flat', 'e': 'uphill', 'd': 'steep_uphill', 'T': 'downhill'}
HIKE_MIN = {';': 1, '<': 5, '=': 8, '>': 10, '?': 12, '@': 15,
            'A': 17, 'B': 20, 'C': 22, 'D': 25}

# Chapters with their book TOC page starts (book page ~= pdf page - 2)
CHAPTERS = [
    ('Murrin Park', 68), ('Shannon Falls', 94), ('The Grand Wall', 116),
    ('Apron Boulders', 262), ('The North Walls', 302), ('Crumpit Woods', 428),
    ('Smoke Bluffs', 448), ('Garibaldi', 476), ('Powerline Boulders', 492),
    ('Cat Lake', 510), ('Paradise Valley', 518), ('Other Areas', 546),
]

def chapter_for(pdf_page):
    book_page = pdf_page - 2
    name = None
    for cname, start in CHAPTERS:
        if book_page >= start:
            name = cname
    return name

hdr_re = re.compile(r'^\s{0,12}([A-Z][A-Z0-9\'’\-\. ]{2,40}?)\s{2,}([\d,]+) problems')
coord_re = re.compile(r'(49\.\d{4,6}),\s*(-123\.\d{4,6})')
icon_re = re.compile(r'([UedT])\s*([;<=>?@ABCD])(?:\s*to\s*([;<=>?@ABCD]))?\s*([y~z{|}]?)\s*([)*]*)\s*$')

areas = []
for i, page in enumerate(pages):
    lines = page.split('\n')
    for li, line in enumerate(lines):
        m = hdr_re.match(line)
        if not m:
            continue
        name = m.group(1).strip().title().replace('’', "'")
        count = int(m.group(2).replace(',', ''))
        # icons: end of the header line, or on one of the next 2 lines
        icon_m = None
        for cand in [line] + lines[li+1:li+3]:
            im = icon_re.search(cand.rstrip())
            if im:
                icon_m = im
                break
        # GPS: first coord found on this page (page header = parking coords)
        gm = coord_re.search(page)
        area = {
            'name': name,
            'chapter': chapter_for(i + 1),
            'pdf_page': i + 1,
            'book_page': i - 1,
            'problems': count,
            'lat': float(gm.group(1)) if gm else None,
            'lon': float(gm.group(2)) if gm else None,
        }
        if icon_m:
            a, t1, t2, sun, dry = icon_m.groups()
            area['approach'] = APPROACH.get(a)
            area['hike_min'] = HIKE_MIN.get(t1)
            if t2:
                area['hike_min_max'] = HIKE_MIN.get(t2)
            area['sun'] = SUN.get(sun) if sun else None
            area['dries_fast'] = ')' in dry
            area['climbable_in_rain'] = '*' in dry
        # drying-related prose from the intro page
        notes = []
        for sent in re.split(r'(?<=[.!?])\s+', ' '.join(page.split())):
            if re.search(r'\b(dry|dries|drying|seep|wet|damp|canopy|drainage|rain shadow|stays? dry)\w*\b', sent, re.I):
                if name.upper() in page[:400].upper() and len(sent) < 400:
                    notes.append(sent.strip())
        if notes:
            area['drying_notes'] = notes[:4]
        areas.append(area)

# de-dup (headers can repeat across page spreads)
seen = {}
for a in areas:
    key = a['name']
    if key not in seen or (a.get('sun') and not seen[key].get('sun')):
        seen[key] = a
areas = list(seen.values())

print(f"{len(areas)} areas parsed")
missing = [a['name'] for a in areas if 'sun' not in a or not a.get('sun')]
print("missing sun aspect:", missing)
json.dump(areas, open('squamish_areas.json', 'w'), indent=1)
