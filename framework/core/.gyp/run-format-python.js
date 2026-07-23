// SPDX-License-Identifier: Apache-2.0

const path = require('node:path');
const { shell } = require('../lib');

function main(argv) {
  // uv 接管 env（承接 buildchain uv 迁移）：经 uv 项目 venv 跑 ruff format。
  // S1：python 格式器 black→ruff（ruff format 兼容 black，配置见 pyproject [tool.ruff]）。
  process.chdir(path.dirname(__dirname));
  shell.runAndExit('uv', ['run', '--frozen', 'ruff', 'format', ...argv]);
}

module.exports.main = main;

if (require.main === module) {
  main(process.argv.slice(2));
}
