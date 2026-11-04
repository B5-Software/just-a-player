import { ui, useLocale } from '../i18n'
import { Range } from '../ui/Range'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { Folder, X, ArrowLeft, MagnifyingGlass, Check, Radio, CaretRight } from '../icons'
import { useDialogs, type AppDialog } from '../ui/dialog-store'
import { matchesFileType, validSaveName, WINDOWS_COMPUTER, type BrowserListing, type FileDialogRequest } from '@shared/dialogs'
import { radioUrl } from '@shared/audio'

const action = 'rounded-2xl px-5 py-2.5 text-sm font-medium'
function Modal({
  title,
  close,
  children,
  wide = false,
}: {
  title: string
  close: () => void
  children: ReactNode
  wide?: boolean
}): React.JSX.Element {
  useLocale()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    if (root) root.inert = true
    const first =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('button,input')
    first?.focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.activeElement?.matches('[role="listbox"]')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      }
      if (e.key === 'Tab') {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),[tabindex="0"]'
          ) ?? []),
        ].filter((n) => n.getClientRects().length)
        const first = items[0],
          last = items.at(-1)
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      if (root) root.inert = false
      if (before?.isConnected) before.focus()
    }
  }, [close])
  return createPortal(
    ui(<div
      data-panel-portal
      data-app-dialog
      className="app-dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass panel-surface app-dialog ${wide ? 'app-dialog-wide app-dialog-file' : ''}`}
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <div className="app-dialog-orbit" aria-hidden />
        <header className="app-dialog-header relative flex items-start justify-between gap-4">
          <div>
            <p className="app-dialog-brand mb-2 text-[10px] font-semibold tracking-[0.24em] text-accent-text">
              JUST A PLAYER
            </p>
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          </div>
          <button
            type="button"
            aria-label="关闭对话框"
            onClick={close}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-hover text-fg-muted"
          >
            <X size={17} />
          </button>
        </header>
        {children}
      </motion.div>
    </div>),
    document.body
  )
}
function FileBrowser({
  request,
  close,
}: {
  request: FileDialogRequest
  close: () => void
}): React.JSX.Element {
  useLocale()
  const [listing, setListing] = useState<BrowserListing | null>(null)
  const [address, setAddress] = useState(request.defaultPath ?? '')
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState<string[]>([])
  const [filename, setFilename] = useState((request.defaultPath ?? '').split(/[\\/]/).at(-1) || '')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [overwrite, setOverwrite] = useState(false)
  const generation = useRef(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const navigate = async (path?: string): Promise<void> => {
    const token = ++generation.current
    setBusy(true)
    setError('')
    setSelected([])
    setOverwrite(false)
    try {
      const result = await window.jap.browseFiles(path)
      if (token === generation.current) {
        setListing(result)
        setAddress(result.virtual ? '此电脑' : result.path)
        setQuery('')
        if (result.selectedPath && request.mode === 'open' && matchesFileType(result.selectedPath, request.extensions))
          setSelected([result.selectedPath])
        setError(result.error ?? '')
      }
    } catch (e) {
      if (token === generation.current) setError(String(e))
    } finally {
      if (token === generation.current) setBusy(false)
    }
  }
  useEffect(() => {
    void navigate(
      request.defaultPath?.includes('/') || request.defaultPath?.includes('\\')
        ? request.defaultPath
        : undefined
    )
    return () => {
      generation.current++
    }
  }, [request.id])
  useEffect(() => window.jap.onFilesChanged?.(() => {
    void navigate(listing?.path)
  }), [listing?.path, request.id])
  const extensions = request.extensions.filter((e) => e !== '*')
  const entries =
    listing?.entries.filter(
      (e) =>
        e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
        (e.directory ||
          (request.mode !== 'folder' && matchesFileType(e.name, request.extensions)))
    ) ?? []
  const submit = async (): Promise<void> => {
    if (!listing || listing.virtual || listing.error) return
    let paths = selected
    if (request.mode === 'save') {
      if (!validSaveName(filename.trim(), window.jap.platform === 'win32')) {
        setError('请填写有效的文件名称')
        return
      }
      let name = filename.trim()
      if (extensions[0] && !name.includes('.')) name += '.' + extensions[0]
      const existing = listing.entries.find((e) => window.jap.platform === 'win32'
        ? e.name.toLowerCase() === name.toLowerCase() : e.name === name)
      if (existing?.directory) {
        setError('此名称已被文件夹使用')
        return
      }
      if (!overwrite && existing) {
        setOverwrite(true)
        return
      }
      paths = [listing.path.replace(/[\\/]$/, '') + (window.jap.platform === 'win32' ? '\\' : '/') + name]
    } else if (request.mode === 'folder' && !paths.length) paths = [listing.path]
    if (!paths.length) return
    setBusy(true)
    try {
      if (await window.jap.dialogReply(request.id, paths)) useDialogs.getState().remove(request.id)
      else setError('此位置已不可用，请重新选择')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    ui(<Modal title={request.title} close={close} wide>
      <div className="file-browser-toolbar mt-5 flex gap-2">
        <button
          type="button"
          aria-label="上一级文件夹"
          disabled={!listing?.parent || busy}
          onClick={() => void navigate(listing?.parent ?? undefined)}
          className="grid size-10 shrink-0 place-items-center rounded-xl bg-hover disabled:opacity-30"
        >
          <ArrowLeft size={18} />
        </button>
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            void navigate(address.trim() === '此电脑' ? WINDOWS_COMPUTER : address)
          }}
        >
          <input
            aria-label="文件夹路径"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="min-w-0 flex-1 rounded-xl bg-hover px-3 py-2 text-xs"
          />
          <button type="submit" aria-label="转到路径" className="file-browser-go grid w-10 shrink-0 place-items-center rounded-r-xl bg-hover">
            <CaretRight size={18} />
          </button>
        </form>
        <button type="button" aria-label="搜索文件" aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}
          className="file-browser-search-toggle grid size-10 shrink-0 place-items-center rounded-xl bg-hover">
          <MagnifyingGlass size={18} />
        </button>
      </div>
      <div className="file-browser-body mt-3 grid min-h-0 grid-cols-[136px_minmax(0,1fr)] gap-4" data-search-open={searchOpen}>
        <nav aria-label="文件位置" className="flex flex-col gap-1 overflow-y-auto">
          {listing?.roots.map((root) => (
            ui(<button
              type="button"
              key={root.path}
              onClick={() => void navigate(root.path)}
              className={`flex items-center gap-2 rounded-xl p-2.5 text-left text-xs ${root.path === listing.path ? 'bg-accent/15 text-accent-text' : 'hover:bg-hover text-fg-muted'}`}
            >
              <Folder size={16} className="shrink-0" />
              <span className="truncate">{root.name}</span>
            </button>)
          ))}
          {listing?.musicPermissionNeeded && window.jap.requestMusicPermission && (
            <button type="button" className="rounded-xl bg-accent/12 p-2.5 text-xs text-accent-text"
              onClick={() => void window.jap.requestMusicPermission!()}>授权读取音乐</button>
          )}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-col rounded-2xl bg-hover p-2">
          <label className="file-browser-search mb-2 flex items-center gap-2 rounded-xl px-2 text-fg-muted">
            <MagnifyingGlass size={15} />
            <input
              aria-label="搜索当前文件夹"
              placeholder="搜索此位置"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
            />
          </label>
          <div
            role="listbox"
            aria-label="文件列表"
            aria-multiselectable={request.multiple}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {busy ? (
              <p role="status" className="p-6 text-center text-sm text-fg-muted">
                正在读取…
              </p>
            ) : (
              entries.map((entry) => (
                ui(<button
                  type="button"
                  role="option"
                  aria-selected={selected.includes(entry.path)}
                  key={entry.path}
                  onDoubleClick={() => {
                    if (entry.directory) void navigate(entry.path)
                  }}
                  onClick={() => {
                    setOverwrite(false)
                    setError(listing?.error ?? '')
                    if (entry.directory && (request.mode !== 'folder' || listing?.virtual)) {
                      void navigate(entry.path)
                      return
                    }
                    if (request.mode === 'save') setFilename(entry.name)
                    else
                      setSelected((s) =>
                        request.multiple
                          ? s.includes(entry.path)
                            ? s.filter((p) => p !== entry.path)
                            : [...s, entry.path]
                          : [entry.path]
                      )
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs ${selected.includes(entry.path) ? 'bg-accent/15 text-accent-text' : 'hover:bg-hover'}`}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-hover">
                    {entry.directory ? (
                      <Folder size={17} />
                    ) : (
                      <span className="font-mono text-[9px] uppercase">
                        {entry.name.split('.').at(-1)?.slice(0, 4)}
                      </span>
                    )}
                  </span>
                   <span translate="no" className="min-w-0 flex-1 break-all">{entry.name}</span>
                  {entry.directory && request.mode === 'folder' && !listing?.virtual && (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`进入 ${entry.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void navigate(entry.path)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          void navigate(entry.path)
                        }
                      }}
                    >
                      ›
                    </span>
                  )}
                  {selected.includes(entry.path) && <Check size={16} />}
                </button>)
              ))
            )}
            {!busy && !entries.length && (
              <p className="p-8 text-center text-xs text-fg-muted">
                {query ? '没有匹配的文件' : '这里暂时没有可选文件'}
              </p>
            )}
          </div>
        </div>
      </div>
      {request.mode === 'save' && (
        <label className="file-browser-filename mt-4 flex items-center gap-3 text-xs text-fg-muted">
          文件名称
          <input
            aria-label="保存文件名"
            value={filename}
            onChange={(e) => {
              setFilename(e.target.value)
              setOverwrite(false)
              setError(listing?.error ?? '')
            }}
            className="min-w-0 flex-1 rounded-xl bg-hover px-3 py-2.5 text-sm text-fg"
          />
        </label>
      )}
      {(error || overwrite) && (
        <p role="status" className="file-browser-message mt-3 rounded-xl bg-accent/10 p-3 text-xs text-accent-text">
          {error || '此文件已存在。确认替换后将覆盖其内容。'}
        </p>
      )}
      <footer className="file-browser-footer mt-5 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-fg-subtle">
          {selected.length
            ? `已选择 ${selected.length} 项`
            : request.mode === 'folder'
              ? '选择文件夹，或直接使用当前位置'
              : extensions.length
                ? extensions.join(' · ').toUpperCase()
                : '浏览本地文件'}
        </p>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={close} className={`${action} bg-hover text-fg-muted`}>
            取消
          </button>
          <button
            type="button"
            disabled={busy || !!listing?.virtual || !!listing?.error || (request.mode === 'open' && !selected.length)}
            onClick={() => void submit()}
            className={`${action} bg-accent text-on-accent disabled:opacity-35`}
          >
            {overwrite
              ? '确认替换'
              : request.mode === 'save'
                ? '保存'
                : request.mode === 'folder'
                  ? '选择文件夹'
                  : '打开'}
          </button>
        </div>
      </footer>
    </Modal>)
  )
}
function ColorDialog({
  item,
  close,
}: {
  item: Extract<AppDialog, { kind: 'color' }>
  close: () => void
}): React.JSX.Element {
  useLocale()
  const [color, setColor] = useState(item.initial)
  const rgb = /^#[a-f\d]{6}$/i.test(color)
    ? [1, 3, 5].map((p) => parseInt(color.slice(p, p + 2), 16))
    : [132, 118, 255]
  const channel = (i: number, value: number): void =>
    setColor('#' + rgb.map((c, j) => (i === j ? value : c).toString(16).padStart(2, '0')).join(''))
  return (
    ui(<Modal title={item.title} close={close}>
      <div
        className="my-6 h-32 rounded-3xl"
        style={{
          background: `radial-gradient(ellipse at 30% 15%, #fff8, transparent 65%), ${/^#[a-f\d]{6}$/i.test(color) ? color : item.initial}`,
          boxShadow: `0 16px 48px -24px ${item.initial}`,
        }}
      />
      {['红', '绿', '蓝'].map((label, i) => (
        ui(<label key={label} className="mb-4 flex items-center gap-4 text-xs text-fg-muted">
          <span>{label}</span>
          <Range
            aria-label={`${label}色通道`}
            min={0}
            max={255}
            value={rgb[i]}
            onChange={(e) => channel(i, Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-8 text-right font-mono">{rgb[i]}</span>
        </label>)
      ))}
      <input
        aria-label="自定义颜色值"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="mt-1 w-full rounded-2xl bg-hover px-4 py-3 font-mono text-sm uppercase"
      />
      <footer className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={close} className={`${action} bg-hover`}>
          取消
        </button>
        <button
          type="button"
          disabled={!/^#[a-f\d]{6}$/i.test(color)}
          onClick={() => {
            item.done(color)
            useDialogs.getState().remove(item.id)
          }}
          className={`${action} bg-accent text-on-accent disabled:opacity-35`}
        >
          使用这束颜色
        </button>
      </footer>
    </Modal>)
  )
}
function RadioDialog({
  item,
  close,
}: {
  item: Extract<AppDialog, { kind: 'radio' }>
  close: () => void
}): React.JSX.Element {
  useLocale()
  const [address, setAddress] = useState('')
  const [title, setTitle] = useState('')
  const url = radioUrl(address.trim())
  const input =
    'w-full rounded-xl bg-hover px-3 py-2.5 text-sm text-fg outline-none ring-1 ring-line focus:ring-accent'
  return (
    ui(<Modal title="添加在线电台" close={close}>
      <form
        className="relative mt-5 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!url) return
          item.done({ path: url.href, title: title.trim() || url.hostname })
          useDialogs.getState().remove(item.id)
        }}
      >
        <label className="grid gap-1.5 text-xs text-fg-muted">
          电台流地址
          <input
            data-autofocus
            type="text"
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={4096}
            className={input}
            value={address}
            placeholder="https://…"
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-xs text-fg-muted">
          收藏名称（可选）
          <input
            type="text"
            maxLength={160}
            className={input}
            value={title}
            placeholder="例如：夜间爵士"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <p className="text-xs leading-5 text-fg-muted">
          支持 HTTP、HTTPS 直连音频，以及包含直连地址的 M3U 或 PLS 播放列表。
        </p>
        <footer className="mt-2 flex justify-end gap-2">
          <button type="button" className={`${action} bg-hover text-fg-muted`} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            disabled={!url}
            className={`${action} inline-flex items-center gap-2 bg-accent text-on-accent disabled:opacity-35`}
          >
            <Radio size={16} /> 保存并播放
          </button>
        </footer>
      </form>
    </Modal>)
  )
}

export function DialogHost(): React.JSX.Element | null {
  useLocale()
  const item = useDialogs((s) => s.queue[0])
  const closeRef = useRef<() => void>(() => {})
  closeRef.current = () => {
    if (!item) return
    if (item.kind === 'file') void window.jap.dialogReply(item.id, [])
    else if (item.kind === 'confirm') item.done(false)
    else item.done(null)
    useDialogs.getState().remove(item.id)
  }
  const close = useRef(() => closeRef.current()).current
  if (!item) return null
  if (item.kind === 'file')
    return ui(<FileBrowser key={item.id} request={item.request} close={close} />)
  if (item.kind === 'color') return ui(<ColorDialog key={item.id} item={item} close={close} />)
  if (item.kind === 'radio') return ui(<RadioDialog key={item.id} item={item} close={close} />)
  return (
    ui(<Modal key={item.id} title={item.title} close={close}>
      <div className="my-6 rounded-2xl bg-accent/8 p-5 text-sm leading-7 text-fg-muted">
        {item.message}
      </div>
      <footer className="flex justify-end gap-2">
        <button
          type="button"
          data-autofocus
          onClick={close}
          className={`${action} bg-hover text-fg-muted`}
        >
          保留
        </button>
        <button
          type="button"
          onClick={() => {
            item.done(true)
            useDialogs.getState().remove(item.id)
          }}
          className={`${action} ${item.danger ? 'bg-fidelity-lossy/15 text-fidelity-lossy' : 'bg-accent text-on-accent'}`}
        >
          {item.confirm}
        </button>
      </footer>
    </Modal>)
  )
}
