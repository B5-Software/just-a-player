/** Core/media tests answer the real custom-dialog IPC; dialog UI has its own suite. */
export async function answerNextFileDialog(page, paths) {
  await page.evaluate(
    (paths) => {
      const off = window.jap.onDialogRequest(async (request) => {
        off()
        if (!(await window.jap.dialogReply(request.id, paths)))
          throw new Error('Custom file dialog rejected QA paths')
        window.__jap.useDialogs.getState().remove(request.id)
      })
    },
    Array.isArray(paths) ? paths : [paths]
  )
}
