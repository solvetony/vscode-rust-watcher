use crate::model::{event, scan, Entry, Filter, Spec};
use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc};

const MAX_SNAPSHOT: u64 = 512 * 1024 * 1024;
const TRAILER: &[u8] = b"\nRUST_FILE_WATCHER_V1\n";

fn parcel_prefix(entries: &BTreeMap<PathBuf, Entry>) -> Vec<u8> {
    let mut bytes = format!("{}\n", entries.len()).into_bytes();
    for (path, entry) in entries {
        let path = path.to_string_lossy();
        let time = (entry.mtime as u64)
            .wrapping_mul(1_000_000_000)
            .wrapping_add(entry.mtime_ns as u64);
        bytes.extend_from_slice(
            format!("{}{path}{time} {}\n", path.len(), u8::from(entry.dir)).as_bytes(),
        );
    }
    bytes
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    identity: String,
    entries: BTreeMap<PathBuf, Entry>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    sha256: String,
    payload: String,
}

pub struct SnapshotTask {
    pub spec: Spec,
    pub path: PathBuf,
    pub write: bool,
    pub cancel: Arc<AtomicBool>,
}

impl Task for SnapshotTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        self.run()
            .map_err(|e| Error::from_reason(format!("snapshot: {e}")))
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

impl SnapshotTask {
    fn run(&self) -> std::io::Result<String> {
        let filter = Filter::new(self.spec.clone())?;
        let entries = scan(&filter, &self.cancel, Some(&self.path))?;
        if self.write {
            let mut bytes = parcel_prefix(&entries);
            let payload = serde_json::to_string(&Snapshot {
                version: 1,
                identity: self.spec.identity.clone(),
                entries,
            })?;
            let sha256 = format!("{:x}", Sha256::digest(payload.as_bytes()));
            bytes.extend_from_slice(TRAILER);
            bytes.extend_from_slice(&serde_json::to_vec(&Envelope { sha256, payload })?);
            if bytes.len() as u64 > MAX_SNAPSHOT {
                return Err(std::io::Error::other("snapshot exceeds size limit"));
            }
            let tmp = self.path.with_extension(format!(
                "rust-watcher-{}-{}.tmp",
                std::process::id(),
                unique()
            ));
            let result = (|| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&tmp)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                if self.cancel.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "snapshot cancelled",
                    ));
                }
                fs::rename(&tmp, &self.path)?;
                if let Some(parent) = self.path.parent() {
                    fs::File::open(parent)?.sync_all()?;
                }
                Ok("null".into())
            })();
            if result.is_err() {
                let _ = fs::remove_file(tmp);
            }
            result
        } else {
            let file = fs::File::open(&self.path)?;
            if file.metadata()?.len() > MAX_SNAPSHOT {
                return Err(std::io::Error::other("snapshot exceeds size limit"));
            }
            let mut bytes = Vec::new();
            file.take(MAX_SNAPSHOT + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_SNAPSHOT {
                return Err(std::io::Error::other("snapshot exceeds size limit"));
            }
            let boundary = bytes
                .windows(TRAILER.len())
                .rposition(|w| w == TRAILER)
                .ok_or_else(|| {
                    std::io::Error::other(
                        "incompatible snapshot; rewrite with Rust before querying",
                    )
                })?;
            let env: Envelope = serde_json::from_slice(&bytes[boundary + TRAILER.len()..])
                .map_err(|_| {
                    std::io::Error::other(
                        "incompatible or corrupt snapshot; rewrite snapshot before querying",
                    )
                })?;
            if env.sha256 != format!("{:x}", Sha256::digest(env.payload.as_bytes())) {
                return Err(std::io::Error::other("snapshot checksum mismatch"));
            }
            let old: Snapshot = serde_json::from_str(&env.payload)?;
            if bytes[..boundary] != parcel_prefix(&old.entries) {
                return Err(std::io::Error::other("snapshot prefix checksum mismatch"));
            }
            if old.version != 1
                || old.identity != self.spec.identity
                || old.entries.len() > self.spec.max_tracked_entries
                || old.entries.keys().any(|p| {
                    !p.is_absolute()
                        || !filter.permitted(p)
                        || p.components()
                            .any(|c| matches!(c, std::path::Component::ParentDir))
                })
            {
                return Err(std::io::Error::other(
                    "snapshot version, root or policy mismatch",
                ));
            }
            let paths: BTreeSet<_> = old.entries.keys().chain(entries.keys()).collect();
            let events: Vec<_> = paths
                .into_iter()
                .filter_map(|p| event(p, old.entries.get(p), entries.get(p)))
                .collect();
            Ok(serde_json::to_string(&events)?)
        }
    }
}

fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}
