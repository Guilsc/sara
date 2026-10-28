// Workspace snapshots: before Sara writes files or runs a shell command outside coding mode, the
// workspace is snapshotted so the owner can undo to "before that step". Content-addressed store
// outside the workspace (Sara can't see or touch it): unchanged files are not copied again, and
// nested git repositories are captured as plain files (git-based snapshots can't do that).
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Regenerable folders that are not snapshotted (and left alone on restore). */
export const SNAPSHOT_SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', 'target', '.gradle']);
const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NEW_BYTES = 1024 * 1024 * 1024;
const KEEP = 100;

interface FileEntry {
  hash: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface SnapshotMeta {
  id: string;
  workspace: string;
  createdAt: string;
  label: string;
  conversationId?: string;
  files: number;
  /** Files skipped because they were too large. */
  skipped: string[];
}

interface Manifest extends SnapshotMeta {
  entries: Record<string, FileEntry>;
}

export class SnapshotStore {
  readonly #root: string;
  readonly #now: () => Date;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.#root = join(dataDir, 'snapshots');
    this.#now = now;
  }

  #dirs(workspace: string) {
    const base = join(this.#root, workspace);
    return { base, objects: join(base, 'objects'), manifests: join(base, 'manifests') };
  }

  #manifestFiles(workspace: string): string[] {
    const { manifests } = this.#dirs(workspace);
    if (!existsSync(manifests)) return [];
    return readdirSync(manifests)
      .filter((f) => f.endsWith('.json'))
      .sort();
  }

  #load(workspace: string, file: string): Manifest {
    return JSON.parse(readFileSync(join(this.#dirs(workspace).manifests, file), 'utf8')) as Manifest;
  }

  /** Snapshots the workspace directory. Reuses content-addressed objects for unchanged content. */
  take(workspace: string, workspaceDir: string, label: string, conversationId?: string): SnapshotMeta {
    const { objects, manifests } = this.#dirs(workspace);
    mkdirSync(objects, { recursive: true, mode: 0o700 });
    mkdirSync(manifests, { recursive: true, mode: 0o700 });
    const files = this.#manifestFiles(workspace);
    const entries: Record<string, FileEntry> = {};
    const skipped: string[] = [];
    let count = 0;
    let newBytes = 0;

    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isSymbolicLink()) continue; // links are not followed or restored
        if (e.isDirectory()) {
          if (!SNAPSHOT_SKIP.has(e.name)) walk(abs);
          continue;
        }
        if (!e.isFile()) continue;
        const rel = relative(workspaceDir, abs).split(sep).join('/');
        if (++count > MAX_FILES) throw new Error(`Workspace has more than ${MAX_FILES} files; snapshot skipped.`);
        const st = statSync(abs);
        if (st.size > MAX_FILE_BYTES) {
          skipped.push(rel);
          continue;
        }
        const data = readFileSync(abs);
        const hash = createHash('sha256').update(data).digest('hex');
        const obj = join(objects, hash);
        if (!existsSync(obj)) {
          newBytes += data.length;
          if (newBytes > MAX_NEW_BYTES) throw new Error('Too much changed data for one snapshot (over 1 GB).');
          writeFileSync(obj, data, { mode: 0o600 });
        }
        entries[rel] = { hash, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777 };
      }
    };
    walk(workspaceDir);

    const createdAt = this.#now().toISOString();
    // Strictly increasing ids, so ordering is right even for snapshots in the same millisecond.
    const lastStamp = files.length ? Number(files.at(-1)!.split('-')[0]) : 0;
    const stamp = Math.max(Date.now(), lastStamp + 1);
    const id = `${String(stamp).padStart(15, '0')}-${randomUUID().slice(0, 8)}`;
    const manifest: Manifest = { id, workspace, createdAt, label: label.slice(0, 300), conversationId, files: Object.keys(entries).length, skipped, entries };
    const tmp = join(manifests, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(manifest));
    renameSync(tmp, join(manifests, `${id}.json`));
    this.#prune(workspace);
    const { entries: _e, ...meta } = manifest;
    return meta;
  }

  /** Files added, changed and removed between two snapshots (receipts for delegated work). */
  compare(workspace: string, fromId: string, toId: string): { added: string[]; changed: string[]; removed: string[] } {
    const a = this.#load(workspace, `${fromId}.json`).entries;
    const b = this.#load(workspace, `${toId}.json`).entries;
    const added = Object.keys(b).filter((k) => !a[k]);
    const removed = Object.keys(a).filter((k) => !b[k]);
    const changed = Object.keys(b).filter((k) => a[k] && a[k].hash !== b[k].hash);
    return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
  }

  list(workspace: string): SnapshotMeta[] {
    return this.#manifestFiles(workspace)
      .reverse()
      .map((f) => {
        const { entries: _e, ...meta } = this.#load(workspace, f);
        return meta;
      });
  }

  /**
   * Restores the workspace to a snapshot: rewrites changed files, recreates deleted ones and removes
   * files that didn't exist then (skipped folders such as node_modules are left alone).
   * Takes a safety snapshot first so the restore itself can be undone.
   */
  restore(workspace: string, workspaceDir: string, id: string): { safety: SnapshotMeta; restored: number; removed: number } {
    if (!/^[0-9]+-[0-9a-f]{8}$/.test(id)) throw new Error('Invalid snapshot id');
    const file = `${id}.json`;
    if (!this.#manifestFiles(workspace).includes(file)) throw new Error('Snapshot not found');
    const target = this.#load(workspace, file);
    const safety = this.take(workspace, workspaceDir, `Before restoring to "${target.label}"`, target.conversationId);
    const current = this.#load(workspace, `${safety.id}.json`).entries;
    const { objects } = this.#dirs(workspace);
    let restored = 0;
    let removed = 0;
    /**
     * The folders on the way to a file: a link where a folder should be is removed and the real
     * folder made, so a restore can never write or delete outside the workspace.
     */
    const realFolders = (rel: string): string => {
      const parts = rel.split('/');
      if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`Bad path in snapshot: ${rel}`);
      let cur = workspaceDir;
      for (const part of parts.slice(0, -1)) {
        cur = join(cur, part);
        let st;
        try {
          st = lstatSync(cur);
        } catch {
          mkdirSync(cur);
          continue;
        }
        if (st.isSymbolicLink() || !st.isDirectory()) {
          rmSync(cur, { force: true });
          mkdirSync(cur);
        }
      }
      return join(cur, parts.at(-1)!);
    };
    for (const [rel, entry] of Object.entries(target.entries)) {
      if (current[rel]?.hash === entry.hash) continue;
      const abs = realFolders(rel);
      if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) unlinkSync(abs);
      writeFileSync(abs, readFileSync(join(objects, entry.hash)));
      try {
        chmodSync(abs, entry.mode);
      } catch {
        // non-POSIX
      }
      restored++;
    }
    for (const rel of Object.keys(current)) {
      if (target.entries[rel]) continue;
      // Only remove it if every folder on the way is real (never through a link).
      let cur = workspaceDir;
      let ok = true;
      for (const part of rel.split('/').slice(0, -1)) {
        cur = join(cur, part);
        try {
          if (lstatSync(cur).isSymbolicLink()) ok = false;
        } catch {
          ok = false;
        }
        if (!ok) break;
      }
      if (!ok || rel.split('/').includes('..')) continue;
      rmSync(join(workspaceDir, ...rel.split('/')), { force: true });
      removed++;
    }
    return { safety, restored, removed };
  }

  #prune(workspace: string): void {
    const files = this.#manifestFiles(workspace);
    if (files.length <= KEEP) return;
    const { manifests, objects } = this.#dirs(workspace);
    for (const f of files.slice(0, files.length - KEEP)) rmSync(join(manifests, f), { force: true });
    const live = new Set<string>();
    for (const f of files.slice(-KEEP)) for (const e of Object.values(this.#load(workspace, f).entries)) live.add(e.hash);
    for (const o of readdirSync(objects)) if (!live.has(o)) rmSync(join(objects, o), { force: true });
  }
}

/** Tools that change the workspace and get a snapshot first (outside coding mode). */
export const SNAPSHOT_TOOLS = new Set(['write_file', 'edit_file', 'shell']);
