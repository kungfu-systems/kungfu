// SPDX-License-Identifier: Apache-2.0

import type { ProjectWorkRunSnapshot } from '@kungfu-tech/api/capability';
import { Box, Text } from 'ink';
import React from 'react';

type Session = NonNullable<ProjectWorkRunSnapshot['session']>;

export function NativeWorkProjectionView({ session }: { session: Session }) {
  const observer = session.nativeObserver;
  if (!observer) return null;
  const displayState = observer.state;
  return (
    <Box flexDirection="column">
      <Text
        bold
        color={
          displayState === 'fresh'
            ? 'green'
            : displayState === 'refreshing'
              ? 'cyan'
              : 'yellow'
        }
      >
        NATIVE UI · OBSERVE ONLY · {displayState?.toUpperCase()} ·{' '}
        {observer.ageMs}ms old
      </Text>
      <Text dimColor>
        Provider owns terminal input; continue in its native UI.
      </Text>
      <Text dimColor>
        Agent session activity is retained; protected Work history begins only
        with an accepted domain receipt.
      </Text>
      {observer.workProjection ? (
        <Text
          color={observer.workProjection.state === 'fresh' ? 'green' : 'yellow'}
        >
          WORK SNAPSHOT · {observer.workProjection.state.toUpperCase()}
          {' · '}
          {observer.workProjection.source}
          {' · queries '}
          {observer.workProjection.queryCount}
        </Text>
      ) : null}
      {observer.work ? (
        <>
          <Text bold color="cyan">
            Work ·{' '}
            {observer.work.title ||
              observer.work.assignmentId ||
              observer.work.state}
          </Text>
          <Text dimColor>
            ID · {observer.work.assignmentId}
            {observer.work.phase ? ` · Phase ${observer.work.phase}` : ''}
          </Text>
          {observer.work.objective ? (
            <Text>Objective · {observer.work.objective}</Text>
          ) : null}
          {observer.work.remainingObligation ? (
            <Text color="yellow">
              Remaining · {observer.work.remainingObligation}
            </Text>
          ) : null}
          {observer.work.acceptanceChecks.map((check, index) => (
            <Text key={`${index}:${check}`}>
              Acceptance {index + 1} · {check}
            </Text>
          ))}
          {observer.work.nextAction ? (
            <Text color="cyan">Next · {observer.work.nextAction}</Text>
          ) : null}
          <Text dimColor>
            Continuity · claims{' '}
            {observer.work.continuation.completionClaimCount} · reviews{' '}
            {observer.work.continuation.independentReviewCount} · decisions{' '}
            {observer.work.continuation.continuationDecisionCount} · evidence{' '}
            {observer.work.evidenceEpisodeRoots.length} · session receipts{' '}
            {session.receiptRoots.length}
          </Text>
        </>
      ) : null}
      {observer.diagnostic ? (
        <Text color="yellow">Observer · {observer.diagnostic}</Text>
      ) : null}
      {observer.detailDiagnostic ? (
        <Text color="yellow">Work details · {observer.detailDiagnostic}</Text>
      ) : null}
    </Box>
  );
}
