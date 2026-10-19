import { useSettings } from '../settings/store'
import { SectionTitle, SettingRow, Toggle } from '../ui/controls'
import { scanMusicFolders } from '../library/scanner'
import { LightingSettings } from './LightingSettings'
import { useUi } from '../ui/store'
import { RenderSettings } from './RenderSettings'

/** 设置：控件自动隐藏，以及文件与播放列表相关的行为开关。 */
export function SettingsPanel(): React.JSX.Element {
  const autoHide = useSettings((s) => s.autoHideControls)
  const sidecarLyrics = useSettings((s) => s.sidecarLyrics)
  const sidecarCover = useSettings((s) => s.sidecarCover)
  const recursiveScan = useSettings((s) => s.recursiveScan)
  const rememberPlaylist = useSettings((s) => s.rememberPlaylist)
  const update = useSettings((s) => s.update)
  const fps = useSettings((s) => s.renderFps)
  const scale = useSettings((s) => s.renderScale)
  const effects = useSettings((s) => s.renderEffects)
  const background = useSettings((s) => s.backgroundPlayback)
  const autoScan = useSettings((s) => s.autoScan)
  const folders = useSettings((s) => s.musicFolders)
  const wallpaper = useSettings((s) => s.wallpaperEnabled)
  const follow = useSettings((s) => s.wallpaperMouseFollow)
  const miniBackdrop = useSettings((s) => s.miniCoverBackdrop)
  const fullscreenTime = useSettings((s) => s.fullscreenTime),
    fullscreenDate = useSettings((s) => s.fullscreenDate),
    wallpaperTime = useSettings((s) => s.wallpaperTime),
    wallpaperDate = useSettings((s) => s.wallpaperDate)

  return (
    <div className="flex flex-col gap-6">
      <LightingSettings />
      <RenderSettings />
      <button
        type="button"
        className="rounded-xl bg-hover p-3 text-left text-xs text-accent-text"
        onClick={() => useUi.getState().setOnboardingOpen(true)}
      >
        重新打开舞台新手指导 · 移动与旋转
      </button>
      <section className="flex flex-col gap-4">
        <SectionTitle>性能与画质</SectionTitle>
        <SettingRow
          title="帧率上限"
          hint="默认不限帧率；最小化或隐藏时自动暂停绘制，音频继续播放。"
        >
          <select
            aria-label="帧率上限"
            value={fps}
            onChange={(e) => update({ renderFps: Number(e.target.value) })}
            className="rounded-lg bg-hover p-2 text-xs"
          >
            {[0, 24, 30, 60, 120].map((v) => (
              <option key={v} value={v}>
                {v ? `${v} FPS` : '不限制'}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="渲染精度" hint="相对于屏幕原生像素；降低精度可减少显存与 GPU 使用。">
          <select
            aria-label="渲染精度"
            value={scale}
            onChange={(e) => update({ renderScale: Number(e.target.value) })}
            className="rounded-lg bg-hover p-2 text-xs"
          >
            {[0.5, 0.75, 1, 1.5, 2].map((v) => (
              <option key={v} value={v}>
                {v * 100}%
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="后处理效果" hint="泛光、颗粒、色差；专业仪表始终保持清晰。">
          <Toggle
            label="后处理效果"
            checked={effects}
            onChange={(renderEffects) => update({ renderEffects })}
          />
        </SettingRow>
        <SettingRow title="后台播放" hint="关闭窗口后保留托盘与音频；托盘菜单可退出。">
          <Toggle
            label="后台播放"
            checked={background}
            onChange={(backgroundPlayback) => update({ backgroundPlayback })}
          />
        </SettingRow>
      </section>
      <section className="flex flex-col gap-4">
        <SectionTitle>界面</SectionTitle>
        <SettingRow
          title="桌面壁纸"
          hint={
            window.jap.platform === 'win32'
              ? '开启后自动铺满桌面。主界面显示时保留静态模糊截图并暂停壁纸绘制；小窗或后台时壁纸继续动态播放。'
              : '桌面壁纸目前仅支持 Windows；此平台可使用全屏可视化。'
          }
        >
          <Toggle
            label="桌面壁纸"
            disabled={window.jap.platform !== 'win32'}
            checked={wallpaper}
            onChange={(wallpaperEnabled) => update({ wallpaperEnabled })}
          />
        </SettingRow>
        <SettingRow title="壁纸鼠标跟随" hint="让 3D 视效跟随系统鼠标；不拦截桌面图标的点击。">
          <Toggle
            label="壁纸鼠标跟随"
            disabled={window.jap.platform !== 'win32'}
            checked={follow}
            onChange={(wallpaperMouseFollow) => update({ wallpaperMouseFollow })}
          />
        </SettingRow>
        <SettingRow title="小窗模糊封面背景">
          <Toggle
            label="小窗模糊封面背景"
            checked={miniBackdrop}
            onChange={(miniCoverBackdrop) => update({ miniCoverBackdrop })}
          />
        </SettingRow>
        <p className="text-xs text-fg-muted">
          悬浮播放入口位于窗口最小化按钮左侧；小窗中点击展开可恢复原窗口。
        </p>
        <SectionTitle>日期与时间</SectionTitle>
        {(
          [
            ['全屏显示时间', fullscreenTime, 'fullscreenTime'],
            ['全屏显示日期', fullscreenDate, 'fullscreenDate'],
            ['壁纸显示时间', wallpaperTime, 'wallpaperTime'],
            ['壁纸显示日期', wallpaperDate, 'wallpaperDate']
          ] as const
        ).map(([label, checked, key]) => (
          <SettingRow key={key} title={label}>
            <Toggle
              label={label}
              disabled={key.startsWith('wallpaper') && window.jap.platform !== 'win32'}
              checked={checked}
              onChange={(value) => update({ [key]: value })}
            />
          </SettingRow>
        ))}
        <SettingRow
          title="控件自动隐藏"
          hint="窗口模式下，空闲 3 秒后隐藏顶栏与控制坞。全屏时始终开启。"
        >
          <Toggle
            checked={autoHide}
            onChange={(v) => update({ autoHideControls: v })}
            label="控件自动隐藏"
          />
        </SettingRow>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>文件与列表</SectionTitle>
        <SettingRow
          title="自动扫描音乐目录"
          hint="启动及每分钟扫描音乐、网易云下载目录；新文件加入“本地音乐”列表。可指定自定义目录。"
        >
          <Toggle
            label="自动扫描音乐目录"
            checked={autoScan}
            onChange={(autoScan) => update({ autoScan })}
          />
        </SettingRow>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-xl bg-hover p-2 text-xs"
            onClick={() => {
              void window.jap.openFolders().then((paths) => {
                if (paths.length) update({ musicFolders: paths })
              })
            }}
          >
            选择扫描目录
          </button>
          <button
            type="button"
            className="rounded-xl bg-hover p-2 text-xs"
            onClick={() => {
              void scanMusicFolders()
            }}
          >
            立即扫描
          </button>
          <button
            type="button"
            className="rounded-xl bg-hover p-2 text-xs"
            onClick={() => update({ musicFolders: [] })}
          >
            默认目录
          </button>
        </div>
        <p className="break-all text-[11px] text-fg-muted">
          {folders.length ? folders.join(' · ') : '系统音乐目录 + 常见 CloudMusic / 网易云下载目录'}
        </p>
        <SettingRow title="同名 .lrc 自动加载" hint="播放时读取与音频同名的歌词文件">
          <Toggle
            checked={sidecarLyrics}
            onChange={(v) => update({ sidecarLyrics: v })}
            label="同名 lrc 自动加载"
          />
        </SettingRow>
        <SettingRow title="同目录封面自动加载" hint="cover / folder / front 图片；内嵌封面优先">
          <Toggle
            checked={sidecarCover}
            onChange={(v) => update({ sidecarCover: v })}
            label="同目录封面自动加载"
          />
        </SettingRow>
        <SettingRow title="文件夹递归扫描" hint="添加文件夹时包含子文件夹">
          <Toggle
            checked={recursiveScan}
            onChange={(v) => update({ recursiveScan: v })}
            label="文件夹递归扫描"
          />
        </SettingRow>
        <SettingRow title="记住播放列表" hint="记住每个列表的曲目、进度与随机顺序；重启不自动播放">
          <Toggle
            checked={rememberPlaylist}
            onChange={(v) => update({ rememberPlaylist: v })}
            label="记住播放列表"
          />
        </SettingRow>
      </section>
      <p className="pt-2 text-center text-xs text-fg-subtle">
        Just A Player {window.jap.version} · B5-Software · GPL-3.0-or-later
      </p>
    </div>
  )
}
