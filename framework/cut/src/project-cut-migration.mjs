// SPDX-License-Identifier: Apache-2.0
// @ts-check

import {
  semanticRoot as legacySemanticRoot,
  verifyProjectCut,
} from '../../project-cut/src/project-cut.mjs';
import { buildCut, semanticRoot, verifyCut } from './cut.mjs';

export const MIGRATION_SCHEMA = 'kungfu.cut.migration-receipt/v1';
export const ADAPTER_ID = 'software-development.project-cut/v1';

const issue = (entry) => ({
  code: entry.code,
  path: entry.path,
  root: entry.root,
  detail: entry.detail,
});

/** Explicit one-way projection. The legacy Project Cut remains authoritative for its old root. */
export function migrateProjectCut(legacyCut) {
  const legacyVerdict = verifyProjectCut(legacyCut);
  if (!legacyVerdict.valid)
    throw Object.assign(
      new Error('legacy Project Cut failed its original verifier'),
      {
        code: 'legacy-project-cut-invalid',
        diagnostics: legacyVerdict.diagnostics,
      },
    );
  const nativeRoots = legacyCut.episodeDelta.nativeRoots;
  const cut = buildCut({
    profile: {
      id: 'software-development',
      version: 1,
      displayName: 'Project Cut',
      schemaRoot: legacyCut.interpretation.schemaRoot,
    },
    parentCutRoots: [...legacyCut.parentCutRoots].sort(),
    bindings: [
      {
        type: 'software.project',
        authority: 'domain-profile',
        root: legacyCut.project.identityRoot,
        schemaRoot: legacyCut.interpretation.schemaRoot,
      },
      {
        type: 'software.source-projection',
        authority: 'git',
        root: legacyCut.sourceProjection.root,
        schemaRoot: legacyCut.sourceProjection.policyRoot,
      },
      {
        type: 'software.epistemic-state',
        authority: 'xinfa-atlas',
        root: legacyCut.atlas.root,
        schemaRoot: legacyCut.atlas.compilerRoot,
      },
      ...nativeRoots.map((entry) => ({
        type: 'causal.episode-delta',
        authority: entry.provider,
        root: entry.root,
        schemaRoot: legacyCut.interpretation.schemaRoot,
      })),
    ].sort((left, right) => {
      const a = `${left.type}\0${left.authority}`;
      const b = `${right.type}\0${right.authority}`;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    episodeDelta: {
      admitted: true,
      empty: legacyCut.episodeDelta.empty,
      root: legacyCut.episodeDelta.empty
        ? null
        : (legacyCut.episodeDelta.semanticRoot ??
          legacySemanticRoot(nativeRoots)),
    },
    interpretation: {
      protocolRoot: legacyCut.interpretation.protocolRoot,
      schemaRoot: legacyCut.interpretation.schemaRoot,
      policyRoots: [...legacyCut.interpretation.policyRoots].sort(),
    },
    uncertainty: {
      omissions: legacyCut.omissions.map(issue),
      conflicts: legacyCut.conflicts.map(issue),
      unknowns: legacyCut.unknowns.map(issue),
    },
  });
  const receiptInput = {
    schema: MIGRATION_SCHEMA,
    adapter: ADAPTER_ID,
    status: 'migrated',
    legacyProtocol: 'project.cut/v1',
    legacyCutRoot: legacyCut.cutRoot,
    cutProtocol: 'kungfu.cut/v1',
    cutRoot: cut.cutRoot,
    rollback: 'read-legacy-project-cut-with-original-verifier',
  };
  return {
    cut,
    receipt: { ...receiptInput, receiptRoot: semanticRoot(receiptInput) },
  };
}

export function verifyMigration(legacyCut, migration) {
  const expected = migrateProjectCut(legacyCut);
  const valid =
    verifyCut(migration.cut).valid &&
    migration.receipt.receiptRoot === expected.receipt.receiptRoot &&
    semanticRoot(
      Object.fromEntries(
        Object.entries(migration.receipt).filter(
          ([key]) => key !== 'receiptRoot',
        ),
      ),
    ) === migration.receipt.receiptRoot &&
    migration.cut.cutRoot === expected.cut.cutRoot;
  return {
    valid,
    diagnostics: valid
      ? []
      : [
          {
            code: 'migration-drift',
            path: '$',
            message: 'migration does not reproduce the frozen adapter result',
          },
        ],
  };
}
