// SPDX-License-Identifier: Apache-2.0
// @ts-check

// This leaf stays source-relative because affected-native delivery identity is
// captured before workspace dependencies are installed on hosted runners.
import { semanticRoot } from '../framework/spec/format/project-cut-canonical-json.mjs';

export const FAMILY_QUEUE_LEASE_SCHEMA = 'project.cut.family-queue-lease/v1';
export const FAMILY_QUEUE_RELEASE_SCHEMA =
  'project.cut.family-queue-release/v1';
export const FAMILY_QUEUE_MARKER = '<!-- kungfu-family-queue-lease:v1 ';

export function familyQueueMarkerFor(value) {
  return `${FAMILY_QUEUE_MARKER}${Buffer.from(
    JSON.stringify(value),
    'utf8',
  ).toString('base64url')} -->`;
}

export function familyQueueLeaseMaterial(lease) {
  const {
    marker: _marker,
    leaseRoot: _leaseRoot,
    idempotent: _idempotent,
    ...material
  } = lease;
  return material;
}

export function parseFamilyQueueLeaseMarker(text) {
  const pattern = /<!-- kungfu-family-queue-lease:v1 ([A-Za-z0-9_-]+) -->/gu;
  let match = null;
  for (const candidate of String(text || '').matchAll(pattern)) {
    match = candidate;
  }
  if (match === null) return null;
  let lease;
  try {
    lease = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('family queue lease marker is not valid canonical JSON');
  }
  if (lease?.schema !== FAMILY_QUEUE_LEASE_SCHEMA) {
    throw new Error('unsupported family queue lease marker schema');
  }
  const material = familyQueueLeaseMaterial(lease);
  const expectedRoot = semanticRoot(material);
  if (lease.leaseRoot !== expectedRoot) {
    throw new Error('family queue lease marker root mismatch');
  }
  if (lease.marker && lease.marker !== familyQueueMarkerFor(material)) {
    throw new Error('family queue lease marker self-reference is invalid');
  }
  return { ...material, leaseRoot: expectedRoot };
}
