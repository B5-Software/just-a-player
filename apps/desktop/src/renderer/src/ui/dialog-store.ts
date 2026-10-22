import { create } from 'zustand'
import type { FileDialogRequest } from '@shared/dialogs'
export type AppDialog =
  | {
      kind: 'confirm'
      id: string
      title: string
      message: string
      confirm: string
      danger?: boolean
      done: (value: boolean) => void
    }
  | {
      kind: 'color'
      id: string
      title: string
      initial: string
      done: (value: string | null) => void
    }
  | { kind: 'file'; id: string; request: FileDialogRequest }
export const useDialogs = create<{
  queue: AppDialog[]
  add: (dialog: AppDialog) => void
  remove: (id: string) => void
}>((set) => ({
  queue: [],
  add: (dialog) => set((s) => ({ queue: [...s.queue, dialog] })),
  remove: (id) => set((s) => ({ queue: s.queue.filter((d) => d.id !== id) })),
}))
export function confirmAction(
  title: string,
  message: string,
  confirm = '确认',
  danger = false
): Promise<boolean> {
  return new Promise((done) =>
    useDialogs.getState().add({
      kind: 'confirm',
      id: crypto.randomUUID(),
      title,
      message,
      confirm,
      danger,
      done,
    })
  )
}
export function chooseColor(initial: string): Promise<string | null> {
  return new Promise((done) =>
    useDialogs.getState().add({
      kind: 'color',
      id: crypto.randomUUID(),
      title: '调一束属于你的颜色',
      initial,
      done,
    })
  )
}
window.jap.onDialogRequest((request) =>
  useDialogs.getState().add({ kind: 'file', id: request.id, request })
)
