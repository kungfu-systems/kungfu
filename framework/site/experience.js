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
    assertKnownKeys(item, ['heading', 'body'], `${pageId} ${section.id} item`);
    assertString(item.heading, `${pageId} ${section.id} item heading`);
    assertString(item.body, `${pageId} ${section.id} item body`);
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
  assertKnownKeys(config.content, ['pages'], 'content');
  if (!config.content?.pages?.length) {
    throw new Error('Kungfu site experience requires at least one page');
  }
  assertUnique(config.content.pages, 'id', 'pages');
  assertUnique(config.content.pages, 'route', 'pages');
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
        ['id', 'path', 'role', 'contentRoot', 'url'],
        `${page.id} authority`,
      );
      for (const field of ['id', 'path', 'role', 'contentRoot', 'url']) {
        assertString(authority[field], `${page.id} authority ${field}`);
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(authority.contentRoot)) {
        throw new Error(
          `Kungfu site experience ${page.id} authority has invalid contentRoot`,
        );
      }
    }
  }
}

function renderSection(section) {
  const items = (section.items || [])
    .map(
      (item) => `<article class="kungfu-reader-item">
        <h3>${escapeHtml(item.heading)}</h3>
        <p>${escapeHtml(item.body)}</p>
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
  *{box-sizing:border-box}body{margin:0;background:var(--kf-bg);color:var(--kf-fg);line-height:1.6}a{color:inherit}.kungfu-shell{width:min(1120px,calc(100% - 32px));margin:auto}.kungfu-header{border-bottom:1px solid var(--kf-line);background:rgba(247,246,242,.96)}.kungfu-bar{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:72px}.kungfu-brand{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-weight:750;text-decoration:none}.kungfu-brand-context{color:var(--kf-muted);font-size:13px;font-weight:500}.kungfu-brand-context:before{content:"·";margin-right:8px;color:var(--kf-line)}.kungfu-nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:14px}.kungfu-nav a{min-height:38px;display:inline-flex;align-items:center;text-decoration:none}.kungfu-nav a[aria-current="page"],.kungfu-nav a:hover{text-decoration:underline;text-underline-offset:5px}.kungfu-main{display:grid;gap:32px;padding:64px 0 80px}.kungfu-hero{display:grid;gap:12px;max-width:900px}.kungfu-eyebrow{margin:0;color:var(--kf-accent);font:700 12px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;text-transform:uppercase;letter-spacing:.08em}.kungfu-hero h1{max-width:20ch;margin:0;font-size:clamp(38px,7vw,72px);line-height:1.02;letter-spacing:-.04em}.kungfu-lead{max-width:70ch;margin:0;color:var(--kf-muted);font-size:clamp(18px,2.2vw,23px)}.kungfu-reader-cue,.kungfu-reader-section,.kungfu-limits,.kungfu-technical{padding:24px;border:1px solid var(--kf-line);background:var(--kf-panel)}.kungfu-reader-cue{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px;border-left:5px solid var(--kf-accent)}.kungfu-reader-cue p,.kungfu-reader-section>p{margin:6px 0 0}.kungfu-reader-cue a{font-weight:750;color:var(--kf-accent)}.kungfu-reader-section{display:grid;gap:12px}.kungfu-reader-section h2,.kungfu-limits h2{margin:0;max-width:30ch;font-size:clamp(25px,4vw,40px);line-height:1.08}.kungfu-reader-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:8px}.kungfu-reader-item{padding:18px;background:var(--kf-soft)}.kungfu-reader-item h3,.kungfu-reader-item p{margin:0}.kungfu-reader-item p{margin-top:6px;color:var(--kf-muted)}.kungfu-limits{border-left:5px solid #bb6b27}.kungfu-limits ul{margin-bottom:0}.kungfu-technical>summary{display:grid;gap:8px;cursor:pointer;list-style:none}.kungfu-technical>summary::-webkit-details-marker{display:none}.kungfu-technical>summary strong{font-size:20px}.kungfu-technical>summary:after{content:attr(data-open-label);width:fit-content;color:var(--kf-accent);font-weight:750;border-bottom:1px solid currentColor}.kungfu-technical[open]>summary:after{content:attr(data-close-label)}.kungfu-technical-body{display:grid;gap:20px;margin-top:24px;padding-top:24px;border-top:1px solid var(--kf-line)}.kungfu-technical:not([open])>.kungfu-technical-body{display:none}.kungfu-technical .kungfu-reader-section{padding:0;border:0}.kungfu-footer{padding:32px 0;border-top:1px solid var(--kf-line);color:var(--kf-muted);font-size:14px}.kungfu-footer p{margin:4px 0}@media(max-width:760px){.kungfu-bar,.kungfu-reader-cue{align-items:flex-start;flex-direction:column;grid-template-columns:1fr}.kungfu-bar{padding:16px 0;gap:8px}.kungfu-nav{width:100%;flex-wrap:nowrap;gap:14px;overflow-x:auto;overscroll-behavior-inline:contain;padding-bottom:6px}.kungfu-nav a{flex:0 0 auto;white-space:nowrap}.kungfu-reader-grid{grid-template-columns:1fr}.kungfu-main{padding-top:40px}}
`;

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
  <main class="kungfu-shell kungfu-main">
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
    <details class="kungfu-technical">
      <summary data-open-label="${escapeAttribute(shared.defaults.progressiveDisclosure.openLabel)}" data-close-label="${escapeAttribute(shared.defaults.progressiveDisclosure.closeLabel)}">
        <span class="kungfu-eyebrow">${escapeHtml(shared.defaults.progressiveDisclosure.technicalLabel)}</span>
        <strong>${escapeHtml(page.technicalSummary || 'Inspect exact contracts, evidence and authority roots.')}</strong>
        <span>Everything remains available without overwhelming the first reading layer.</span>
      </summary>
      <div class="kungfu-technical-body">${technicalSections}</div>
    </details>
  </main>
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

function createSiteExperience(config, defaults, sources = []) {
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
      primary,
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
  const agentIndex = {
    contract: 'kungfu.site-kfd3-reader-entry/v1',
    standard: shared.kfd3.standard,
    site: shared.site,
    brand: shared.brand,
    parityRule: shared.kfd3.parityRule,
    authorities: shared.kfd3.authorities,
    navigation: shared.navigation,
    readingOrder: pageEntries,
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
    files: [...pageFiles, manifestFile, agentIndexFile, llmsFile],
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
  for (const file of pageFiles) {
    if (
      !file.body.includes(experience.brand.signature) ||
      !file.body.includes(
        `href="${escapeAttribute(experience.machineEntries.agentIndex)}"`,
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
    files: experience.files.length,
    machineEntry: experience.machineEntries.agentIndex,
  };
}

module.exports = {
  CONFIG_CONTRACT,
  createSiteExperience,
  verifySiteExperience,
};
