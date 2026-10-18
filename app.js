(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  const article = $('#article');
  const nav = $('#navigation');
  const toc = $('#toc');
  const search = $('#search');
  const resultsBox = $('#search-results');
  const breadcrumbs = $('#breadcrumbs');
  const pageMeta = $('#page-path');
  const sidebar = $('#sidebar');
  const menuButton = $('#mobile-menu');

  // Índice generado por scripts/build_index.py.
  let site = { title: 'The Void', pages: [] };
  const byId = new Map();
  const children = new Map();
  const lookup = new Map();

  let current = null;
  let renderToken = 0;
  let searchText = null;
  let searchLoading = null;
  let activeResult = -1;
  let tocObserver = null;

  // ---------------------------------------------------------------- utilidades

  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');

  const slug = (value) =>
    normalize(value)
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-');

  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);

  const href = (id, heading = '') =>
    '#/' + id.split('/').map(encodeURIComponent).join('/') +
    (heading ? '#' + encodeURIComponent(heading) : '');

  function el(tag, attrs = {}, ...content) {
    const node = document.createElement(tag);

    Object.entries(attrs).forEach(([key, value]) => {
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    });

    node.append(...content.flat().filter(Boolean));
    return node;
  }

  const isFolder = (page) => page.kind !== 'note';

  function sortPages(list) {
    return list.slice().sort((a, b) => {
      const orderA = a.order ?? Infinity;
      const orderB = b.order ?? Infinity;
      return (orderA === orderB ? 0 : orderA < orderB ? -1 : 1) || a.title.localeCompare(b.title);
    });
  }

  function ancestors(page) {
    const chain = [];
    let cursor = page && page.parent !== null ? byId.get(page.parent) : null;

    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parent !== null ? byId.get(cursor.parent) : null;
    }

    return chain;
  }

  // Ruta legible sin "Home": "Study / Game Theory".
  const trailText = (page) =>
    ancestors(page).filter((p) => p.kind !== 'home').map((p) => p.title).join(' / ');

  const sectionOf = (page) =>
    page.kind === 'section' ? page : ancestors(page).find((p) => p.kind === 'section');

  // Notas contenidas en una carpeta, contando subcarpetas.
  function countNotes(page) {
    return (children.get(page.id) || []).reduce(
      (total, child) => total + (isFolder(child) ? countNotes(child) : 1),
      0
    );
  }

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function resolve(target) {
    const raw = String(target || '').trim().replace(/^\/+|\/+$/g, '');
    if (byId.has(raw)) return byId.get(raw);
    return byId.get(lookup.get(raw.toLowerCase()) ?? lookup.get(slug(raw)));
  }

  function indexPages(pages) {
    byId.clear();
    children.clear();
    lookup.clear();

    pages.forEach((page) => byId.set(page.id, page));

    pages.forEach((page) => {
      if (page.parent !== null && byId.has(page.parent)) {
        if (!children.has(page.parent)) children.set(page.parent, []);
        children.get(page.parent).push(page);
      }

      if (!lookup.has(page.id.toLowerCase())) lookup.set(page.id.toLowerCase(), page.id);

      [page.title, ...(page.aliases || [])].forEach((key) => {
        const k = slug(key);
        if (k && !lookup.has(k)) lookup.set(k, page.id);
      });
    });

    children.forEach((list, id) => children.set(id, sortPages(list)));
  }

  // ------------------------------------------------------------------ rutas

  // #/study/game-theory/nash#seccion  ->  página + encabezado
  function parseHash() {
    let path = location.hash.slice(1);
    let heading = '';

    if (path.startsWith('/')) path = path.slice(1);

    const split = path.indexOf('#');
    if (split >= 0) {
      heading = path.slice(split + 1);
      path = path.slice(0, split);
    }

    try {
      path = decodeURIComponent(path);
      heading = decodeURIComponent(heading);
    } catch {
      // Hash mal formado: se usa tal cual.
    }

    // También admite direcciones antiguas como #inicio o #game-theory.
    return { page: path === '' ? byId.get('') : resolve(path), heading };
  }

  function route() {
    const { page, heading } = parseHash();

    if (!page) {
      renderMissing();
      return;
    }

    if (current && page.id === current.id) {
      if (heading) scrollToHeading(heading);
      return;
    }

    render(page, heading);
  }

  // -------------------------------------------------------------- navegación

  function buildNavigation() {
    if (!nav) return;

    const activeSection = current ? sectionOf(current) : null;
    const path = new Set(current ? [...ancestors(current), current].map((p) => p.id) : []);

    const home = byId.get('');
    const sections = (children.get('') || []).filter(isFolder);
    const list = el('ul', { class: 'nav-list' });

    if (home) list.append(navItem(home, current?.id === '', false));

    sections.forEach((section) => {
      const isActive = section === activeSection;
      const item = navItem(section, isActive && current.id === section.id, isActive);

      // Solo se despliega la rama activa: sección -> campos -> subcampos.
      if (isActive) {
        const tree = fieldTree(section, path);
        if (tree) item.append(tree);
      }

      list.append(item);
    });

    nav.replaceChildren(list);
  }

  function navItem(page, isCurrent, inPath) {
    return el(
      'li',
      {},
      el('a', {
        class: 'nav-link' + (isCurrent ? ' active' : '') + (inPath ? ' in-path' : ''),
        href: href(page.id),
        'aria-current': isCurrent ? 'page' : null,
        text: page.title
      })
    );
  }

  function fieldTree(parent, path) {
    const fields = (children.get(parent.id) || []).filter(isFolder);
    if (!fields.length) return null;

    const list = el('ul', { class: 'nav-tree' });

    fields.forEach((field) => {
      const isCurrent = current?.id === field.id;
      const inPath = path.has(field.id);

      const item = el(
        'li',
        {},
        el(
          'a',
          {
            class: 'nav-field' + (isCurrent ? ' active' : '') + (inPath ? ' in-path' : ''),
            href: href(field.id),
            'aria-current': isCurrent ? 'page' : null
          },
          el('span', { text: field.title }),
          el('span', { class: 'nav-count', text: String(countNotes(field)) })
        )
      );

      if (inPath) {
        const sub = fieldTree(field, path);
        if (sub) item.append(sub);
      }

      list.append(item);
    });

    return list;
  }

  function renderBreadcrumbs(page) {
    if (!breadcrumbs) return;

    const trail = [...ancestors(page), page];
    const parts = [];

    trail.forEach((item, index) => {
      if (index > 0) parts.push(el('span', { 'aria-hidden': 'true', text: '/' }));

      parts.push(
        index === trail.length - 1
          ? el('span', { 'aria-current': 'page', text: item.title })
          : el('a', { href: href(item.id), text: item.title })
      );
    });

    breadcrumbs.replaceChildren(...parts);
  }

  function renderMeta(page) {
    if (!pageMeta) return;

    const bits = [];

    if (page.kind === 'note') {
      if (page.status) bits.push(page.status === 'empty' ? 'not written yet' : page.status);
      if (page.words) bits.push(page.words.toLocaleString('en') + ' words');
      if (page.updated) bits.push('updated ' + page.updated);
    } else if (page.kind !== 'home') {
      bits.push(plural(countNotes(page), 'note'));
    }

    pageMeta.replaceChildren(
      page.description ? el('span', { class: 'meta-description', text: page.description }) : '',
      bits.length ? el('span', { class: 'meta-details', text: bits.join(' · ') }) : ''
    );
  }

  // ------------------------------------------------------------- contenido

  function stripFrontMatter(markdown) {
    return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(\n|$)/, '');
  }

  // [texto](wiki:nota) -> enlace interno, antes de pasar por marked.
  function rewriteWikiHrefs(markdown) {
    return markdown.replace(/\]\(wiki:([^)#\s]+)(?:#([^)\s]*))?\)/g, (match, target, heading) => {
      const page = resolve(target);
      return page ? '](' + href(page.id, heading || '') + ')' : '](#/missing)';
    });
  }

  // [[nota]], [[nota|texto]] y [[nota#sección]], fuera de bloques de código.
  function rewriteWikiLinks(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest('code, pre, a')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.includes('[[') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      const source = node.nodeValue;
      const pattern = /\[\[([^\]]+)\]\]/g;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;

      while ((match = pattern.exec(source)) !== null) {
        fragment.append(source.slice(lastIndex, match.index));

        const [target, label] = match[1].split('|');
        const [pageTarget, heading = ''] = target.split('#');
        const page = resolve(pageTarget);
        const text = (label || pageTarget).trim();

        fragment.append(
          page
            ? el('a', { class: 'wiki-link', href: href(page.id, slug(heading)), title: page.title, text })
            : el('span', { class: 'wiki-link broken', title: 'Not written yet: ' + pageTarget.trim(), text })
        );

        lastIndex = pattern.lastIndex;
      }

      fragment.append(source.slice(lastIndex));
      node.replaceWith(fragment);
    });
  }

  function listing(title, pages, describe) {
    if (!pages.length) return '';

    return el(
      'section',
      { class: 'listing' },
      el('h2', { text: title }),
      el(
        'ul',
        {},
        pages.map((page) =>
          el(
            'li',
            { class: page.status === 'empty' && page.kind === 'note' ? 'is-empty' : null },
            el('a', { href: href(page.id), text: page.title }),
            el('span', { class: 'listing-detail', text: describe(page) })
          )
        )
      )
    );
  }

  const describeFolder = (p) =>
    [p.description, plural(countNotes(p), 'note')].filter(Boolean).join(' · ');

  const describeNote = (p) =>
    p.status === 'empty' ? 'not written yet' : p.description || '';

  // Índice automático de una carpeta: subcampos y notas.
  function folderOverview(page) {
    const items = children.get(page.id) || [];
    const fields = items.filter(isFolder);
    const notes = items.filter((p) => !isFolder(p));
    const fragment = document.createDocumentFragment();

    if (page.kind === 'home') {
      const recent = site.pages
        .filter((p) => p.kind === 'note' && p.status !== 'empty' && p.updated)
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, 5);

      fragment.append(
        listing('Sections', fields, describeFolder),
        listing('Recently updated', recent, (p) => [trailText(p), p.updated].filter(Boolean).join(' · '))
      );

      return fragment;
    }

    fragment.append(
      listing(page.kind === 'section' ? 'Fields' : 'Subfields', fields, describeFolder),
      listing('Notes', notes, describeNote)
    );

    return fragment;
  }

  // Pie de cada nota: etiquetas, referencias inversas y anterior/siguiente.
  function connections(page) {
    const siblings = (children.get(page.parent) || []).filter((p) => !isFolder(p));
    const index = siblings.findIndex((p) => p.id === page.id);
    const prev = siblings[index - 1];
    const next = siblings[index + 1];
    const parent = byId.get(page.parent);

    const backlinks = sortPages((page.backlinks || []).map((id) => byId.get(id)).filter(Boolean));
    const block = el('footer', { class: 'connections' });

    if (page.tags?.length) {
      block.append(
        el(
          'div',
          { class: 'tags' },
          page.tags.map((tag) =>
            el('button', { type: 'button', class: 'tag', 'data-tag': tag, text: '#' + tag })
          )
        )
      );
    }

    if (backlinks.length) {
      block.append(
        el('h2', { text: 'Referenced by' }),
        el(
          'ul',
          { class: 'backlinks' },
          backlinks.map((p) =>
            el(
              'li',
              {},
              el('a', { href: href(p.id), text: p.title }),
              el('span', { class: 'listing-detail', text: trailText(p) })
            )
          )
        )
      );
    }

    if (prev || next) {
      block.append(
        el(
          'nav',
          { class: 'pager', 'aria-label': 'More in ' + (parent?.title || 'this field') },
          prev
            ? el('a', { class: 'pager-prev', href: href(prev.id) }, el('small', { text: '← Previous' }), el('span', { text: prev.title }))
            : el('span'),
          next
            ? el('a', { class: 'pager-next', href: href(next.id) }, el('small', { text: 'Next →' }), el('span', { text: next.title }))
            : el('span')
        )
      );
    }

    return block.childNodes.length ? block : '';
  }

  async function loadMarkdown(page) {
    if (!page.file || page.status === 'empty') return '';

    const response = await fetch(new URL(page.file, document.baseURI), { cache: 'no-cache' });

    if (!response.ok) {
      throw new Error('Could not load ' + page.file + ' (HTTP ' + response.status + ').');
    }

    return stripFrontMatter(await response.text());
  }

  async function render(page, heading = '') {
    const token = ++renderToken;
    current = page;

    buildNavigation();
    renderBreadcrumbs(page);
    renderMeta(page);
    closeMenu();
    closeSearch();

    document.title = page.kind === 'home' ? site.title : page.title + ' — ' + site.title;

    try {
      const markdown = await loadMarkdown(page);
      if (token !== renderToken) return;

      if (!window.marked || !window.DOMPurify) {
        throw new Error('The Markdown libraries failed to load. Check your connection.');
      }

      const content = el('div');
      content.innerHTML = window.DOMPurify.sanitize(
        window.marked.parse(rewriteWikiHrefs(markdown), { gfm: true, breaks: false })
      );

      rewriteWikiLinks(content);

      if (page.kind !== 'home' && !content.querySelector('h1')) {
        content.prepend(el('h1', { text: page.title }));
      }

      if (page.kind === 'note' && page.status === 'empty') {
        content.append(el('p', { class: 'muted', text: 'This note hasn’t been written yet.' }));
      }

      content.append(isFolder(page) ? folderOverview(page) : connections(page));

      article.replaceChildren(...content.childNodes);
      buildToc();

      if (heading) {
        requestAnimationFrame(() => scrollToHeading(heading));
      } else {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    } catch (error) {
      if (token !== renderToken) return;

      console.error(error);
      article.replaceChildren(
        el('h1', { text: 'This page could not be opened' }),
        el('p', { text: 'Make sure the file exists and the site is served from GitHub Pages or a local server.' }),
        el('pre', { text: error.message })
      );
      buildToc();
    }
  }

  function renderMissing() {
    current = null;
    ++renderToken;

    buildNavigation();
    breadcrumbs?.replaceChildren(el('a', { href: '#/', text: 'Home' }));
    pageMeta?.replaceChildren();
    document.title = site.title;

    article.replaceChildren(
      el('h1', { text: 'Not in the archive' }),
      el('p', {}, 'There is nothing at this address yet. ', el('a', { href: '#/', text: 'Return home' }), ' or search the archive.')
    );
    buildToc();
  }

  // ---------------------------------------------------- índice de la página

  function buildToc() {
    if (!toc) return;

    tocObserver?.disconnect();

    const used = new Set();
    const headings = [...article.querySelectorAll('h2, h3')];

    // Ids estables a partir del texto, para poder enlazar a secciones.
    headings.forEach((heading) => {
      const base = slug(heading.textContent) || 'section';
      let id = base;
      for (let n = 2; used.has(id); n++) id = base + '-' + n;
      used.add(id);
      heading.id = id;
    });

    if (!headings.length) {
      toc.replaceChildren(el('span', { class: 'muted', text: 'No sections' }));
      return;
    }

    const links = headings.map((heading) =>
      el('a', {
        href: href(current?.id ?? '', heading.id),
        class: heading.tagName === 'H3' ? 'toc-h3' : null,
        'data-target': heading.id,
        text: heading.textContent
      })
    );

    toc.replaceChildren(...links);

    // Resalta la sección visible.
    if ('IntersectionObserver' in window) {
      tocObserver = new IntersectionObserver(
        (entries) => {
          const visible = entries.find((entry) => entry.isIntersecting);
          if (!visible) return;

          links.forEach((link) =>
            link.classList.toggle('active', link.dataset.target === visible.target.id)
          );
        },
        { rootMargin: '0px 0px -70% 0px' }
      );

      headings.forEach((heading) => tocObserver.observe(heading));
    }
  }

  function scrollToHeading(target) {
    const wanted = slug(target);
    const heading = [...article.querySelectorAll('h1, h2, h3, h4, h5, h6')].find(
      (h) => h.id === target || h.id === wanted || slug(h.textContent) === wanted
    );

    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --------------------------------------------------------------- búsqueda

  // El texto completo (search.json) solo se descarga al usar el buscador.
  function loadSearchText() {
    if (searchText) return Promise.resolve(searchText);

    searchLoading ||= fetch(new URL('search.json', document.baseURI), { cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}))
      .then((data) => {
        searchText = {};

        Object.entries(data).forEach(([id, text]) => {
          searchText[id] = { raw: text, norm: normalize(text) };
        });

        if (search && document.activeElement === search && search.value.trim()) {
          renderSearch(search.value);
        }

        return searchText;
      });

    return searchLoading;
  }

  function scorePage(page, terms, tagFilter) {
    if (tagFilter && !(page.tags || []).some((t) => normalize(t) === tagFilter)) return 0;

    const title = normalize(page.title);
    const tags = normalize((page.tags || []).join(' '));
    const headings = normalize((page.headings || []).join(' '));
    const description = normalize(page.description);
    const body = searchText?.[page.id]?.norm || '';

    let score = 0;

    for (const term of terms) {
      let best = 0;

      if (title.startsWith(term)) best = 100;
      else if (title.includes(term)) best = 60;
      else if (tags.includes(term)) best = 40;
      else if (headings.includes(term)) best = 25;
      else if (description.includes(term)) best = 15;
      else if (body.includes(term)) best = 5;

      if (!best) return 0;
      score += best;
    }

    // Una nota escrita pesa algo más que una carpeta o una nota vacía.
    return score + 1 + (page.kind === 'note' && page.status !== 'empty' ? 1 : 0);
  }

  // Fragmento del texto alrededor de la coincidencia, con <mark>.
  function snippet(page, terms) {
    const entry = searchText?.[page.id];
    const term = terms.find((t) => entry?.norm.includes(t));

    if (!entry || !term) return esc(page.description || '');

    const at = entry.norm.indexOf(term);
    const start = Math.max(0, at - 50);
    const end = Math.min(entry.raw.length, at + term.length + 90);

    // normalize() conserva la longitud con letras acentuadas compuestas,
    // así que los índices del texto normalizado sirven para el original.
    const raw = entry.raw.slice(start, end);
    const norm = entry.norm.slice(start, end);

    let out = start > 0 ? '…' : '';
    let cursor = 0;
    let pos;

    while ((pos = norm.indexOf(term, cursor)) >= 0) {
      out += esc(raw.slice(cursor, pos)) + '<mark>' + esc(raw.slice(pos, pos + term.length)) + '</mark>';
      cursor = pos + term.length;
    }

    return out + esc(raw.slice(cursor)) + (end < entry.raw.length ? '…' : '');
  }

  function renderSearch(query) {
    if (!resultsBox) return;

    const trimmed = query.trim();

    if (!trimmed) {
      closeSearch();
      return;
    }

    loadSearchText();

    const words = normalize(trimmed).split(/\s+/);
    const tagFilter = words[0].startsWith('#') ? words.shift().slice(1) : '';
    const terms = words.filter(Boolean);

    const results = site.pages
      .map((page) => ({ page, score: scorePage(page, terms, tagFilter) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
      .slice(0, 8);

    activeResult = results.length ? 0 : -1;

    if (!results.length) {
      resultsBox.replaceChildren(el('p', { class: 'search-empty', text: 'Nothing found in the archive.' }));
    } else {
      resultsBox.replaceChildren(
        ...results.map(({ page }, index) => {
          const detail = el('span', { class: 'search-snippet' });
          detail.innerHTML = snippet(page, terms);

          return el(
            'a',
            { class: 'search-result' + (index === 0 ? ' active' : ''), href: href(page.id) },
            el('strong', { text: page.title }),
            el('em', { text: trailText(page) || (page.kind === 'home' ? '' : 'Archive') }),
            detail
          );
        })
      );
    }

    resultsBox.hidden = false;
    search?.setAttribute('aria-expanded', 'true');
  }

  function moveSelection(step) {
    const items = [...resultsBox.querySelectorAll('.search-result')];
    if (!items.length) return;

    activeResult = (activeResult + step + items.length) % items.length;
    items.forEach((item, i) => item.classList.toggle('active', i === activeResult));
    items[activeResult].scrollIntoView({ block: 'nearest' });
  }

  function closeSearch() {
    if (!resultsBox) return;

    resultsBox.hidden = true;
    resultsBox.replaceChildren();
    search?.setAttribute('aria-expanded', 'false');
    activeResult = -1;
  }

  function leaveSearch() {
    if (!search) return;
    search.value = '';
    search.blur();
    closeSearch();
  }

  // ----------------------------------------------------------- menú móvil

  function closeMenu() {
    sidebar?.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
  }

  // ---------------------------------------------------------------- eventos

  if (search) {
    search.setAttribute('aria-controls', 'search-results');
    search.setAttribute('aria-expanded', 'false');

    search.addEventListener('focus', loadSearchText, { once: true });
    search.addEventListener('input', () => renderSearch(search.value));

    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key === 'Enter') {
        const chosen = resultsBox?.querySelectorAll('.search-result')[activeResult];

        if (chosen) {
          event.preventDefault();
          location.hash = chosen.getAttribute('href');
          leaveSearch();
        }
      }
    });
  }

  resultsBox?.addEventListener('click', (event) => {
    if (event.target.closest('.search-result')) leaveSearch();
  });

  // Etiquetas: buscan todas las notas con la misma etiqueta.
  article?.addEventListener('click', (event) => {
    const tag = event.target.closest('.tag');
    if (!tag || !search) return;

    search.value = '#' + tag.dataset.tag;
    search.focus();
    renderSearch(search.value);
  });

  document.addEventListener('click', (event) => {
    if (resultsBox && search && !resultsBox.contains(event.target) && !search.contains(event.target)) {
      resultsBox.hidden = true;
    }
  });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

    if (event.key === '/' && !typing) {
      event.preventDefault();
      search?.focus();
    }

    if (event.key === 'Escape') {
      leaveSearch();
      closeMenu();
    }
  });

  menuButton?.addEventListener('click', () => {
    const open = sidebar?.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(Boolean(open)));
  });

  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- frase del día

  // Una frase por sesión del navegador, sin repetir la de la sesión anterior.
  async function showQuote() {
    const box = $('#sidebar-quote');
    if (!box) return;

    try {
      const response = await fetch(new URL('quotes.json', document.baseURI), { cache: 'no-cache' });
      const quotes = (await response.json()).filter((quote) => quote?.text);
      if (!quotes.length) return;

      const read = (store, key) => {
        try { return store.getItem(key); } catch { return null; }
      };
      const write = (store, key, value) => {
        try { store.setItem(key, value); } catch { /* almacenamiento bloqueado */ }
      };

      let index = Number.parseInt(read(sessionStorage, 'void.quote'), 10);

      if (!(index >= 0 && index < quotes.length)) {
        const last = Number.parseInt(read(localStorage, 'void.lastQuote'), 10);
        index = Math.floor(Math.random() * quotes.length);
        if (quotes.length > 1 && index === last) index = (index + 1) % quotes.length;

        write(sessionStorage, 'void.quote', index);
        write(localStorage, 'void.lastQuote', index);
      }

      const { text, author } = quotes[index];
      box.querySelector('blockquote').textContent = text;
      box.querySelector('figcaption').textContent = author || '';
      box.querySelector('figcaption').hidden = !author;
      box.hidden = false;
    } catch (error) {
      console.warn('quotes.json could not be loaded.', error);
    }
  }

  // ---------------------------------------------------------------- inicio

  async function init() {
    try {
      const response = await fetch(new URL('wiki.json', document.baseURI), { cache: 'no-cache' });

      if (!response.ok) {
        throw new Error('wiki.json not found (HTTP ' + response.status + ').');
      }

      site = await response.json();

      if (!Array.isArray(site.pages) || !site.pages.length) {
        throw new Error('wiki.json has no pages. Run: python3 scripts/build_index.py');
      }

      indexPages(site.pages);
      route();
    } catch (error) {
      console.error(error);

      article.replaceChildren(
        el('h1', { text: 'The archive could not be opened' }),
        el('p', { text: 'Make sure wiki.json exists (python3 scripts/build_index.py) and the site is served from GitHub Pages or a local server.' }),
        el('pre', { text: error.message })
      );
    }
  }

  showQuote();
  init();
})();
