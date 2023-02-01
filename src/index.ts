// TODO: move most/all of this logic over to the Path class.
// The PathWalker should operate on *strings*, and the Paths should
// operate on *Paths*, should be a good blend of performance and
// usability.
// so PathWalker.dirname(str) => PathWalker.resolve(dir).dirname().fullpath
//
// TODO: pw.resolve() should ONLY take strings, throw away any relatives
// that come before any absolutes, and cache the lookup
//
// TODO: replace the children linked list with an array of children,
// but test perf because that might not be good.

import LRUCache from 'lru-cache'
import { parse, resolve, sep } from 'path'

import { Dir, lstatSync, opendirSync, readlinkSync } from 'fs'
import { lstat, opendir, readlink } from 'fs/promises'

import { Dirent, Stats } from 'fs'

function* syncDirIterate(dir: Dir) {
  let e
  try {
    while ((e = dir.readSync())) {
      yield e
    }
  } finally {
    dir.closeSync()
  }
}

// turn something like //?/c:/ into c:\
const uncRegexp = /^\\\\\?\\([a-z]:)\\?$/
const unUNCDrive = (rootPath: string): string =>
  rootPath.replace(/\//g, '\\').replace(uncRegexp, '$1:\\')

const isWindows = process.platform === 'win32'
const isDarwin = process.platform === 'darwin'
const defNocase = isWindows || isDarwin
const driveCwd = (c: string) => c.match(/^([a-z]):(?:\\|\/|$)/)?.[1]
const eitherSep = /[\\\/]/
const splitSep = isWindows ? eitherSep : sep

// a PathWalker has a PointerSet with the following setup:
// - value: the string representing the path portion, using
//   `/` for posix root paths.
// - type: a raw uint32 field:
//    - low 4 bits are the S_IFMT nibble, or 0 for "unknown"
//    - remaining bits are used for various helpful flags.
// - parent: pointer to parent directory
// - chead: start of linked list of child entries
// - ctail: end of linked list of child entries
// - next: next sibling entry in the same directory
// - prev: previous sibling entry in the same directory
// - linkTarget: pointer to path entry that symlink references, if known
//
// Each PathWalker has a single root, but they can share the same store,
// so you could potentially have multiple entries in the store that are
// parentless, even though each PathWalker only has a single root entry.

// PROVISIONAL CHILDREN vs REAL CHILDREN
// each entry has chead and ctail, which define the entire set of children
// they also have a phead which is the first "provisional" child, ie a
// child entry that has not been the subject of a readdir() walk or explicit
// lstat.
//
// when we call pw.child(parent, pathPart) we search the list of children
// for any child entry between chead and ctail, and return it if found,
// otherwise insert at phead.  If phead not set, then it's the new entry
// appended to ctail.  If it is set, then just append to ctail.
//
// when we call pw.readdir() and READDIR_CALLED bit is set, return the list
// of children from chead to before phead.
// If READDIR_CALLED is *not* set, but chead and phead are set, then for
// each entry returned from the fs.Dir iterator, search from phead to ctail
// to see a matching entry.  If found, and equal to phead, then advance phead
// (which might set phead to nullPointer if phead was equal to ctail).
// If found and not phead, move to behind phead.  Otherwise, create a new
// entry and insert behind phead.
// If READDIR_CALLED is not set, and chead and phead are not set, then just
// build the list and don't set phead.
// There should never be a case where phead is set, but chead and ctail are
// not set.
// There should never be a case where READDIR_CALLED is set, and chead/ctail
// are not set.
// There should never be a case where READDIR_CALLED is not set, and chead
// is not equal to phead.
// The only case where READDIR_CALLED will be set, and chead will be equal
// to phead, is if there are no actual children, only provisional ones. And
// in that case, we can bail out of readdir early.

const UNKNOWN = 0 // may not even exist, for all we know
const IFIFO = 0b0001
const IFCHR = 0b0010
const IFDIR = 0b0100
const IFBLK = 0b0110
const IFREG = 0b1000
const IFLNK = 0b1010
const IFSOCK = 0b1100
const IFMT = 0b1111

// mask to unset low 4 bits
const IFMT_UNKNOWN = ~IFMT
// set after successfully calling readdir() and getting entries.
const READDIR_CALLED = 0b0001_0000
// set if an entry (or one of its parents) is definitely not a dir
const ENOTDIR = 0b0010_0000
// set if an entry (or one of its parents) does not exist
// (can also be set on lstat errors like EACCES or ENAMETOOLONG)
const ENOENT = 0b0100_0000
// cannot have child entries
const ENOCHILD = ENOTDIR | ENOENT
// set if we fail to readlink
const ENOREADLINK = 0b1000_0000
const TYPEMASK = 0b1111_1111

const entToType = (s: Dirent | Stats) =>
  s.isFile()
    ? IFREG
    : s.isDirectory()
    ? IFDIR
    : s.isSymbolicLink()
    ? IFLNK
    : s.isCharacterDevice()
    ? IFCHR
    : s.isBlockDevice()
    ? IFBLK
    : s.isSocket()
    ? IFSOCK
    : s.isFIFO()
    ? IFIFO
    : UNKNOWN

// TODO
// Non-PointerSet approach:
// each "Path" is:
// {
//   basename: string (no separators, just a single portion)
//   fullpath?: string (cached resolve())
//   type: number (uint32 of flags)
//   parent?: Path
//   chead?: Path
//   ctail?: Path
//   phead?: Path
//   prev?: Path
//   next?: Path
//   linkTarget?: Path
// }
//
// The PathWalker has a reference to the roots it's seen (which there will only
// be one of on Posix systems, but on Windows could be any number), and all the
// methods for operating on Path objects.
//
// The operations are essentially the same, but instead of taking a Pointer,
// they receive a Path object, and instead of doing stuff like:
// `this.store.ref(pointer, field, otherPointer)` it just does:
// `path[field] = otherPath`.
//
// So we still do each operation exactly once, and a given resolved path string
// always points to the same Path object. And hopefully, the GC won't be so
// terrible, because the entire graph can be pruned at once.
//
// A next step, if gc IS an issue, is to try storing all the Path objects in an
// array, and replacing the Path references to numeric indexes into that array.
// Then each Path would only ever be referenced by the array, and as long as
// none of them make it to old object generation, we should be good there.

interface PathOpts {
  fullpath?: string
  parent?: Path
  chead?: Path
  ctail?: Path
  phead?: Path
  prev?: Path
  next?: Path
  linkTarget?: Path
}
export class Path implements PathOpts {
  basename: string
  fullpath?: string
  type: number
  parent?: Path
  chead?: Path
  ctail?: Path
  phead?: Path
  prev?: Path
  next?: Path
  linkTarget?: Path
  constructor(
    basename: string,
    type: number = UNKNOWN,
    opts: PathOpts = {}
  ) {
    this.basename = basename
    this.type = type & TYPEMASK
    Object.assign(this, opts)
  }

  getType(): number {
    return this.type
  }
  setType(type: number): number {
    return (this.type = type & TYPEMASK)
  }
  addType(type: number): number {
    return (this.type |= type & TYPEMASK)
  }

  isUnknown(): boolean {
    return (this.getType() && IFMT) === UNKNOWN
  }
  isFile(): boolean {
    return (this.getType() & IFMT) === IFREG
  }
  // a directory, or a symlink to a directory
  isDirectory(): boolean {
    return (this.getType() & IFMT) === IFDIR
  }
  isCharacterDevice(): boolean {
    return (this.getType() & IFMT) === IFCHR
  }
  isBlockDevice(): boolean {
    return (this.getType() & IFMT) === IFBLK
  }
  isFIFO(): boolean {
    return (this.getType() & IFMT) === IFIFO
  }
  isSocket(): boolean {
    return (this.getType() & IFMT) === IFSOCK
  }

  // we know it is a symlink
  isSymbolicLink(): boolean {
    return (this.getType() & IFLNK) === IFLNK
  }
}

export interface PathWalkerOpts {
  nocase?: boolean
  roots?: { [k: string]: Path }
  cache?: LRUCache<string, Path>
}

export class PathWalker {
  root: Path
  rootPath: string
  roots: { [k: string]: Path }
  cwd: Path
  cwdPath: string
  nocase: boolean
  cache: LRUCache<string, Path>

  constructor(
    cwd: string = process.cwd(),
    {
      nocase = defNocase,
      roots = Object.create(null),
      cache = new LRUCache<string, Path>({ max: 256 }),
    }: PathWalkerOpts = {}
  ) {
    this.nocase = nocase
    this.cache = cache

    // resolve and split root, and then add to the store.
    // this is the only time we call path.resolve()
    const cwdPath = resolve(cwd)
    this.cwdPath = cwdPath
    if (isWindows) {
      const rootPath = parse(cwdPath).root
      this.rootPath = unUNCDrive(rootPath)
      if (this.rootPath === sep) {
        const drive = driveCwd(resolve(rootPath))
        this.rootPath = drive + sep
      }
    } else {
      this.rootPath = '/'
    }

    const split = cwdPath.substring(this.rootPath.length).split(sep)
    // resolve('/') leaves '', splits to [''], we don't want that.
    if (split.length === 1 && !split[0]) {
      split.pop()
    }
    // we can safely assume the root is a directory.
    this.roots = roots
    const existing = this.roots[this.rootPath]
    if (existing) {
      this.root = existing
    } else {
      this.root = new Path(this.rootPath, IFDIR)
      this.roots[this.rootPath] = this.root
    }
    let prev: Path = this.root
    for (const part of split) {
      prev = this.child(prev, part)
    }
    this.cwd = prev
  }

  // if path is absolute on a diff root, return
  // new PathWalker(path, this).cwd to store paths in the same store
  //
  // if absolute on the same root, walk from the root
  //
  // otherwise, walk it from this.cwd, and return pointer to result
  resolve(path: string): Path
  resolve(entry: Path, path?: string): Path
  resolve(entry: Path | string, path?: string): Path {
    if (typeof entry === 'string') {
      path = entry
      entry = this.cwd
    }
    if (!path) {
      return entry
    }
    const rootPath = isWindows
      ? parse(path).root
      : path.startsWith('/')
      ? '/'
      : ''
    const dir = path.substring(rootPath.length)
    const dirParts = dir.split(splitSep)
    if (rootPath) {
      let root =
        this.roots[rootPath] ||
        (this.sameRoot(rootPath)
          ? this.root
          : new PathWalker(this.dirname(entry), this).root)
      this.roots[rootPath] = root
      return this.resolveParts(root, dirParts)
    } else {
      return this.resolveParts(entry, dirParts)
    }
  }

  sameRoot(rootPath: string): boolean {
    if (!isWindows) {
      // only one root, and it's always /
      return true
    }
    rootPath = rootPath
      .replace(/\\/g, '\\')
      .replace(/\\\\\?\\([a-z]:)\\?$/, '$1:\\')
    // windows can (rarely) have case-sensitive filesystem, but
    // UNC and drive letters are always case-insensitive
    if (rootPath.toUpperCase() === this.rootPath.toUpperCase()) {
      return true
    }
    return false
  }

  resolveParts(dir: Path, dirParts: string[]) {
    let p: Path = dir
    for (const part of dirParts) {
      p = this.child(p, part)
      if (!p) {
        return dir
      }
    }
    return p
  }

  child(parent: Path, pathPart: string): Path {
    if (pathPart === '' || pathPart === '.') {
      return parent
    }
    if (pathPart === '..') {
      return this.parent(parent)
    }

    // find the child
    const { chead, ctail, phead } = parent
    for (let p = chead; p; p = p.next) {
      const v = p.basename
      if (this.matchName(v, pathPart)) {
        return p
      }
      if (p === ctail) {
        break
      }
    }

    // didn't find it, create provisional child, since it might not
    // actually exist.  If we know the parent it's a dir, then
    // in fact it CAN'T exist.
    const s = parent.parent ? sep : ''
    const fullpath = parent.fullpath
      ? parent.fullpath + s + pathPart
      : undefined
    const cached = fullpath && this.cache.get(fullpath)
    if (cached) {
      return cached
    }
    const pchild = new Path(pathPart, UNKNOWN, { parent, fullpath })
    if (fullpath) {
      this.cache.set(fullpath, pchild)
    }
    if (parent.getType() & ENOCHILD) {
      pchild.setType(ENOENT)
    }

    if (phead) {
      if (ctail === undefined) {
        throw new Error(
          'have provisional children, but invalid children list'
        )
      }
      // have provisional children already, just append
      ctail.next = pchild
      pchild.prev = ctail
      parent.ctail = pchild
    } else if (ctail) {
      // have children, just not provisional children
      ctail.next = pchild
      pchild.prev = ctail
      Object.assign(parent, { ctail: pchild, phead: pchild })
    } else {
      // first child, of any kind
      Object.assign(parent, {
        chead: pchild,
        ctail: pchild,
        phead: pchild,
      })
    }
    return pchild
  }

  parent(entry: Path): Path {
    // parentless entries are root path entries.
    return entry.parent || entry
  }

  // dirname/basename/fullpath always within a given PW, so we know
  // that the only thing that can be parentless is the root, unless
  // something is deeply wrong.
  basename(entry: Path = this.cwd): string {
    return entry.basename
  }

  fullpath(entry: Path = this.cwd): string {
    if (entry.fullpath) {
      return entry.fullpath
    }
    const basename = this.basename(entry)
    const p = entry.parent
    if (!p) {
      return (entry.fullpath = entry.basename)
    }
    const pv = this.fullpath(p)
    const fp = pv + (!p.parent ? '' : '/') + basename
    return (entry.fullpath = fp)
  }

  dirname(entry: Path = this.cwd): string {
    return !entry.parent
      ? this.basename(entry)
      : this.fullpath(entry.parent)
  }

  calledReaddir(p: Path): boolean {
    return (p.getType() & READDIR_CALLED) === READDIR_CALLED
  }

  *cachedReaddir(entry: Path): Iterable<Path> {
    const { chead, ctail, phead } = entry
    while (true) {
      for (let c = chead; c && c !== phead; c = c.next) {
        yield c
        if (c === ctail) {
          break
        }
      }
      return
    }
  }

  // asynchronous iterator for dir entries
  async *readdir(entry: Path = this.cwd): AsyncIterable<Path> {
    const t = entry.getType()
    if ((t & ENOCHILD) !== 0) {
      return
    }

    if (this.calledReaddir(entry)) {
      for (const e of this.cachedReaddir(entry)) yield e
      return
    }

    // else read the directory, fill up children
    // de-provisionalize any provisional children.
    const fullpath = this.fullpath(entry)
    if (fullpath === undefined) {
      return
    }
    let finished = false
    try {
      const dir = await opendir(fullpath)
      for await (const e of dir) {
        yield this.readdirAddChild(entry, e)
      }
      finished = true
    } catch (er) {
      this.readdirFail(entry, er as NodeJS.ErrnoException)
    } finally {
      if (finished) {
        this.readdirSuccess(entry)
      } else {
        // all refs must be considered provisional, since it did not
        // complete.
        entry.phead = entry.chead
      }
    }
  }

  readdirSuccess(entry: Path) {
    // succeeded, mark readdir called bit
    entry.addType(READDIR_CALLED)
    // mark all remaining provisional children as ENOENT
    const { phead, ctail } = entry
    for (let p = phead; p; p = p.next) {
      this.markENOENT(p)
      if (p === ctail) {
        break
      }
    }
  }

  readdirAddChild(entry: Path, e: Dirent) {
    return (
      this.readdirMaybePromoteChild(entry, e) ||
      this.readdirAddNewChild(entry, e)
    )
  }

  readdirMaybePromoteChild(entry: Path, e: Dirent): Path | undefined {
    const { phead } = entry
    for (let p = phead; p; p = (p as Path).next) {
      const v = this.basename(p)
      if (!this.matchName(v, e.name)) {
        continue
      }

      return this.readdirPromoteChild(entry, e, p)
    }
  }

  readdirPromoteChild(entry: Path, e: Dirent, p: Path): Path {
    const phead = entry.phead
    const v = this.basename(p)
    const type = entToType(e)
    const ctail = entry.ctail
    const chead = entry.chead
    /* c8 ignore start */
    if (!chead || !ctail || !phead) {
      throw new Error('cannot promote, no provisional entries')
    }
    /* c8 ignore stop */

    p.setType(type)
    // case sensitivity fixing when we learn the true name.
    if (v !== e.name) p.basename = e.name

    if (p === phead) {
      // just advance phead (potentially off the list)
      entry.phead = phead.next
    } else {
      // move to head of list
      const { prev, next } = p
      /* c8 ignore start */
      if (!prev) {
        throw new Error('non-head Path node has no previous entry')
      }

      // if p was at the end of the list, move back tail
      // otherwise, next.prev = prev
      if (p === ctail) entry.ctail = prev
      else if (next) next.prev = prev

      // prev.next points p's next (possibly null)
      prev.next = next
      // move p to chead
      chead.prev = p
      p.next = chead
      entry.chead = p
    }
    return p
  }

  readdirAddNewChild(parent: Path, e: Dirent): Path {
    // alloc new entry at head, so it's never provisional
    const next = parent.chead
    const ctail = parent.ctail
    const type = entToType(e)
    const child = new Path(e.name, type, { parent, next })
    if (next) next.prev = child
    parent.chead = child
    if (!ctail) parent.ctail = child
    return child
  }

  readdirFail(entry: Path, er: NodeJS.ErrnoException) {
    if (er.code === 'ENOTDIR' || er.code === 'EPERM') {
      this.markENOTDIR(entry)
    }
    if (er.code === 'ENOENT') {
      this.markENOENT(entry)
    }
  }

  // save the information when we know the entry is not a dir
  markENOTDIR(entry: Path) {
    // entry is not a directory, so any children can't exist.
    // unmark IFDIR, mark ENOTDIR
    let t = entry.getType()
    // if it's already marked ENOTDIR, bail
    if (t & ENOTDIR) return
    // this could happen if we stat a dir, then delete it,
    // then try to read it or one of its children.
    if ((t & IFDIR) === IFDIR) t &= IFMT_UNKNOWN
    entry.setType(t | ENOTDIR)
    this.markChildrenENOENT(entry)
  }

  markENOENT(entry: Path) {
    // mark as UNKNOWN and ENOENT
    const t = entry.getType()
    if (t & ENOENT) return
    entry.setType((t | ENOENT) & IFMT_UNKNOWN)
    this.markChildrenENOENT(entry)
  }

  markChildrenENOENT(entry: Path) {
    const h = entry.chead
    // all children are provisional
    entry.phead = h
    const t = entry.ctail
    // all children do not exist
    for (let p = h; p; p = p.next) {
      this.markENOENT(p)
      if (p === t) {
        break
      }
    }
  }

  *readdirSync(entry: Path = this.cwd): Iterable<Path> {
    const t = entry.getType()
    if ((t & ENOCHILD) !== 0) {
      return
    }

    if (this.calledReaddir(entry)) {
      for (const e of this.cachedReaddir(entry)) yield e
      return
    }

    // else read the directory, fill up children
    // de-provisionalize any provisional children.
    const fullpath = this.fullpath(entry)
    if (fullpath === undefined) {
      return
    }
    let finished = false
    try {
      const dir = opendirSync(fullpath)
      for (const e of syncDirIterate(dir)) {
        yield this.readdirAddChild(entry, e)
      }
      finished = true
    } catch (er) {
      this.readdirFail(entry, er as NodeJS.ErrnoException)
    } finally {
      if (finished) {
        this.readdirSuccess(entry)
      } else {
        // all refs must be considered provisional now, since it failed.
        entry.phead = entry.chead
      }
    }
  }

  matchName(a: string | undefined, b: string) {
    return a === undefined
      ? false
      : this.nocase
      ? a.toLowerCase() === b.toLowerCase()
      : a === b
    //console.error('MN', a, b, ret)
    //return ret
  }

  // fills in the data we can gather, or returns undefined on error
  async lstat(entry: Path = this.cwd): Promise<Path | undefined> {
    const t = entry.getType()
    if (t & ENOENT) {
      return
    }
    try {
      const path = this.fullpath(entry)
      if (!path) return
      entry.setType(entToType(await lstat(path)))
      return entry
    } catch (er) {
      this.lstatFail(entry, er as NodeJS.ErrnoException)
    }
  }

  lstatSync(entry: Path = this.cwd): Path | undefined {
    const t = entry.getType()
    if (t & ENOENT) {
      return
    }
    try {
      const path = this.fullpath(entry)
      if (!path) return
      entry.setType(entToType(lstatSync(path)))
      return entry
    } catch (er) {
      this.lstatFail(entry, er as NodeJS.ErrnoException)
    }
  }

  lstatFail(entry: Path, er: NodeJS.ErrnoException) {
    if (er.code === 'ENOTDIR') {
      this.markENOTDIR(this.parent(entry))
    } else if (er.code === 'ENOENT') {
      this.markENOENT(entry)
    }
  }

  cannotReadlink(entry: Path): boolean {
    const t = entry.getType()
    // cases where it cannot possibly succeed
    return (
      !!((t & IFMT) !== UNKNOWN && !(t & IFLNK)) ||
      !!(t & ENOREADLINK) ||
      !!(t & ENOENT)
    )
  }

  async readlink(entry: Path): Promise<Path | undefined> {
    const target = entry.linkTarget
    if (target) {
      return target
    }
    if (this.cannotReadlink(entry)) {
      return undefined
    }
    const p = this.parent(entry)
    const fp = this.fullpath(entry)
    /* c8 ignore start */
    // already covered by the cannotReadlink test
    if (!fp || !p) {
      return undefined
    }
    /* c8 ignore stop */
    try {
      const read = await readlink(fp)
      const linkTarget = this.resolve(p, read)
      if (linkTarget) {
        return (entry.linkTarget = linkTarget)
      }
    } catch (er) {
      this.readlinkFail(entry, er as NodeJS.ErrnoException)
      return undefined
    }
  }

  readlinkFail(entry: Path, er: NodeJS.ErrnoException) {
    let ter: number = ENOREADLINK | (er.code === 'ENOENT' ? ENOENT : 0)
    if (er.code === 'EINVAL') {
      // exists, but not a symlink, we don't know WHAT it is, so remove
      // all IFMT bits.
      ter &= IFMT_UNKNOWN
    }
    if (er.code === 'ENOTDIR') {
      this.markENOTDIR(this.parent(entry))
    }
    entry.addType(ter)
  }

  readlinkSync(entry: Path): Path | undefined {
    const target = entry.linkTarget
    if (target) {
      return target
    }
    if (this.cannotReadlink(entry)) {
      return undefined
    }
    const p = this.parent(entry)
    const fp = this.fullpath(entry)
    /* c8 ignore start */
    // already covered by the cannotReadlink test
    if (!fp || !p) {
      return undefined
    }
    /* c8 ignore stop */
    try {
      const read = readlinkSync(fp)
      const linkTarget = this.resolve(p, read)
      if (linkTarget) {
        return (entry.linkTarget = linkTarget)
      }
    } catch (er) {
      this.readlinkFail(entry, er as NodeJS.ErrnoException)
      return undefined
    }
  }
}
