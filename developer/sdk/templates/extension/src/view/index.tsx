// __EXT_NAME__ — a Kungfu view extension.
//
// The bundle exports exactly one thing: the View component. Everything
// static about the view (title, capability handles, settings) lives in
// package.json under `kungfuConfig.config.view`; the shell reads it without
// executing code, and at load time injects the declared capability handles
// plus its own react instance. Declare capabilities in the manifest and they
// arrive here as `caps.<name>`.
import type { KfxViewProps } from '@kungfu-tech/kfx';
import { headingStyle, mono, panelStyle } from '@kungfu-tech/kfx';

export function View({ shell }: KfxViewProps) {
  return (
    <div style={panelStyle}>
      <h2 style={headingStyle}>__EXT_NAME__</h2>
      <div style={mono}>
        runtime {shell.info.kfcVersion || 'n/a'} · profile{' '}
        {shell.state.profileId}
      </div>
    </div>
  );
}
