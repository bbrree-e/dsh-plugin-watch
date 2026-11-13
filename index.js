/**
 * 插件版本体检 —— 宿主半边。
 *
 * 每次体检都重新读各 profile 的 package.json，所以新装的插件下一次自动被认出来。
 *
 * 数据来源：
 *   - npm 装的：registry 的 dist-tags.latest
 *   - GitHub 装的（github:/git+https://...）：仓库 main（或 master）分支的 package.json
 *
 * 自动安装（带闸）：
 *   只在凌晨窗口里跑、只装补丁号变化（主次版本号相同）、只装 npm 来源的、
 *   装之前先把 package.json / lockfile 备份一份，装完不重启（下次开客户端才生效）。
 *
 * 路由：
 *   GET  /dsh-plugin-watch/status    读缓存
 *   POST /dsh-plugin-watch/refresh   立刻体检一次
 *   GET  /dsh-plugin-watch/auto      上一次自动安装的结果
 */

import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILES_DIR = join(DSH_HOME, 'profiles')
const STORE_DIR = join(DSH_HOME, 'plugin-watch')
const STORE_FILE = join(STORE_DIR, 'report.json')
const AUTO_FILE = join(STORE_DIR, 'auto.json')
const HISTORY_FILE = join(STORE_DIR, 'history.json')
const ROUTE = '/dsh-plugin-watch'

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 每小时醒一次
const STALE_AFTER_MS = 22 * 60 * 60 * 1000 // 超过这么久就重新体检
const NET_TIMEOUT_MS = 15000

// 自动安装只在凌晨这几个小时里动手，白天不碰。
const AUTO_HOUR_START = 4
const AUTO_HOUR_END = 6

export const inject = ['webServer']

export function apply(ctx) {
  /** @type {{ checkedAt: string|null, profiles: any[] } | null} */
  let report = null
  let running = null
  let lastError = null
  /** @type {any} */
  let autoRecord = null
  /** @type {any[]} */
  let history = []

  const PLAN = {
    windowStart: AUTO_HOUR_START,
    windowEnd: AUTO_HOUR_END,
    patchOnly: true,
    npmOnly: true,
    restart: false,
    backup: true,
    maxPerDay: 1,
  }

  const pnpmMjs = join(
    dirname(process.execPath),
    'resources',
    'runtime',
    'primary-runtime',
    'dependencies',
    'pnpm',
    'bin',
    'pnpm.mjs',
  )

  // ── 小工具 ────────────────────────────────────────────────────
  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  function parseVersion(text) {
    return String(text || '')
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => {
        const n = parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      })
  }

  /** 返回 -1 / 0 / 1；只比前三段数字。 */
  function compareVersions(a, b) {
    const x = parseVersion(a)
    const y = parseVersion(b)
    for (let i = 0; i < 3; i += 1) {
      const l = x[i] || 0
      const r = y[i] || 0
      if (l > r) return 1
      if (l < r) return -1
    }
    return 0
  }

  /** 主、次版本号都一样 —— 只有补丁号在动。 */
  function isPatchOnly(installed, latest) {
    if (!installed || !latest) return false
    const a = parseVersion(installed)
    const b = parseVersion(latest)
    return a[0] === b[0] && a[1] === b[1] && b[2] > a[2]
  }

  function parseGitSpec(spec) {
    const raw = String(spec || '')
    let m = /^github:([^/\s]+)\/([^/#\s]+)/.exec(raw)
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
    m = /^git\+https:\/\/github\.com\/([^/\s]+)\/([^/#\s]+?)(?:\.git)?(?:#.*)?$/.exec(raw)
    if (m) return { owner: m[1], repo: m[2] }
    return null
  }

  async function fetchJson(url) {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  async function npmLatest(name) {
    const data = await fetchJson(`https://registry.npmmirror.com/${encodeURIComponent(name)}`)
    const version = data?.['dist-tags']?.latest || null
    const published = version ? data?.time?.[version] || null : null
    return { version, published }
  }

  async function gitLatest(owner, repo) {
    let last = null
    for (const branch of ['main', 'master']) {
      try {
        const data = await fetchJson(
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/package.json`,
        )
        return { version: data?.version || null, published: null, ref: branch }
      } catch (error) {
        last = error
      }
    }
    throw last || new Error('unreachable')
  }

  async function installedVersion(profileDir, name) {
    const pkg = await readJson(join(profileDir, 'node_modules', name, 'package.json'))
    return pkg?.version || null
  }

  function createLookup() {
    const cache = new Map()
    function lookup(name, spec) {
      const key = `${name}@${spec}`
      if (!cache.has(key)) cache.set(key, resolve(name, spec))
      return cache.get(key)
    }
    async function resolve(name, spec) {
      const git = parseGitSpec(spec)
      if (git) {
        const info = await gitLatest(git.owner, git.repo)
        return { source: 'github', repo: `${git.owner}/${git.repo}`, ...info }
      }
      const info = await npmLatest(name)
      return { source: 'npm', repo: null, ...info }
    }
    return lookup
  }

  // ── 体检 ──────────────────────────────────────────────────────
  async function scanProfiles() {
    const lookup = createLookup()
    const dirs = await readdir(PROFILES_DIR, { withFileTypes: true }).catch(() => [])
    const profiles = []

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const profileDir = join(PROFILES_DIR, dir.name)
      const pkg = await readJson(join(profileDir, 'package.json'))
      const deps = pkg?.dependencies
      if (!deps) continue

      const plugins = []
      for (const [name, spec] of Object.entries(deps)) {
        const installed = await installedVersion(profileDir, name)
        const row = {
          name,
          spec,
          installed,
          latest: null,
          published: null,
          source: parseGitSpec(spec) ? 'github' : 'npm',
          repo: null,
          status: 'unknown',
          error: null,
        }

        // 本地目录装的（安装器写 link:/file:）没有远端可比。
        if (/^(link|file):/i.test(String(spec))) {
          row.status = installed ? 'local' : 'missing'
          row.source = 'local'
          plugins.push(row)
          continue
        }

        try {
          const info = await lookup(name, spec)
          row.latest = info.version
          row.published = info.published || null
          row.source = info.source
          row.repo = info.repo || null
          if (!installed) row.status = 'missing'
          else if (!info.version) row.status = 'unknown'
          else row.status = compareVersions(installed, info.version) >= 0 ? 'latest' : 'outdated'
        } catch (error) {
          row.error = String((error && error.message) || error)
          row.status = installed ? 'error' : 'missing'
        }
        plugins.push(row)
      }

      plugins.sort((a, b) => {
        const rank = { outdated: 0, error: 1, missing: 2, unknown: 3, local: 4, latest: 5 }
        const d = (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
        return d !== 0 ? d : a.name.localeCompare(b.name)
      })

      profiles.push({ name: dir.name, plugins })
    }

    profiles.sort((a, b) => a.name.localeCompare(b.name))
    return { checkedAt: new Date().toISOString(), profiles }
  }

  async function saveJson(path, value) {
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`plugin-watch: 写不进 ${path}：${error}`)
    }
  }

  async function appendHistory(entry) {
    history.unshift(entry)
    if (history.length > 30) history = history.slice(0, 30)
    await saveJson(HISTORY_FILE, history)
  }

  function runScan() {
    if (running) return running
    running = (async () => {
      try {
        const next = await scanProfiles()
        report = next
        lastError = null
        await saveJson(STORE_FILE, next)
        return next
      } catch (error) {
        lastError = String((error && error.message) || error)
        ctx.logger?.warn?.(`plugin-watch: 体检失败：${lastError}`)
        throw error
      } finally {
        running = null
      }
    })()
    return running
  }

  function isStale() {
    if (!report?.checkedAt) return true
    return Date.now() - Date.parse(report.checkedAt) > STALE_AFTER_MS
  }

  // ── 自动安装 ──────────────────────────────────────────────────
  function autoWindowOpen(now = new Date()) {
    const hour = now.getHours()
    return hour >= AUTO_HOUR_START && hour < AUTO_HOUR_END
  }

  async function ensureReleaseAgeExclude(profileDir, specs) {
    const file = join(profileDir, 'pnpm-workspace.yaml')
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return
    }
    const missing = specs.filter((entry) => !text.includes(`- ${entry}`))
    if (missing.length === 0) return
    const lines = text.replace(/\s+$/, '').split('\n')
    const index = lines.findIndex((line) => line.trim() === 'minimumReleaseAgeExclude:')
    if (index === -1) {
      lines.push('minimumReleaseAgeExclude:')
      lines.push(...missing.map((entry) => `  - ${entry}`))
    } else {
      lines.splice(index + 1, 0, ...missing.map((entry) => `  - ${entry}`))
    }
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  }

  function runPnpm(args, cwd) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [pnpmMjs, ...args], {
        cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      })
      let output = ''
      child.stdout?.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        output += String(chunk)
      })
      child.on('error', (error) => resolve({ code: -1, output: String(error) }))
      child.on('exit', (code) => resolve({ code: code ?? -1, output }))
    })
  }

  async function backupProfile(profileDir, stamp) {
    const dir = join(STORE_DIR, 'backup', `${stamp}-${profileDir.split(/[\\/]/).pop()}`)
    await mkdir(dir, { recursive: true })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const from = join(profileDir, name)
      if (existsSync(from)) await copyFile(from, join(dir, name))
    }
    return dir
  }

  /** 挑出可以自动装的：npm 来源 + 只差补丁号。 */
  function pickAutoTargets(scan) {
    const picks = []
    for (const profile of scan.profiles) {
      for (const row of profile.plugins) {
        if (row.status !== 'outdated') continue
        if (row.source !== 'npm') continue
        if (!isPatchOnly(row.installed, row.latest)) continue
        if (!/^\d+\.\d+\.\d+/.test(String(row.latest))) continue
        picks.push({ profile: profile.name, name: row.name, from: row.installed, to: row.latest })
      }
    }
    return picks
  }

  async function autoInstall() {
    if (!existsSync(pnpmMjs)) {
      return { ran: false, reason: '这个启动方式下找不到自带的那套安装器' }
    }
    const today = new Date().toISOString().slice(0, 10)
    if (autoRecord?.date === today) return { ran: false, reason: '今天已经跑过' }

    const scan = await runScan()
    const picks = pickAutoTargets(scan)
    if (picks.length === 0) {
      autoRecord = { date: today, at: new Date().toISOString(), installed: [], note: '没有只差补丁号的更新' }
      await saveJson(AUTO_FILE, autoRecord)
      return { ran: true, installed: [] }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const byProfile = new Map()
    for (const pick of picks) {
      if (!byProfile.has(pick.profile)) byProfile.set(pick.profile, [])
      byProfile.get(pick.profile).push(pick)
    }

    const installed = []
    const failed = []
    for (const [profileName, list] of byProfile) {
      const profileDir = join(PROFILES_DIR, profileName)
      try {
        await backupProfile(profileDir, stamp)
        await ensureReleaseAgeExclude(profileDir, list.map((p) => `${p.name}@${p.to}`))
        const result = await runPnpm(['add', ...list.map((p) => `${p.name}@${p.to}`)], profileDir)
        if (result.code === 0) {
          for (const p of list) installed.push({ ...p })
        } else {
          failed.push({ profile: profileName, output: result.output.slice(-600) })
        }
      } catch (error) {
        failed.push({ profile: profileName, output: String(error) })
      }
    }

    autoRecord = {
      date: today,
      at: new Date().toISOString(),
      backup: join(STORE_DIR, 'backup', stamp),
      installed,
      failed,
    }
    await saveJson(AUTO_FILE, autoRecord)
    await appendHistory({
      at: autoRecord.at,
      kind: 'auto',
      backup: autoRecord.backup || null,
      installed,
      failed,
      note: installed.length === 0 && failed.length === 0 ? '没有需要装的补丁版本' : undefined,
    })
    await runScan().catch(() => {})
    return { ran: true, installed, failed }
  }

  // ── 单个更新 ──────────────────────────────────────────────────
  /** 把某一个插件装到指定版本；GitHub 来源的重新拉一次最新提交。 */
  async function updateOne(profileName, name, version) {
    const profileDir = join(PROFILES_DIR, profileName)
    const pkg = await readJson(join(profileDir, 'package.json'))
    const spec = pkg?.dependencies?.[name]
    if (!spec) throw new Error('这个配置里没有这个插件')

    const git = parseGitSpec(spec)
    const target = git ? `github:${git.owner}/${git.repo}` : `${name}@${version}`
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const before = await installedVersion(profileDir, name)

    await backupProfile(profileDir, stamp)
    if (!git) await ensureReleaseAgeExclude(profileDir, [`${name}@${version}`])

    const result = await runPnpm(['add', target], profileDir)
    if (result.code !== 0) {
      throw new Error((result.output || '').trim().slice(-400) || '安装器返回了失败')
    }
    await runScan().catch(() => {})
    await appendHistory({
      at: new Date().toISOString(),
      kind: 'manual',
      installed: [{ profile: profileName, name, from: before, to: git ? 'latest commit' : version }],
      failed: [],
    })
    return { profile: profileName, name, version: git ? 'latest commit' : version }
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let text = ''
      req.on('data', (chunk) => {
        text += String(chunk)
        if (text.length > 100000) req.destroy()
      })
      req.on('end', () => resolve(text))
    })
  }

  // ── 路由 ──────────────────────────────────────────────────────
  function sendJson(res, payload, status = 200) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  function snapshot() {
    return { ok: true, running: Boolean(running), lastError, report, auto: autoRecord, plan: PLAN, history }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/status`,
      handler: async (req, res) => {
        try {
          sendJson(res, snapshot())
        } catch (error) {
          sendJson(res, { ok: false, error: String(error) }, 500)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/refresh`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, { ok: false, error: 'POST only' }, 405)
            return
          }
          await runScan()
          sendJson(res, snapshot())
        } catch (error) {
          sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/update`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, { ok: false, error: 'POST only' }, 405)
            return
          }
          const body = JSON.parse((await readBody(req)) || '{}')
          const { profile, name, version } = body || {}
          if (!profile || !name || !version) {
            sendJson(res, { ok: false, error: '缺少 profile / name / version' }, 400)
            return
          }
          const done = await updateOne(String(profile), String(name), String(version))
          sendJson(res, { ok: true, result: done, ...snapshot() })
        } catch (error) {
          sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500)
        }
      },
    }),
  )

  // 启动：读上次结果，过期补一次；然后每小时看看要不要自动装。
  ctx.effect(() => {
    let disposed = false
    ;(async () => {
      const saved = await readJson(STORE_FILE)
      if (!disposed && saved?.checkedAt) report = saved
      const savedAuto = await readJson(AUTO_FILE)
      if (!disposed && savedAuto) autoRecord = savedAuto
      const savedHistory = await readJson(HISTORY_FILE)
      if (!disposed && Array.isArray(savedHistory)) history = savedHistory
      if (!disposed && isStale()) runScan().catch(() => {})
      // 凌晨启动时也补一次自动安装，不然错过了每小时那一跳。
      if (!disposed && autoWindowOpen()) {
        autoInstall().catch((error) => {
          ctx.logger?.warn?.(`plugin-watch: 自动安装失败：${error}`)
        })
      }
    })()
    return () => {
      disposed = true
    }
  }, 'plugin-watch: load')

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (running) return
      if (!autoWindowOpen()) return
      autoInstall().catch((error) => {
        ctx.logger?.warn?.(`plugin-watch: 自动安装失败：${error}`)
      })
    }, CHECK_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'plugin-watch: timer')
}
