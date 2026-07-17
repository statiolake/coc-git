import { extensions, Uri, workspace } from 'coc.nvim'
import path from 'path'
import type { CocDiffviewApi, DiffLayout } from '@statiolake/coc-diffview'
import Git from './model/git'

export type { DiffLayout } from '@statiolake/coc-diffview'

export default class GitDiffEditor {
  constructor(private readonly git: Git) {}

  public async openCurrent(layout?: DiffLayout, revision = 'HEAD'): Promise<void> {
    const bufnr = await workspace.nvim.call('bufnr', ['%']) as number
    const document = workspace.getDocument(bufnr)
    if (!document || Uri.parse(document.uri).scheme !== 'file') {
      throw new Error('The current buffer is not a file')
    }
    const filename = Uri.parse(document.uri).fsPath
    const root = await this.git.getRepositoryRoot(path.dirname(filename))
    const relative = toGitPath(path.relative(root, filename))
    await this.open(root, relative, bufnr, layout, revision)
  }

  public async openFile(
    root: string,
    relative: string,
    layout?: DiffLayout,
    revision = 'HEAD'
  ): Promise<void> {
    const filename = path.join(root, relative)
    const bufnr = await workspace.nvim.call('bufadd', [filename]) as number
    await workspace.nvim.call('bufload', [bufnr])
    await this.open(root, toGitPath(relative), bufnr, layout, revision)
  }

  private async open(
    root: string,
    relative: string,
    bufnr: number,
    layout: DiffLayout | undefined,
    revision: string
  ): Promise<void> {
    const diffview = extensions.getExtensionById<CocDiffviewApi>('@statiolake/coc-diffview')
    if (!diffview?.exports) {
      throw new Error('coc-diffview is not active')
    }
    let original = ''
    try {
      original = (await this.git.exec(root, ['show', `${revision}:${relative}`], { log: false })).stdout
    } catch {
      // A missing blob represents a newly added worktree file.
    }
    const filetype = await workspace.nvim.call('getbufvar', [bufnr, '&filetype']) as string
    await diffview.exports.open({
      original: {
        kind: 'text',
        text: original,
        label: `${revision}:${relative}`,
        filetype
      },
      modified: {
        kind: 'buffer',
        buffer: bufnr,
        label: relative
      },
      title: `${relative} (${revision} ↔ Worktree)`,
      layout
    })
  }
}

function toGitPath(value: string): string {
  return value.split(path.sep).join('/')
}
