#!/usr/bin/env node
/**
 * 从当前 DSH profile 卸载 dsh-better-output。
 *
 * 默认只移除 profile 里的依赖、bundle 条目与 node_modules 链接；
 * 加 --purge 才会删除 $DSH_HOME/plugins/dsh-better-output。
 * 工作区里已经生成的归档目录不会动。
 */
import { lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGE = 'dsh-better-output';
const purge = process.argv.includes('--purge');
const dryRun = process.argv.includes('--dry-run');
const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
const profileName = process.env.DSH_PROFILE || 'desktop';
const profileDir = join(dshHome, 'profiles', profileName);
const packageJsonPath = join(profileDir, 'package.json');
const target = join(dshHome, 'plugins', PACKAGE);
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

try {
  if (!await exists(packageJsonPath)) throw new Error(`找不到 profile: ${packageJsonPath}`);

  const raw = await readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw);
  let changed = false;

  if (pkg.dependencies && typeof pkg.dependencies === 'object' && PACKAGE in pkg.dependencies) {
    delete pkg.dependencies[PACKAGE];
    changed = true;
  }
  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const next = bundles.filter(item => item !== PACKAGE);
    if (next.length !== bundles.length) {
      pkg.dsh.profile.bundles = next;
      changed = true;
    }
  }

  if (changed) {
    if (dryRun) step(`会从 ${packageJsonPath} 移除依赖与 bundle 条目`);
    else {
      await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      step('已移除 profile 中的依赖与 bundle 条目');
    }
  } else {
    step('profile 中没有本插件条目');
  }

  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink()) {
      if (dryRun) step(`会删除链接 ${linkPath}`);
      else {
        await unlink(linkPath);
        step(`已删除链接 ${linkPath}`);
      }
    } else {
      step(`${linkPath} 不是链接，跳过`);
    }
  } catch {
    step('没有 node_modules 链接需要删除');
  }

  if (purge && await exists(target)) {
    if (dryRun) step(`会删除 ${target}`);
    else {
      await rm(target, { recursive: true, force: true });
      step(`已删除 ${target}`);
    }
  }

  console.log('');
  console.log('卸载完成。重启 DSH 后生效；已生成的归档目录保持不变。');
} catch (error) {
  console.error(`卸载失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
