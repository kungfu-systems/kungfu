#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Route topology contract (ADR-0108).
//
// docs/route-topology.registry.json is the declared account of which component
// consumes which carrier. It is maintained by hand: it is a claim, and this
// script is what makes the claim falsifiable by checking it against the source
// in both directions — every declared route must exist, and every route in the
// source must be declared.
//
// The registry exists because the question it answers cannot be answered from
// one process. The three consumers of ACTION_ENVELOPE live in two processes and
// two languages, and one of them selects the carrier inside a guard predicate
// that never names it. No search, and no runtime table, can attribute that set.
//
//   node scripts/route-topology-contract.mjs                     # verify
//   node scripts/route-topology-contract.mjs --consumer ACTION_ENVELOPE --json
//
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'docs/route-topology.registry.json';

/** Anchors: how each route kind appears in source. Kept literal so a rename fails loudly. */
const ANCHORS = {
  declared: (route) =>
    route.carrier === 'ANY_FRAME'
      ? [`declare_frames(route_phase::${route.phase}, "${route.name}"`]
      : route.carrier
        ? [
            `declare<${route.carrier}>(route_phase::${route.phase}, "${route.name}"`,
          ]
        : [`declare_events(route_phase::${route.phase}, "${route.name}"`],
  dynamic: (route) =>
    route.carrier
      ? [`declare_dynamic<${route.carrier}>("${route.name}"`]
      : [`declare_dynamic_events("${route.name}"`],
  observe: (route) => [`self.observe(${route.carrier}, self.${route.name})`],
};

/** Source patterns, for the reverse direction: what exists that the registry must cover. */
const SOURCE_PATTERNS = [
  /declare<(\w+)>\(route_phase::(\w+),\s*"([^"]+)"/g,
  /declare_events\(route_phase::(\w+),\s*"([^"]+)"/g,
  /declare_frames\(route_phase::(\w+),\s*"([^"]+)"/g,
  /declare_dynamic<(\w+)>\("([^"]+)"/g,
  /declare_dynamic_events\("([^"]+)"/g,
  /self\.observe\(\w+,\s*self\.(\w+)\)/g,
];

function readRegistry() {
  const file = path.join(ROOT, REGISTRY);
  if (!fs.existsSync(file)) {
    throw new Error(`${REGISTRY} is missing`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Collapse the source text so a declaration wrapped by the formatter still matches its anchor. */
function flatten(text) {
  return text.replace(/\s+/g, ' ');
}

function verify(registry) {
  const problems = [];
  const seenNames = new Set();

  for (const component of registry.components) {
    const file = path.join(ROOT, component.anchor);
    if (!fs.existsSync(file)) {
      problems.push(
        `${component.id}: anchor ${component.anchor} does not exist`,
      );
      continue;
    }
    const flat = flatten(fs.readFileSync(file, 'utf8'));

    // Forward: every declared route must be present in its anchor.
    for (const route of component.routes) {
      seenNames.add(route.name);
      const build = ANCHORS[route.kind];
      if (!build) {
        problems.push(
          `${component.id}/${route.name}: unknown kind '${route.kind}'`,
        );
        continue;
      }
      const anchors = build(route).map(flatten);
      if (!anchors.some((anchor) => flat.includes(anchor))) {
        problems.push(
          `${component.id}/${route.name}: registry claims a route the anchor does not contain\n` +
            `    expected in ${component.anchor}: ${anchors[0]}`,
        );
      }
    }

    // Reverse: every route in the anchor must be declared, or the registry is
    // an incomplete answer while looking like a complete one.
    for (const pattern of SOURCE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of flat.matchAll(pattern)) {
        const name = match[match.length - 1];
        if (!seenNames.has(name)) {
          problems.push(
            `${component.anchor}: route '${name}' exists in source but is not in the registry`,
          );
        }
      }
    }
  }
  return problems;
}

function resolveCarrier(registry, name) {
  return registry.carrierAliases?.[name] ?? name;
}

function consumersOf(registry, carrierName) {
  const wanted = resolveCarrier(registry, carrierName);
  const found = [];
  for (const component of registry.components) {
    for (const route of component.routes) {
      const selects =
        route.carrier && resolveCarrier(registry, route.carrier) === wanted;
      const declares = (route.consumes ?? []).some(
        (c) => resolveCarrier(registry, c) === wanted,
      );
      if (selects || declares) {
        found.push({
          component: component.id,
          process: component.process,
          language: component.language,
          route: route.name,
          via: selects ? 'carrier' : 'consumes',
          anchor: component.anchor,
        });
      }
    }
  }
  return found;
}

function main() {
  const argv = process.argv.slice(2);
  const registry = readRegistry();
  const consumerIndex = argv.indexOf('--consumer');

  if (consumerIndex !== -1) {
    const carrier = argv[consumerIndex + 1];
    if (!carrier) {
      console.error('[route-topology] --consumer needs a carrier name');
      process.exit(2);
    }
    const consumers = consumersOf(registry, carrier);
    if (argv.includes('--json')) {
      console.log(
        JSON.stringify(
          { carrier: resolveCarrier(registry, carrier), consumers },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `[route-topology] consumers of ${resolveCarrier(registry, carrier)}: ${consumers.length}`,
      );
      for (const c of consumers) {
        console.log(
          `  ${c.component} (${c.language}, process=${c.process})  ${c.route}  via ${c.via}`,
        );
      }
    }
    return;
  }

  const problems = verify(registry);
  const routes = registry.components.reduce((n, c) => n + c.routes.length, 0);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`[route-topology] ${problem}`);
    }
    console.error(`[route-topology] result=fail problems=${problems.length}`);
    process.exit(1);
  }
  console.log(
    `[route-topology] components=${registry.components.length} routes=${routes} declared routes match their anchors, and no source route is undeclared`,
  );
  console.log('[route-topology] result=pass');
}

main();
