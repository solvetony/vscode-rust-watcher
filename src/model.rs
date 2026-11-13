use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_ENTRIES: usize = 1_000_000;

fn default_max_tracked_entries() -> usize {
    MAX_ENTRIES
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub root: PathBuf,
    pub roots: Vec<PathBuf>,
    pub literals: Vec<PathBuf>,
    pub patterns: Vec<String>,
    pub global_patterns: Vec<String>,
    pub identity: String,
    pub debounce_ms: u64,
    pub max_batch_size: usize,
    pub max_queued_events: usize,
    #[serde(default = "default_max_tracked_entries")]
    pub max_tracked_entries: usize,
}

pub struct Filter {
    pub spec: Spec,
    patterns: Vec<Regex>,
    global_patterns: Vec<Regex>,
}

impl Filter {
    pub fn new(spec: Spec) -> io::Result<Self> {
        if !spec.root.is_absolute()
            || spec
                .roots
                .iter()
                .any(|p| !p.is_absolute() || !p.starts_with(&spec.root))
            || spec.max_batch_size == 0
            || spec.max_batch_size > 65536
            || spec.max_queued_events < spec.max_batch_size
            || spec.max_queued_events > MAX_ENTRIES
            || spec.max_tracked_entries == 0
            || spec.max_tracked_entries > 10_000_000
            || spec.debounce_ms > 60000
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid native specification",
            ));
        }
        let patterns = spec
            .patterns
            .iter()
            .map(|s| {
                regex::bytes::RegexBuilder::new(s)
                    .unicode(false)
                    .size_limit(2 * 1024 * 1024)
                    .build()
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
            })
            .collect::<io::Result<_>>()?;
        let global_patterns = spec
            .global_patterns
            .iter()
            .map(|s| {
                regex::bytes::RegexBuilder::new(s)
                    .unicode(false)
                    .size_limit(2 * 1024 * 1024)
                    .build()
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
            })
            .collect::<io::Result<_>>()?;
        Ok(Self {
            spec,
            patterns,
            global_patterns,
        })
    }

    pub fn ignored(&self, path: &Path) -> bool {
        if self.spec.literals.iter().any(|p| path.starts_with(p)) {
            return true;
        }
        let relative = path
            .strip_prefix(&self.spec.root)
            .unwrap_or(path)
            .to_string_lossy();
        self.patterns
            .iter()
            .any(|p| p.is_match(relative.as_bytes()))
            || self
                .global_patterns
                .iter()
                .any(|p| p.is_match(path.as_os_str().as_encoded_bytes()))
    }

    pub fn permitted(&self, path: &Path) -> bool {
        self.spec.roots.iter().any(|r| path.starts_with(r)) && !self.ignored(path)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub dir: bool,
    pub ino: u64,
    pub dev: u64,
    pub size: u64,
    pub mtime: i64,
    pub mtime_ns: i64,
    pub ctime: i64,
    pub ctime_ns: i64,
    pub mode: u32,
}

impl Entry {
    pub fn read(path: &Path) -> io::Result<Self> {
        let m = fs::symlink_metadata(path)?;
        Ok(Self {
            dir: m.is_dir(),
            ino: m.ino(),
            dev: m.dev(),
            size: m.size(),
            mtime: m.mtime(),
            mtime_ns: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_ns: m.ctime_nsec(),
            mode: m.mode(),
        })
    }

    pub fn changed(&self, other: &Self) -> bool {
        if self.dir && other.dir {
            self.ino != other.ino || self.dev != other.dev || self.mode != other.mode
        } else {
            self != other
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Event {
    pub path: String,
    pub r#type: &'static str,
}

pub fn event(path: &Path, old: Option<&Entry>, new: Option<&Entry>) -> Option<Event> {
    let kind = match (old, new) {
        (None, Some(_)) => "create",
        (Some(_), None) => "delete",
        (Some(a), Some(b)) if a.changed(b) => "update",
        _ => return None,
    };
    Some(Event {
        path: path.to_string_lossy().into_owned(),
        r#type: kind,
    })
}

pub fn transient(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR))
}

pub fn checked_path(path: PathBuf) -> io::Result<PathBuf> {
    if path.to_str().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "non-UTF-8 filename unsupported; subscription stopped",
        ));
    }
    Ok(path)
}

pub fn scan(
    filter: &Filter,
    cancelled: &AtomicBool,
    skip: Option<&Path>,
) -> io::Result<BTreeMap<PathBuf, Entry>> {
    let mut result = BTreeMap::new();
    let mut pending = filter.spec.roots.clone();
    while let Some(path) = pending.pop() {
        if cancelled.load(Ordering::Acquire) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "scan cancelled"));
        }
        if Some(path.as_path()) == skip || !filter.permitted(&path) {
            continue;
        }
        let metadata = match Entry::read(&path) {
            Ok(m) => m,
            Err(e) if transient(&e) && !filter.spec.roots.contains(&path) => continue,
            Err(e) => return Err(io::Error::new(e.kind(), format!("{}: {e}", path.display()))),
        };
        if metadata.dir {
            let children = match fs::read_dir(&path) {
                Ok(children) => children,
                Err(e) if transient(&e) && !filter.spec.roots.contains(&path) => continue,
                Err(e) => return Err(e),
            };
            for child in children {
                if cancelled.load(Ordering::Acquire) {
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "scan cancelled"));
                }
                let child = match child {
                    Ok(child) => checked_path(child.path())?,
                    Err(e) if transient(&e) => continue,
                    Err(e) => return Err(e),
                };
                if Some(child.as_path()) == skip || !filter.permitted(&child) {
                    continue;
                }
                if pending.len() >= filter.spec.max_tracked_entries {
                    return Err(io::Error::other(format!("snapshot pending work limit exceeded: maxTrackedEntries={}, trackedEntries={}, pendingWork={}", filter.spec.max_tracked_entries, result.len(), pending.len())));
                }
                pending.push(child);
            }
        }
        result.insert(path, metadata);
        if result.len() > filter.spec.max_tracked_entries {
            return Err(io::Error::other(format!(
                "snapshot tracked entry limit exceeded: maxTrackedEntries={}, trackedEntries={}",
                filter.spec.max_tracked_entries,
                result.len()
            )));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment_is_component_aware() {
        let spec = Spec {
            root: "/tmp".into(),
            roots: vec!["/tmp/project".into()],
            literals: vec!["/tmp/project/node_modules".into()],
            patterns: vec![],
            global_patterns: vec![],
            identity: "test".into(),
            debounce_ms: 40,
            max_batch_size: 4,
            max_queued_events: 8,
            max_tracked_entries: MAX_ENTRIES,
        };
        let filter = Filter::new(spec).unwrap();
        assert!(filter.permitted(Path::new("/tmp/project/src/a")));
        assert!(!filter.permitted(Path::new("/tmp/project-two/a")));
        assert!(!filter.permitted(Path::new("/tmp/project/node_modules/a")));
    }
}
