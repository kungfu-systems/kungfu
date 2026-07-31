import { mono } from '@kungfu-tech/kfx';
import React from 'react';

export interface ProductNavigationItem {
  id: string;
  title: string;
  icon: string;
}

export interface ProductNavigationFailure {
  dir: string;
  error: string;
}

interface ProductNavigationProps {
  collapsed: boolean;
  activeViewId?: string;
  labOpen: boolean;
  projectsOpen: boolean;
  publicItems: ProductNavigationItem[];
  advancedItems: ProductNavigationItem[];
  failures: ProductNavigationFailure[];
  onToggle: () => void;
  onOpenView: (id: string) => void;
  onOpenProjects: () => void;
  onOpenLab: () => void;
}

export function ProductNavigation({
  collapsed,
  activeViewId,
  labOpen,
  projectsOpen,
  publicItems,
  advancedItems,
  failures,
  onToggle,
  onOpenView,
  onOpenProjects,
  onOpenLab,
}: ProductNavigationProps) {
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const navStyle = (active: boolean): React.CSSProperties => ({
    ...mono,
    display: 'grid',
    gridTemplateColumns: collapsed ? '1fr' : '18px minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: collapsed ? 0 : 8,
    width: '100%',
    height: 32,
    boxSizing: 'border-box',
    textAlign: collapsed ? 'center' : 'left',
    padding: collapsed ? 0 : '6px 10px',
    border: 'none',
    borderRadius: 5,
    cursor: 'pointer',
    background: active ? '#04395e' : 'transparent',
    color: active ? '#9cdcfe' : '#cccccc',
    overflow: 'hidden',
  });
  const iconStyle: React.CSSProperties = {
    width: 18,
    height: 18,
    lineHeight: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    justifySelf: 'center',
    overflow: 'hidden',
    fontSize: 16,
  };
  const labelStyle: React.CSSProperties = {
    minWidth: 0,
    height: 18,
    lineHeight: '18px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const button = (
    item: ProductNavigationItem,
    active: boolean,
    onClick: () => void,
  ) => (
    <button
      key={item.id}
      type="button"
      onClick={onClick}
      title={item.title}
      aria-label={item.title}
      aria-current={active ? 'page' : undefined}
      style={navStyle(active)}
    >
      <span aria-hidden="true" style={iconStyle}>
        {item.icon}
      </span>
      {!collapsed && <span style={labelStyle}>{item.title}</span>}
    </button>
  );
  const ordinaryView = !labOpen && !projectsOpen;

  return (
    <nav
      aria-label="Views"
      style={{
        width: collapsed ? 44 : 150,
        flexShrink: 0,
        minHeight: 0,
        overflow: 'auto',
        overflowX: 'hidden',
        transition: 'width 120ms ease',
      }}
    >
      <button
        type="button"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={onToggle}
        style={{
          ...mono,
          width: '100%',
          height: 32,
          marginBottom: 8,
          border: '1px solid #3c3c3c',
          borderRadius: 5,
          cursor: 'pointer',
          background: '#252526',
          color: '#cccccc',
          fontSize: 14,
        }}
      >
        {collapsed ? '›' : '‹'}
      </button>
      {publicItems.map((item) =>
        button(item, ordinaryView && activeViewId === item.id, () =>
          onOpenView(item.id),
        ),
      )}
      {button(
        { id: 'projects', title: 'Projects', icon: '◫' },
        projectsOpen,
        onOpenProjects,
      )}
      {button(
        { id: 'agent-work-lab', title: 'Agent Work Lab', icon: '🧪' },
        labOpen,
        onOpenLab,
      )}
      {!collapsed && advancedItems.length > 0 ? (
        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          style={{
            ...mono,
            width: '100%',
            minHeight: 30,
            marginTop: 12,
            border: 'none',
            background: 'transparent',
            color: '#858585',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {advancedOpen ? '▾' : '▸'} Advanced
        </button>
      ) : null}
      {advancedOpen
        ? advancedItems.map((item) =>
            button(item, ordinaryView && activeViewId === item.id, () =>
              onOpenView(item.id),
            ),
          )
        : null}
      {failures.length > 0 ? (
        <div
          title={failures
            .map((failure) => `${failure.dir}: ${failure.error}`)
            .join('\n')}
          style={{
            ...mono,
            color: '#f48771',
            marginTop: 12,
            fontSize: 10,
            textAlign: collapsed ? 'center' : 'left',
          }}
        >
          {collapsed ? '!' : `${failures.length} kfx failed to load`}
        </div>
      ) : null}
    </nav>
  );
}
