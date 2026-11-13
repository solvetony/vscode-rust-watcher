mod model;
mod reactor;
mod snapshot;

use napi::bindgen_prelude::*;
use napi::{CleanupEnvHook, JsFunction};
use napi_derive::napi;
use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::thread::JoinHandle;

struct Control {
    stopped: Arc<AtomicBool>,
    acknowledged: Arc<AtomicBool>,
    wake: Mutex<Option<UnixStream>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Control {
    fn wake(&self) {
        if let Ok(mut wake) = self.wake.lock() {
            if let Some(wake) = wake.as_mut() {
                let _ = wake.write(&[1]);
            }
        }
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.wake();
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
        if let Ok(mut wake) = self.wake.lock() {
            wake.take();
        }
    }
}

#[napi]
pub struct Engine {
    control: Arc<Control>,
    tx: Option<mpsc::SyncSender<reactor::Command>>,
    subscriptions: HashMap<u32, Arc<AtomicBool>>,
    stats: Arc<reactor::Stats>,
    cleanup: Option<CleanupEnvHook<Weak<Control>>>,
}

#[napi]
impl Engine {
    #[napi(constructor)]
    pub fn new(mut env: Env, callback: JsFunction) -> Result<Self> {
        let callback: reactor::Callback = callback.create_threadsafe_function(
            1,
            |ctx: napi::threadsafe_function::ThreadSafeCallContext<String>| {
                Ok(vec![ctx.env.create_string(&ctx.value)?])
            },
        )?;
        let (read, write) = UnixStream::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        let (tx, rx) = mpsc::sync_channel(1024);
        let stopped = Arc::new(AtomicBool::new(false));
        let acknowledged = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(reactor::Stats::default());
        let control = Arc::new(Control {
            stopped: stopped.clone(),
            acknowledged: acknowledged.clone(),
            wake: Mutex::new(Some(write)),
            thread: Mutex::new(None),
        });
        let thread_stats = stats.clone();
        let thread = std::thread::Builder::new()
            .name("rust-file-watcher".into())
            .spawn(move || reactor::run(rx, read, stopped, acknowledged, thread_stats, callback))?;
        *control
            .thread
            .lock()
            .map_err(|_| Error::from_reason("thread mutex poisoned"))? = Some(thread);
        let cleanup = env.add_env_cleanup_hook(Arc::downgrade(&control), |weak| {
            if let Some(control) = weak.upgrade() {
                control.stop();
            }
        })?;
        Ok(Self {
            control,
            tx: Some(tx),
            subscriptions: HashMap::new(),
            stats,
            cleanup: Some(cleanup),
        })
    }

    #[napi]
    pub fn start(&mut self, id: u32, spec: String) -> Result<()> {
        if self.control.stopped.load(Ordering::Acquire) {
            return Err(Error::from_reason("engine closed"));
        }
        if self.subscriptions.contains_key(&id) || self.subscriptions.len() >= 1024 {
            return Err(Error::from_reason("subscription id/limit"));
        }
        let spec: model::Spec =
            serde_json::from_str(&spec).map_err(|e| Error::from_reason(e.to_string()))?;
        model::Filter::new(spec.clone())?;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.tx
            .as_ref()
            .ok_or_else(|| Error::from_reason("engine closed"))?
            .try_send(reactor::Command::Add(id, spec, cancelled.clone()))
            .map_err(|e| Error::from_reason(e.to_string()))?;
        self.subscriptions.insert(id, cancelled);
        self.control.wake();
        Ok(())
    }

    #[napi]
    pub fn cancel(&mut self, id: u32) {
        if let Some(cancelled) = self.subscriptions.remove(&id) {
            cancelled.store(true, Ordering::Release);
        }
        self.control.wake();
    }

    #[napi]
    pub fn ack(&self) {
        self.control.acknowledged.store(true, Ordering::Release);
        self.control.wake();
    }

    #[napi]
    pub fn reconcile(&self) -> Result<()> {
        self.tx
            .as_ref()
            .ok_or_else(|| Error::from_reason("engine closed"))?
            .try_send(reactor::Command::Overflow)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        self.control.wake();
        Ok(())
    }

    #[napi]
    pub fn stats(&self) -> String {
        self.stats.json()
    }

    #[napi]
    pub fn snapshot(
        &self,
        spec: String,
        path: String,
        write: bool,
    ) -> Result<AsyncTask<snapshot::SnapshotTask>> {
        let spec = serde_json::from_str(&spec).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(AsyncTask::new(snapshot::SnapshotTask {
            spec,
            path: PathBuf::from(path),
            write,
            cancel: self.control.stopped.clone(),
        }))
    }

    #[napi]
    pub fn close(&mut self, mut env: Env) -> Result<()> {
        self.control.stop();
        self.tx.take();
        if let Some(cleanup) = self.cleanup.take() {
            env.remove_env_cleanup_hook(cleanup)?;
        }
        Ok(())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.control.stop();
    }
}
