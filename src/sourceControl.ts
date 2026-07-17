import {
  Disposable,
  Emitter,
  Event,
  ExtensionContext,
  extensions,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  workspace
} from 'coc.nvim'
import path from 'path'
import type { CocUiApi } from '@statiolake/coc-ui'
import Manager from './manager'
import Git from './model/git'

interface ChangedFile {
  kind: 'change'
  root: string
  relative: string
  status: string
}

interface Commit {
  kind: 'commit'
  root: string
  hash: string
  subject: string
  decoration: string
  parent: string
}

interface CommitFile {
  kind: 'commitFile'
  root: string
  relative: string
  status: string
  originalRevision: string
  modifiedRevision: string
}

type HistoryItem = Commit | CommitFile

abstract class RefreshableProvider<T> implements TreeDataProvider<T>, Disposable {
  private readonly emitter = new Emitter<void>()
  public readonly onDidChangeTreeData: Event<void> = this.emitter.event

  public refresh(): void {
    this.emitter.fire()
  }

  public dispose(): void {
    this.emitter.dispose()
  }

  public abstract getChildren(element?: T): Promise<T[]>
  public abstract getTreeItem(element: T): TreeItem
}

class ChangesProvider extends RefreshableProvider<ChangedFile> {
  constructor(private readonly sourceControl: SourceControl) {
    super()
  }

  public async getChildren(): Promise<ChangedFile[]> {
    const root = await this.sourceControl.currentRoot()
    if (!root) return []
    const output = await this.sourceControl.exec(root, ['status', '--porcelain=v1', '-uall'])
    return output.split(/\r?\n/).filter(Boolean).map(line => ({
      kind: 'change',
      root,
      status: line.slice(0, 2),
      relative: line.slice(3).split(' -> ').pop()!
    }))
  }

  public getTreeItem(file: ChangedFile): TreeItem {
    const item = new TreeItem(Uri.file(path.join(file.root, file.relative)), TreeItemCollapsibleState.None)
    item.description = file.status
    item.tooltip = `${file.status} ${file.relative}`
    item.command = {
      command: 'git.openSourceControlChange',
      title: 'Open Changes',
      arguments: [file]
    }
    return item
  }
}

class HistoryProvider extends RefreshableProvider<HistoryItem> {
  constructor(private readonly sourceControl: SourceControl) {
    super()
  }

  public async getChildren(element?: HistoryItem): Promise<HistoryItem[]> {
    if (element?.kind === 'commitFile') return []
    if (element?.kind === 'commit') {
      const output = await this.sourceControl.exec(element.root, [
        'diff-tree', '--no-commit-id', '--name-status', '-r', '--root', element.hash
      ])
      return output.split(/\r?\n/).filter(Boolean).map(line => {
        const fields = line.split('\t')
        return {
          kind: 'commitFile' as const,
          root: element.root,
          status: fields[0],
          relative: fields[fields.length - 1],
          originalRevision: element.parent,
          modifiedRevision: element.hash
        }
      })
    }

    const root = await this.sourceControl.currentRoot()
    if (!root) return []
    const limit = Math.max(1, workspace.getConfiguration('git').get<number>('history.maxEntries', 50))
    const output = await this.sourceControl.exec(root, [
      'log', `--max-count=${limit}`, '--format=%H%x1f%P%x1f%D%x1f%s'
    ])
    return output.split(/\r?\n/).filter(Boolean).map(line => {
      const [hash, parents, decoration, subject] = line.split('\x1f')
      return {
        kind: 'commit' as const,
        root,
        hash,
        parent: parents.split(' ')[0] || `${hash}^`,
        decoration,
        subject
      }
    })
  }

  public getTreeItem(element: HistoryItem): TreeItem {
    if (element.kind === 'commit') {
      const item = new TreeItem(`${element.hash.slice(0, 8)} ${element.subject}`, TreeItemCollapsibleState.Collapsed)
      item.description = element.decoration
      item.tooltip = `${element.hash}\n${element.subject}`
      return item
    }
    const item = new TreeItem(element.relative, TreeItemCollapsibleState.None)
    item.description = element.status
    item.command = {
      command: 'git.openSourceControlCommitFile',
      title: 'Open Commit Changes',
      arguments: [element]
    }
    return item
  }
}

export default class SourceControl implements Disposable {
  private readonly changes = new ChangesProvider(this)
  private readonly history = new HistoryProvider(this)
  private readonly disposables: Disposable[] = [this.changes, this.history]

  private constructor(
    private readonly ui: CocUiApi,
    private readonly manager: Manager,
    private readonly git: Git
  ) {}

  public static create(context: ExtensionContext, manager: Manager, git: Git): SourceControl {
    const extension = extensions.getExtensionById<CocUiApi>('@statiolake/coc-ui')
    if (!extension?.exports) throw new Error('coc-ui is not active')
    const sourceControl = new SourceControl(extension.exports, manager, git)
    sourceControl.register(context)
    return sourceControl
  }

  private register(context: ExtensionContext): void {
    const container = this.ui.registerViewContainer({
      id: 'git', title: 'Source Control', icon: '', location: 'primarySidebar', order: 2
    })
    const changesView = this.ui.registerView({ id: 'git.changes', containerId: 'git', name: 'Changes', order: 1 })
    const historyView = this.ui.registerView({ id: 'git.history', containerId: 'git', name: 'History', order: 2 })
    this.disposables.push(
      container,
      changesView,
      historyView,
      this.ui.createTreeView('git.changes', { treeDataProvider: this.changes }),
      this.ui.createTreeView('git.history', { treeDataProvider: this.history }),
      workspace.onDidSaveTextDocument(() => this.refresh())
    )
    context.subscriptions.push(this)
  }

  public async show(): Promise<void> {
    this.refresh()
    await this.ui.showContainer('git', { focus: true })
  }

  public refresh(): void {
    this.changes.refresh()
    this.history.refresh()
  }

  public async openChange(file: ChangedFile): Promise<void> {
    await this.manager.openFileDiff(file.root, file.relative)
  }

  public async openCommitFile(file: CommitFile): Promise<void> {
    await this.manager.openRevisionFileDiff(
      file.root, file.relative, file.originalRevision, file.modifiedRevision
    )
  }

  public async currentRoot(): Promise<string | undefined> {
    const bufnr = await workspace.nvim.call('bufnr', ['%']) as number
    return await this.manager.resolveGitRootFromBufferOrCwd(bufnr) || undefined
  }

  public async exec(root: string, args: string[]): Promise<string> {
    return (await this.git.exec(root, args, { log: false })).stdout.trimEnd()
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }
}

export type { ChangedFile, CommitFile }
