// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AgentWorkLab,
  ProjectFileTreeEntry,
  ProjectWork,
  Projects,
  WorkStartReceipt,
} from '@kungfu-tech/api/capability';
import { Box, Text } from 'ink';
import React from 'react';

export const PROJECT_TOUR_STORY_STEPS = [
  'Create a disposable Project from the shipped Starter template',
  'Open the Project and inspect its real file tree',
  'Run one Work; retain a simulated transport disconnect (exit 75)',
  'Retry the same Work; retain a simulated Agent crash (exit 23)',
  'Retry again; write a deterministic recovery deliverable',
  'Run a fresh read-only Mock Reviewer and settle through native Work authority',
  'Capture another Work and show the complete Project Work inventory',
] as const;

export type ProjectTourResult =
  | {
      state: 'completed';
      report: {
        schema: 'kungfu.project-work.tui-tour/v1';
        status: 'qualified';
        reportRoot: string;
        eventCount: number;
        projectPath: string;
        workCount: number;
      };
    }
  | { state: 'failed'; message: string };

type TourEvent = {
  title: string;
  detail: string;
  tone: 'good' | 'bad' | 'info';
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function shortWorkState(work: ProjectWork): string {
  if (work.settled) return 'settled';
  if (work.phase === 'executing') return 'recovery needed';
  return work.phase ?? 'captured';
}

function treeLabel(entry: ProjectFileTreeEntry): string {
  const indent = '  '.repeat(entry.depth);
  if (entry.kind === 'directory') return `${indent}▸ ${entry.name}/`;
  return `${indent}· ${entry.name}`;
}

function resultRoot(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function ProjectTourView({
  lab,
  projects,
  destination,
  columns,
  onSettled,
}: {
  lab: AgentWorkLab;
  projects: Projects;
  destination: string;
  columns: number;
  onSettled: (result: ProjectTourResult) => void;
}) {
  const [step, setStep] = React.useState(0);
  const [status, setStatus] = React.useState(
    'Preparing an isolated Starter Project…',
  );
  const [events, setEvents] = React.useState<TourEvent[]>([]);
  const [files, setFiles] = React.useState<ProjectFileTreeEntry[]>([]);
  const [works, setWorks] = React.useState<ProjectWork[]>([]);
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    let active = true;
    const record = (event: TourEvent) => {
      if (!active) return;
      setEvents((current) => [...current, event].slice(-8));
      setStatus(event.detail);
    };
    const refreshFiles = () => {
      if (!active) return;
      setFiles(
        projects.files(destination, {
          expandedPaths: new Set(['deliverables', 'inputs']),
          maxDepth: 3,
          maxEntries: 18,
        }),
      );
    };
    const refreshWorks = async () => {
      const inventory = await projects.works(destination);
      if (active) setWorks(inventory.works);
      return inventory;
    };
    const runAttempt = async (
      assignmentId: string,
      expectedStatus: 'agent-failed' | 'agent-finished',
    ): Promise<WorkStartReceipt> => {
      const plan = await projects.planRun('mock', {
        workspace: destination,
        work: assignmentId,
        scenario: 'recovery-story',
      });
      if (!plan.executable) {
        throw new Error(
          `Mock recovery Work plan is blocked: binding=${plan.admissionBinding.state}; agent=${plan.agent.verification.error ?? (plan.agent.verification.ok ? 'verified' : 'unavailable')}`,
        );
      }
      const receipt = await projects.run(
        'mock',
        {
          workspace: destination,
          work: assignmentId,
          scenario: 'recovery-story',
          expectedPlanRoot: plan.planRoot,
        },
        () => undefined,
      );
      if (receipt.status !== expectedStatus) {
        throw new Error(
          `Mock recovery attempt returned ${receipt.status}; expected ${expectedStatus}`,
        );
      }
      return receipt;
    };

    void (async () => {
      try {
        const plan = await lab.planStarterProject(destination);
        const created = await lab.createStarterProject(plan, 'project-tour');
        await lab.openStarterProject(created);
        setStep(1);
        refreshFiles();
        const initial = await refreshWorks();
        const work = initial.activeWork ?? initial.works[0];
        if (!work) throw new Error('Starter Project has no captured Work');
        record({
          title: 'Starter Project created',
          detail:
            'The Project is real and disposable; Files and captured Work are visible.',
          tone: 'good',
        });
        await wait(650);

        setStep(2);
        const disconnected = await runAttempt(
          work.assignmentId,
          'agent-failed',
        );
        record({
          title: 'Connection lost · exit 75',
          detail:
            'Kungfu retained the failed attempt; Work stayed executing and review was not fabricated.',
          tone: 'bad',
        });
        await refreshWorks();
        await wait(700);

        setStep(3);
        const crashed = await runAttempt(work.assignmentId, 'agent-failed');
        record({
          title: 'Agent process crashed · exit 23',
          detail:
            'The second failure is another retained attempt under the same Work identity.',
          tone: 'bad',
        });
        await refreshWorks();
        await wait(700);

        setStep(4);
        const completed = await runAttempt(work.assignmentId, 'agent-finished');
        refreshFiles();
        record({
          title: 'Fresh attempt produced evidence',
          detail:
            'Mock Agent wrote deliverables/mock-agent-recovery-report.md; process exit still did not settle Work.',
          tone: 'good',
        });
        await wait(700);

        setStep(5);
        const reviewPlan = await lab.planStarterReview(
          completed,
          'kungfu.mock-agent.review-fit',
        );
        if (!reviewPlan.executable)
          throw new Error('Mock review plan is blocked');
        const review = await lab.runStarterReview(reviewPlan);
        if (review.status !== 'review-passed') {
          throw new Error(
            `Mock review returned ${review.status}: ${review.message ?? 'no settlement detail'}`,
          );
        }
        const closePlan = await lab.planStarterClose({
          destination,
          initialWork: {
            initiativeId: work.initiativeId,
            assignmentId: work.assignmentId,
            requestPath: work.requestPath,
          },
        });
        const closed = await lab.closeStarterWork(closePlan);
        if (closed.status !== 'completed') {
          throw new Error(`Native Work close returned ${closed.status}`);
        }
        record({
          title: 'Independent review and native settlement',
          detail:
            'The read-only qualification reviewer passed; native receipts closed the Work.',
          tone: 'good',
        });
        await refreshWorks();
        await wait(700);

        setStep(6);
        const followupPlan = projects.prepareWork(
          'Publish the recovery checklist for the next operator',
          'A new captured Work remains visible beside the settled recovery Work',
        );
        await projects.captureWork(destination, followupPlan);
        const finalInventory = await refreshWorks();
        record({
          title: 'All Work inventory restored',
          detail: `${finalInventory.works.length} Works are visible: completed history plus the next captured outcome.`,
          tone: 'info',
        });
        await wait(1100);

        const evidence = {
          projectPath: destination,
          requestRoot: created.initialWork.requestRoot,
          failedAttempts: [
            disconnected.agentReport?.reportRoot,
            crashed.agentReport?.reportRoot,
          ],
          completedAttempt: completed.agentReport?.reportRoot,
          reviewRoot: review.receiptRoot,
          closeRoot: closed.receiptRoot,
          inventoryRoot: finalInventory.inventoryRoot,
        };
        const report = {
          schema: 'kungfu.project-work.tui-tour/v1' as const,
          status: 'qualified' as const,
          reportRoot: resultRoot(evidence),
          eventCount: 7,
          projectPath: destination,
          workCount: finalInventory.works.length,
        };
        if (active) onSettled({ state: 'completed', report });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record({ title: 'Tour stopped', detail: message, tone: 'bad' });
        await wait(500);
        if (active) onSettled({ state: 'failed', message });
      }
    })();
    return () => {
      active = false;
    };
  }, [destination, lab, onSettled, projects]);

  const fileWidth = Math.min(38, Math.max(24, Math.floor(columns * 0.26)));
  const workWidth = Math.min(48, Math.max(32, Math.floor(columns * 0.3)));
  return (
    <Box flexDirection="column" width={columns}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          Kungfu Project → Work → Agent · recovery tour
        </Text>
        <Text dimColor>
          {' '}
          STEP {Math.min(step + 1, 7)}/7 · {path.basename(destination)}
        </Text>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Box
          width={fileWidth}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Text bold>FILES</Text>
          {files.length === 0 ? (
            <Text dimColor>Creating Starter files…</Text>
          ) : (
            files.slice(0, 15).map((entry) => (
              <Text
                key={entry.relativePath}
                color={
                  entry.relativePath.includes('mock-agent-recovery')
                    ? 'green'
                    : undefined
                }
              >
                {treeLabel(entry)}
              </Text>
            ))
          )}
        </Box>
        <Box
          width={workWidth}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Text bold>PROJECT WORK</Text>
          {works.length === 0 ? (
            <Text dimColor>Loading captured Work…</Text>
          ) : (
            works.map((work, index) => (
              <Box
                key={`${work.initiativeId}:${work.assignmentId}`}
                flexDirection="column"
                marginTop={index ? 1 : 0}
              >
                <Text
                  color={
                    work.settled
                      ? 'green'
                      : work.phase === 'executing'
                        ? 'yellow'
                        : 'cyan'
                  }
                >
                  {work.settled ? '✓' : '●'} {work.title}
                </Text>
                <Text dimColor>
                  {' '}
                  {shortWorkState(work)} · {work.assignmentId}
                </Text>
              </Box>
            ))
          )}
        </Box>
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          <Text bold>RETAINED ATTEMPTS + SETTLEMENT</Text>
          {events.map((event, index) => (
            <Box
              key={`${event.title}:${index}`}
              flexDirection="column"
              marginTop={index ? 1 : 0}
            >
              <Text
                color={
                  event.tone === 'good'
                    ? 'green'
                    : event.tone === 'bad'
                      ? 'red'
                      : 'cyan'
                }
              >
                {event.tone === 'bad' ? '!' : '✓'} {event.title}
              </Text>
              <Text dimColor>{event.detail}</Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan">{status}</Text>
        <Text dimColor>
          {' '}
          Mock Agent is explicit; exit never grants completion authority.
        </Text>
      </Box>
    </Box>
  );
}
