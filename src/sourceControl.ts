import {
  Disposable, Emitter, Event, ExtensionContext, events, extensions,
  TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri, window, workspace
} from 'coc.nvim'
import path from 'path'
import type { CocUiApi } from '@statiolake/coc-ui'
import Manager from './manager'
import Git from './model/git'

type ChangeArea = 'staged' | 'workingTree'

interface ChangedFile {
  kind: 'change'
  area: ChangeArea
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
  public refresh(): void { this.emitter.fire() }
  public dispose(): void { this.emitter.dispose() }
  public abstract getChildren(element?: T): Promise<T[]>
  public abstract getTreeItem(element: T): TreeItem
}

class ChangesProvider extends RefreshableProvider<ChangedFile> {
  constructor(private readonly sourceControl: SourceControl, private readonly area: ChangeArea) { super() }

  public getChildren(): Promise<ChangedFile[]> { return this.sourceControl.getChanges(this.area) }

  public getTreeItem(file: ChangedFile): TreeItem {
    const item = new TreeItem(Uri.file(path.join(file.root, file.relative)), TreeItemCollapsibleState.None)
    item.description = file.status
    item.tooltip = `${file.status} ${file.relative}`
    item.command = { command: 'git.openSourceControlChange', title: 'Open Changes', arguments: [file] }
    return item
  }
}

class HistoryProvider extends RefreshableProvider<HistoryItem> {
  private readonly expanded = new Set<string>()
  constructor(private readonly sourceControl: SourceControl) { super() }

  public toggle(commit: Commit): void {
    if (this.expanded.has(commit.hash)) this.expanded.delete(commit.hash)
    else this.expanded.add(commit.hash)
    this.refresh()
  }

  public async getChildren(element?: HistoryItem): Promise<HistoryItem[]> {
    if (element?.kind === 'commitFile') return []
    if (element?.kind === 'commit') {
      if (!this.expanded.has(element.hash)) return []
      const output = await this.sourceControl.exec(element.root, [
        'diff-tree', '--no-commit-id', '--name-status', '-r', '--root', element.hash
      ])
      return output.split(/\r?\n/).filter(Boolean).map(line => {
        const fields = line.split('\t')
        return { kind: 'commitFile' as const, root: element.root, status: fields[0],
          relative: fields[fields.length - 1], originalRevision: element.parent, modifiedRevision: element.hash }
      })
    }
    const root = await this.sourceControl.currentRoot()
    if (!root) return []
    const limit = Math.max(1, workspace.getConfiguration('git').get<number>('history.maxEntries', 50))
    const output = await this.sourceControl.exec(root, ['log', `--max-count=${limit}`, '--format=%H%x1f%P%x1f%D%x1f%s'])
    return output.split(/\r?\n/).filter(Boolean).map(line => {
      const [hash, parents, decoration, subject] = line.split('\x1f')
      return { kind: 'commit' as const, root, hash, parent: parents.split(' ')[0] || `${hash}^`, decoration, subject }
    })
  }

  public getTreeItem(element: HistoryItem): TreeItem {
    if (element.kind === 'commit') {
      const state = this.expanded.has(element.hash) ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed
      const item = new TreeItem(`${element.hash.slice(0, 8)} ${element.subject}`, state)
      item.id = element.hash
      item.description = element.decoration
      item.tooltip = `${element.hash}\n${element.subject}`
      item.command = { command: 'git.activateSourceControlHistoryItem', title: 'Show Commit Files', arguments: [element] }
      return item
    }
    const item = new TreeItem(element.relative, TreeItemCollapsibleState.None)
    item.description = element.status
    item.command = { command: 'git.activateSourceControlHistoryItem', title: 'Open Commit Changes', arguments: [element] }
    return item
  }
}

export default class SourceControl implements Disposable {
  private readonly staged = new ChangesProvider(this, 'staged')
  private readonly workingTree = new ChangesProvider(this, 'workingTree')
  private readonly history = new HistoryProvider(this)
  private readonly disposables: Disposable[] = [this.staged, this.workingTree, this.history]
  private readonly visibleTrees = new Set<string>()
  private monitorTimer: NodeJS.Timeout | undefined
  private monitorRunning = false
  private repositorySnapshot: string | undefined
  private changesPromise: Promise<ChangedFile[]> | undefined

  private constructor(private readonly ui: CocUiApi, private readonly manager: Manager, private readonly git: Git) {}

  public static create(context: ExtensionContext, manager: Manager, git: Git): SourceControl {
    const extension = extensions.getExtensionById<CocUiApi>('@statiolake/coc-ui')
    if (!extension?.exports) throw new Error('coc-ui is not active')
    const sourceControl = new SourceControl(extension.exports, manager, git)
    sourceControl.register(context)
    return sourceControl
  }

  private register(context: ExtensionContext): void {
    const container = this.ui.registerViewContainer({ id: 'git', title: 'Source Control', icon: '', location: 'primarySidebar', order: 2 })
    const stagedView = this.ui.registerView({ id: 'git.stagedChanges', containerId: 'git', name: 'Staged Changes', order: 1 })
    const changesView = this.ui.registerView({ id: 'git.changes', containerId: 'git', name: 'Changes', order: 2 })
    const historyView = this.ui.registerView({ id: 'git.history', containerId: 'git', name: 'History', order: 3 })
    const stagedTree = this.ui.createTreeView('git.stagedChanges', {
      treeDataProvider: this.staged,
      actions: this.changeActions('staged')
    })
    const changesTree = this.ui.createTreeView('git.changes', {
      treeDataProvider: this.workingTree,
      actions: this.changeActions('workingTree')
    })
    const historyTree = this.ui.createTreeView('git.history', {
      treeDataProvider: this.history,
      actions: [{ id: 'git.activateHistoryItem', title: 'Activate', keys: ['<CR>'], handler: item => this.activateHistoryItem(item) }]
    })
    this.disposables.push(container, stagedView, changesView, historyView, stagedTree, changesTree, historyTree)
    for (const [id, tree] of [['staged', stagedTree], ['changes', changesTree], ['history', historyTree]] as const) {
      this.disposables.push(tree.onDidChangeVisibility(event => this.setTreeVisibility(id, event.visible)))
    }
    this.disposables.push(
      workspace.onDidSaveTextDocument(() => void this.checkRepository(true)),
      events.on('FocusGained', () => void this.checkRepository()),
      events.on('BufEnter', () => void this.checkRepository())
    )
    context.subscriptions.push(this)
  }

  private changeActions(area: ChangeArea) {
    return [
      { id: area === 'staged' ? 'git.unstage' : 'git.stage', title: area === 'staged' ? 'Unstage' : 'Stage',
        keys: [area === 'staged' ? 'u' : 's'], handler: (file: ChangedFile) => area === 'staged' ? this.unstage(file) : this.stage(file) },
      { id: 'git.commit', title: 'Commit', keys: ['c'], handler: () => this.commit() }
    ]
  }

  public async getChanges(area: ChangeArea): Promise<ChangedFile[]> {
    if (!this.changesPromise) this.changesPromise = this.loadChanges()
    return (await this.changesPromise).filter(change => change.area === area)
  }

  private async loadChanges(): Promise<ChangedFile[]> {
    const root = await this.currentRoot()
    if (!root) return []
    const output = await this.exec(root, ['status', '--porcelain=v1', '-uall'])
    return output.split(/\r?\n/).filter(Boolean).flatMap(line => {
      const [index, worktree] = line.slice(0, 2)
      const relative = line.slice(3).split(' -> ').pop()!
      const result: ChangedFile[] = []
      const untracked = line.startsWith('??')
      if (index !== ' ' && index !== '?') result.push({ kind: 'change', area: 'staged', root, relative, status: index })
      if (worktree !== ' ' || untracked) result.push({ kind: 'change', area: 'workingTree', root, relative, status: untracked ? '?' : worktree })
      return result
    })
  }

  public async show(): Promise<void> { this.refresh(); await this.ui.showContainer('git', { focus: true }) }
  public refresh(): void { this.changesPromise = undefined; this.staged.refresh(); this.workingTree.refresh(); this.history.refresh() }

  public async openChange(file: ChangedFile): Promise<void> {
    if (file.area === 'staged') await this.manager.openStagedFileDiff(file.root, file.relative)
    else await this.manager.openWorkingTreeFileDiff(file.root, file.relative)
  }
  public async openCommitFile(file: CommitFile): Promise<void> {
    await this.manager.openRevisionFileDiff(file.root, file.relative, file.originalRevision, file.modifiedRevision)
  }
  public async activateHistoryItem(item: HistoryItem): Promise<void> {
    if (item.kind === 'commit') this.history.toggle(item)
    else await this.openCommitFile(item)
  }
  public async stage(file: ChangedFile): Promise<void> { await this.exec(file.root, ['add', '--', file.relative]); await this.afterMutation() }
  public async unstage(file: ChangedFile): Promise<void> { await this.exec(file.root, ['restore', '--staged', '--', file.relative]); await this.afterMutation() }
  public async commit(): Promise<void> {
    const root = await this.currentRoot()
    if (!root) return
    const message = await window.requestInput('Commit message')
    if (!message?.trim()) return
    await this.exec(root, ['commit', '-m', message.trim()])
    await this.afterMutation()
  }
  private async afterMutation(): Promise<void> { this.repositorySnapshot = undefined; this.refresh(); await this.checkRepository(true) }

  private setTreeVisibility(id: string, visible: boolean): void {
    if (visible) this.visibleTrees.add(id); else this.visibleTrees.delete(id)
    if (this.visibleTrees.size) this.startMonitor(); else this.stopMonitor()
  }
  private startMonitor(): void { if (this.monitorTimer) return; void this.checkRepository(true); this.monitorTimer = setInterval(() => void this.checkRepository(), 1000) }
  private stopMonitor(): void { if (this.monitorTimer) clearInterval(this.monitorTimer); this.monitorTimer = undefined; this.repositorySnapshot = undefined }
  private async checkRepository(forceRefresh = false): Promise<void> {
    if (!this.visibleTrees.size || this.monitorRunning) return
    this.monitorRunning = true
    try {
      const root = await this.currentRoot(); if (!root) return
      const [head, branch, status] = await Promise.all([
        this.exec(root, ['rev-parse', 'HEAD']).catch(() => ''), this.exec(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
        this.exec(root, ['status', '--porcelain=v1', '-uall']).catch(() => '')
      ])
      const snapshot = `${root}\0${head}\0${branch}\0${status}`
      if (forceRefresh || (this.repositorySnapshot && snapshot !== this.repositorySnapshot)) this.refresh()
      this.repositorySnapshot = snapshot
    } finally { this.monitorRunning = false }
  }

  public async currentRoot(): Promise<string | undefined> {
    const bufnr = await workspace.nvim.call('bufnr', ['%']) as number
    return await this.manager.resolveGitRootFromBufferOrCwd(bufnr) || undefined
  }
  public async exec(root: string, args: string[]): Promise<string> { return (await this.git.exec(root, args, { log: false })).stdout.trimEnd() }
  public dispose(): void { this.stopMonitor(); for (const disposable of this.disposables.splice(0)) disposable.dispose() }
}

export type { ChangedFile, Commit, CommitFile, HistoryItem }
