// SPDX-License-Identifier: Apache-2.0

export const PRODUCT_HELP_LINKS = [
  {
    label: 'GitHub Repository',
    url: 'https://github.com/kungfu-systems/kungfu',
  },
  { label: 'Kungfu Website', url: 'https://kungfu.tech' },
  { label: 'Developer Platform', url: 'https://libkungfu.dev' },
] as const;

export type ProductHelpMenuItem = {
  label?: string;
  type?: 'separator';
  click?: () => void;
};

export function productHelpMenuItems({
  openOnboarding,
  openExternal,
}: {
  openOnboarding: () => void;
  openExternal: (url: string) => void;
}): ProductHelpMenuItem[] {
  return [
    { label: 'Onboarding', click: openOnboarding },
    { type: 'separator' },
    ...PRODUCT_HELP_LINKS.map(({ label, url }) => ({
      label,
      click: () => openExternal(url),
    })),
  ];
}
