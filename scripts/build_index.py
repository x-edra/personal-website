#!/usr/bin/env python3
"""Genera wiki.json y search.json a partir de la carpeta docs/.

La estructura de carpetas define la navegación:

    docs/index.md                       -> Home
    docs/study/index.md                 -> sección "Study"
    docs/study/game-theory/index.md     -> campo "Game Theory"
    docs/study/game-theory/nash.md      -> nota dentro de "Game Theory"

Cada archivo puede empezar con un bloque opcional de metadatos:

    ---
    title: Nash Equilibrium
    description: Una línea que resume la nota.
    tags: [equilibrium, strategy]
    order: 2
    status: draft
    ---

Los enlaces entre notas ([[nota]], [[nota|texto]], [[nota#sección]] o
[texto](wiki:nota)) se resuelven aquí para calcular las referencias inversas.

Archivos y carpetas que empiezan por "_" o "." se ignoran (borradores).

Uso:  python3 scripts/build_index.py
"""

import datetime
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'

DEFAULT_SITE_TITLE = 'The Void'
DEFAULT_SITE_DESCRIPTION = 'A personal archive of ideas, research, projects, and references.'

FRONT_MATTER = re.compile(r'\A---\s*\n(.*?)\n---\s*(?:\n|\Z)', re.S)
WIKI_LINK = re.compile(r'\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]')
WIKI_HREF = re.compile(r'\]\(wiki:([^)#\s]+)(?:#[^)\s]*)?\)')
CODE_FENCE = re.compile(r'^(```|~~~).*?^\1', re.S | re.M)
INLINE_CODE = re.compile(r'`[^`\n]*`')
HEADING = re.compile(r'^(#{1,6})\s+(.+?)\s*#*\s*$', re.M)


def slug(value):
    value = unicodedata.normalize('NFD', str(value).lower())
    value = ''.join(c for c in value if unicodedata.category(c) != 'Mn')
    value = re.sub(r'[^\w\s-]', '', value).strip()
    return re.sub(r'[\s_]+', '-', value)


def humanize(name):
    return re.sub(r'[-_]+', ' ', name).strip().title()


def parse_scalar(value):
    value = value.strip()

    if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
        return value[1:-1]

    if value.startswith('[') and value.endswith(']'):
        return [parse_scalar(v) for v in value[1:-1].split(',') if v.strip()]

    if re.fullmatch(r'-?\d+(\.\d+)?', value):
        return float(value) if '.' in value else int(value)

    return value


def parse_front_matter(text):
    """YAML mínimo: `clave: valor`, listas `[a, b]` o con guiones."""
    match = FRONT_MATTER.match(text)
    if not match:
        return {}, text

    meta = {}
    current_list = None

    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue

        item = re.match(r'^\s*-\s+(.*)$', line)
        if item and current_list is not None:
            meta[current_list].append(parse_scalar(item.group(1)))
            continue

        pair = re.match(r'^([\w-]+)\s*:\s*(.*)$', line)
        if not pair:
            continue

        key, value = pair.group(1).lower(), pair.group(2)

        if value.strip() == '':
            meta[key] = []
            current_list = key
        else:
            meta[key] = parse_scalar(value)
            current_list = None

    return meta, text[match.end():]


def plain_text(markdown):
    text = re.sub(r'<[^>]+>', ' ', markdown)
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', text)
    text = re.sub(r'\[\[([^\]|]+)\|([^\]]+)\]\]', r'\2', text)
    text = re.sub(r'\[\[([^\]]+)\]\]', r'\1', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+', '', text, flags=re.M)
    text = re.sub(r'[*_~`|]+', '', text)
    text = re.sub(r'^-{3,}\s*$', ' ', text, flags=re.M)
    return re.sub(r'\s+', ' ', text).strip()


def first_paragraph(markdown, limit=160):
    for block in re.split(r'\n\s*\n', markdown):
        block = block.strip()
        if not block or block.startswith(('#', '```', '~~~', '|', '<', '!', '---')):
            continue

        text = plain_text(block)
        if len(text) > limit:
            text = text[:limit].rsplit(' ', 1)[0] + '…'
        return text

    return ''


def as_list(value):
    if value is None or value == '':
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    return [v.strip() for v in str(value).split(',') if v.strip()]


def is_hidden(path):
    return any(part.startswith(('_', '.')) for part in path.relative_to(DOCS).parts)


def page_id(path):
    """docs/study/x/index.md -> 'study/x'; docs/index.md -> ''."""
    rel = path.relative_to(DOCS).with_suffix('')
    parts = list(rel.parts)
    if parts and parts[-1] == 'index':
        parts.pop()
    return '/'.join(parts)


def parent_id(pid):
    if pid == '':
        return None
    return pid.rsplit('/', 1)[0] if '/' in pid else ''


def kind_of(pid, is_folder):
    if pid == '':
        return 'home'
    if is_folder:
        return 'section' if '/' not in pid else 'field'
    return 'note'


def build():
    if not DOCS.is_dir():
        sys.exit('No existe la carpeta docs/.')

    pages = {}
    search = {}
    bodies = {}

    folders = sorted(
        p for p in [DOCS, *DOCS.rglob('*')]
        if p.is_dir() and not (p != DOCS and is_hidden(p))
    )

    # Cada carpeta es un campo, tenga o no index.md.
    for folder in folders:
        pid = '/'.join(folder.relative_to(DOCS).parts)
        pages[pid] = {
            'id': pid,
            'kind': kind_of(pid, True),
            'title': 'Home' if pid == '' else humanize(folder.name),
            'description': '',
            'file': None,
            'parent': parent_id(pid),
            'order': None,
            'tags': [],
            'status': '',
            'updated': '',
            'words': 0,
            'aliases': [folder.name] if pid else ['home', 'inicio'],
            'links': [],
            'backlinks': [],
            'headings': [],
        }

    site_meta = {}

    for path in sorted(DOCS.rglob('*.md')):
        if is_hidden(path):
            continue

        raw = path.read_text(encoding='utf-8')
        meta, body = parse_front_matter(raw)
        pid = page_id(path)
        is_index = path.stem == 'index'

        page = pages.get(pid) or {
            'id': pid,
            'kind': 'note',
            'title': humanize(path.stem),
            'parent': parent_id(pid),
            'aliases': [path.stem],
            'links': [],
            'backlinks': [],
        }

        if pid == '':
            site_meta = meta

        headings = [(len(h), plain_text(t)) for h, t in HEADING.findall(CODE_FENCE.sub('', body))]
        h1 = next((t for level, t in headings if level == 1), None)
        text = plain_text(CODE_FENCE.sub('', body))

        page.update({
            'file': path.relative_to(ROOT).as_posix(),
            'title': str(meta.get('title') or h1 or page['title']),
            'description': str(meta.get('description') or first_paragraph(body)),
            'order': meta.get('order'),
            'tags': as_list(meta.get('tags')),
            'status': str(meta.get('status') or ('' if text else 'empty')),
            'updated': str(meta.get('updated') or datetime.date.fromtimestamp(
                path.stat().st_mtime).isoformat()),
            'words': len(text.split()),
            'headings': [t for level, t in headings if level in (2, 3)],
        })
        page['aliases'] = page['aliases'] + as_list(meta.get('aliases'))

        if not is_index and pid in pages:
            print(f'  aviso: {page["file"]} tiene el mismo id que una carpeta; se ignora.')
            continue

        pages[pid] = page
        bodies[pid] = body
        search[pid] = text

    # Resolución de enlaces: id completo, nombre de archivo/carpeta, título, alias.
    lookup = {}
    for page in pages.values():
        lookup.setdefault(page['id'].lower(), page['id'])
        for key in [page['title'], *page['aliases']]:
            lookup.setdefault(slug(key), page['id'])

    broken = []

    for pid, body in bodies.items():
        clean = INLINE_CODE.sub('', CODE_FENCE.sub('', body))
        targets = WIKI_LINK.findall(clean) + WIKI_HREF.findall(clean)
        links = []

        for target in targets:
            target = target.strip()
            resolved = lookup.get(target.lower().strip('/')) or lookup.get(slug(target))
            if resolved is None:
                broken.append((pages[pid]['file'], target))
            elif resolved != pid and resolved not in links:
                links.append(resolved)

        pages[pid]['links'] = links

    for page in pages.values():
        for target in page['links']:
            if page['id'] not in pages[target]['backlinks']:
                pages[target]['backlinks'].append(page['id'])

    ordered = sorted(pages.values(), key=lambda p: p['id'])

    wiki = {
        'title': str(site_meta.get('site_title') or DEFAULT_SITE_TITLE),
        'description': str(site_meta.get('site_description') or DEFAULT_SITE_DESCRIPTION),
        'pages': ordered,
    }

    (ROOT / 'wiki.json').write_text(
        json.dumps(wiki, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    (ROOT / 'search.json').write_text(
        json.dumps(search, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

    counts = {}
    for page in ordered:
        counts[page['kind']] = counts.get(page['kind'], 0) + 1

    summary = ', '.join(f'{n} {k}' for k, n in sorted(counts.items()))
    print(f'wiki.json y search.json generados: {summary}.')

    for file, target in broken:
        print(f'  aviso: enlace roto en {file}: [[{target}]]')


if __name__ == '__main__':
    build()
