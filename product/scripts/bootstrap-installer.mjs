#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalBytes, contentRoot } from './release-channel-index.mjs';

export const BOOTSTRAP_PUBLICATION_SCHEMA =
  'kungfu.bootstrap-installer-publication/v1';

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function shellLiteral(value) {
  requiredString(value, 'shell literal');
  if (/[\r\n\0]/.test(value)) throw new Error('shell literal is unsafe');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellLiteral(value) {
  requiredString(value, 'PowerShell literal');
  if (/[\r\n\0]/.test(value)) throw new Error('PowerShell literal is unsafe');
  return `'${value.replaceAll("'", "''")}'`;
}

function cliArtifact(entry) {
  const artifacts = entry.manifest?.artifacts?.filter(
    (artifact) => artifact.kind === 'cli',
  );
  if (artifacts?.length !== 1) {
    throw new Error('bootstrap release must bind exactly one CLI artifact');
  }
  const artifact = artifacts[0];
  if (
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') ||
    !artifact.signature ||
    artifact.signature === 'unqualified-local-build'
  ) {
    throw new Error('bootstrap CLI artifact is not publication-qualified');
  }
  const url = new URL(requiredString(artifact.url, 'CLI artifact URL'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search) {
    throw new Error('bootstrap CLI artifact must use public HTTPS');
  }
  return artifact;
}

function verifyChannel(index, trustedKeys) {
  if (index?.schema !== 'kungfu.release-channel-index/v1') {
    throw new Error('unsupported release channel index');
  }
  const signature = index.signature;
  const publicKey = trustedKeys?.[signature?.keyId];
  if (
    signature?.algorithm !== 'ed25519' ||
    !publicKey ||
    typeof signature.value !== 'string'
  ) {
    throw new Error('release channel signature has no trusted key');
  }
  const signed = Object.fromEntries(
    Object.entries(index).filter(([key]) => key !== 'signature'),
  );
  const payload = Object.fromEntries(
    Object.entries(signed).filter(([key]) => key !== 'payloadRoot'),
  );
  if (contentRoot(payload) !== index.payloadRoot) {
    throw new Error('release channel payload root mismatch');
  }
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKey, 'base64'),
    ]),
    format: 'der',
    type: 'spki',
  });
  if (
    !verify(
      null,
      canonicalBytes(signed),
      key,
      Buffer.from(signature.value, 'base64'),
    )
  ) {
    throw new Error('release channel signature did not verify');
  }
}

function publicationEntries(index, channel) {
  const identities = new Set();
  return index.entries
    .filter(
      (entry) =>
        entry.channel === channel &&
        entry.installSource === 'archive' &&
        entry.rollout === 'current',
    )
    .map((entry) => {
      const identity = `${entry.platform}/${entry.architecture}`;
      if (
        !['darwin', 'linux', 'win32'].includes(entry.platform) ||
        !['arm64', 'x64'].includes(entry.architecture)
      ) {
        throw new Error(`unsupported bootstrap target: ${identity}`);
      }
      if (identities.has(identity)) {
        throw new Error(`ambiguous bootstrap target: ${identity}`);
      }
      identities.add(identity);
      const artifact = cliArtifact(entry);
      if (
        entry.manifest.releaseChannel !== channel ||
        entry.manifest.sourceCommit !== index.sourceCommit ||
        contentRoot(entry.manifest) !== entry.manifestRoot
      ) {
        throw new Error(`bootstrap release identity mismatch: ${identity}`);
      }
      if (
        !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(
          entry.manifest.productVersion || '',
        )
      ) {
        throw new Error(`unsafe bootstrap product version: ${identity}`);
      }
      const archiveName = new URL(artifact.url).pathname.split('/').pop();
      const archiveBase = archiveName.replace(/\.(?:tar\.gz|zip)$/, '');
      if (
        !archiveName ||
        archiveBase === archiveName ||
        !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(archiveBase)
      ) {
        throw new Error(`unsupported bootstrap archive name: ${archiveName}`);
      }
      if (
        (entry.platform === 'win32' && !archiveName.endsWith('.zip')) ||
        (entry.platform !== 'win32' && !archiveName.endsWith('.tar.gz'))
      ) {
        throw new Error(
          `bootstrap archive format does not match target: ${identity}`,
        );
      }
      return {
        platform: entry.platform,
        architecture: entry.architecture,
        version: entry.manifest.productVersion,
        sourceCommit: index.sourceCommit,
        manifestRoot: entry.manifestRoot,
        artifactRoot: entry.artifactRoot,
        artifactUrl: artifact.url,
        artifactSize: artifact.size,
        artifactDigest: artifact.digest,
        artifactSignature: artifact.signature,
        archiveName,
        archiveBase,
      };
    })
    .sort((left, right) =>
      `${left.platform}/${left.architecture}`.localeCompare(
        `${right.platform}/${right.architecture}`,
      ),
    );
}

function posixCases(entries) {
  return entries
    .filter((entry) => entry.platform !== 'win32')
    .map(
      (entry) => `  ${entry.platform}/${entry.architecture})
    version=${shellLiteral(entry.version)}
    source_commit=${shellLiteral(entry.sourceCommit)}
    manifest_root=${shellLiteral(entry.manifestRoot)}
    artifact_root=${shellLiteral(entry.artifactRoot)}
    artifact_url=${shellLiteral(entry.artifactUrl)}
    artifact_size=${shellLiteral(String(entry.artifactSize))}
    artifact_digest=${shellLiteral(entry.artifactDigest.slice(7))}
    archive_name=${shellLiteral(entry.archiveName)}
    archive_base=${shellLiteral(entry.archiveBase)}
    ;;`,
    )
    .join('\n');
}

function posixInstaller({
  channel,
  channelUrl,
  channelSha256,
  keyId,
  publicKey,
  entries,
}) {
  return `#!/bin/sh
# Generated from one signed Kungfu release channel. Do not edit.
set -eu

channel=${shellLiteral(channel)}
channel_url=${shellLiteral(channelUrl)}
channel_sha256=${shellLiteral(channelSha256)}
trusted_key=${shellLiteral(`${keyId}=${publicKey}`)}
install_root=\${XDG_DATA_HOME:-"$HOME/.local/share"}/kungfu/product
bin_dir="$HOME/.local/bin"
dry_run=0
verbose=0
requested_channel="$channel"
requested_version=

usage() {
  printf '%s\\n' "usage: install.sh [--channel ${channel}] [--version VERSION] [--install-dir DIR] [--bin-dir DIR] [--no-path] [--dry-run] [--yes] [--ci] [--verbose]"
}
log() { printf '%s\\n' "kungfu-install: $*" >&2; }
debug() { [ "$verbose" -eq 0 ] || log "$@"; }
fail() { log "error[$1]: $2"; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel) [ "$#" -ge 2 ] || fail option-missing "--channel needs a value"; requested_channel=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || fail option-missing "--version needs a value"; requested_version=$2; shift 2 ;;
    --install-dir) [ "$#" -ge 2 ] || fail option-missing "--install-dir needs a value"; install_root=$2; shift 2 ;;
    --bin-dir) [ "$#" -ge 2 ] || fail option-missing "--bin-dir needs a value"; bin_dir=$2; shift 2 ;;
    --no-path|--yes|--ci|--non-interactive) shift ;;
    --dry-run) dry_run=1; shift ;;
    --verbose) verbose=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail option-unknown "unknown option: $1" ;;
  esac
done
[ "$requested_channel" = "$channel" ] || fail channel-unavailable "this installer is pinned to $channel"

os=$(uname -s 2>/dev/null || true)
case "$os" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail unsupported-platform "supported systems are macOS and Linux" ;; esac
machine=$(uname -m 2>/dev/null || true)
case "$machine" in arm64|aarch64) architecture=arm64 ;; x86_64|amd64) architecture=x64 ;; *) fail unsupported-architecture "unsupported architecture: $machine" ;; esac
if [ "$platform" = linux ]; then
  libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 | head -1 || true)
  case "$libc" in *glibc*|*"GNU libc"*|*GLIBC*) ;; *) fail unsupported-libc "the advertised Linux archive requires glibc" ;; esac
fi

case "$platform/$architecture" in
${posixCases(entries)}
  *) fail unsupported-target "no signed $channel archive exists for $platform/$architecture" ;;
esac
[ -z "$requested_version" ] || [ "$requested_version" = "$version" ] || fail version-unavailable "this immutable installer selects $version"

launcher="$bin_dir/kungfu"
version_key=$(printf '%s' "$manifest_root" | cut -c8-23)
version_root="$install_root/versions/$version-$version_key"
log "plan: $channel $version ($source_commit) $platform/$architecture -> $version_root"
if [ "$dry_run" -eq 1 ]; then exit 0; fi

command -v curl >/dev/null 2>&1 || fail prerequisite-missing "curl is required"
command -v tar >/dev/null 2>&1 || fail prerequisite-missing "tar is required"
if command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{print $1}'; }
else
  fail prerequisite-missing "shasum or sha256sum is required"
fi
existing=$(command -v kungfu 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "$launcher" ]; then
  fail ownership-conflict "existing Kungfu is owned outside $launcher: $existing"
fi
if [ -e "$launcher" ] && [ ! -L "$launcher" ]; then
  fail ownership-conflict "$launcher is not owned by the Kungfu archive installer"
fi
mkdir -p "$install_root/versions" "$bin_dir"
lock="$install_root/.bootstrap-install.lock"
mkdir "$lock" 2>/dev/null || fail concurrent-install "another Kungfu installer owns $lock"
stage="$install_root/.bootstrap-stage.$$"
cleanup() { rm -rf "$stage"; rmdir "$lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
[ ! -e "$stage" ] || fail staging-conflict "staging path already exists: $stage"
umask 077
mkdir "$stage" "$stage/download" "$stage/extract"

channel_file="$stage/download/channel.json"
archive_file="$stage/download/$archive_name"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$channel_file" "$channel_url" ||
  fail channel-download-failed "could not download signed channel"
observed_channel=$(sha256_file "$channel_file")
[ "$observed_channel" = "$channel_sha256" ] || fail channel-byte-mismatch "channel bytes differ from the reviewed installer"

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$archive_file" "$artifact_url" ||
  fail artifact-download-failed "could not download CLI archive"
observed_size=$(wc -c < "$archive_file" | tr -d ' ')
[ "$observed_size" = "$artifact_size" ] || fail artifact-size-mismatch "CLI archive size differs from signed evidence"
observed_digest=$(sha256_file "$archive_file")
[ "$observed_digest" = "$artifact_digest" ] || fail artifact-digest-mismatch "CLI archive digest differs from signed evidence"

tar -tzf "$archive_file" | awk '
  /^\\// || /(^|\\/)\\.\\.(\\/|$)/ { exit 1 }
  { count += 1 }
  END { if (count == 0) exit 1 }
' || fail archive-unsafe "CLI archive contains an unsafe or empty path set"
tar -xzf "$archive_file" -C "$stage/extract" || fail archive-invalid "CLI archive could not be extracted"
candidate="$stage/extract/$archive_base"
[ -f "$candidate/product.json" ] || fail product-manifest-missing "CLI product manifest is missing"
[ -x "$candidate/runtime/kungfu" ] || fail runtime-missing "CLI runtime is missing"
platform_trust=signed-channel-digest
if [ "$platform" = darwin ]; then
  codesign --verify --deep --strict "$candidate/runtime/kungfu" >/dev/null 2>&1 ||
    fail platform-trust-failed "macOS code signature did not verify"
  platform_trust=codesign-valid
fi

mkdir -p "$candidate/install"
"$candidate/kungfu" update bootstrap-verify "$channel_file" "$archive_file" "$candidate" \\
  --channel "$channel" --platform "$platform" --architecture "$architecture" \\
  --version "$version" --manifest-root "$manifest_root" --artifact-root "$artifact_root" \\
  --platform-trust "$platform_trust" --trusted-key "$trusted_key" \\
  > "$candidate/install/bootstrap-receipt.json" ||
  fail signed-authority-mismatch "staged CLI did not verify the signed channel and release identity"

if [ -d "$version_root" ]; then
  debug "verified version already installed"
else
  mv "$candidate" "$version_root" || fail activation-failed "could not publish the verified version"
fi
temporary_link="$bin_dir/.kungfu.bootstrap.$$"
ln -s "$version_root/kungfu" "$temporary_link"
mv -f "$temporary_link" "$launcher"
trap - EXIT HUP INT TERM
cleanup
log "installed: $launcher"
log "PATH was not modified; add $bin_dir explicitly if it is not already present"
`;
}

function powershellCases(entries) {
  return entries
    .filter((entry) => entry.platform === 'win32')
    .map(
      (entry) => `  '${entry.architecture}' {
    $Architecture = ${powershellLiteral(entry.architecture)}
    $Version = ${powershellLiteral(entry.version)}
    $SourceCommit = ${powershellLiteral(entry.sourceCommit)}
    $ManifestRoot = ${powershellLiteral(entry.manifestRoot)}
    $ArtifactRoot = ${powershellLiteral(entry.artifactRoot)}
    $ArtifactUrl = ${powershellLiteral(entry.artifactUrl)}
    $ArtifactSize = [int64]${entry.artifactSize}
    $ArtifactDigest = ${powershellLiteral(entry.artifactDigest.slice(7))}
    $ArchiveName = ${powershellLiteral(entry.archiveName)}
    $ArchiveBase = ${powershellLiteral(entry.archiveBase)}
  }`,
    )
    .join('\n');
}

function powershellInstaller({
  channel,
  channelUrl,
  channelSha256,
  keyId,
  publicKey,
  entries,
}) {
  return `# Generated from one signed Kungfu release channel. Do not edit.
[CmdletBinding()]
param(
  [ValidateSet('alpha','stable')][string]$Channel = ${powershellLiteral(channel)},
  [string]$Version,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Kungfu\\product'),
  [string]$BinDir = (Join-Path $env:LOCALAPPDATA 'Kungfu\\bin'),
  [switch]$NoPath,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$CI
)
$ErrorActionPreference = 'Stop'
$RequestedVersion = $Version
if ($Channel -ne ${powershellLiteral(channel)}) { throw 'error[channel-unavailable]: this installer is pinned to ${channel}' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'error[unsupported-platform]: 64-bit Windows is required' }
switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
${powershellCases(entries)}
  default { throw "error[unsupported-architecture]: no signed archive exists for $_" }
}
if ($RequestedVersion -and $RequestedVersion -ne $Version) { throw "error[version-unavailable]: this immutable installer selects $Version" }
$ChannelUrl = ${powershellLiteral(channelUrl)}
$ChannelSha256 = ${powershellLiteral(channelSha256)}
$TrustedKey = ${powershellLiteral(`${keyId}=${publicKey}`)}
$VersionKey = $ManifestRoot.Substring(7, 16)
$VersionRoot = Join-Path $InstallDir "versions\\$Version-$VersionKey"
$Launcher = Join-Path $BinDir 'kungfu.cmd'
Write-Host "kungfu-install: plan: $Channel $Version win32/$Architecture -> $VersionRoot"
if ($DryRun) { exit 0 }

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'versions'), $BinDir | Out-Null
$Existing = Get-Command kungfu -ErrorAction SilentlyContinue
if ($Existing -and $Existing.Source -ne $Launcher) {
  throw "error[ownership-conflict]: existing Kungfu is owned outside $Launcher: $($Existing.Source)"
}
if (Test-Path $Launcher) {
  $firstLine = Get-Content -LiteralPath $Launcher -TotalCount 1
  if ($firstLine -ne '@rem kungfu-archive-bootstrap/v1') { throw "error[ownership-conflict]: $Launcher is not owned by the Kungfu archive installer" }
}
$Lock = Join-Path $InstallDir '.bootstrap-install.lock'
try { New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null }
catch { throw "error[concurrent-install]: another Kungfu installer owns $Lock" }
$Stage = Join-Path $InstallDir ".bootstrap-stage.$([Guid]::NewGuid().ToString('N'))"
try {
  New-Item -ItemType Directory -Path $Stage | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $Stage 'download'), (Join-Path $Stage 'extract') | Out-Null
  $ChannelFile = Join-Path $Stage 'download\\channel.json'
  $ArchiveFile = Join-Path $Stage "download\\$ArchiveName"
  Invoke-WebRequest -UseBasicParsing -Uri $ChannelUrl -OutFile $ChannelFile
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ChannelFile).Hash.ToLowerInvariant() -ne $ChannelSha256) {
    throw 'error[channel-byte-mismatch]: channel bytes differ from the reviewed installer'
  }
  Invoke-WebRequest -UseBasicParsing -Uri $ArtifactUrl -OutFile $ArchiveFile
  $Archive = Get-Item -LiteralPath $ArchiveFile
  if ($Archive.Length -ne $ArtifactSize) { throw 'error[artifact-size-mismatch]: CLI archive size differs from signed evidence' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ArchiveFile).Hash.ToLowerInvariant() -ne $ArtifactDigest) {
    throw 'error[artifact-digest-mismatch]: CLI archive digest differs from signed evidence'
  }
  Expand-Archive -LiteralPath $ArchiveFile -DestinationPath (Join-Path $Stage 'extract')
  $Candidate = Join-Path $Stage "extract\\$ArchiveBase"
  $Runtime = Join-Path $Candidate 'runtime\\kungfu.exe'
  $Signature = Get-AuthenticodeSignature -LiteralPath $Runtime
  if ($Signature.Status -ne 'Valid') { throw "error[platform-trust-failed]: Windows Authenticode status is $($Signature.Status)" }
  New-Item -ItemType Directory -Force -Path (Join-Path $Candidate 'install') | Out-Null
  $Receipt = Join-Path $Candidate 'install\\bootstrap-receipt.json'
  $ReceiptJson = & (Join-Path $Candidate 'kungfu.cmd') update bootstrap-verify $ChannelFile $ArchiveFile $Candidate \`
    --channel $Channel --platform win32 --architecture $Architecture --version $Version \`
    --manifest-root $ManifestRoot --artifact-root $ArtifactRoot --platform-trust authenticode-valid \`
    --trusted-key $TrustedKey
  if ($LASTEXITCODE -ne 0) { throw 'error[signed-authority-mismatch]: staged CLI did not verify release authority' }
  [IO.File]::WriteAllText(
    $Receipt,
    (($ReceiptJson -join [Environment]::NewLine) + [Environment]::NewLine),
    (New-Object Text.UTF8Encoding($false))
  )
  if (-not (Test-Path $VersionRoot)) { Move-Item -LiteralPath $Candidate -Destination $VersionRoot }
  $Temporary = "$Launcher.$PID.tmp"
  "@rem kungfu-archive-bootstrap/v1\`r\`n@call \`"$VersionRoot\\kungfu.cmd\`" %*\`r\`n" | Set-Content -LiteralPath $Temporary -Encoding Ascii
  Move-Item -Force -LiteralPath $Temporary -Destination $Launcher
  Write-Host "kungfu-install: installed: $Launcher"
  Write-Host "kungfu-install: PATH, profiles, registry, services, and scheduled tasks were not modified"
}
finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $Stage
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Lock
}
`;
}

export function buildBootstrapInstallerPublication({
  channelIndex,
  trustedKeys,
  channel,
  channelUrl,
  canonicalBaseUrl = 'https://kungfu.tech',
  installerVersion = 'v1',
}) {
  if (!['alpha', 'stable'].includes(channel)) {
    throw new Error(`unsupported bootstrap channel: ${channel}`);
  }
  const parsedChannelUrl = new URL(channelUrl);
  if (parsedChannelUrl.protocol !== 'https:' || parsedChannelUrl.search) {
    throw new Error('channelUrl must be public HTTPS without query parameters');
  }
  verifyChannel(channelIndex, trustedKeys);
  const entries = publicationEntries(channelIndex, channel);
  if (!entries.length)
    throw new Error(`channel has no current archive entries: ${channel}`);
  const keyId = channelIndex.signature.keyId;
  const publicKey = trustedKeys[keyId];
  const channelBytes = Buffer.concat([
    canonicalBytes(channelIndex),
    Buffer.from('\n'),
  ]);
  const channelSha256 = sha256Bytes(channelBytes);
  const posix = posixInstaller({
    channel,
    channelUrl,
    channelSha256,
    keyId,
    publicKey,
    entries,
  });
  const powershell = powershellInstaller({
    channel,
    channelUrl,
    channelSha256,
    keyId,
    publicKey,
    entries,
  });
  const versionPath = `installers/${installerVersion}/${channel}/${channelIndex.payloadRoot.slice(7, 23)}`;
  const assets = [
    {
      name: 'install.sh',
      contentType: 'text/x-shellscript; charset=utf-8',
      bytes: Buffer.from(posix),
    },
    {
      name: 'install.ps1',
      contentType: 'text/plain; charset=utf-8',
      bytes: Buffer.from(powershell),
    },
  ].map((asset) => ({
    ...asset,
    size: asset.bytes.length,
    digest: `sha256:${sha256Bytes(asset.bytes)}`,
    immutableUrl: `${canonicalBaseUrl}/${versionPath}/${asset.name}`,
    friendlyUrl: `${canonicalBaseUrl}/${asset.name}`,
  }));
  return {
    schema: BOOTSTRAP_PUBLICATION_SCHEMA,
    installerVersion,
    channel,
    sourceCommit: channelIndex.sourceCommit,
    channelUrl,
    channelPayloadRoot: channelIndex.payloadRoot,
    channelFileDigest: `sha256:${channelSha256}`,
    releasePassport: channelIndex.releasePassport,
    immutablePath: versionPath,
    entries,
    assets,
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--channel-index') options.channelIndex = args[++index];
    else if (value === '--trusted-keys') options.trustedKeys = args[++index];
    else if (value === '--channel') options.channel = args[++index];
    else if (value === '--channel-url') options.channelUrl = args[++index];
    else if (value === '--canonical-base-url')
      options.canonicalBaseUrl = args[++index];
    else if (value === '--output') options.output = args[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  for (const name of [
    'channelIndex',
    'trustedKeys',
    'channel',
    'channelUrl',
    'output',
  ]) {
    if (!options[name]) {
      throw new Error(
        `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`,
      );
    }
  }
  return options;
}

function writeBootstrapInstallerPublication(options) {
  const output = path.resolve(options.output);
  const channelIndex = JSON.parse(
    fs.readFileSync(path.resolve(options.channelIndex), 'utf8'),
  );
  const trustedValue = JSON.parse(
    fs.readFileSync(path.resolve(options.trustedKeys), 'utf8'),
  );
  const trustedKeys = Array.isArray(trustedValue)
    ? Object.fromEntries(trustedValue.map((key) => [key.keyId, key.publicKey]))
    : trustedValue;
  const publication = buildBootstrapInstallerPublication({
    channelIndex,
    trustedKeys,
    channel: options.channel,
    channelUrl: options.channelUrl,
    canonicalBaseUrl: options.canonicalBaseUrl,
  });
  fs.mkdirSync(path.join(output, publication.immutablePath), {
    recursive: true,
  });
  for (const asset of publication.assets) {
    fs.writeFileSync(path.join(output, asset.name), asset.bytes);
    fs.writeFileSync(
      path.join(output, publication.immutablePath, asset.name),
      asset.bytes,
    );
  }
  const serializable = {
    ...publication,
    assets: publication.assets.map(({ bytes: _bytes, ...asset }) => asset),
  };
  fs.writeFileSync(
    path.join(output, 'installer-publication.json'),
    `${JSON.stringify(serializable, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(output, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contract: 'kungfu-bootstrap-installer-web-surface/v1',
        archivePolicy: {
          contract: 'kungfu-buildchain-publication-archive-policy',
          deploymentBoundary: 'append-only immutable version prefixes',
        },
        installerPublication: 'installer-publication.json',
        publications: [
          {
            id: `kungfu-bootstrap-installer-${publication.channel}`,
            versions: [
              {
                version: publication.channelPayloadRoot,
                immutablePath: `/${publication.immutablePath}/`,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return serializable;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const publication = writeBootstrapInstallerPublication(options);
    process.stdout.write(
      `${JSON.stringify({
        output: path.resolve(options.output),
        channelPayloadRoot: publication.channelPayloadRoot,
        immutablePath: publication.immutablePath,
        assets: publication.assets.map((asset) => asset.digest),
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`bootstrap-installer: ${error.message}\n`);
    process.exitCode = 1;
  }
}
