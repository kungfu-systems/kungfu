// Shared inline styles for the reference app (dark, dense, monospace).
import type React from 'react';

export const panelStyle: React.CSSProperties = {
  background: '#252526',
  border: '1px solid #3c3c3c',
  borderRadius: 6,
  padding: 12,
  overflow: 'auto',
  minHeight: 0,
};

export const headingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#858585',
  margin: '0 0 8px 0',
};

export const mono: React.CSSProperties = {
  fontFamily: 'SF Mono, Menlo, monospace',
  fontSize: 12,
};

export const inputStyle: React.CSSProperties = {
  ...mono,
  padding: 4,
  background: '#1e1e1e',
  border: '1px solid #3c3c3c',
  borderRadius: 4,
  color: '#cccccc',
};
