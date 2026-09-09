// SPDX-License-Identifier: Apache-2.0
export interface ContractArtifact {
  label: string;
  source: string;
  artifact: string;
  surface?: string;
}
export interface ContractRegistry {
  schema: 'kungfu.contract-registry/v1';
  canonicalPolicy?: { source: string; artifact: string };
  contracts: Array<{
    surface: string;
    source: string;
    artifact: string;
    extraArtifacts?: Array<{
      label?: string;
      source: string;
      artifact: string;
    }>;
  }>;
}
export const REGISTRY_ARTIFACT: string;
export const REGISTRY_SOURCE: string;
export function loadContractRegistry(): ContractRegistry;
export function contractArtifacts(): ContractArtifact[];
export function copyContractArtifacts(distKfc: string): void;
export function sha256File(file: string): string;
