import { extensions, Uri, workspace } from 'coc.nvim'
import path from 'path'
import type { CocDiffviewApi, DiffLayout, OpenDiffOptions } from '@statiolake/coc-diffview'
import Git from './model/git'

export type { DiffLayout } from '@statiolake/coc-diffview'

export default class GitDiffEditor {
  constructor(private readonly git: Git) {}

  public async openCurrent(layout?: DiffLayout, revision = 'HEAD'): Promise<void> {
    const { root, relative, bufnr } = await this.currentFile()
    await this.getDiffview().open(await this.fileOptions(root, relative, bufnr, layout, revision))
  }

  public async toggleCurrent(revision = 'HEAD'): Promise<void> {
    const { root, relative, bufnr } = await this.currentFile()
    await this.getDiffview().toggle(await this.fileOptions(root, relative, bufnr, undefined, revision))
  }

  private async currentFile(): Promise<{ root: string; relative: string; bufnr: number }> {
    const bufnr = await workspace.nvim.call('bufnr', ['%']) as number
    const document = workspace.getDocument(bufnr)
    if (!document || Uri.parse(document.uri).scheme !== 'file') {
      throw new Error('The current buffer is not a file')
    }
    const filename = Uri.parse(document.uri).fsPath
    const root = await this.git.getRepositoryRoot(path.dirname(filename))
    const relative = toGitPath(path.relative(root, filename))
    return { root, relative, bufnr }
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
    const gitPath = toGitPath(relative)
    await this.getDiffview().open(await this.fileOptions(root, gitPath, bufnr, layout, revision))
  }

  public async openRevisionFile(
    root: string,
    relative: string,
    originalRevision: string,
    modifiedRevision: string,
    layout?: DiffLayout
  ): Promise<void> {
    const gitPath = toGitPath(relative)
    const [original, modified] = await Promise.all([
      this.readRevision(root, originalRevision, gitPath),
      this.readRevision(root, modifiedRevision, gitPath)
    ])
    const diffview = this.getDiffview()
    await diffview.open({
      original: {
        kind: 'text',
        text: original,
        label: `${originalRevision}:${gitPath}`
      },
      modified: {
        kind: 'text',
        text: modified,
        label: `${modifiedRevision}:${gitPath}`
      },
      title: `${gitPath} (${originalRevision} ↔ ${modifiedRevision})`,
      layout
    })
  }

  private async fileOptions(
    root: string,
    relative: string,
    bufnr: number,
    layout: DiffLayout | undefined,
    revision: string
  ): Promise<OpenDiffOptions> {
    let original = ''
    try {
      original = (await this.git.exec(root, ['show', `${revision}:${relative}`], { log: false })).stdout
    } catch {
      // A missing blob represents a newly added worktree file.
    }
    const filetype = await workspace.nvim.call('getbufvar', [bufnr, '&filetype']) as string
    return {
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
    }
  }

  private getDiffview(): CocDiffviewApi {
    const extension = extensions.getExtensionById<CocDiffviewApi>('@statiolake/coc-diffview')
    if (!extension?.exports) throw new Error('coc-diffview is not active')
    return extension.exports
  }

  private async readRevision(root: string, revision: string, relative: string): Promise<string> {
    try {
      return (await this.git.exec(root, ['show', `${revision}:${relative}`], { log: false })).stdout
    } catch {
      return ''
    }
  }
}

function toGitPath(value: string): string {
  return value.split(path.sep).join('/')
}
