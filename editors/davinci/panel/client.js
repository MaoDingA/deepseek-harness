window.__ModuleLoader__.load({
  id: '@local/dsh-davinci-panel',
  /**
   * Browser half of the DaVinci panel bundle: one left-rail entry and the
   * panel it opens. The panel is a launcher and reference for the
   * `resolve_*` toolset that the source-launched `davinci-resolve` Host plugin
   * registers; it opens no Host connection of its own.
   */
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'davinci-panel'
    const PANEL_ID = 'davinci'

    const ZH = {
      'panel.label': '达芬奇',
      'panel.title': '达芬奇剪辑',
      'panel.subtitle': '套片、贴视效、输出的入口与工具速查。',
      'panel.note': '这个面板只做入口和速查，不实时连接 Resolve。真正的读写由会话里的 resolve_* 工具执行；写操作会弹出审批。',
      'section.workflow': '工作流',
      'section.tools': '工具速查（22 个）',
      'section.requirements': '环境要求',
      'workflow.hint': '点击后会在新会话的输入框里预填提示词，发送前你可以再改。',
      'action.newSession': '新建会话',
      'action.copy': '复制提示词',
      'action.copied': '已复制',
      'action.copyFailed': '复制失败',
      'action.openPlugins': '插件设置',
      'wf.conformAudio.title': '套片 · 按 WP 对回素材',
      'wf.conformAudio.body': '按每本的定版 WP 把原始素材对回 V1，一本一条时间线；声音不参与。',
      'wf.conformAudio.prompt': '做套片：先问用户 WP bin（如 03_WP）、原始素材 bin（如 01_SOURCE）、每本时间线名（第一本…第五本）、片头 bin、是否要整片 master。然后用 resolve_project_info 和 resolve_media_pool 核对每本 WP 的 Start TC/时长，用 resolve_timeline_items(1) 核对 V1 覆盖；声音不参与。只读，不改时间线。',
      'wf.conformNested.title': '套片 · 逐本核对',
      'wf.conformNested.body': '核对每本时间线与 WP 的时长、TC、片头和 V1 覆盖，输出差异清单。',
      'wf.conformNested.prompt': '套片核对：先问用户 WP bin 和每本时间线名；逐本比较 WP 的 Start TC/时长与时间线帧范围、片头是否在位、V1 是否有缺口或重叠，输出每本的差异清单。只读。',
      'wf.vfx.title': '贴视效',
      'wf.vfx.body': '按交付物的源 Start TC 找到对应 V1 段，把 VFX 贴到 V2 同起始帧。',
      'wf.vfx.prompt': '贴视效：先问用户交付物 bin、命名/TC 约定、目标轨（默认 V2）、handle、覆盖还是叠加；再用 resolve_plan_vfx_placement 生成贴片单（匹配 V1 段、落点、占用），对 verdict=ready 的条目用 resolve_place_clip_ui 贴片（需要 macOS 辅助功能权限，写操作等审批），最后用 resolve_verify_placement 做结构质检。',
      'wf.render.title': '输出',
      'wf.render.body': '确认渲染设置与预设，把当前时间线入队、启动或停止渲染。',
      'wf.render.prompt': '输出：先问用户交付格式/编码或预设、目标目录、命名、每本还是整片、是否带片头、QC 清单；再用 resolve_render_status / resolve_render_presets 核对当前设置，确认后入队并开始渲染（写操作等审批）。',
      'tools.read': '读取',
      'tools.visual': '视觉',
      'tools.session': '会话',
      'tools.write': '写 · 需审批',
      'tools.tip.projectInfo': '工程、时间线与当前轨道',
      'tools.tip.mediaPool': '列 bin 与素材',
      'tools.tip.timelineItems': '视频轨条目（分页）',
      'tools.tip.findByTc': '按源 TC 找 V1 段',
      'tools.tip.findClip': '全工程按名找条目',
      'tools.tip.planPlacement': '贴片单：匹配段与落点',
      'tools.tip.verifyPlacement': '结构质检：是否对位',
      'tools.tip.audioTimelineItems': '音频轨条目',
      'tools.tip.renderStatus': '渲染队列与当前设置',
      'tools.tip.renderPresets': '预设列表与当前格式',
      'tools.tip.seek': '移动播放头',
      'tools.tip.screenshot': '截屏，配合 read_image',
      'tools.tip.switchTimeline': '切换当前时间线',
      'tools.tip.placeClip': '贴片段（append + 回滚）',
      'tools.tip.placeClipUi': 'UI 定位贴到 V2（需辅助功能）',
      'tools.tip.deleteItem': '按起始帧删条目',
      'tools.tip.addMarker': '加时间线标记',
      'tools.tip.addRenderJob': '当前时间线入队',
      'tools.tip.loadRenderPreset': '切换渲染预设',
      'tools.tip.deleteRenderJob': '按 id 撤销入队',
      'tools.tip.startRendering': '开始渲染',
      'tools.tip.stopRendering': '停止渲染',
      'req.1': 'DaVinci Resolve 正在运行，并打开了一个工程。',
      'req.2': '首选项 → 系统 → 常规 → 外部脚本 设为「本地」。',
      'req.3': 'davinci-mcp 服务器在默认路径，或在插件 Config 里指定 mcpServerPath / resolveMcpPath。',
      'req.4': '当前 profile 挂载了 davinci-resolve 插件（本机 web / headless 已挂载，desktop 未挂载）。',
      'footer': '失败结果形如 ERROR [code] message。写操作的审批提示就是授权，不要先在聊天里问一遍。',
    }

    const EN = {
      'panel.label': 'DaVinci',
      'panel.title': 'DaVinci Editing',
      'panel.subtitle': 'Workflow entry points and tool reference for conform, VFX layup, and output.',
      'panel.note': 'This panel is an entry point and reference only; it holds no live Resolve connection. The resolve_* tools run the reads and writes inside a Session, and every write asks for approval.',
      'section.workflow': 'Workflows',
      'section.tools': 'Tool reference (22)',
      'section.requirements': 'Requirements',
      'workflow.hint': 'Clicking prefills the prompt in a new Session; edit it before sending.',
      'action.newSession': 'New Session',
      'action.copy': 'Copy prompt',
      'action.copied': 'Copied',
      'action.copyFailed': 'Copy failed',
      'action.openPlugins': 'Plugin settings',
      'wf.conformAudio.title': 'Conform · WP to source',
      'wf.conformAudio.body': 'Rebuild each reel from its locked workprint against the original source on V1; sound is out of scope.',
      'wf.conformAudio.prompt': 'Do a conform: first ask the user for the workprint bin (e.g. 03_WP), the source bin (e.g. 01_SOURCE), the reel timeline names, the leader bin, and whether a master timeline is wanted. Then use resolve_project_info and resolve_media_pool to compare each workprint reel Start TC/duration, and resolve_timeline_items(1) to check V1 coverage; sound is out of scope. Read-only.',
      'wf.conformNested.title': 'Conform · Per-reel check',
      'wf.conformNested.body': 'Compare each reel timeline with its workprint: duration, TC, leader, and V1 coverage; report the differences.',
      'wf.conformNested.prompt': 'Conform check: first ask the user for the workprint bin and the reel timeline names; then compare each workprint reel Start TC/duration with the timeline frame range, the leader, and V1 coverage, and report the differences per reel. Read-only.',
      'wf.vfx.title': 'VFX layup',
      'wf.vfx.body': 'Match a deliverable to its V1 segment by source Start TC and place it on V2 at the same start frame.',
      'wf.vfx.prompt': 'VFX layup: first ask the user for the deliverable bin, naming/TC convention, target track (default V2), handles, and replace vs overlay; then build a placement sheet with resolve_plan_vfx_placement (matched V1 segment, landing, occupancy). For each verdict=ready row, place it with resolve_place_clip_ui (needs macOS Accessibility; the write waits for approval), then run resolve_verify_placement for structural QC.',
      'wf.render.title': 'Output',
      'wf.render.body': 'Confirm render settings and preset, then enqueue the current timeline and start or stop rendering.',
      'wf.render.prompt': 'Output: first ask the user for the deliverable format/codec or preset, target directory, naming, per-reel vs master, leader inclusion, and the QC checklist; then check resolve_render_status / resolve_render_presets, and after confirmation enqueue and start rendering (the writes wait for approval).',
      'tools.read': 'Read',
      'tools.visual': 'Visual',
      'tools.session': 'Session',
      'tools.write': 'Write · approval',
      'tools.tip.projectInfo': 'Project, timelines, current tracks',
      'tools.tip.mediaPool': 'List bins and clips',
      'tools.tip.timelineItems': 'Video-track items (paged)',
      'tools.tip.findByTc': 'Find V1 segments by source TC',
      'tools.tip.findClip': 'Find items by name everywhere',
      'tools.tip.planPlacement': 'Placement plan: match and landing',
      'tools.tip.verifyPlacement': 'Structural check: aligned?',
      'tools.tip.audioTimelineItems': 'Audio-track items',
      'tools.tip.renderStatus': 'Queue state and live settings',
      'tools.tip.renderPresets': 'Preset list and active format',
      'tools.tip.seek': 'Move the playhead',
      'tools.tip.screenshot': 'Capture for read_image',
      'tools.tip.switchTimeline': 'Change the current timeline',
      'tools.tip.placeClip': 'Append + rollback',
      'tools.tip.placeClipUi': 'Positioned V2 paste via the UI',
      'tools.tip.deleteItem': 'Delete by start frame',
      'tools.tip.addMarker': 'Add a timeline marker',
      'tools.tip.addRenderJob': 'Enqueue the current timeline',
      'tools.tip.loadRenderPreset': 'Switch the render preset',
      'tools.tip.deleteRenderJob': 'Cancel a queued job by id',
      'tools.tip.startRendering': 'Start rendering',
      'tools.tip.stopRendering': 'Stop rendering',
      'req.1': 'DaVinci Resolve is running with a project open.',
      'req.2': 'Preferences → System → General → External scripting set to Local.',
      'req.3': 'The davinci-mcp server sits at its default path, or Config sets mcpServerPath / resolveMcpPath.',
      'req.4': 'The active profile mounts the davinci-resolve plugin (web and headless do here; desktop does not).',
      'footer': 'Failures arrive as ERROR [code] message. The approval prompt on a write is the consent; do not ask again in chat.',
    }

    const WORKFLOWS = [
      { id: 'conform-audio', title: 'wf.conformAudio.title', body: 'wf.conformAudio.body', prompt: 'wf.conformAudio.prompt' },
      { id: 'conform-nested', title: 'wf.conformNested.title', body: 'wf.conformNested.body', prompt: 'wf.conformNested.prompt' },
      { id: 'vfx', title: 'wf.vfx.title', body: 'wf.vfx.body', prompt: 'wf.vfx.prompt' },
      { id: 'render', title: 'wf.render.title', body: 'wf.render.body', prompt: 'wf.render.prompt' },
    ]

    const TOOL_GROUPS = [
      {
        id: 'read',
        title: 'tools.read',
        tools: [
          ['resolve_project_info', 'tools.tip.projectInfo'],
          ['resolve_media_pool', 'tools.tip.mediaPool'],
          ['resolve_timeline_items', 'tools.tip.timelineItems'],
          ['resolve_find_by_tc', 'tools.tip.findByTc'],
          ['resolve_find_clip', 'tools.tip.findClip'],
          ['resolve_plan_vfx_placement', 'tools.tip.planPlacement'],
          ['resolve_verify_placement', 'tools.tip.verifyPlacement'],
          ['resolve_audio_timeline_items', 'tools.tip.audioTimelineItems'],
          ['resolve_render_status', 'tools.tip.renderStatus'],
          ['resolve_render_presets', 'tools.tip.renderPresets'],
        ],
      },
      {
        id: 'visual',
        title: 'tools.visual',
        tools: [
          ['resolve_seek', 'tools.tip.seek'],
          ['resolve_screenshot', 'tools.tip.screenshot'],
        ],
      },
      {
        id: 'session',
        title: 'tools.session',
        tools: [['resolve_switch_timeline', 'tools.tip.switchTimeline']],
      },
      {
        id: 'write',
        title: 'tools.write',
        tools: [
          ['resolve_place_clip', 'tools.tip.placeClip'],
          ['resolve_place_clip_ui', 'tools.tip.placeClipUi'],
          ['resolve_delete_item', 'tools.tip.deleteItem'],
          ['resolve_add_marker', 'tools.tip.addMarker'],
          ['resolve_add_render_job', 'tools.tip.addRenderJob'],
          ['resolve_load_render_preset', 'tools.tip.loadRenderPreset'],
          ['resolve_delete_render_job', 'tools.tip.deleteRenderJob'],
          ['resolve_start_rendering', 'tools.tip.startRendering'],
          ['resolve_stop_rendering', 'tools.tip.stopRendering'],
        ],
      },
    ]

    const CSS = `
      .dv-scope { height: 100%; overflow: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .dv-inner {
        width: 100%; max-width: 960px; margin: 0 auto; padding: 28px clamp(24px, 4vw, 48px) 48px;
        box-sizing: border-box;
      }
      [data-platform='darwin'] .dv-inner { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
      .dv-btn { appearance: none; font: inherit; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease; }
      .dv-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
      .dv-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .dv-card { transition: border-color 120ms ease; }
      .dv-card:hover { border-color: var(--dsw-alias-border-l2); }
      @media (max-width: 640px) { .dv-inner { padding: 20px 18px 40px; } }
    `

    const S = {
      header: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18, flexWrap: 'wrap' },
      tile: {
        width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', flex: '0 0 auto',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      heading: { minWidth: 0, flex: '1 1 220px' },
      h1: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: 1.4 },
      subtitle: { margin: '3px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      note: {
        display: 'flex', gap: 10, padding: '11px 14px', marginBottom: 26, borderRadius: 10,
        borderLeft: '3px solid var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5, lineHeight: 1.6,
      },
      section: { marginBottom: 30 },
      sectionHead: { display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 12px', flexWrap: 'wrap' },
      h2: { margin: 0, fontSize: 14, fontWeight: 600 },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 },
      card: {
        padding: '16px 16px 14px', borderRadius: 12, border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      h3: { margin: '0 0 6px', fontSize: 13.5, fontWeight: 600 },
      body: { margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      primary: {
        padding: '6px 12px', borderRadius: 8, border: '1px solid transparent', fontSize: 12.5, fontWeight: 500,
        background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
      },
      secondary: {
        padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', fontSize: 12.5,
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      },
      feedback: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      list: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 7 },
      item: { fontSize: 12.5, lineHeight: 1.45 },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      tip: { marginLeft: 6, color: 'var(--dsw-alias-label-secondary)' },
      reqList: { margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary)' },
      footer: {
        marginTop: 8, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /** Keep the panel's launch button inert while the app holds no Workspace. */
    const selectNoWorkspace = (snapshot) => snapshot.phase === 'ready' && snapshot.items.length === 0

    /**
     * Film-frame and playhead glyph; the sidebar owns the button, label, and
     * selected state around it.
     */
    function DaVinciIcon(props) {
      const size = props.size
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('rect', { x: 2.75, y: 4.75, width: 18.5, height: 14.5, rx: 2.5 }),
        h('path', { d: 'M7.5 4.75v14.5M16.5 4.75v14.5', opacity: 0.5 }),
        h('path', { d: 'M10.75 9.1l4.1 2.9-4.1 2.9z', fill: 'currentColor', stroke: 'none' }),
      )
    }

    /**
     * Render one workflow card: description plus the Session and clipboard
     * actions for its prompt.
     */
    function WorkflowCard(props) {
      const { t, workflow, noWorkspace, copied, onStart, onCopy } = props
      return h('article', { className: 'dv-card', style: S.card },
        h('h3', { style: S.h3 }, t(workflow.title)),
        h('p', { style: S.body }, t(workflow.body)),
        h('div', { style: S.row },
          h('button', {
            type: 'button', className: 'dv-btn', style: S.primary,
            disabled: noWorkspace,
            onClick: () => { onStart(t(workflow.prompt)) },
          }, t('action.newSession')),
          h('button', {
            type: 'button', className: 'dv-btn', style: S.secondary,
            onClick: () => { onCopy(workflow.id, t(workflow.prompt)) },
          }, t('action.copy')),
          copied === workflow.id ? h('span', { style: S.feedback, role: 'status' }, t('action.copied')) : null,
          copied === workflow.id + ':failed' ? h('span', { style: S.feedback, role: 'status' }, t('action.copyFailed')) : null,
        ),
      )
    }

    /**
     * Render the root-scoped DaVinci panel: workflow launchers, the tool
     * inventory, and the prerequisites the Host plugin documents.
     */
    function DaVinciPanel(props) {
      const { t, startWorkflow, openPlugins } = props
      const noWorkspace = props.useWorkspaces(selectNoWorkspace)
      const [copied, setCopied] = React.useState(null)
      const timer = React.useRef(null)
      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])
      const onCopy = async (id, text) => {
        let next = id
        try {
          await navigator.clipboard.writeText(text)
        } catch (error) {
          next = id + ':failed'
        }
        setCopied(next)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => { setCopied(null) }, 1600)
      }

      return h('div', { className: 'dv-scope' },
        h('style', null, CSS),
        h('div', { className: 'dv-inner' },
          h('header', { style: S.header },
            h('div', { style: S.tile, 'aria-hidden': true }, h(DaVinciIcon, { size: 24 })),
            h('div', { style: S.heading },
              h('h1', { style: S.h1 }, t('panel.title')),
              h('p', { style: S.subtitle }, t('panel.subtitle')),
            ),
            h('button', {
              type: 'button', className: 'dv-btn', style: S.secondary, onClick: openPlugins,
            }, t('action.openPlugins')),
          ),
          h('p', { style: S.note }, t('panel.note')),
          h('section', { style: S.section },
            h('div', { style: S.sectionHead },
              h('h2', { style: S.h2 }, t('section.workflow')),
              h('span', { style: S.hint }, t('workflow.hint')),
            ),
            h('div', { style: S.grid },
              WORKFLOWS.map((workflow) => h(WorkflowCard, {
                key: workflow.id, t, workflow, noWorkspace,
                copied, onStart: startWorkflow, onCopy,
              })),
            ),
          ),
          h('section', { style: S.section },
            h('div', { style: S.sectionHead }, h('h2', { style: S.h2 }, t('section.tools'))),
            h('div', { style: S.grid },
              TOOL_GROUPS.map((group) => h('article', { key: group.id, className: 'dv-card', style: S.card },
                h('h3', { style: S.h3 }, t(group.title)),
                h('ul', { style: S.list },
                  group.tools.map(([name, tip]) => h('li', { key: name, style: S.item },
                    h('code', { style: S.code }, name),
                    h('span', { style: S.tip }, t(tip)),
                  )),
                ),
              )),
            ),
          ),
          h('section', { style: S.section },
            h('div', { style: S.sectionHead }, h('h2', { style: S.h2 }, t('section.requirements'))),
            h('article', { className: 'dv-card', style: S.card },
              h('ul', { style: S.reqList },
                ['req.1', 'req.2', 'req.3', 'req.4'].map((key) => h('li', { key }, t(key))),
              ),
            ),
          ),
          h('p', { style: S.footer }, t('footer')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'layout'],
      /**
       * Register the panel and its left-rail entry. The dictionary lives in
       * the Client locale service; the two actions reach the same services a
       * sidebar entry would.
       * @param ctx - Client context owning the registrations.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'davinci-panel: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'davinci-panel: en dictionary')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({
            startWorkflow: (prompt) => { ctx.uiWorkspace.startSession(undefined, { prompt }) },
            openPlugins: () => { ctx.layout.selectPanel('plugins') },
          }),
        }, DaVinciPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel.label'),
        }, DaVinciIcon))
      },
    }
  },
})
