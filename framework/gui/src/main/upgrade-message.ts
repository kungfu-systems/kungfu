// SPDX-License-Identifier: Apache-2.0

import upgradeContract from '../../../upgrade/kungfu-upgrade.contract.json';

export const UPGRADE_GUIDE_URL =
  'https://www.kungfu.tech/docs/guides/upgrading';

export type UpgradeMessage = {
  schema: 'kungfu.product-upgrade-message/v1';
  reasonCode: string;
  messageReasonCode: string;
  title: string;
  whatHappened: string;
  activeWork: string;
  activation: string;
  userAction: string;
  dataAndSessions: string;
  impact: Record<string, unknown>;
  documentationUrl: string;
};

type MessageRow = Omit<
  UpgradeMessage,
  'schema' | 'reasonCode' | 'messageReasonCode' | 'impact' | 'documentationUrl'
> & { documentationAnchor: string };

const registry = upgradeContract.messageRegistry as {
  fallbackReason: string;
  reasonMessages: Record<string, MessageRow>;
};

export function upgradeUserMessage(
  reasonCode: string,
  documentationUrl = UPGRADE_GUIDE_URL,
  impact: Record<string, unknown> = {},
): UpgradeMessage {
  const messageReasonCode = registry.reasonMessages[reasonCode]
    ? reasonCode
    : registry.fallbackReason;
  const selected = registry.reasonMessages[messageReasonCode];
  if (!selected) throw new Error('Upgrade fallback message is missing');
  return {
    schema: 'kungfu.product-upgrade-message/v1',
    reasonCode,
    messageReasonCode,
    title: selected.title,
    whatHappened: selected.whatHappened,
    activeWork: selected.activeWork,
    activation: selected.activation,
    userAction: selected.userAction,
    dataAndSessions: selected.dataAndSessions,
    impact: structuredClone(impact),
    documentationUrl: `${documentationUrl.split('#', 1)[0]}${selected.documentationAnchor}`,
  };
}
