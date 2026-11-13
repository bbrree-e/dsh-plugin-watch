/**
 * 插件版本体检 —— 网页半边：在「设置 → 插件」里多一个「版本」分页。
 * 数据从宿主那两条本地路由读，自己不扫盘。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-watch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'settings.pluginWatch'

    const zh = {
      tab: '版本',
      title: '插件版本体检',
      subtitle: '每天自动核对一次；也可以现在重新检查。',
      recheck: '重新检查',
      checking: '检查中…',
      lastChecked: '上次检查',
      never: '还没检查过',
      profile: '配置',
      plugin: '插件',
      installed: '已装',
      latest: '最新',
      status: '状态',
      action: '操作',
      update: '更新',
      updating: '装…',
      updateFailed: '装失败',
      upToDate: '已是最新',
      outdated: '有新版本',
      missing: '没装上',
      unknown: '查不到',
      failed: '查询失败',
      local: '本地目录',
      empty: '这个配置里还没有装插件。',
      loadFailed: '拿不到体检结果',
      sourceGithub: '来自 GitHub',
      sourceNpm: '来自 registry',
      autoTitle: '凌晨自动装的',
      autoPending: '装好了，下次开客户端生效',
      autoFailed: '自动装失败',
      autoEmpty: '还没有自动装过东西。',
      note: '只差补丁号的更新会在凌晨 4–6 点自动装好（备份在先，装完下次开客户端生效）；主次版本号变了、或者来自 GitHub 的只提醒——想装就点行尾的「更新」。',
      planTitle: '自动更新计划',
      planLine: '每天 04:00–06:00 之间跑一次，一天最多一次；只装补丁号变化、只装 npm 来源；装前备份配置；装完不自动重启。',
      planNext: '下一次',
      historyTitle: '更新历史',
      historyEmpty: '还没有记录。',
      kindAuto: '自动',
      kindManual: '手动',
      historyFailed: '失败',
    }

    const en = {
      tab: 'Versions',
      title: 'Plugin version check',
      subtitle: 'Checked once a day; you can also re-check now.',
      recheck: 'Re-check',
      checking: 'Checking…',
      lastChecked: 'Last checked',
      never: 'Never checked',
      profile: 'Profile',
      plugin: 'Plugin',
      installed: 'Installed',
      latest: 'Latest',
      status: 'Status',
      action: '',
      update: 'Update',
      updating: 'Installing…',
      updateFailed: 'Install failed',
      upToDate: 'Up to date',
      outdated: 'Update available',
      missing: 'Not installed',
      unknown: 'Unknown',
      failed: 'Check failed',
      local: 'Local folder',
      empty: 'No plugins installed in this profile.',
      loadFailed: 'Could not load the report',
      sourceGithub: 'From GitHub',
      sourceNpm: 'From registry',
      autoTitle: 'Installed overnight',
      autoPending: 'Installed; applies on next launch',
      autoFailed: 'Automatic install failed',
      autoEmpty: 'Nothing installed automatically yet.',
      note: 'Patch-only updates install overnight between 4 and 6 (backed up first, active next launch). Minor and major bumps, and GitHub sources, are only reported — press Update in the row to install one.',
      planTitle: 'Auto-update plan',
      planLine: 'Runs once a day between 04:00 and 06:00; patch-only, npm sources only; backs up the profile first; never restarts the app.',
      planNext: 'Next run',
      historyTitle: 'History',
      historyEmpty: 'Nothing recorded yet.',
      kindAuto: 'Auto',
      kindManual: 'Manual',
      historyFailed: 'failed',
    }

    const STATUS = {
      latest: { key: 'upToDate', color: 'var(--dsw-alias-state-success-primary, #1a8f4a)' },
      outdated: { key: 'outdated', color: 'var(--dsw-alias-state-business-primary, #247bbf)' },
      missing: { key: 'missing', color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
      unknown: { key: 'unknown', color: 'var(--dsw-alias-label-tertiary, #888)' },
      error: { key: 'failed', color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
      local: { key: 'local', color: 'var(--dsw-alias-label-tertiary, #888)' },
    }

    function formatTime(t, iso) {
      if (!iso) return t('never')
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        width: '100%',
        maxWidth: '860px',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        fontSize: '13px',
        lineHeight: '20px',
      },
      head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600 },
      sub: { color: 'var(--dsw-alias-label-tertiary, #888)' },
      btn: {
        marginLeft: 'auto',
        border: '0.5px solid var(--dsw-alias-border-l3, #d0d7de)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-settings-card-fill, transparent)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        padding: '4px 12px',
        fontSize: '13px',
        cursor: 'pointer',
      },
      card: {
        border: '1px solid var(--dsw-alias-settings-card-stroke, #e5e7eb)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-settings-card-fill, transparent)',
        overflow: 'hidden',
      },
      cardHead: {
        padding: '8px 12px',
        fontWeight: 600,
        borderBottom: '1px solid var(--dsw-alias-settings-card-stroke, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-tertiary, #888)',
        padding: '6px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l4, #eef0f2)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '6px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l4, #eef0f2)',
        verticalAlign: 'top',
      },
      name: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12.5px' },
      muted: { color: 'var(--dsw-alias-label-tertiary, #888)' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' },
      dot: { width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block' },
      note: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px' },
      error: { color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
    }

    function Badge(props) {
      const meta = STATUS[props.status] || STATUS.unknown
      return h(
        'span',
        { style: styles.badge },
        h('span', { style: { ...styles.dot, background: meta.color } }),
        h('span', { style: { color: meta.color } }, props.t(meta.key)),
      )
    }

    function ProfileCard(props) {
      const { profile, t } = props
      const rows = profile.plugins || []
      return h(
        'section',
        { style: styles.card },
        h('div', { style: styles.cardHead }, `${t('profile')} · ${profile.name}`),
        rows.length === 0
          ? h('div', { style: { ...styles.td, ...styles.muted } }, t('empty'))
          : h(
              'table',
              { style: styles.table },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { style: styles.th }, t('plugin')),
                  h('th', { style: styles.th }, t('installed')),
                  h('th', { style: styles.th }, t('latest')),
                  h('th', { style: styles.th }, t('status')),
                  h('th', { style: styles.th }, t('action')),
                ),
              ),
              h(
                'tbody',
                null,
                rows.map((row) =>
                  h(
                    'tr',
                    { key: row.name },
                    h(
                      'td',
                      { style: styles.td },
                      h('div', { style: styles.name }, row.name),
                      row.error
                        ? h('div', { style: { ...styles.note, ...styles.error } }, row.error)
                        : null,
                    ),
                    h('td', { style: styles.td }, row.installed || '—'),
                    h(
                      'td',
                      { style: styles.td },
                      row.latest || '—',
                      row.published
                        ? h(
                            'div',
                            { style: styles.note },
                            new Date(row.published).toLocaleDateString(),
                          )
                        : null,
                    ),
                    h(
                      'td',
                      { style: styles.td },
                      h(Badge, { status: row.status, t }),
                      row.source === 'local'
                        ? null
                        : h(
                            'div',
                            { style: styles.note },
                            row.source === 'github' ? t('sourceGithub') : t('sourceNpm'),
                          ),
                    ),
                    h(
                      'td',
                      { style: styles.td },
                      row.status === 'outdated' && props.onUpdate
                        ? h(
                            'button',
                            {
                              type: 'button',
                              style: {
                                ...styles.btn,
                                marginLeft: 0,
                                opacity: props.busyFor && props.busyFor(row.name) ? 0.6 : 1,
                              },
                              disabled: Boolean(props.busyFor && props.busyFor(row.name)),
                              onClick: () => props.onUpdate(profile.name, row),
                            },
                            props.busyFor && props.busyFor(row.name) ? t('updating') : t('update'),
                          )
                        : null,
                    ),
                  ),
                ),
              ),
            ),
      )
    }

    /** 下一次窗口：今天 04:00，过了就明天；今天已经跑过且还在窗口内也顺延。 */
    function nextRunLabel(auto) {
      const now = new Date()
      const next = new Date(now)
      next.setHours(4, 0, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      if (auto?.at) {
        const at = new Date(auto.at)
        const sameDay = at.toDateString() === now.toDateString()
        if (sameDay && now.getHours() >= 4 && now.getHours() < 6) next.setDate(next.getDate() + 1)
      }
      return formatTime(null, next.toISOString())
    }

    function VersionTab(props) {
      const t = props.t
      const [state, setState] = useState({
        loading: true,
        running: false,
        report: null,
        auto: null,
        plan: null,
        history: [],
        error: null,
      })

      const apply = useCallback((payload) => {
        if (!payload || payload.ok === false) {
          setState({ loading: false, running: false, report: null, auto: null, plan: null, history: [], error: payload?.error || 'unknown' })
          return
        }
        setState({
          loading: false,
          running: Boolean(payload.running),
          report: payload.report,
          auto: payload.auto || null,
          plan: payload.plan || null,
          history: Array.isArray(payload.history) ? payload.history : [],
          error: null,
        })
      }, [])

      const load = useCallback(async () => {
        try {
          const res = await fetch('/dsh-plugin-watch/status', { cache: 'no-store' })
          apply(await res.json())
        } catch (error) {
          setState({ loading: false, running: false, report: null, error: String(error) })
        }
      }, [apply])

      const refresh = useCallback(async () => {
        setState((prev) => ({ ...prev, running: true }))
        try {
          const res = await fetch('/dsh-plugin-watch/refresh', { method: 'POST' })
          apply(await res.json())
        } catch (error) {
          setState({ loading: false, running: false, report: null, error: String(error) })
        }
      }, [apply])

      useEffect(() => {
        load()
      }, [load])

      const updateOne = useCallback(
        async (profileName, row) => {
          const key = `${profileName}|${row.name}`
          setState((prev) => ({ ...prev, busy: { ...(prev.busy || {}), [key]: true } }))
          try {
            const res = await fetch('/dsh-plugin-watch/update', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ profile: profileName, name: row.name, version: row.latest }),
            })
            const payload = await res.json()
            if (!payload || payload.ok === false) throw new Error(payload?.error || 'failed')
            apply(payload)
          } catch (error) {
            setState((prev) => ({
              ...prev,
              error: `${row.name}: ${String(error)}`,
              busy: { ...(prev.busy || {}), [key]: false },
            }))
          }
        },
        [apply],
      )

      const report = state.report

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.head },
          h('div', { style: styles.title }, t('title')),
          h('div', { style: styles.sub }, t('subtitle')),
          h(
            'button',
            {
              type: 'button',
              style: styles.btn,
              disabled: state.running,
              onClick: () => {
                if (!state.running) refresh()
              },
            },
            state.running ? t('checking') : t('recheck'),
          ),
        ),
        h(
          'div',
          { style: styles.sub },
          `${t('lastChecked')}：${report ? formatTime(t, report.checkedAt) : t('never')}`,
        ),
        state.auto && (state.auto.installed || []).length > 0
          ? h(
              'div',
              { style: styles.sub },
              `${t('autoTitle')}：` +
                state.auto.installed
                  .map((row) => `${row.name} ${row.from}→${row.to}`)
                  .join('，') +
                `（${t('autoPending')}）`,
            )
          : null,
        state.auto && (state.auto.failed || []).length > 0
          ? h(
              'div',
              { style: styles.error },
              `${t('autoFailed')}：` + state.auto.failed.map((row) => row.profile).join('，'),
            )
          : null,
        state.loading
          ? h('div', { style: styles.sub }, t('checking'))
          : state.error
            ? h('div', { style: styles.error }, `${t('loadFailed')}：${state.error}`)
            : (report?.profiles || []).length === 0
              ? h('div', { style: styles.sub }, t('empty'))
              : report.profiles.map((profile) =>
                  h(ProfileCard, {
                    key: profile.name,
                    profile,
                    t,
                    onUpdate: updateOne,
                    busyFor: (rowName) => Boolean(state.busy?.[`${profile.name}|${rowName}`]),
                  }),
                ),
        h('div', { style: styles.note }, t('note')),
        h(
          'section',
          { style: styles.card },
          h('div', { style: styles.cardHead }, t('planTitle')),
          h(
            'div',
            { style: { padding: '8px 12px' } },
            h('div', null, t('planLine')),
            h('div', { style: styles.note }, `${t('planNext')}：${nextRunLabel(state.auto)}`),
          ),
        ),
        h(
          'section',
          { style: styles.card },
          h('div', { style: styles.cardHead }, t('historyTitle')),
          state.history.length === 0
            ? h('div', { style: { ...styles.td, ...styles.muted } }, t('historyEmpty'))
            : h(
                'div',
                { style: { padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                state.history.map((entry, index) =>
                  h(
                    'div',
                    { key: `${entry.at}-${index}` },
                    h(
                      'div',
                      null,
                      `${formatTime(t, entry.at)} · ${entry.kind === 'auto' ? t('kindAuto') : t('kindManual')}`,
                    ),
                    (entry.installed || []).map((row) =>
                      h(
                        'div',
                        { key: `${row.name}-${row.to}`, style: styles.note },
                        `${row.name} ${row.from || '?'} → ${row.to}`,
                      ),
                    ),
                    (entry.failed || []).length > 0
                      ? h(
                          'div',
                          { style: styles.error },
                          `${t('historyFailed')}：` + entry.failed.map((row) => row.profile).join('，'),
                        )
                      : null,
                  ),
                ),
              ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-watch: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'plugin-watch-versions',
              order: 20,
              label: () => t('tab'),
              locale: NS,
              inject: () => ({ t }),
            },
            VersionTab,
          ),
        )
      },
    }
  },
})
