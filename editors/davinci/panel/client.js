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
      'section.tools': '工具速查（19 个）',
      'section.requirements': '环境要求',
      'workflow.hint': '点击后会在新会话的输入框里预填提示词，发送前你可以再改。',
      'action.newSession': '新建会话',
      'action.copy': '复制提示词',
      'action.copied': '已复制',
      'action.copyFailed': '复制失败',
      'action.openPlugins': '插件设置',
      'wf.conformAudio.title': '套片 · 音画合套',
      'wf.conformAudio.body': '把 SOUNDS 的长混音与 V1 镜头逐段对齐，找出没有落在混音覆盖范围内的片段。',
      'wf.conformAudio.prompt': '读取当前达芬奇工程：先调用 resolve_project_info，再用 resolve_audio_timeline_items(1) 列出 A1 混音、resolve_timeline_items(1) 列出 V1 镜头，逐段比对帧范围，列出没有落在混音覆盖范围内或明显错位的 V1 片段。只读，不改时间线。',
      'wf.conformNested.title': '套片 · 嵌套组装',
      'wf.conformNested.body': '把 TL bin 里按日期命名的嵌套时间线，按落点帧贴到父时间线 V1。',
      'wf.conformNested.prompt': "读取当前达芬奇工程和素材池：用 resolve_project_info 确认时间线，用 resolve_media_pool('TL') 找按日期命名的嵌套时间线（例如 EP04_20260129）。先给出目标父时间线和落点帧的方案；确认后再用 resolve_place_clip 贴到 V1（写操作等审批）。",
      'wf.vfx.title': '贴视效',
      'wf.vfx.body': '按交付物的源 Start TC 找到对应 V1 段，把 VFX 贴到 V2 同起始帧。',
      'wf.vfx.prompt': '在达芬奇里做贴视效：先 resolve_project_info，然后对每个 VFX 交付物用 resolve_find_by_tc 按源 Start TC 找到对应 V1 段，汇总匹配结果和落点帧；确认后用 resolve_place_clip 把交付物贴到 V2 同起始帧（写操作等审批）。',
      'wf.render.title': '输出',
      'wf.render.body': '确认渲染设置与预设，把当前时间线入队、启动或停止渲染。',
      'wf.render.prompt': '检查达芬奇渲染状态：resolve_render_status 与 resolve_render_presets，确认当前格式、编码和预设，报告队列深度与设置；确认后再把当前时间线入队并开始渲染（写操作等审批）。',
      'tools.read': '读取',
      'tools.visual': '视觉',
      'tools.session': '会话',
      'tools.write': '写 · 需审批',
      'tools.tip.projectInfo': '工程、时间线与当前轨道',
      'tools.tip.mediaPool': '列 bin 与素材',
      'tools.tip.timelineItems': '视频轨条目（分页）',
      'tools.tip.findByTc': '按源 TC 找 V1 段',
      'tools.tip.findClip': '全工程按名找条目',
      'tools.tip.audioTimelineItems': '音频轨条目',
      'tools.tip.renderStatus': '渲染队列与当前设置',
      'tools.tip.renderPresets': '预设列表与当前格式',
      'tools.tip.seek': '移动播放头',
      'tools.tip.screenshot': '截屏，配合 read_image',
      'tools.tip.switchTimeline': '切换当前时间线',
      'tools.tip.placeClip': '贴片段（V2 对位约定）',
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
      'section.tools': 'Tool reference (19)',
      'section.requirements': 'Requirements',
      'workflow.hint': 'Clicking prefills the prompt in a new Session; edit it before sending.',
      'action.newSession': 'New Session',
      'action.copy': 'Copy prompt',
      'action.copied': 'Copied',
      'action.copyFailed': 'Copy failed',
      'action.openPlugins': 'Plugin settings',
      'wf.conformAudio.title': 'Conform · Audio sync',
      'wf.conformAudio.body': 'Align the long SOUNDS mix with each V1 shot and flag segments the mix does not cover.',
      'wf.conformAudio.prompt': 'Read the running DaVinci project: call resolve_project_info, then list the A1 mix with resolve_audio_timeline_items(1) and the V1 shots with resolve_timeline_items(1), compare frame ranges segment by segment, and report the V1 segments that fall outside the mix coverage or look misaligned. Read-only: do not change the timeline.',
      'wf.conformNested.title': 'Conform · Nested assembly',
      'wf.conformNested.body': 'Place a date-named nested timeline from the TL bin onto the parent timeline V1 at the right frame.',
      'wf.conformNested.prompt': "Read the running DaVinci project and media pool: confirm timelines with resolve_project_info, then find the date-named nested timeline in the TL bin with resolve_media_pool('TL') (for example EP04_20260129). Propose the target parent timeline and landing frame first; after confirmation, place it on V1 with resolve_place_clip (the write waits for approval).",
      'wf.vfx.title': 'VFX layup',
      'wf.vfx.body': 'Match a deliverable to its V1 segment by source Start TC and place it on V2 at the same start frame.',
      'wf.vfx.prompt': 'Do a VFX layup in DaVinci: call resolve_project_info, then match every VFX deliverable to its V1 segment by source Start TC with resolve_find_by_tc, and summarize the matches and landing frames. After confirmation, place each deliverable on V2 at the matching start frame with resolve_place_clip (the write waits for approval).',
      'wf.render.title': 'Output',
      'wf.render.body': 'Confirm render settings and preset, then enqueue the current timeline and start or stop rendering.',
      'wf.render.prompt': 'Inspect the DaVinci render state: call resolve_render_status and resolve_render_presets, confirm the current format, codec, and preset, and report queue depth and settings. After confirmation, enqueue the current timeline and start rendering (the writes wait for approval).',
      'tools.read': 'Read',
      'tools.visual': 'Visual',
      'tools.session': 'Session',
      'tools.write': 'Write · approval',
      'tools.tip.projectInfo': 'Project, timelines, current tracks',
      'tools.tip.mediaPool': 'List bins and clips',
      'tools.tip.timelineItems': 'Video-track items (paged)',
      'tools.tip.findByTc': 'Find V1 segments by source TC',
      'tools.tip.findClip': 'Find items by name everywhere',
      'tools.tip.audioTimelineItems': 'Audio-track items',
      'tools.tip.renderStatus': 'Queue state and live settings',
      'tools.tip.renderPresets': 'Preset list and active format',
      'tools.tip.seek': 'Move the playhead',
      'tools.tip.screenshot': 'Capture for read_image',
      'tools.tip.switchTimeline': 'Change the current timeline',
      'tools.tip.placeClip': 'Place a clip (V2 convention)',
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
