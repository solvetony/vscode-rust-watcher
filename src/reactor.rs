use crate::model::{checked_path, event, transient, Entry, Filter, Spec};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::ffi::CString;
use std::fs::{self, ReadDir};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

pub type Callback = ThreadsafeFunction<String, ErrorStrategy::CalleeHandled>;

pub enum Command {
    Add(u32, Spec, Arc<AtomicBool>),
    Overflow,
}

#[derive(Default)]
pub struct Stats {
    pub watches: AtomicUsize,
    pub subscriptions: AtomicUsize,
    pub visited: AtomicUsize,
    pub pruned: AtomicUsize,
    pub queued: AtomicUsize,
    pub overflows: AtomicUsize,
    pub rescans: AtomicUsize,
    pub tracked: AtomicUsize,
    pub work: AtomicUsize,
    pub peak_work: AtomicUsize,
}

impl Stats {
    pub fn json(&self) -> String {
        json!({"activeWatches": self.watches.load(Ordering::Relaxed),
            "subscriptions": self.subscriptions.load(Ordering::Relaxed),
            "visitedDirectories": self.visited.load(Ordering::Relaxed),
            "pruned": self.pruned.load(Ordering::Relaxed),
            "queuedEvents": self.queued.load(Ordering::Relaxed),
            "overflows": self.overflows.load(Ordering::Relaxed),
            "rescans": self.rescans.load(Ordering::Relaxed),
            "trackedEntries": self.tracked.load(Ordering::Relaxed),
            "pendingWork": self.work.load(Ordering::Relaxed),
            "peakSubscriptionWork": self.peak_work.load(Ordering::Relaxed)})
        .to_string()
    }
}

enum Work {
    Visit(PathBuf),
    Children(ReadDir),
}

struct Subscription {
    filter: Filter,
    cancelled: Arc<AtomicBool>,
    current: BTreeMap<PathBuf, Entry>,
    delivered: BTreeMap<PathBuf, Entry>,
    dirty: BTreeSet<PathBuf>,
    pending: HashMap<PathBuf, (bool, bool)>,
    work: VecDeque<Work>,
    watched: HashSet<PathBuf>,
    ready: bool,
    ready_sent: bool,
    error: Option<String>,
    full_diff: bool,
    overflow_notice: bool,
    since: Instant,
    due: Instant,
}

impl Subscription {
    fn check_limits(&self) -> io::Result<()> {
        let limit = self.filter.spec.max_tracked_entries;
        if self.current.len() > limit || self.work.len() > limit {
            return Err(io::Error::other(format!("subscription tracking limit exceeded: maxTrackedEntries={limit}, trackedEntries={}, pendingWork={}, requestedRoot={}, effectiveRoots={:?}", self.current.len(), self.work.len(), self.filter.spec.root.display(), self.filter.spec.roots)));
        }
        Ok(())
    }

    fn new(spec: Spec, cancelled: Arc<AtomicBool>) -> io::Result<Self> {
        let filter = Filter::new(spec)?;
        let work = filter
            .spec
            .roots
            .iter()
            .filter(|p| !filter.ignored(p))
            .cloned()
            .map(Work::Visit)
            .collect();
        Ok(Self {
            filter,
            cancelled,
            current: BTreeMap::new(),
            delivered: BTreeMap::new(),
            dirty: BTreeSet::new(),
            pending: HashMap::new(),
            work,
            watched: HashSet::new(),
            ready: false,
            ready_sent: false,
            error: None,
            full_diff: false,
            overflow_notice: false,
            since: Instant::now(),
            due: Instant::now(),
        })
    }

    fn dirty(&mut self, path: PathBuf, stats: &Stats) {
        if !self.ready || self.full_diff {
            return;
        }
        let first = self.dirty.is_empty();
        self.dirty.insert(path);
        if self.dirty.len() > self.filter.spec.max_queued_events {
            self.dirty.clear();
            self.pending.clear();
            self.full_diff = true;
            self.overflow_notice = true;
            stats.overflows.fetch_add(1, Ordering::Relaxed);
        }
        if first {
            self.due = Instant::now() + Duration::from_millis(self.filter.spec.debounce_ms);
        }
    }

    fn record(&mut self, path: PathBuf, kind: &str, stats: &Stats) {
        self.dirty(path.clone(), stats);
        if !self.ready || self.full_diff {
            return;
        }
        let flags = self.pending.entry(path).or_default();
        match kind {
            "create" => {
                if flags.1 {
                    flags.1 = false;
                } else {
                    flags.0 = true;
                }
            }
            "delete" => flags.1 = true,
            _ => {}
        }
    }
}

struct Watch {
    wd: i32,
    owners: HashSet<u32>,
}

struct Watches {
    fd: OwnedFd,
    paths: HashMap<PathBuf, Watch>,
    descriptors: HashMap<i32, PathBuf>,
}

impl Watches {
    fn new() -> io::Result<Self> {
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            fd: unsafe { OwnedFd::from_raw_fd(fd) },
            paths: HashMap::new(),
            descriptors: HashMap::new(),
        })
    }

    fn add(&mut self, id: u32, path: &Path) -> io::Result<()> {
        #[cfg(test)]
        if let Some(errno) = WATCH_ERROR.with(|value| value.take()) {
            return Err(io::Error::from_raw_os_error(errno));
        }
        if let Some(watch) = self.paths.get_mut(path) {
            watch.owners.insert(id);
            return Ok(());
        }
        let name = CString::new(path.as_os_str().as_bytes())?;
        let mask = libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_MODIFY
            | libc::IN_ATTRIB
            | libc::IN_MOVED_FROM
            | libc::IN_MOVED_TO
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF
            | libc::IN_ONLYDIR
            | libc::IN_DONT_FOLLOW;
        let wd = unsafe { libc::inotify_add_watch(self.fd.as_raw_fd(), name.as_ptr(), mask) };
        if wd < 0 {
            return Err(io::Error::last_os_error());
        }
        if self.descriptors.get(&wd).is_some_and(|p| p != path) {
            return Err(io::Error::other(
                "directory alias changed during watch registration",
            ));
        }
        self.descriptors.insert(wd, path.to_path_buf());
        self.paths.insert(
            path.to_path_buf(),
            Watch {
                wd,
                owners: HashSet::from([id]),
            },
        );
        Ok(())
    }

    fn remove(&mut self, id: u32, path: &Path) {
        if let Some(w) = self.paths.get_mut(path) {
            w.owners.remove(&id);
            if w.owners.is_empty() {
                let wd = w.wd;
                self.paths.remove(path);
                self.descriptors.remove(&wd);
                unsafe {
                    libc::inotify_rm_watch(self.fd.as_raw_fd(), wd);
                }
            }
        }
    }

    fn clear(&mut self, id: u32, sub: &mut Subscription) {
        for path in sub.watched.drain() {
            self.remove(id, &path);
        }
    }

    fn add_for(&mut self, id: u32, sub: &mut Subscription, path: &Path) -> io::Result<()> {
        self.add(id, path)?;
        sub.watched.insert(path.to_path_buf());
        Ok(())
    }
}

#[cfg(test)]
thread_local! {
    static WATCH_ERROR: std::cell::Cell<Option<i32>> = const { std::cell::Cell::new(None) };
}

fn remove_tree(id: u32, sub: &mut Subscription, watches: &mut Watches, path: &Path, stats: &Stats) {
    if sub.pending.contains_key(path) && !sub.current.contains_key(path) {
        sub.record(path.to_path_buf(), "delete", stats);
    }
    let removed: Vec<_> = sub
        .current
        .range(path.to_path_buf()..)
        .take_while(|(p, _)| p.starts_with(path))
        .map(|(p, _)| p.clone())
        .collect();
    for p in removed {
        sub.current.remove(&p);
        sub.record(p, "delete", stats);
    }
    let removed: Vec<_> = sub
        .watched
        .iter()
        .filter(|p| p.starts_with(path))
        .cloned()
        .collect();
    for p in removed {
        sub.watched.remove(&p);
        watches.remove(id, &p);
    }
}

fn step(id: u32, sub: &mut Subscription, watches: &mut Watches, stats: &Stats) -> io::Result<()> {
    for _ in 0..128 {
        if sub.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        let Some(work) = sub.work.pop_front() else {
            break;
        };
        match work {
            Work::Visit(path) => {
                if !sub.filter.permitted(&path) {
                    stats.pruned.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                let metadata = match Entry::read(&path) {
                    Ok(m) => m,
                    Err(e) if transient(&e) => {
                        remove_tree(id, sub, watches, &path, stats);
                        continue;
                    }
                    Err(e) => {
                        return Err(io::Error::new(e.kind(), format!("{}: {e}", path.display())))
                    }
                };
                if metadata.dir {
                    match watches.add_for(id, sub, &path) {
                        Err(e) if transient(&e) => continue,
                        r => r?,
                    }
                    stats.visited.fetch_add(1, Ordering::Relaxed);
                    let children = match fs::read_dir(&path) {
                        Ok(r) => r,
                        Err(e) if transient(&e) => continue,
                        Err(e) => {
                            return Err(io::Error::new(
                                e.kind(),
                                format!("{}: {e}", path.display()),
                            ))
                        }
                    };
                    sub.work.push_front(Work::Children(children));
                }
                sub.current.insert(path.clone(), metadata);
                sub.dirty(path, stats);
            }
            Work::Children(mut children) => {
                if let Some(child) = children.next() {
                    let path = match child {
                        Ok(c) => checked_path(c.path())?,
                        Err(e) if transient(&e) => {
                            sub.work.push_back(Work::Children(children));
                            continue;
                        }
                        Err(e) => return Err(e),
                    };
                    sub.work.push_front(Work::Children(children));
                    if sub.filter.permitted(&path) {
                        sub.work.push_front(Work::Visit(path));
                    } else {
                        stats.pruned.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
        stats.peak_work.fetch_max(sub.work.len(), Ordering::Relaxed);
        sub.check_limits()?;
    }
    sub.check_limits()
}

fn initialize(id: u32, sub: &mut Subscription, watches: &mut Watches) -> io::Result<()> {
    for root in sub.filter.spec.roots.clone() {
        if sub.filter.ignored(&root) {
            continue;
        }
        let metadata = Entry::read(&root).map_err(|e| {
            io::Error::new(e.kind(), format!("requested root {}: {e}", root.display()))
        })?;
        if !metadata.dir {
            return Err(io::Error::other("requested root is not a directory"));
        }
        if let Some(parent) = root.parent() {
            watches.add_for(id, sub, parent)?;
        }
    }
    Ok(())
}

fn reconcile(
    id: u32,
    sub: &mut Subscription,
    watches: &mut Watches,
    stats: &Stats,
) -> io::Result<()> {
    watches.clear(id, sub);
    sub.work.clear();
    sub.current.clear();
    sub.dirty.clear();
    sub.pending.clear();
    sub.full_diff = true;
    sub.overflow_notice = true;
    stats.rescans.fetch_add(1, Ordering::Relaxed);
    for root in sub.filter.spec.roots.clone() {
        if sub.filter.ignored(&root) {
            continue;
        }
        if let Some(parent) = root.parent() {
            watches.add_for(id, sub, parent)?;
        }
        sub.work.push_back(Work::Visit(root));
    }
    Ok(())
}

fn changed(
    id: u32,
    sub: &mut Subscription,
    watches: &mut Watches,
    path: &Path,
    mask: u32,
    stats: &Stats,
) -> io::Result<()> {
    if !sub.filter.permitted(path) {
        return Ok(());
    }
    if mask & (libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_DELETE_SELF) != 0 {
        remove_tree(id, sub, watches, path, stats);
    } else {
        match Entry::read(path) {
            Ok(metadata) => {
                sub.record(
                    path.to_path_buf(),
                    if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                        "create"
                    } else {
                        "update"
                    },
                    stats,
                );
                if metadata.dir
                    && (!sub.current.contains_key(path) || mask & libc::IN_MOVED_TO != 0)
                {
                    sub.work.push_back(Work::Visit(path.to_path_buf()));
                } else {
                    sub.current.insert(path.to_path_buf(), metadata);
                    sub.dirty(path.to_path_buf(), stats);
                }
            }
            Err(e) if transient(&e) => remove_tree(id, sub, watches, path, stats),
            Err(e) => return Err(io::Error::new(e.kind(), format!("{}: {e}", path.display()))),
        }
    }
    sub.check_limits()
}

fn drain_events(
    watches: &mut Watches,
    subscriptions: &mut BTreeMap<u32, Subscription>,
    stats: &Stats,
) -> io::Result<bool> {
    let mut bytes = [0u8; 65536];
    for _ in 0..8 {
        let n = unsafe {
            libc::read(
                watches.fd.as_raw_fd(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::WouldBlock {
                return Ok(true);
            }
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        if n == 0 {
            return Ok(true);
        }
        let mut offset = 0;
        while offset + std::mem::size_of::<libc::inotify_event>() <= n as usize {
            let raw = unsafe {
                std::ptr::read_unaligned(bytes.as_ptr().add(offset).cast::<libc::inotify_event>())
            };
            let start = offset + std::mem::size_of::<libc::inotify_event>();
            offset = start + raw.len as usize;
            if offset > n as usize {
                return Err(io::Error::other("invalid inotify record"));
            }
            if raw.mask & libc::IN_Q_OVERFLOW != 0 {
                stats.overflows.fetch_add(1, Ordering::Relaxed);
                for (id, sub) in subscriptions.iter_mut() {
                    if let Err(e) = reconcile(*id, sub, watches, stats) {
                        sub.error = Some(e.to_string());
                    }
                }
                continue;
            }
            let Some(parent) = watches.descriptors.get(&raw.wd).cloned() else {
                continue;
            };
            if raw.mask & libc::IN_IGNORED != 0 {
                watches.descriptors.remove(&raw.wd);
                if let Some(watch) = watches.paths.remove(&parent) {
                    for id in watch.owners {
                        if let Some(sub) = subscriptions.get_mut(&id) {
                            sub.watched.remove(&parent);
                        }
                    }
                }
                continue;
            }
            let name = &bytes[start..offset];
            let name = &name[..name.iter().position(|b| *b == 0).unwrap_or(name.len())];
            let path = if name.is_empty() {
                parent.clone()
            } else {
                parent.join(std::ffi::OsStr::from_bytes(name))
            };
            let owners: Vec<_> = watches
                .paths
                .get(&parent)
                .map(|w| w.owners.iter().copied().collect())
                .unwrap_or_default();
            for id in owners {
                if let Some(sub) = subscriptions.get_mut(&id) {
                    if sub.cancelled.load(Ordering::Acquire) || sub.error.is_some() {
                        continue;
                    }
                    if path.to_str().is_none() {
                        sub.error =
                            Some("non-UTF-8 filename unsupported; subscription stopped".into());
                        continue;
                    }
                    if let Err(e) = changed(id, sub, watches, &path, raw.mask, stats) {
                        sub.error = Some(e.to_string());
                    }
                }
            }
        }
    }
    Ok(false)
}

fn batch(id: u32, sub: &mut Subscription) -> Option<String> {
    if !sub.ready_sent {
        sub.ready_sent = true;
        return Some(
            json!({"id": id, "kind": "ready", "initializationMs": sub.since.elapsed().as_millis()})
                .to_string(),
        );
    }
    if sub.overflow_notice {
        sub.overflow_notice = false;
        return Some(json!({"id": id, "kind": "overflow", "message": "event history lost; reconciling final state"}).to_string());
    }
    if Instant::now() < sub.due {
        return None;
    }
    let limit = sub.filter.spec.max_batch_size;
    let paths: Vec<_> = if sub.full_diff {
        sub.current
            .keys()
            .chain(sub.delivered.keys())
            .filter(|p| event(p, sub.delivered.get(*p), sub.current.get(*p)).is_some())
            .take(limit)
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    } else {
        sub.dirty.iter().take(limit).cloned().collect()
    };
    let mut events = Vec::new();
    for path in &paths {
        let change = match sub.pending.remove(path) {
            Some((true, true)) => None,
            Some((created, deleted)) => Some(crate::model::Event {
                path: path.to_string_lossy().into_owned(),
                r#type: if created {
                    "create"
                } else if deleted {
                    "delete"
                } else {
                    "update"
                },
            }),
            None => event(path, sub.delivered.get(path), sub.current.get(path)),
        };
        if let Some(e) = change {
            events.push(e);
        }
        match sub.current.get(path) {
            Some(entry) => {
                sub.delivered.insert(path.clone(), entry.clone());
            }
            None => {
                sub.delivered.remove(path);
            }
        }
        sub.dirty.remove(path);
    }
    if paths.is_empty() {
        sub.full_diff = false;
    }
    if events.is_empty() {
        None
    } else {
        Some(json!({"id": id, "kind": "events", "events": events}).to_string())
    }
}

pub fn run(
    rx: mpsc::Receiver<Command>,
    mut wake: UnixStream,
    stopped: Arc<AtomicBool>,
    acknowledged: Arc<AtomicBool>,
    stats: Arc<Stats>,
    callback: Callback,
) {
    let mut watches = match Watches::new() {
        Ok(w) => w,
        Err(e) => {
            callback.call(
                Ok(json!({"kind": "fatal", "message": e.to_string()}).to_string()),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
            return;
        }
    };
    let mut subscriptions = BTreeMap::<u32, Subscription>::new();
    let mut outstanding = false;
    let mut last_id = 0;
    while !stopped.load(Ordering::Acquire) {
        let mut wake_bytes = [0; 1024];
        while wake.read(&mut wake_bytes).is_ok_and(|n| n > 0) {}
        if acknowledged.swap(false, Ordering::AcqRel) {
            outstanding = false;
        }
        for _ in 0..1024 {
            let Ok(command) = rx.try_recv() else {
                break;
            };
            match command {
                Command::Add(id, spec, cancelled) => match Subscription::new(spec, cancelled) {
                    Ok(mut sub) => {
                        if let Err(e) = initialize(id, &mut sub, &mut watches) {
                            sub.error = Some(e.to_string());
                        }
                        subscriptions.insert(id, sub);
                    }
                    Err(e) => {
                        callback.call(
                            Ok(json!({"id": id, "kind": "error", "message": e.to_string()})
                                .to_string()),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                },
                Command::Overflow => {
                    stats.overflows.fetch_add(1, Ordering::Relaxed);
                    for (id, sub) in &mut subscriptions {
                        if let Err(e) = reconcile(*id, sub, &mut watches, &stats) {
                            sub.error = Some(e.to_string());
                        }
                    }
                }
            }
        }
        subscriptions.retain(|id, sub| {
            if sub.cancelled.load(Ordering::Acquire) {
                watches.clear(*id, sub);
                false
            } else {
                true
            }
        });
        let drained = match drain_events(&mut watches, &mut subscriptions, &stats) {
            Ok(v) => v,
            Err(e) => {
                for sub in subscriptions.values_mut() {
                    sub.error = Some(e.to_string());
                }
                true
            }
        };
        for (id, sub) in &mut subscriptions {
            if sub.error.is_none() {
                if let Err(e) = step(*id, sub, &mut watches, &stats) {
                    sub.error = Some(e.to_string());
                }
                if sub.work.is_empty() && drained && !sub.ready {
                    sub.ready = true;
                    sub.delivered = sub.current.clone();
                }
            }
        }
        if !outstanding {
            let ids: Vec<_> = subscriptions
                .range((
                    std::ops::Bound::Excluded(last_id),
                    std::ops::Bound::Unbounded,
                ))
                .map(|(id, _)| *id)
                .chain(subscriptions.range(..=last_id).map(|(id, _)| *id))
                .collect();
            for id in ids {
                let sub = subscriptions.get_mut(&id).expect("subscription exists");
                let message = if let Some(error) = sub.error.take() {
                    watches.clear(id, sub);
                    sub.cancelled.store(true, Ordering::Release);
                    Some(json!({"id": id, "kind": "error", "message": error}).to_string())
                } else if sub.ready && sub.work.is_empty() {
                    batch(id, sub)
                } else {
                    None
                };
                if let Some(message) = message {
                    let status =
                        callback.call(Ok(message), ThreadsafeFunctionCallMode::NonBlocking);
                    if status != Status::Ok {
                        return;
                    }
                    outstanding = true;
                    last_id = id;
                    break;
                }
            }
        }
        stats.watches.store(watches.paths.len(), Ordering::Relaxed);
        stats
            .subscriptions
            .store(subscriptions.len(), Ordering::Relaxed);
        stats.queued.store(
            subscriptions.values().map(|s| s.dirty.len()).sum(),
            Ordering::Relaxed,
        );
        stats.tracked.store(
            subscriptions.values().map(|s| s.current.len()).sum(),
            Ordering::Relaxed,
        );
        stats.work.store(
            subscriptions.values().map(|s| s.work.len()).sum(),
            Ordering::Relaxed,
        );
        let busy = !drained || subscriptions.values().any(|s| !s.work.is_empty());
        let timed = !outstanding
            && subscriptions
                .values()
                .any(|s| !s.dirty.is_empty() || s.full_diff || !s.ready_sent || s.error.is_some());
        let timeout = if busy {
            0
        } else if timed {
            10
        } else {
            -1
        };
        if stopped.load(Ordering::Acquire) {
            break;
        }
        let mut fds = [
            libc::pollfd {
                fd: watches.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: wake.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let rc = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if rc < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_limits_are_terminal_without_retry() {
        let root =
            std::env::temp_dir().join(format!("rust-watcher-watch-limit-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let spec = Spec {
            root: root.clone(),
            roots: vec![root.clone()],
            literals: vec![],
            patterns: vec![],
            global_patterns: vec![],
            identity: "test".into(),
            debounce_ms: 0,
            max_batch_size: 4,
            max_queued_events: 8,
            max_tracked_entries: crate::model::MAX_ENTRIES,
        };
        for errno in [libc::ENOSPC, libc::EMFILE, libc::EACCES] {
            let mut watches = Watches::new().unwrap();
            let mut sub =
                Subscription::new(spec.clone(), Arc::new(AtomicBool::new(false))).unwrap();
            WATCH_ERROR.with(|value| value.set(Some(errno)));
            let error = initialize(1, &mut sub, &mut watches).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(errno));
            assert!(!transient(&error));
            assert!(watches.paths.is_empty());
            assert!(WATCH_ERROR.with(|value| value.get()).is_none());
        }
        fs::remove_dir(root).unwrap();
    }
}
