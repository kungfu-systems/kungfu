// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { createHash } = require('node:crypto');

const EXPERIENCE_CONTRACT = 'kungfu.site-experience/v1';
const CONFIG_CONTRACT = 'kungfu.site-experience-config/v1';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Kungfu site experience requires ${label}`);
  }
}

function assertKnownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Kungfu site experience requires ${label}`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(
      `Kungfu site experience ${label} has unknown fields: ${unknown.join(', ')}`,
    );
  }
}

function assertRoute(value, label, page = false) {
  assertString(value, label);
  const pattern = page
    ? /^\/(?:[a-zA-Z0-9._-]+\/)*$/
    : /^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/;
  if (!pattern.test(value)) {
    throw new Error(`Kungfu site experience has invalid ${label}: ${value}`);
  }
}

function absoluteUrl(base, route) {
  return new URL(route, `${base.replace(/\/+$/u, '')}/`).href;
}

function assertNavigationHref(value) {
  if (value.startsWith('/') && !value.startsWith('//')) return;
  let resolved;
  try {
    resolved = new URL(value);
  } catch {
    resolved = null;
  }
  if (!resolved || !['http:', 'https:'].includes(resolved.protocol)) {
    throw new Error(
      `Kungfu site experience external navigation must be HTTP(S): ${value}`,
    );
  }
}

function assertUnique(items, field, label) {
  const values = items.map((item) => item[field]);
  if (new Set(values).size !== values.length) {
    throw new Error(`Kungfu site experience ${label} has duplicate ${field}`);
  }
}

function validateSection(section, pageId, tier) {
  assertKnownKeys(
    section,
    ['id', 'eyebrow', 'heading', 'body', 'items'],
    `${pageId} ${tier} section`,
  );
  assertString(section?.id, `${pageId} ${tier} section id`);
  assertString(section?.heading, `${pageId} ${tier} section heading`);
  if (!section.body && !section.items?.length) {
    throw new Error(
      `Kungfu site experience ${pageId} ${tier} section ${section.id} has no body or items`,
    );
  }
  for (const item of section.items || []) {
    assertKnownKeys(
      item,
      ['heading', 'body', 'href', 'actionLabel'],
      `${pageId} ${section.id} item`,
    );
    assertString(item.heading, `${pageId} ${section.id} item heading`);
    assertString(item.body, `${pageId} ${section.id} item body`);
    if (item.href) {
      assertString(item.href, `${pageId} ${section.id} item href`);
      assertNavigationHref(item.href);
    }
    if (item.actionLabel) {
      assertString(
        item.actionLabel,
        `${pageId} ${section.id} item actionLabel`,
      );
    }
  }
}

function validateDocument(document) {
  assertKnownKeys(
    document,
    [
      'id',
      'label',
      'route',
      'summary',
      'body',
      'claimClass',
      'maturity',
      'format',
      'authorityPath',
      'source',
      'topicIds',
      'navigation',
      'linkMap',
    ],
    'document',
  );
  assertString(document.id, 'document.id');
  if (!/^[a-z0-9-]+$/u.test(document.id)) {
    throw new Error(`Invalid Kungfu site document id: ${document.id}`);
  }
  for (const field of ['label', 'summary', 'body', 'claimClass', 'maturity']) {
    assertString(document[field], `${document.id}.${field}`);
  }
  if (
    document.format &&
    !['markdown', 'json', 'code'].includes(document.format)
  ) {
    throw new Error(`Kungfu site experience ${document.id} has invalid format`);
  }
  if (document.authorityPath) {
    assertString(document.authorityPath, `${document.id}.authorityPath`);
  }
  for (const topicId of document.topicIds || []) {
    assertString(topicId, `${document.id}.topicIds entry`);
    if (!/^[a-z0-9-]+$/u.test(topicId)) {
      throw new Error(
        `Kungfu site experience ${document.id} has invalid topic id: ${topicId}`,
      );
    }
  }
  if (
    new Set(document.topicIds || []).size !== (document.topicIds || []).length
  ) {
    throw new Error(
      `Kungfu site experience ${document.id} has duplicate topic ids`,
    );
  }
  assertRoute(document.route, `${document.id}.route`, true);
  assertKnownKeys(
    document.source,
    ['route', 'contentRoot', 'byteLength'],
    `${document.id}.source`,
  );
  assertRoute(document.source.route, `${document.id}.source.route`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(document.source.contentRoot)) {
    throw new Error(
      `Kungfu site experience ${document.id} source has invalid contentRoot`,
    );
  }
  if (
    !Number.isSafeInteger(document.source.byteLength) ||
    document.source.byteLength < 1
  ) {
    throw new Error(
      `Kungfu site experience ${document.id} source has invalid byteLength`,
    );
  }
  if (
    sha256(document.body) !== document.source.contentRoot ||
    Buffer.byteLength(document.body) !== document.source.byteLength
  ) {
    throw new Error(
      `Kungfu site experience ${document.id} source body drifted`,
    );
  }
  if (document.navigation) {
    assertKnownKeys(
      document.navigation,
      ['previous', 'next', 'related'],
      `${document.id}.navigation`,
    );
    for (const entry of [
      document.navigation.previous,
      document.navigation.next,
      ...(document.navigation.related || []),
    ].filter(Boolean)) {
      assertKnownKeys(
        entry,
        ['label', 'href'],
        `${document.id}.navigation entry`,
      );
      assertString(entry.label, `${document.id}.navigation label`);
      assertString(entry.href, `${document.id}.navigation href`);
      assertNavigationHref(entry.href);
    }
  }
  if (document.linkMap) {
    if (
      typeof document.linkMap !== 'object' ||
      Array.isArray(document.linkMap)
    ) {
      throw new Error(
        `Kungfu site experience ${document.id}.linkMap must be an object`,
      );
    }
    for (const [source, target] of Object.entries(document.linkMap)) {
      assertString(source, `${document.id}.linkMap source`);
      assertString(target, `${document.id}.linkMap target`);
      assertNavigationHref(target);
    }
  }
}

function validateConfiguration(config) {
  assertKnownKeys(
    config,
    ['contract', 'site', 'navigation', 'machineRoutes', 'content'],
    'configuration',
  );
  if (config?.contract !== CONFIG_CONTRACT) {
    throw new Error('Unexpected Kungfu site experience config contract');
  }
  assertKnownKeys(
    config.site,
    ['id', 'context', 'canonicalBaseUrl', 'language'],
    'site',
  );
  assertString(config.site?.id, 'site.id');
  if (!/^[a-z0-9-]+$/u.test(config.site.id)) {
    throw new Error(`Invalid Kungfu site experience id: ${config.site.id}`);
  }
  assertString(config.site?.context, 'site.context');
  assertString(config.site?.canonicalBaseUrl, 'site.canonicalBaseUrl');
  const canonicalBase = new URL(config.site.canonicalBaseUrl);
  if (!['http:', 'https:'].includes(canonicalBase.protocol)) {
    throw new Error('Kungfu site experience canonicalBaseUrl must be HTTP(S)');
  }
  if (config.navigation) {
    assertKnownKeys(config.navigation, ['primary', 'external'], 'navigation');
    for (const id of config.navigation.primary || []) {
      assertString(id, 'navigation.primary entry');
      if (!/^[a-z0-9-]+$/u.test(id)) {
        throw new Error(`Invalid Kungfu site navigation id: ${id}`);
      }
    }
    for (const entry of config.navigation.external || []) {
      assertKnownKeys(entry, ['label', 'href'], 'external navigation entry');
    }
  }
  if (config.machineRoutes) {
    assertKnownKeys(
      config.machineRoutes,
      ['manifest', 'agentIndex', 'llms'],
      'machineRoutes',
    );
  }
  assertKnownKeys(config.content, ['pages', 'documents'], 'content');
  if (!config.content?.pages?.length) {
    throw new Error('Kungfu site experience requires at least one page');
  }
  assertUnique(config.content.pages, 'id', 'pages');
  assertUnique(config.content.pages, 'route', 'pages');
  assertUnique(config.content.documents || [], 'id', 'documents');
  assertUnique(config.content.documents || [], 'route', 'documents');
  for (const page of config.content.pages) {
    assertKnownKeys(
      page,
      [
        'id',
        'label',
        'route',
        'kicker',
        'headline',
        'summary',
        'claimClass',
        'maturity',
        'knownLimits',
        'humanSections',
        'technicalSections',
        'technicalSummary',
        'authorities',
      ],
      'page',
    );
    assertString(page.id, 'page.id');
    if (!/^[a-z0-9-]+$/u.test(page.id)) {
      throw new Error(`Invalid Kungfu site page id: ${page.id}`);
    }
    assertString(page.label, `${page.id}.label`);
    assertRoute(page.route, `${page.id}.route`, true);
    for (const field of ['headline', 'summary', 'claimClass', 'maturity']) {
      assertString(page[field], `${page.id}.${field}`);
    }
    if (!page.knownLimits?.length) {
      throw new Error(`Kungfu site experience ${page.id} has no known limits`);
    }
    for (const limit of page.knownLimits) {
      assertString(limit, `${page.id}.knownLimits entry`);
    }
    if (!page.humanSections?.length || !page.technicalSections?.length) {
      throw new Error(
        `Kungfu site experience ${page.id} must keep human and technical layers`,
      );
    }
    for (const section of page.humanSections) {
      validateSection(section, page.id, 'human');
    }
    for (const section of page.technicalSections) {
      validateSection(section, page.id, 'technical');
    }
    for (const authority of page.authorities || []) {
      assertKnownKeys(
        authority,
        [
          'id',
          'path',
          'packagePath',
          'role',
          'contentRoot',
          'byteLength',
          'url',
        ],
        `${page.id} authority`,
      );
      for (const field of [
        'id',
        'path',
        'packagePath',
        'role',
        'contentRoot',
        'url',
      ]) {
        assertString(authority[field], `${page.id} authority ${field}`);
      }
      if (
        !Number.isSafeInteger(authority.byteLength) ||
        authority.byteLength < 1
      ) {
        throw new Error(
          `Kungfu site experience ${page.id} authority has invalid byteLength`,
        );
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(authority.contentRoot)) {
        throw new Error(
          `Kungfu site experience ${page.id} authority has invalid contentRoot`,
        );
      }
    }
  }
  for (const document of config.content.documents || []) {
    validateDocument(document);
    for (const topicId of document.topicIds || []) {
      if (!config.content.pages.some((page) => page.id === topicId)) {
        throw new Error(
          `Kungfu site experience ${document.id} references unknown topic: ${topicId}`,
        );
      }
    }
  }
  const allRoutes = [
    ...config.content.pages.map((page) => page.route),
    ...(config.content.documents || []).map((document) => document.route),
  ];
  if (new Set(allRoutes).size !== allRoutes.length) {
    throw new Error('Kungfu site experience pages and documents share a route');
  }
}

function renderSection(section) {
  const items = (section.items || [])
    .map(
      (item) => `<article class="kungfu-reader-item">
        <h3>${item.href ? `<a href="${escapeAttribute(item.href)}">${escapeHtml(item.heading)}</a>` : escapeHtml(item.heading)}</h3>
        <p>${escapeHtml(item.body)}</p>
        ${item.href ? `<a class="kungfu-reader-action" href="${escapeAttribute(item.href)}">${escapeHtml(item.actionLabel || 'Open document')} →</a>` : ''}
      </article>`,
    )
    .join('');
  return `<section class="kungfu-reader-section" id="${escapeAttribute(section.id)}">
    ${section.eyebrow ? `<p class="kungfu-eyebrow">${escapeHtml(section.eyebrow)}</p>` : ''}
    <h2>${escapeHtml(section.heading)}</h2>
    ${section.body ? `<p>${escapeHtml(section.body)}</p>` : ''}
    ${items ? `<div class="kungfu-reader-grid">${items}</div>` : ''}
  </section>`;
}

const STYLE = `
  :root{color-scheme:light;--kf-bg:#f7f6f2;--kf-panel:#fff;--kf-fg:#171717;--kf-muted:#5f6065;--kf-line:#d9d6cc;--kf-accent:#6f48c6;--kf-soft:#f0ebfb;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}body{margin:0;background:var(--kf-bg);color:var(--kf-fg);line-height:1.6}a{color:inherit}.kungfu-shell{width:min(1120px,calc(100% - 32px));margin:auto}.kungfu-wide-shell{width:min(1400px,calc(100% - 32px));margin:auto}.kungfu-header{border-bottom:1px solid var(--kf-line);background:rgba(247,246,242,.96)}.kungfu-bar{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:72px}.kungfu-brand{display:inline-flex;min-width:0;flex-wrap:wrap;align-items:baseline;gap:8px;font-weight:750;text-decoration:none}.kungfu-brand>span:first-child{flex:0 0 auto}.kungfu-brand-context{min-width:0;color:var(--kf-muted);font-size:13px;font-weight:500}.kungfu-brand-context:before{content:"·";margin-right:8px;color:var(--kf-line)}.kungfu-nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:14px}.kungfu-nav a{min-height:38px;display:inline-flex;align-items:center;text-decoration:none}.kungfu-nav a[aria-current="page"],.kungfu-nav a:hover{text-decoration:underline;text-underline-offset:5px}.kungfu-page-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:48px;align-items:start}.kungfu-main{min-width:0;display:grid;gap:32px;padding:64px 0 80px}.kungfu-sidebar-desktop{position:sticky;top:24px;max-height:calc(100vh - 48px);overflow:auto;padding:64px 0 40px}.kungfu-sidebar-mobile{display:none}.kungfu-sidebar-panel{display:grid;gap:24px;padding:20px;border:1px solid var(--kf-line);background:var(--kf-panel)}.kungfu-sidebar-group{display:grid;gap:8px}.kungfu-sidebar-title{margin:0;color:var(--kf-muted);font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.kungfu-topic-tree{display:grid;gap:3px}.kungfu-topic-node{border-left:3px solid transparent}.kungfu-topic-node[data-current-topic="true"]{border-left-color:var(--kf-accent)}.kungfu-topic-node>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px 10px;color:var(--kf-muted);font-size:14px;font-weight:650;line-height:1.35;cursor:pointer;list-style:none}.kungfu-topic-node>summary::-webkit-details-marker{display:none}.kungfu-topic-node>summary:after{content:"+";color:var(--kf-accent);font-size:16px}.kungfu-topic-node[open]>summary:after{content:"−"}.kungfu-topic-node>summary:hover{background:var(--kf-bg);color:var(--kf-fg)}.kungfu-topic-node[data-current-topic="true"]>summary{background:var(--kf-soft);color:var(--kf-fg);font-weight:750}.kungfu-topic-children{display:grid;gap:2px;margin:2px 0 8px 13px;padding-left:12px;border-left:1px solid var(--kf-line)}.kungfu-topic-children a{display:block;padding:6px 8px;color:var(--kf-muted);font-size:13px;line-height:1.35;text-decoration:none;overflow-wrap:anywhere}.kungfu-topic-children a:hover{background:var(--kf-bg);color:var(--kf-fg)}.kungfu-topic-children a[aria-current="page"]{background:var(--kf-soft);color:var(--kf-fg);font-weight:750}.kungfu-sidebar-links{display:grid;gap:3px}.kungfu-sidebar-links a{display:block;padding:8px 10px;border-left:3px solid transparent;color:var(--kf-muted);font-size:14px;line-height:1.35;text-decoration:none}.kungfu-sidebar-links a:hover{color:var(--kf-fg);background:var(--kf-bg)}.kungfu-sidebar-links a[aria-current="page"]{border-left-color:var(--kf-accent);background:var(--kf-soft);color:var(--kf-fg);font-weight:750}.kungfu-sidebar-links-secondary a{padding-top:6px;padding-bottom:6px;font-size:13px}.kungfu-sidebar-mobile>summary{display:grid;gap:2px;padding:16px 18px;border:1px solid var(--kf-line);background:var(--kf-panel);cursor:pointer;list-style:none}.kungfu-sidebar-mobile>summary::-webkit-details-marker{display:none}.kungfu-sidebar-mobile>summary span{color:var(--kf-accent);font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.kungfu-sidebar-mobile>summary strong:after{content:"+";float:right;color:var(--kf-accent);font-size:20px}.kungfu-sidebar-mobile[open]>summary strong:after{content:"−"}.kungfu-sidebar-mobile .kungfu-sidebar-panel{border-top:0}.kungfu-hero{display:grid;gap:12px;max-width:900px}.kungfu-eyebrow{margin:0;color:var(--kf-accent);font:700 12px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.08em}.kungfu-hero h1{max-width:20ch;margin:0;font-size:clamp(38px,7vw,72px);line-height:1.02;letter-spacing:-.04em}.kungfu-lead{max-width:70ch;margin:0;color:var(--kf-muted);font-size:clamp(18px,2.2vw,23px)}.kungfu-reader-cue,.kungfu-reader-section,.kungfu-limits,.kungfu-technical,.kungfu-document,.kungfu-doc-nav{padding:24px;border:1px solid var(--kf-line);background:var(--kf-panel)}.kungfu-reader-cue{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;border-left:5px solid var(--kf-accent)}.kungfu-reader-cue p,.kungfu-reader-section>p{margin:6px 0 0}.kungfu-reader-cue a{font-weight:750;color:var(--kf-accent)}.kungfu-reader-section{display:grid;gap:12px}.kungfu-reader-section h2,.kungfu-limits h2{margin:0;max-width:30ch;font-size:clamp(25px,4vw,40px);line-height:1.08}.kungfu-reader-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:8px}.kungfu-reader-item{min-width:0;padding:18px;background:var(--kf-soft)}.kungfu-reader-item h3,.kungfu-reader-item p{margin:0;overflow-wrap:anywhere}.kungfu-reader-item h3 a{text-decoration-thickness:1px;text-underline-offset:4px}.kungfu-reader-item p{margin-top:6px;color:var(--kf-muted)}.kungfu-reader-action{display:inline-block;margin-top:14px;color:var(--kf-accent);font-weight:750}.kungfu-limits{border-left:5px solid #bb6b27}.kungfu-limits ul{margin-bottom:0}.kungfu-technical>summary{display:grid;gap:8px;cursor:pointer;list-style:none}.kungfu-technical>summary::-webkit-details-marker{display:none}.kungfu-technical>summary strong{font-size:20px}.kungfu-technical>summary:after{content:attr(data-open-label);width:fit-content;color:var(--kf-accent);font-weight:750;border-bottom:1px solid currentColor}.kungfu-technical[open]>summary:after{content:attr(data-close-label)}.kungfu-technical-body{display:grid;gap:20px;margin-top:24px;padding-top:24px;border-top:1px solid var(--kf-line)}.kungfu-technical:not([open])>.kungfu-technical-body{display:none}.kungfu-technical .kungfu-reader-section{padding:0;border:0}.kungfu-document{min-width:0;padding:clamp(24px,5vw,56px)}.kungfu-document>*:first-child{margin-top:0}.kungfu-document>*:last-child{margin-bottom:0}.kungfu-document h1{display:none}.kungfu-document h2{margin:2.4em 0 .55em;font-size:clamp(25px,4vw,38px);line-height:1.14}.kungfu-document h3{margin:2em 0 .4em;font-size:22px;line-height:1.2}.kungfu-document p,.kungfu-document li{max-width:76ch}.kungfu-document blockquote{margin:24px 0;padding:14px 18px;border-left:5px solid #bb6b27;background:#fff7ec}.kungfu-document pre{max-width:100%;overflow:auto;padding:18px;background:#202124;color:#f6f6f6;border-radius:4px}.kungfu-document code{font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.kungfu-document :not(pre)>code{padding:2px 5px;background:var(--kf-soft);color:#3d276d}.kungfu-document table{display:block;width:100%;overflow-x:auto;border-collapse:collapse}.kungfu-document th,.kungfu-document td{min-width:140px;padding:10px 12px;border:1px solid var(--kf-line);text-align:left;vertical-align:top}.kungfu-document th{background:var(--kf-soft)}.kungfu-document a{color:var(--kf-accent);overflow-wrap:anywhere}.kungfu-doc-nav{display:grid;gap:16px}.kungfu-doc-nav-links{display:flex;flex-wrap:wrap;gap:10px 20px}.kungfu-doc-nav a{color:var(--kf-accent);font-weight:750;overflow-wrap:anywhere}.kungfu-source-detail{overflow-wrap:anywhere}.kungfu-footer{padding:32px 0;border-top:1px solid var(--kf-line);color:var(--kf-muted);font-size:14px}.kungfu-footer p{margin:4px 0}@media(max-width:960px){.kungfu-page-layout{grid-template-columns:1fr;gap:0}.kungfu-sidebar-desktop{display:none}.kungfu-sidebar-mobile{display:block;margin-top:32px}.kungfu-main{padding-top:32px}}@media(max-width:760px){.kungfu-bar,.kungfu-reader-cue{align-items:flex-start;flex-direction:column;grid-template-columns:1fr}.kungfu-bar{padding:16px 0;gap:8px}.kungfu-brand{display:grid;gap:2px}.kungfu-brand-context:before{content:"";margin:0}.kungfu-nav{width:100%;flex-wrap:nowrap;gap:14px;overflow-x:auto;overscroll-behavior-inline:contain;padding-bottom:6px}.kungfu-nav a{flex:0 0 auto;white-space:nowrap}.kungfu-reader-grid{grid-template-columns:1fr}.kungfu-document{padding:22px 18px}}
`;

function renderSidebarPanel({
  shared,
  activeTopicId,
  currentRoute,
  localLinks,
}) {
  const topicTree = shared.navigation.tree
    .map(
      (
        topic,
      ) => `<details class="kungfu-topic-node"${topic.id === activeTopicId ? ' open data-current-topic="true"' : ''}>
        <summary>${escapeHtml(topic.label)}</summary>
        <div class="kungfu-topic-children">${topic.children
          .map(
            (child) =>
              `<a href="${escapeAttribute(child.href)}"${topic.id === activeTopicId && child.route === currentRoute ? ' aria-current="page"' : ''}>${escapeHtml(child.label)}</a>`,
          )
          .join('')}</div>
      </details>`,
    )
    .join('');
  const local =
    localLinks?.length > 0
      ? `<section class="kungfu-sidebar-group">
          <p class="kungfu-sidebar-title">On this page</p>
          <nav class="kungfu-sidebar-links kungfu-sidebar-links-secondary" aria-label="On this page">${localLinks
            .map(
              (entry) =>
                `<a href="${escapeAttribute(entry.href)}">${escapeHtml(entry.label)}</a>`,
            )
            .join('')}</nav>
        </section>`
      : '';
  return `<div class="kungfu-sidebar-panel">
    <section class="kungfu-sidebar-group">
      <p class="kungfu-sidebar-title">Product themes</p>
      <nav class="kungfu-topic-tree" aria-label="Product themes">${topicTree}</nav>
    </section>
    ${local}
  </div>`;
}

function renderSidebar({
  shared,
  activeTopicId,
  activeLabel,
  currentRoute,
  localLinks,
}) {
  const panel = renderSidebarPanel({
    shared,
    activeTopicId,
    currentRoute,
    localLinks,
  });
  return `<aside class="kungfu-sidebar-desktop" aria-label="Topic navigation">${panel}</aside>
  <details class="kungfu-sidebar-mobile">
    <summary><span>Browse topics</span><strong>${escapeHtml(activeLabel || 'Product map')}</strong></summary>
    ${panel}
  </details>`;
}

function renderPageDocument({ page, shared }) {
  const navigation = shared.navigation.primary
    .map(
      (entry) =>
        `<a href="${escapeAttribute(entry.href)}"${entry.id === page.id ? ' aria-current="page"' : ''}>${escapeHtml(entry.label)}</a>`,
    )
    .concat(
      shared.navigation.external.map(
        (entry) =>
          `<a href="${escapeAttribute(entry.href)}">${escapeHtml(entry.label)}</a>`,
      ),
    )
    .join('');
  const humanSections = page.humanSections.map(renderSection).join('');
  const technicalSections = page.technicalSections.map(renderSection).join('');
  const limits = page.knownLimits
    .map((limit) => `<li>${escapeHtml(limit)}</li>`)
    .join('');
  const canonical = absoluteUrl(shared.site.canonicalBaseUrl, page.route);
  const title = `${page.label} | ${shared.brand.signature} — ${shared.site.context}`;
  const sidebar = renderSidebar({
    shared,
    activeTopicId: page.id,
    activeLabel: page.label,
    currentRoute: page.route,
    localLinks: [
      ...page.humanSections.map((section) => ({
        label: section.heading,
        href: `#${section.id}`,
      })),
      {
        label: 'Known limits',
        href: `#${page.id}-limits`,
      },
      {
        label: 'Technical details',
        href: '#technical-details',
      },
    ],
  });
  return `<!doctype html>
<html lang="${escapeAttribute(shared.site.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(page.summary)}">
  <meta name="application-name" content="${escapeAttribute(shared.brand.signature)}">
  <meta property="og:site_name" content="${escapeAttribute(shared.brand.signature)}">
  <meta property="og:title" content="${escapeAttribute(title)}">
  <meta property="og:description" content="${escapeAttribute(page.summary)}">
  <link rel="canonical" href="${escapeAttribute(canonical)}">
  <link rel="alternate" type="application/json" title="${escapeAttribute(shared.kfd3.standard)} machine entry" href="${escapeAttribute(shared.machineEntries.agentIndex)}">
  <link rel="alternate" type="application/json" title="Site manifest" href="${escapeAttribute(shared.machineEntries.manifest)}">
  <link rel="alternate" type="text/plain" title="Agent reading entry" href="${escapeAttribute(shared.machineEntries.llms)}">
  <style>${STYLE}</style>
</head>
<body>
  <header class="kungfu-header">
    <div class="kungfu-shell kungfu-bar">
      <a class="kungfu-brand" href="${escapeAttribute(shared.navigation.brand.href)}" aria-label="${escapeAttribute(`${shared.brand.signature} — ${shared.site.context}; home`)}"><span>${escapeHtml(shared.brand.signature)}</span><span class="kungfu-brand-context">${escapeHtml(shared.site.context)}</span></a>
      <nav class="kungfu-nav" aria-label="Primary">${navigation}</nav>
    </div>
  </header>
  <div class="kungfu-wide-shell kungfu-page-layout">
    ${sidebar}
  <main class="kungfu-main">
    <section class="kungfu-hero">
      <p class="kungfu-eyebrow">${escapeHtml(page.kicker || page.label)} · ${escapeHtml(page.claimClass)} / ${escapeHtml(page.maturity)}</p>
      <h1>${escapeHtml(page.headline)}</h1>
      <p class="kungfu-lead">${escapeHtml(page.summary)}</p>
    </section>
    <aside class="kungfu-reader-cue" aria-label="${escapeAttribute(shared.defaults.firstScreen.coReadingLabel)}">
      <div>
        <p class="kungfu-eyebrow">Human first · Agent co-reading</p>
        <strong>${escapeHtml(shared.defaults.firstScreen.coReadingLabel)}</strong>
        <p>${escapeHtml(shared.defaults.firstScreen.coReadingPrompt)}</p>
      </div>
      <a href="${escapeAttribute(shared.machineEntries.agentIndex)}">${escapeHtml(shared.kfd3.standard)} machine entry</a>
    </aside>
    ${humanSections}
    <section class="kungfu-limits" aria-labelledby="${escapeAttribute(`${page.id}-limits`)}">
      <p class="kungfu-eyebrow">Known limits</p>
      <h2 id="${escapeAttribute(`${page.id}-limits`)}">Read the boundary before acting.</h2>
      <ul>${limits}</ul>
    </section>
    <span id="technical-details"></span>
    <details class="kungfu-technical">
      <summary data-open-label="${escapeAttribute(shared.defaults.progressiveDisclosure.openLabel)}" data-close-label="${escapeAttribute(shared.defaults.progressiveDisclosure.closeLabel)}">
        <span class="kungfu-eyebrow">${escapeHtml(shared.defaults.progressiveDisclosure.technicalLabel)}</span>
        <strong>${escapeHtml(page.technicalSummary || 'Inspect exact contracts, evidence and authority roots.')}</strong>
        <span>Everything remains available without overwhelming the first reading layer.</span>
      </summary>
      <div class="kungfu-technical-body">${technicalSections}</div>
    </details>
  </main>
  </div>
  <footer class="kungfu-footer">
    <div class="kungfu-shell">
      <p>${escapeHtml(shared.brand.trademarkNotice)}</p>
      <p>${escapeHtml(shared.brand.boundary)}</p>
    </div>
  </footer>
</body>
</html>
`;
}

function safeDocumentHref(value, linkMap) {
  const mapped = linkMap?.[value] || value;
  if (
    mapped.startsWith('/') ||
    mapped.startsWith('#') ||
    /^https?:\/\//u.test(mapped)
  ) {
    return mapped;
  }
  return null;
}

function renderInlineMarkdown(value, linkMap = {}) {
  const tokens = [];
  const token = (body) => {
    const id = `\uE000${tokens.length}\uE001`;
    tokens.push(body);
    return id;
  };
  let text = String(value)
    .replace(/`([^`\n]+)`/gu, (_match, code) =>
      token(`<code>${escapeHtml(code)}</code>`),
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu,
      (_match, label, href) => {
        const safeHref = safeDocumentHref(href, linkMap);
        if (!safeHref) return label;
        return token(
          `<a href="${escapeAttribute(safeHref)}">${escapeHtml(label)}</a>`,
        );
      },
    );
  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/__([^_]+)__/gu, '<strong>$1</strong>');
  return text.replace(/\uE000(\d+)\uE001/gu, (_match, index) => tokens[index]);
}

function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u.test(line);
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

function startsMarkdownBlock(line, next) {
  return (
    !line.trim() ||
    /^#{1,6}\s+/u.test(line) ||
    /^```/u.test(line) ||
    /^>\s?/u.test(line) ||
    /^\s*[-*]\s+/u.test(line) ||
    /^\s*\d+\.\s+/u.test(line) ||
    (line.includes('|') && isTableDivider(next || ''))
  );
}

function renderFenceBlock(lines, start, fence) {
  const code = [];
  let index = start + 1;
  while (index < lines.length && !/^```\s*$/u.test(lines[index])) {
    code.push(lines[index]);
    index += 1;
  }
  if (index < lines.length) index += 1;
  const language = fence[1]
    ? ` class="language-${escapeAttribute(fence[1])}"`
    : '';
  return {
    html: `<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`,
    index,
  };
}

function renderTableBlock(lines, start, linkMap) {
  const headers = tableCells(lines[start]);
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes('|')) {
    rows.push(tableCells(lines[index]));
    index += 1;
  }
  return {
    html: `<table>
        <thead><tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell, linkMap)}</th>`).join('')}</tr></thead>
        <tbody>${rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell, linkMap)}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody>
      </table>`,
    index,
  };
}

function renderQuoteBlock(lines, start, linkMap) {
  const quote = [];
  let index = start;
  while (index < lines.length && /^>\s?/u.test(lines[index])) {
    quote.push(lines[index].replace(/^>\s?/u, ''));
    index += 1;
  }
  return {
    html: `<blockquote><p>${renderInlineMarkdown(quote.join(' '), linkMap)}</p></blockquote>`,
    index,
  };
}

function renderListBlock(lines, start, ordered, linkMap) {
  const items = [];
  const pattern = ordered ? /^\s*\d+\.\s+(.+)$/u : /^\s*[-*]\s+(.+)$/u;
  let index = start;
  while (index < lines.length) {
    const item = lines[index].match(pattern);
    if (!item) break;
    const parts = [item[1]];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !pattern.test(lines[index]) &&
      !startsMarkdownBlock(lines[index], lines[index + 1])
    ) {
      parts.push(lines[index].trim());
      index += 1;
    }
    items.push(parts.join(' '));
  }
  const tag = ordered ? 'ol' : 'ul';
  return {
    html: `<${tag}>${items.map((item) => `<li>${renderInlineMarkdown(item, linkMap)}</li>`).join('')}</${tag}>`,
    index,
  };
}

function renderParagraphBlock(lines, start, linkMap) {
  const paragraph = [lines[start].trim()];
  let index = start + 1;
  while (
    index < lines.length &&
    !startsMarkdownBlock(lines[index], lines[index + 1])
  ) {
    paragraph.push(lines[index].trim());
    index += 1;
  }
  return {
    html: `<p>${renderInlineMarkdown(paragraph.join(' '), linkMap)}</p>`,
    index,
  };
}

function renderMarkdown(body, linkMap = {}) {
  const normalized = String(body).replace(/\r\n?/gu, '\n');
  const withoutFrontmatter = normalized.startsWith('---\n')
    ? normalized.replace(/^---\n[\s\S]*?\n---\n/u, '')
    : normalized;
  const lines = withoutFrontmatter.split('\n');
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```\s*([a-zA-Z0-9_-]*)\s*$/u);
    if (fence) {
      const block = renderFenceBlock(lines, index, fence);
      html.push(block.html);
      index = block.index;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      const level = heading[1].length;
      html.push(
        `<h${level}>${renderInlineMarkdown(heading[2], linkMap)}</h${level}>`,
      );
      index += 1;
      continue;
    }
    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      const block = renderTableBlock(lines, index, linkMap);
      html.push(block.html);
      index = block.index;
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const block = renderQuoteBlock(lines, index, linkMap);
      html.push(block.html);
      index = block.index;
      continue;
    }
    const list = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/u);
    if (list) {
      const block = renderListBlock(lines, index, Boolean(list[2]), linkMap);
      html.push(block.html);
      index = block.index;
      continue;
    }
    const block = renderParagraphBlock(lines, index, linkMap);
    html.push(block.html);
    index = block.index;
  }
  return html.join('\n');
}

function renderDocumentBody(document) {
  if (document.format === 'json' || document.format === 'code') {
    const language = document.format === 'json' ? 'json' : 'text';
    return `<pre><code class="language-${language}">${escapeHtml(document.body)}</code></pre>`;
  }
  return renderMarkdown(document.body, document.linkMap);
}

function renderDocumentNavigation(navigation) {
  const entries = [
    navigation?.previous
      ? { ...navigation.previous, prefix: 'Previous' }
      : null,
    navigation?.next ? { ...navigation.next, prefix: 'Next' } : null,
    ...(navigation?.related || []).map((entry) => ({
      ...entry,
      prefix: 'Related',
    })),
  ].filter(Boolean);
  if (!entries.length) return '';
  return `<nav class="kungfu-doc-nav" aria-label="Document journey">
    <p class="kungfu-eyebrow">Continue progressively</p>
    <div class="kungfu-doc-nav-links">${entries
      .map(
        (entry) =>
          `<a href="${escapeAttribute(entry.href)}">${escapeHtml(entry.prefix)}: ${escapeHtml(entry.label)}</a>`,
      )
      .join('')}</div>
  </nav>`;
}

function renderDocumentPage({ document, shared }) {
  const navigation = shared.navigation.primary
    .map((entry) => {
      const current =
        document.route === entry.route ||
        (entry.route !== '/' && document.route.startsWith(entry.route));
      return `<a href="${escapeAttribute(entry.href)}"${current ? ' aria-current="page"' : ''}>${escapeHtml(entry.label)}</a>`;
    })
    .concat(
      shared.navigation.external.map(
        (entry) =>
          `<a href="${escapeAttribute(entry.href)}">${escapeHtml(entry.label)}</a>`,
      ),
    )
    .join('');
  const canonical = absoluteUrl(shared.site.canonicalBaseUrl, document.route);
  const title = `${document.label} | ${shared.brand.signature} — ${shared.site.context}`;
  const documentNavigation = renderDocumentNavigation(document.navigation);
  const routeTopic = shared.navigation.primary.find(
    (entry) => entry.route !== '/' && document.route.startsWith(entry.route),
  );
  const activeTopicId =
    document.topicIds?.[0] || routeTopic?.id || shared.navigation.home.id;
  const activeLabel =
    shared.navigation.tree.find((entry) => entry.id === activeTopicId)?.label ||
    'Documentation';
  const sidebar = renderSidebar({
    shared,
    activeTopicId,
    activeLabel,
    currentRoute: document.route,
    localLinks: [
      ...(document.navigation?.previous
        ? [
            {
              label: `Previous: ${document.navigation.previous.label}`,
              href: document.navigation.previous.href,
            },
          ]
        : []),
      ...(document.navigation?.next
        ? [
            {
              label: `Next: ${document.navigation.next.label}`,
              href: document.navigation.next.href,
            },
          ]
        : []),
      {
        label: 'Exact source and evidence',
        href: '#document-evidence',
      },
    ],
  });
  return `<!doctype html>
<html lang="${escapeAttribute(shared.site.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(document.summary)}">
  <meta name="application-name" content="${escapeAttribute(shared.brand.signature)}">
  <meta property="og:site_name" content="${escapeAttribute(shared.brand.signature)}">
  <meta property="og:title" content="${escapeAttribute(title)}">
  <meta property="og:description" content="${escapeAttribute(document.summary)}">
  <link rel="canonical" href="${escapeAttribute(canonical)}">
  <link rel="alternate" type="text/markdown" title="Exact source document" href="${escapeAttribute(document.source.route)}">
  <link rel="alternate" type="application/json" title="${escapeAttribute(shared.kfd3.standard)} machine entry" href="${escapeAttribute(shared.machineEntries.agentIndex)}">
  <style>${STYLE}</style>
</head>
<body>
  <header class="kungfu-header">
    <div class="kungfu-shell kungfu-bar">
      <a class="kungfu-brand" href="${escapeAttribute(shared.navigation.brand.href)}" aria-label="${escapeAttribute(`${shared.brand.signature} — ${shared.site.context}; home`)}"><span>${escapeHtml(shared.brand.signature)}</span><span class="kungfu-brand-context">${escapeHtml(shared.site.context)}</span></a>
      <nav class="kungfu-nav" aria-label="Primary">${navigation}</nav>
    </div>
  </header>
  <div class="kungfu-wide-shell kungfu-page-layout">
    ${sidebar}
  <main class="kungfu-main">
    <section class="kungfu-hero">
      <p class="kungfu-eyebrow">Documentation · ${escapeHtml(document.claimClass)} / ${escapeHtml(document.maturity)}</p>
      <h1>${escapeHtml(document.label)}</h1>
      <p class="kungfu-lead">${escapeHtml(document.summary)}</p>
    </section>
    <aside class="kungfu-reader-cue" aria-label="${escapeAttribute(shared.defaults.firstScreen.coReadingLabel)}">
      <div>
        <p class="kungfu-eyebrow">Human first · Agent co-reading</p>
        <strong>${escapeHtml(shared.defaults.firstScreen.coReadingLabel)}</strong>
        <p>Read the rendered guide here, or give an Agent the exact rooted Markdown entry.</p>
      </div>
      <a href="${escapeAttribute(document.source.route)}">Exact Markdown source</a>
    </aside>
    ${documentNavigation}
    <article class="kungfu-document">${renderDocumentBody(document)}</article>
    ${documentNavigation}
    <span id="document-evidence"></span>
    <details class="kungfu-technical">
      <summary data-open-label="${escapeAttribute(shared.defaults.progressiveDisclosure.openLabel)}" data-close-label="${escapeAttribute(shared.defaults.progressiveDisclosure.closeLabel)}">
        <span class="kungfu-eyebrow">Exact document evidence</span>
        <strong>Verify the source bytes before reusing this guidance.</strong>
        <span>The human page and Agent route are generated from the same rooted Markdown.</span>
      </summary>
      <div class="kungfu-technical-body">
        <section class="kungfu-reader-section">
          <h2>Source document</h2>
          <p class="kungfu-source-detail"><a href="${escapeAttribute(document.source.route)}">${escapeHtml(document.source.route)}</a><br>${escapeHtml(document.source.contentRoot)}<br>${document.source.byteLength} bytes</p>
        </section>
        <section class="kungfu-reader-section">
          <h2>Site machine entry</h2>
          <p class="kungfu-source-detail"><a href="${escapeAttribute(shared.machineEntries.agentIndex)}">${escapeHtml(shared.machineEntries.agentIndex)}</a></p>
        </section>
      </div>
    </details>
  </main>
  </div>
  <footer class="kungfu-footer">
    <div class="kungfu-shell">
      <p>${escapeHtml(shared.brand.trademarkNotice)}</p>
      <p>${escapeHtml(shared.brand.boundary)}</p>
    </div>
  </footer>
</body>
</html>
`;
}

function fileDescriptor(route, contentType, body, kind) {
  return {
    route,
    kind,
    contentType,
    body,
    byteLength: Buffer.byteLength(body),
    contentRoot: sha256(body),
  };
}

function publicFile(file) {
  return {
    route: file.route,
    kind: file.kind,
    contentType: file.contentType,
    byteLength: file.byteLength,
    contentRoot: file.contentRoot,
  };
}

function experienceRoot(experience) {
  return sha256(
    canonicalJson({
      contract: experience.contract,
      site: experience.site,
      brand: experience.brand,
      navigation: experience.navigation,
      kfd3: experience.kfd3,
      machineEntries: experience.machineEntries,
      files: experience.files.map(publicFile),
    }),
  );
}

function createSiteExperience(
  config,
  defaults,
  sources = [],
  additionalFiles = [],
) {
  validateConfiguration(config);
  if (defaults?.contract !== 'kungfu.site-experience-defaults/v1') {
    throw new Error('Kungfu site experience defaults are missing');
  }
  const machineRoutes = {
    manifest: config.machineRoutes?.manifest || '/manifest.json',
    agentIndex: config.machineRoutes?.agentIndex || '/agent-index.json',
    llms: config.machineRoutes?.llms || '/llms.txt',
  };
  for (const [id, route] of Object.entries(machineRoutes)) {
    assertRoute(route, `machineRoutes.${id}`);
  }
  const pagesById = new Map(
    config.content.pages.map((page) => [page.id, structuredClone(page)]),
  );
  const homePage =
    config.content.pages.find((page) => page.route === '/') ||
    config.content.pages[0];
  const primaryIds =
    config.navigation?.primary ||
    config.content.pages
      .filter((page) => page.id !== homePage.id)
      .map((page) => page.id);
  if (new Set(primaryIds).size !== primaryIds.length) {
    throw new Error('Kungfu site experience primary navigation has duplicates');
  }
  if (primaryIds.includes(homePage.id)) {
    throw new Error(
      'Kungfu site experience brand owns home; primary navigation must not duplicate it',
    );
  }
  const primary = primaryIds.map((id) => {
    const page = pagesById.get(id);
    if (!page) {
      throw new Error(`Kungfu site navigation references unknown page: ${id}`);
    }
    return { id, label: page.label, route: page.route, href: page.route };
  });
  const external = (config.navigation?.external || []).map((entry) => {
    assertString(entry.label, 'external navigation label');
    assertString(entry.href, 'external navigation href');
    assertNavigationHref(entry.href);
    return structuredClone(entry);
  });
  const documents = config.content.documents || [];
  const routeTopicForDocument = (document) =>
    primary.find(
      (topic) => topic.route !== '/' && document.route.startsWith(topic.route),
    );
  const topicTree = [
    {
      id: homePage.id,
      label: homePage.label,
      route: homePage.route,
      href: homePage.route,
    },
    ...primary,
  ].map((topic) => ({
    ...topic,
    children: [
      {
        id: `${topic.id}-overview`,
        label: 'Overview',
        route: topic.route,
        href: topic.href,
        kind: 'topic-overview',
      },
      ...documents
        .filter((document) => {
          if ((document.topicIds || []).length) {
            return document.topicIds.includes(topic.id);
          }
          return (
            routeTopicForDocument(document)?.id === topic.id ||
            (!routeTopicForDocument(document) && topic.id === homePage.id)
          );
        })
        .map((document) => ({
          id: document.id,
          label: document.label,
          route: document.route,
          href: document.route,
          kind: 'document',
        })),
    ],
  }));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const kfd3Authorities = defaults.kfd3.sourceIds.map((id) => {
    const source = sourceById.get(id);
    if (!source) {
      throw new Error(`Kungfu site experience KFD-3 source is missing: ${id}`);
    }
    return {
      id,
      path: source.path,
      contentRoot: source.contentRoot,
      url: source.url,
    };
  });
  const shared = {
    site: {
      id: config.site.id,
      context: config.site.context,
      canonicalBaseUrl: config.site.canonicalBaseUrl.replace(/\/+$/u, ''),
      language: config.site.language || 'en',
    },
    brand: structuredClone(defaults.brand),
    defaults,
    navigation: {
      brand: {
        label: defaults.brand.signature,
        href: homePage.route,
      },
      home: {
        id: homePage.id,
        label: homePage.label,
        route: homePage.route,
      },
      primary,
      tree: topicTree,
      external,
      machineEntriesInPrimary: false,
    },
    machineEntries: machineRoutes,
    kfd3: {
      standard: defaults.kfd3.standard,
      machineEntry: machineRoutes.agentIndex,
      parityRule: defaults.kfd3.parityRule,
      authorities: kfd3Authorities,
    },
  };
  const pageFiles = config.content.pages.map((page) =>
    fileDescriptor(
      page.route,
      'text/html; charset=utf-8',
      renderPageDocument({ page, shared }),
      'human-page',
    ),
  );
  const documentFiles = documents.map((document) =>
    fileDescriptor(
      document.route,
      'text/html; charset=utf-8',
      renderDocumentPage({ document, shared }),
      'human-document',
    ),
  );
  const documentSourceFiles = documents.map((document) =>
    fileDescriptor(
      document.source.route,
      'text/markdown; charset=utf-8',
      document.body,
      'source-document',
    ),
  );
  const packagedFiles = additionalFiles.map((file) => {
    assertKnownKeys(
      file,
      ['route', 'contentType', 'body', 'kind'],
      'additional file',
    );
    assertRoute(file.route, 'additional file route');
    assertString(file.contentType, `${file.route} contentType`);
    assertString(file.kind, `${file.route} kind`);
    if (!(typeof file.body === 'string' || Buffer.isBuffer(file.body))) {
      throw new Error(
        `Kungfu site experience additional file body is invalid: ${file.route}`,
      );
    }
    return fileDescriptor(file.route, file.contentType, file.body, file.kind);
  });
  const pageEntries = config.content.pages.map((page, index) => ({
    id: page.id,
    label: page.label,
    route: page.route,
    headline: page.headline,
    summary: page.summary,
    claimClass: page.claimClass,
    maturity: page.maturity,
    knownLimits: structuredClone(page.knownLimits),
    humanSections: structuredClone(page.humanSections),
    technicalSections: structuredClone(page.technicalSections),
    authorities: structuredClone(page.authorities || []),
    contentRoot: pageFiles[index].contentRoot,
  }));
  const documentEntries = documents.map((document, index) => ({
    id: document.id,
    label: document.label,
    route: document.route,
    summary: document.summary,
    claimClass: document.claimClass,
    maturity: document.maturity,
    source: structuredClone(document.source),
    topicIds: structuredClone(document.topicIds || []),
    navigation: structuredClone(document.navigation || {}),
    contentRoot: documentFiles[index].contentRoot,
  }));
  const packagedEntries = packagedFiles.map(publicFile);
  const agentIndex = {
    contract: 'kungfu.site-kfd3-reader-entry/v1',
    standard: shared.kfd3.standard,
    site: shared.site,
    brand: shared.brand,
    parityRule: shared.kfd3.parityRule,
    authorities: shared.kfd3.authorities,
    navigation: shared.navigation,
    readingOrder: pageEntries,
    documents: documentEntries,
    packagedArtifacts: packagedEntries,
    machineEntries: machineRoutes,
  };
  const agentIndexFile = fileDescriptor(
    machineRoutes.agentIndex,
    'application/json; charset=utf-8',
    `${JSON.stringify(agentIndex, null, 2)}\n`,
    'kfd3-machine-entry',
  );
  const llmsBody = `# ${shared.brand.signature} — ${shared.site.context}

${shared.brand.boundary}

KFD-3 parity rule: ${shared.kfd3.parityRule}

Human reading order:
${pageEntries.map((page) => `- ${page.route} ${page.label} [${page.claimClass}; ${page.maturity}]: ${page.summary}\n  Known limits: ${page.knownLimits.join(' ')}`).join('\n')}

Progressive documentation:
${documentEntries.map((document) => `- ${document.route} ${document.label} [${document.claimClass}; ${document.maturity}]: ${document.summary}\n  Exact source: ${document.source.route} ${document.source.contentRoot}`).join('\n')}

Packaged machine and evidence artifacts:
${packagedEntries.map((file) => `- ${file.route} ${file.contentType} ${file.contentRoot}`).join('\n')}

Machine entries:
- ${machineRoutes.agentIndex}
- ${machineRoutes.manifest}
- ${machineRoutes.llms}
`;
  const llmsFile = fileDescriptor(
    machineRoutes.llms,
    'text/plain; charset=utf-8',
    llmsBody,
    'agent-reading-entry',
  );
  const manifest = {
    contract: 'kungfu.site-experience-manifest/v1',
    site: shared.site,
    brand: shared.brand,
    navigation: shared.navigation,
    kfd3: shared.kfd3,
    pages: pageEntries.map((page) => ({
      id: page.id,
      route: page.route,
      contentRoot: page.contentRoot,
    })),
    documents: documentEntries.map((document) => ({
      id: document.id,
      route: document.route,
      contentRoot: document.contentRoot,
      source: document.source,
      topicIds: document.topicIds,
    })),
    packagedArtifacts: packagedEntries,
    machineEntries: {
      manifest: machineRoutes.manifest,
      agentIndex: {
        route: machineRoutes.agentIndex,
        contentRoot: agentIndexFile.contentRoot,
      },
      llms: {
        route: machineRoutes.llms,
        contentRoot: llmsFile.contentRoot,
      },
    },
  };
  const manifestFile = fileDescriptor(
    machineRoutes.manifest,
    'application/json; charset=utf-8',
    `${JSON.stringify(manifest, null, 2)}\n`,
    'site-manifest',
  );
  const experience = {
    contract: EXPERIENCE_CONTRACT,
    site: shared.site,
    brand: shared.brand,
    navigation: shared.navigation,
    kfd3: shared.kfd3,
    machineEntries: machineRoutes,
    files: [
      ...pageFiles,
      ...documentFiles,
      ...documentSourceFiles,
      ...packagedFiles,
      manifestFile,
      agentIndexFile,
      llmsFile,
    ],
  };
  experience.contentRoot = experienceRoot(experience);
  verifySiteExperience(experience);
  return experience;
}

function verifySiteExperience(experience) {
  if (experience?.contract !== EXPERIENCE_CONTRACT) {
    throw new Error('Unexpected Kungfu site experience contract');
  }
  assertUnique(experience.files || [], 'route', 'files');
  for (const file of experience.files || []) {
    if (
      sha256(file.body) !== file.contentRoot ||
      Buffer.byteLength(file.body) !== file.byteLength
    ) {
      throw new Error(
        `Kungfu site experience file root mismatch: ${file.route}`,
      );
    }
  }
  if (experienceRoot(experience) !== experience.contentRoot) {
    throw new Error('Kungfu site experience content root mismatch');
  }
  if (
    experience.brand?.signature !== 'Kungfu UNGFU™' ||
    experience.brand?.productName !== 'Kungfu' ||
    !experience.brand?.boundary?.includes('not a second product or runtime')
  ) {
    throw new Error('Kungfu site experience brand boundary drifted');
  }
  if (experience.navigation?.machineEntriesInPrimary !== false) {
    throw new Error('Machine entries must not enter human primary navigation');
  }
  const pageFiles = experience.files.filter(
    (file) => file.kind === 'human-page',
  );
  const documentFiles = experience.files.filter(
    (file) => file.kind === 'human-document',
  );
  const humanRoutes = new Set(
    [...pageFiles, ...documentFiles].map((file) => file.route),
  );
  const topicTree = experience.navigation?.tree;
  if (
    !Array.isArray(topicTree) ||
    topicTree.length !== pageFiles.length ||
    topicTree.some(
      (topic) =>
        !Array.isArray(topic.children) ||
        topic.children[0]?.kind !== 'topic-overview' ||
        topic.children[0]?.route !== topic.route ||
        topic.children.some((child) => !humanRoutes.has(child.route)),
    ) ||
    documentFiles.some(
      (file) =>
        !topicTree.some((topic) =>
          topic.children.some((child) => child.route === file.route),
        ),
    )
  ) {
    throw new Error('Kungfu site experience topic tree drifted');
  }
  for (const file of [...pageFiles, ...documentFiles]) {
    if (
      !file.body.includes(experience.brand.signature) ||
      !file.body.includes(
        `href="${escapeAttribute(experience.machineEntries.agentIndex)}"`,
      ) ||
      !file.body.includes(
        `href="${escapeAttribute(file.route)}" aria-current="page"`,
      ) ||
      !file.body.includes('<details class="kungfu-technical">') ||
      file.body.includes('<details class="kungfu-technical" open')
    ) {
      throw new Error(
        `Kungfu site experience human/Agent reader contract drifted: ${file.route}`,
      );
    }
  }
  const agentFile = experience.files.find(
    (file) => file.route === experience.machineEntries.agentIndex,
  );
  const manifestFile = experience.files.find(
    (file) => file.route === experience.machineEntries.manifest,
  );
  if (!agentFile || !manifestFile) {
    throw new Error('Kungfu site experience machine entries are missing');
  }
  const agentIndex = JSON.parse(agentFile.body);
  const manifest = JSON.parse(manifestFile.body);
  if (
    agentIndex.standard !== experience.kfd3.standard ||
    canonicalJson(agentIndex.brand) !== canonicalJson(experience.brand) ||
    canonicalJson(agentIndex.navigation) !==
      canonicalJson(experience.navigation) ||
    canonicalJson(manifest.brand) !== canonicalJson(experience.brand) ||
    canonicalJson(manifest.navigation) !==
      canonicalJson(experience.navigation) ||
    agentIndex.readingOrder?.length !== pageFiles.length ||
    agentIndex.documents?.length !== documentFiles.length ||
    agentIndex.packagedArtifacts?.length !==
      experience.files.filter((file) =>
        ['format-machine-artifact', 'format-evidence'].includes(file.kind),
      ).length ||
    agentIndex.parityRule !== experience.kfd3.parityRule ||
    canonicalJson(agentIndex.authorities) !==
      canonicalJson(experience.kfd3.authorities) ||
    !agentIndex.authorities?.length ||
    agentIndex.authorities.some(
      (authority) => !/^sha256:[0-9a-f]{64}$/u.test(authority.contentRoot),
    )
  ) {
    throw new Error('Kungfu site experience KFD-3 projection drifted');
  }
  return {
    status: 'passing',
    site: structuredClone(experience.site),
    contentRoot: experience.contentRoot,
    pages: pageFiles.length,
    documents: documentFiles.length,
    files: experience.files.length,
    machineEntry: experience.machineEntries.agentIndex,
  };
}

module.exports = {
  CONFIG_CONTRACT,
  createSiteExperience,
  verifySiteExperience,
};
