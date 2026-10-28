/**
 * 从宿主那棵树里取 `@deepseek-ai/schemastery`（拿不到就退到自己 dependencies 里那份）。
 *
 * 为什么要这么绕：
 *   桌面版 profile 是 `autoInstallPeers: false`，`@deepseek-ai/*` 作为 optional peer 永远不装，
 *   裸 import 会让**整条插件不激活**（DSH 只留一句 "entry did not activate"）。
 *   拿不到就返回 null —— 插件照常跑，只是没有 Config（设置页降级），
 *   绝不因为一个依赖让插件的直播能力一起死掉。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai');

function candidateRoots() {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  push(process.env.DSH_HOST_MODULES);
  const appdata = process.env.APPDATA;
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules');
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
    push(join(npm, '@deepseek-ai'));
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'));
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'));
    }
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES);
  return out;
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name);
    const pkgFile = join(dir, 'package.json');
    if (!existsSync(pkgFile)) return null;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    const dot = pkg.exports?.['.'];
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main);
    if (!rel) return null;
    const file = join(dir, String(rel).replace(/^\.\//, ''));
    return existsSync(file) ? pathToFileURL(file).href : null;
  } catch { return null; }
}

async function fromHostTree(name, log) {
  const fails = [];
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue;
    const url = entryUrlFor(root, name);
    if (!url) continue;
    try {
      const mod = await import(url);
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`);
      return mod;
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`); }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`);
  return null;
}

/** @returns {Promise<{z: any, notes: string[]}>} */
export async function loadSchema() {
  const notes = [];
  const log = (m) => notes.push(m);
  let mod = await fromHostTree('schemastery', log);
  if (!mod) {
    try {
      mod = await import('@deepseek-ai/schemastery');
      log('schemastery：宿主树里没有，用自己依赖里那份');
    } catch (e) {
      log(`⚠️ schemastery 彻底拿不到（${e?.code || ''}）—— 本插件没有 Config，设置页降级（直播能力照常）`);
    }
  }
  return { z: mod?.default ?? mod ?? null, notes };
}