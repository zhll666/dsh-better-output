#!/usr/bin/env node
/**
 * 把 dsh-better-output 安装到当前 DSH profile。
 *
 * 做四件事：
 *   1. 复制插件到 $DSH_HOME/plugins/dsh-better-output；
 *   2. profile package.json 增加 link: 依赖；
 *   3. dsh.profile.bundles 追加本包；
 *   4. profile node_modules 建 junction，保证加载器解析得到。
 *
 * 不重启、不改 cordis.yml；重启 DSH 后生效。
 */
import { cp, lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dsh-better-output';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
const profileName = process.env.DSH_PROFILE || 'desktop';
const profileDir = join(dshHome, 'profiles', profileName);
const packageJsonPath = join(profileDir, 'package.json');
const pluginsRoot = join(dshHome, 'plugins');
const target = join(pluginsRoot, PACKAGE);
const linkPath = join(profileDir, 'node_modules', PACKAGE);

function step(message) {
  console.log(`${dryRun ? '[dry-run] ' : ''}${message}`);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertProfile() {
  if (!await exists(packageJsonPath)) {
    throw new Error(`找不到 profile: ${packageJsonPath}\n请确认 DSH_HOME / DSH_PROFILE 是否正确。`);
  }
}

/** 只复制运行所需文件，避免把工作区里的归档目录一起带进安装位置。 */
const ENTRIES = [
  'index.js',
  'src',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'scripts/install.mjs',
  'scripts/uninstall.mjs',
];

async function copyPlugin() {
  if (source === target) {
    step(`源码已在 ${target}，跳过复制`);
    return;
  }
  if (dryRun) {
    step(`会复制 ${source} → ${target}（只含运行文件）`);
    return;
  }
  await mkdir(pluginsRoot, { recursive: true });
  if (await exists(target)) await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const entry of ENTRIES) {
    const from = join(source, ...entry.split('/'));
    if (!await exists(from)) continue;
    const to = join(target, ...entry.split('/'));
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }
  step(`已复制到 ${target}`);
}

async function patchProfile() {
  const raw = await readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const linkSpec = `link:${target.replace(/\\/g, '/')}`;
  const changedDependency = pkg.dependencies[PACKAGE] !== linkSpec;
  pkg.dependencies[PACKAGE] = linkSpec;

  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const changedBundle = !bundles.includes(PACKAGE);
  if (changedBundle) bundles.push(PACKAGE);
  pkg.dsh.profile.bundles = bundles;

  if (!changedDependency && !changedBundle) {
    step('profile 已包含本插件，无需修改');
    return;
  }
  if (dryRun) {
    step(`会写入 ${packageJsonPath}（dependencies + bundles）`);
    return;
  }

  const backup = `${packageJsonPath}.${PACKAGE}.bak`;
  if (!await exists(backup)) await writeFile(backup, raw, 'utf8');
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  step(`已更新 profile 配置（备份: ${backup}）`);
}

async function linkProfile() {
  await mkdir(dirname(linkPath), { recursive: true });
  let info;
  try {
    info = await lstat(linkPath);
  } catch {
    info = undefined;
  }
  if (info !== undefined) {
    if (!info.isSymbolicLink()) {
      throw new Error(`${linkPath} 已存在且不是链接，请先手动处理。`);
    }
    if (dryRun) {
      step(`会替换已有链接 ${linkPath}`);
      return;
    }
    await unlink(linkPath);
  }
  if (dryRun) {
    step(`会创建链接 ${linkPath} → ${target}`);
    return;
  }
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  step(`已创建链接 ${linkPath} → ${target}`);
}

try {
  await assertProfile();
  await copyPlugin();
  await patchProfile();
  await linkProfile();
  console.log('');
  console.log('安装完成。请完全退出并重启 DSH，然后在工作区发一条消息，');
  console.log('检查是否出现 <工作区>/.dsh-better-output/ 目录。');
  console.log(`卸载: node "${join(source, 'scripts', 'uninstall.mjs')}"`);
} catch (error) {
  console.error(`安装失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
