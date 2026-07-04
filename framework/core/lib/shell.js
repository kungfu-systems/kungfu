// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GithubBinaryHost = 'https://prebuilt.libkungfu.io';
/**
 * Identity predicate used with Array#filter to drop null/undefined entries.
 * @template T
 * @param {T} e
 * @returns {T}
 */
const defined = (e) => e;

const utils = {
  /** @param {unknown} error */
  exitOnError: function (error) {
    console.error(error);
    process.exit(-1);
  },

  /** @param {string} npmConfigValue @returns {string} */
  getScope: function (npmConfigValue) {
    return npmConfigValue === 'undefined' ? '[package.json]' : '[user]';
  },

  /** @param {string} cmd @param {string[]} argv @param {{ silent?: boolean }} opts */
  trace: function (cmd, argv, opts) {
    if (!opts.silent) {
      console.log(`$ ${cmd} ${argv.join(' ')}`);
    }
  },

  getCoreGypDir: function () {
    const local = process.cwd().toString() === path.dirname(__dirname);
    return local ? '.gyp' : path.resolve(__dirname);
  },

  /** @param {string} key @returns {string} */
  getNpmConfigValue: function (key) {
    return shell.runAndCollect('npm', ['config', 'get', key], { silent: true })
      .out;
  },

  /**
   * Collect the package names in a package.json's dependency maps that
   * themselves declare a node-pre-gyp `binary` block.
   * @param {any} packageJson a parsed package.json (untyped shape)
   * @returns {string[]}
   */
  findBinaryDependency: function (packageJson) {
    /** @param {Record<string, string>} deps */
    const hasBinary = (deps) =>
      Object.keys(deps)
        .map((key) => {
          const dependency = shell.getPackageJson(key);
          if (dependency && dependency.binary) {
            return dependency.name;
          }
        })
        .filter(defined);
    return [
      packageJson.dependencies || {},
      packageJson.optionalDependencies || {},
      packageJson.devDependencies || {},
    ]
      .filter(defined)
      .map(hasBinary)
      .flat();
  },

  /** @param {string} [packageName] */
  setBinaryHostConfig: function (packageName) {
    const packageJson = shell.getPackageJson(packageName);
    if (!packageJson) {
      return;
    }
    if (packageJson.binary) {
      const key = `${packageJson.binary.module_name}_binary_host_mirror`;
      const binaryGithub = packageJson.binaryGithub;
      const override = binaryGithub && binaryGithub.host;
      const value = override ? binaryGithub.host : GithubBinaryHost;
      shell.npmCall(['config', 'set', key, value]);
    }
  },

  /** @param {string} key */
  showProjectConfig: function (key) {
    const packageJson = shell.getPackageJson();
    const projectName = packageJson.name;
    const npmConfigKey = `${projectName}:${key}`;
    const npmConfigValue = utils.getNpmConfigValue(npmConfigKey);
    const value =
      npmConfigValue === 'undefined' ? packageJson.config[key] : npmConfigValue;
    console.log(
      `[config] ${npmConfigKey} = ${value} ${utils.getScope(npmConfigValue)}`,
    );
  },

  /** @param {string} [packageName] */
  showBinaryHostConfig: function (packageName) {
    const packageJson = shell.getPackageJson(packageName);
    if (!packageJson) {
      return;
    }
    const key = packageJson.binary.module_name;
    const npmConfigKey = `${key}_binary_host_mirror`;
    const hostConfigValue = utils.getNpmConfigValue(npmConfigKey);
    const value =
      hostConfigValue === 'undefined' && packageJson
        ? packageJson.binary.host
        : hostConfigValue;
    console.log(
      `[binary] ${npmConfigKey} = ${value} ${utils.getScope(hostConfigValue)}`,
    );
  },
};

const shell = {
  /** @returns {string | undefined} */
  getElectronArch: function () {
    try {
      /** @type {any} electron's main-process require has no bundled types here */
      const electron = require('electron');
      const electronVersionScript = path.resolve(
        path.dirname(__dirname),
        '.gyp',
        'electron-version.js',
      );
      const isLinux = process.platform === 'linux';
      const electronArgs = isLinux ? ['--no-sandbox'] : [];
      const result = shell.runAndCollect(
        electron,
        [...electronArgs, electronVersionScript],
        {
          silent: true,
        },
      ).out;
      /** @param {string | undefined} arch */
      const resolveHeadless = (arch) => {
        return arch || shell.getTargetArch();
      };
      return isLinux ? resolveHeadless(result) : result;
    } catch (e) {
      return undefined;
    }
  },

  /** @returns {string} */
  getTargetArch: function () {
    // tracing-foundation Phase 1: config.arch 未显式设置时回退到宿主架构(process.arch)。
    // 原 config 硬编码 'x64'(x64 时代),在 arm64 机器上会误判;回退使本机构建自动匹配
    // (Mac arm64 / Linux·Win x64),同时保留显式 config.arch 以支持交叉编译目标。
    return (
      shell.getPackageJson('@kungfu-tech/core').config.arch || process.arch
    );
  },

  /**
   * Read and parse a package.json: the current working dir's when no name is
   * given, otherwise the named package's (resolved via require.resolve).
   * @param {string} [packageName]
   * @returns {any} parsed package.json, or undefined if the named one is unresolvable
   */
  getPackageJson: function (packageName) {
    /** @param {string} filepath */
    const toJSON = (filepath) => {
      return JSON.parse(fs.readFileSync(filepath, 'utf8').toString());
    };
    if (!packageName) {
      return toJSON(path.resolve(process.cwd().toString(), 'package.json'));
    }
    try {
      return toJSON(require.resolve(`${packageName}/package.json`));
    } catch (e) {
      return undefined;
    }
  },

  /** @param {string} name @returns {string | undefined} */
  getConfigValue: function (name) {
    return process.env[`npm_package_config_${name}`];
  },

  /** @param {string[]} npmArgs */
  npmCall: function (npmArgs) {
    return shell.run('npm', npmArgs);
  },

  verifyElectron: function () {
    const electronArch = shell.getElectronArch();
    const targetArch = shell.getTargetArch();
    if (electronArch === targetArch) {
      return;
    }
    console.error(
      `Electron arch ${electronArch} does not match target ${targetArch}`,
    );
    console.log(`Try to fix it by reinstall electron [${targetArch}]`);
    try {
      const electronModulePath = path.dirname(
        require.resolve('electron/package.json'),
      );
      fs.rmSync(electronModulePath, {
        force: true,
        recursive: true,
      });
    } catch (e) {
      console.warn('Failed to remove electron module');
    }
    shell.run('pnpm', ['install', '--frozen-lockfile', '--silent'], true, {
      silent: true,
      env: {
        ...process.env,
        npm_config_arch: targetArch,
      },
    });
    const reinstalledElectronArch = shell.getElectronArch();
    console.log(`Reinstall electron [${reinstalledElectronArch}] done`);
    if (reinstalledElectronArch !== targetArch) {
      console.error(
        `Reinstall electron [${reinstalledElectronArch}] failed to match [${targetArch}]`,
      );
      console.error(
        `Please fix it manually by pnpm install with environment variable npm_config_arch set to ${targetArch}`,
      );
      process.exit(-1);
    }
  },

  /**
   * spawnSync a command with the shell, inheriting stdio, from the real
   * (symlink-resolved) cwd. When `check` is set, exit the process on a non-zero
   * status unless `opts.tolerant` is set.
   * @param {string} cmd
   * @param {string[]} [argv]
   * @param {boolean} [check]
   * @param {import('child_process').SpawnSyncOptions & { silent?: boolean, tolerant?: boolean }} [opts]
   * @returns {import('child_process').SpawnSyncReturns<string | Buffer>}
   */
  run: function (cmd, argv = [], check = true, opts = {}) {
    const real_cwd = fs.realpathSync(path.resolve(process.cwd().toString()));
    utils.trace(cmd, argv, opts);
    const result = spawnSync(cmd, argv, {
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
      cwd: real_cwd,
      ...opts,
    });
    if (check && result.status !== 0) {
      // status is null when the child was terminated by a signal; keep the
      // original runtime behaviour (process.exit(null) === exit code 0).
      process.exit(opts.tolerant ? 0 : (result.status ?? 0));
    }
    return result;
  },

  /**
   * Like `run` but pipes stdout and returns it, trimmed, as an extra `out`
   * field on the spawn result.
   * @param {string} cmd
   * @param {string[]} [argv]
   * @param {import('child_process').SpawnSyncOptions & { silent?: boolean }} [opts]
   * @returns {import('child_process').SpawnSyncReturns<string | Buffer> & { out: string }}
   */
  runAndCollect: function (cmd, argv = [], opts = {}) {
    utils.trace(cmd, argv, opts);
    const result = spawnSync(cmd, argv, {
      shell: true,
      stdio: 'pipe',
      windowsHide: true,
      ...opts,
    });
    const out = result.stdout.toString().trim();
    return Object.assign(result, { out });
  },

  /**
   * Run a command; if it succeeds, exit the process with code 0, otherwise
   * return the spawn result for the caller to handle.
   * @param {string} cmd
   * @param {string[]} [argv]
   * @param {import('child_process').SpawnSyncOptions & { silent?: boolean, tolerant?: boolean }} [opts]
   */
  runAndExit: function (cmd, argv = [], opts = {}) {
    const result = shell.run(cmd, argv, false, opts);
    if (result.status === 0) {
      process.exit(0);
    }
    return result;
  },

  setAutoConfig: function () {
    const isGithubEnv = () => process.env.CI && process.env.GITHUB_ACTIONS;
    if (!isGithubEnv()) {
      return;
    }
    const packageJson = shell.getPackageJson();
    if (packageJson.configGithub) {
      Object.keys(packageJson.configGithub).forEach((key) => {
        shell.npmCall([
          'config',
          'set',
          `${packageJson.name}:${key}`,
          packageJson.configGithub[key],
        ]);
      });
    }
    if (packageJson.binary) {
      utils.setBinaryHostConfig();
    }
    utils.findBinaryDependency(packageJson).map(utils.setBinaryHostConfig);
  },

  showAutoConfig: function () {
    const packageJson = shell.getPackageJson();
    if (packageJson.config) {
      Object.keys(packageJson.config).map(utils.showProjectConfig);
    }
    if (packageJson.binary) {
      utils.showBinaryHostConfig();
    }
    utils.findBinaryDependency(packageJson).map(utils.showBinaryHostConfig);
  },

  /** @param {string} filename @param {string} [dirname] */
  touch: function (filename, dirname = process.cwd().toString()) {
    const now = new Date();
    const filepath = path.resolve(dirname, filename);
    fs.utimesSync(filepath, now, now);
  },

  utils: utils,
};

module.exports = shell;
