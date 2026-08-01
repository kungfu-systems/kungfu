// SPDX-License-Identifier: Apache-2.0

import type { GlobalWorkRow } from '@kungfu-tech/api/capability';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';

import { assignmentSelector } from './project-work-run';

export function resolveSelectedProjectWorkRow(
  rows: GlobalWorkRow[],
  visibleRows: GlobalWorkRow[],
  selectedRoot: string | null,
  selectedAssignmentId: string | null,
): GlobalWorkRow | null {
  return (
    rows.find((row) => row.canonical_root === selectedRoot) ??
    (selectedAssignmentId
      ? rows.find(
          (row) => assignmentSelector(row.subject) === selectedAssignmentId,
        )
      : undefined) ??
    visibleRows[0] ??
    null
  );
}

export function ProjectWorkList({
  rows,
  currentRoot,
  compact = false,
  onSelect,
}: {
  rows: GlobalWorkRow[];
  currentRoot?: string;
  compact?: boolean;
  onSelect: (row: GlobalWorkRow) => void;
}) {
  return (
    <section
      aria-label="Work list"
      style={
        compact
          ? {
              flex: 1,
              minHeight: 100,
              overflow: 'auto',
              border: '1px solid #3c3c3c',
              borderRadius: 6,
              padding: 4,
              background: '#1e1e1e',
            }
          : {
              ...panelStyle,
              width: 460,
              overflow: 'auto',
              flexShrink: 0,
            }
      }
    >
      {rows.map((row) => (
        <button
          type="button"
          key={row.canonical_root}
          onClick={() => onSelect(row)}
          style={{
            ...mono,
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: compact ? '7px 6px' : 8,
            marginBottom: 3,
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            background:
              currentRoot === row.canonical_root ? '#04395e' : 'transparent',
            color: '#cccccc',
          }}
        >
          <span style={{ color: row.conflict ? '#f48771' : '#4ec9b0' }}>
            [{row.display.status || row.display.portfolio_state || 'open'}]
          </span>{' '}
          {row.display.title || row.subject}
          <div
            style={{
              color: '#858585',
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.observations
              .map((item) => item.workspace_id)
              .filter(Boolean)
              .join(' · ')}
          </div>
        </button>
      ))}
      {rows.length === 0 ? (
        <div style={{ ...mono, color: '#6a6a6a', padding: 8 }}>
          No Work matches this view.
        </div>
      ) : null}
    </section>
  );
}
