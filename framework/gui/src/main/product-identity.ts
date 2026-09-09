// SPDX-License-Identifier: Apache-2.0

export const PRODUCT_NAME = 'Kungfu';
export const SECONDARY_SOURCE_SIGNATURE = 'Kungfu UNGFU™';
export const SOURCE_PRINCIPLE = 'Never Guess. Facts Unfold.';

export function versionFirstLine(output: string): string {
  return (
    output
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() || ''
  );
}

export function productAboutPanelOptions(applicationVersion: string) {
  return {
    applicationName: PRODUCT_NAME,
    applicationVersion,
    version: applicationVersion,
    credits: `${SECONDARY_SOURCE_SIGNATURE}\n${SOURCE_PRINCIPLE}`,
    website: 'https://kungfu.tech',
  };
}
