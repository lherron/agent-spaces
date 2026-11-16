//! aspd's observation-only cardo surface, composed from the lattice parts.
//! The aspc path only records observations; all kernel work runs on its own
//! threads. raspd owns signals and may keep serving after this surface stops.
use aspd_domain::{BINDING, DOCUMENT, OPERATION, Observations, PROVIDER, observations::Observer};
use cardo_app::parts::{
    self, Args, Durability, Failure, GraphSpec, Health, Limits, Lock, Logger, Openings, Paths,
    Record, Setup, Start,
};
use cardo_core::{CoreRules, Format};
use crossbeam_channel::{Sender, bounded};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

const WAKE_POLL: Duration = Duration::from_millis(250);

pub struct Kernel {
    stop: Sender<()>,
    served: JoinHandle<Result<(), String>>,
}

impl Kernel {
    /// Called on tokio's blocking pool during aspd's signal-driven retire.
    pub fn stop_and_join(self) -> Result<(), String> {
        let _ = self.stop.try_send(());
        self.served
            .join()
            .map_err(|_| "the kernel thread panicked".to_string())?
    }
}

pub fn start(
    observations: Arc<Observations>,
    args: Args,
    watchdog: Duration,
) -> Result<Kernel, String> {
    let runtime = tokio::runtime::Handle::try_current().map_err(|e| e.to_string())?;
    let paths = Paths::new("aspd", &args);
    let mount = parts::mount("aspd", args.instance.as_deref());
    let lock = Lock::acquire(&paths.socket).map_err(|e| e.to_string())?;
    let log = Logger::open(&paths.log, &mount).map_err(|e| e.to_string())?;
    let logger = log.clone();
    cardo_runtime::perf::configure_slow_runs(
        Duration::from_millis(250),
        Duration::from_millis(100),
        Some(Arc::new(move |line| logger.raw(line))),
    );
    let mut record = Record::new(
        "aspd",
        args.instance.clone(),
        paths.socket.clone(),
        vec![],
        vec![],
        Start {
            by: args.started_by,
            argv: std::env::args().collect(),
            cwd: std::env::current_dir().map_err(|e| e.to_string())?,
        },
    );
    record.write(&paths.record).map_err(|e| e.to_string())?;
    let fail = |record: &mut Record, error: String| {
        *record = record.clone().failed(
            &Failure::new(
                "kernel_start_failed",
                error.clone(),
                "read the kernel log and repair the named start failure",
            ),
            paths.log.clone(),
        );
        let _ = record.write(&paths.record);
        log.error("kernel.start_failed", json!({"error": error}));
        error
    };
    let mut openings = Openings::with_rules(|| CoreRules, aspd_domain::decode_edits);
    openings.stop_unsupported(
        "aspd is a launchd service; stop it with `just aspd-stop <namespace>` on its node",
    );
    openings.provider_json(aspd_domain::declarations::declarations());
    openings.graph(
        GraphSpec::new(DOCUMENT, Format::new("aspd", 1))
            .durability(Durability::None)
            .rebuildable(true),
    );
    openings.limits(Limits {
        poll_millis: 10,
        worker_call: Duration::from_secs(10),
        ..Default::default()
    });
    let provider = observations.clone();
    let (wake_tx, wake_rx) = bounded(1);
    openings.compose(move |adapter| {
        adapter.in_process_worker(PROVIDER, move || Box::new(Observer(provider.clone())));
        let _ = wake_tx.send(adapter.ingest_waker());
    });
    let kernel = parts::Kernel::start(
        openings,
        Setup {
            mount,
            owner: "aspd".into(),
            graphs: paths.graphs.clone(),
            socket: Some(paths.socket.clone()),
        },
        Health::default(),
    )
    .map_err(|e| fail(&mut record, e.to_string()))?;
    kernel.log_dirs(log.clone());
    let client = match kernel.client() {
        Some(client) => client,
        None => {
            let _ = kernel.shutdown();
            return Err(fail(
                &mut record,
                "kernel has no single-owner client".into(),
            ));
        }
    };
    if let Err(error) = parts::send(
        &client,
        "ingest.attach",
        json!({"document_id": DOCUMENT,
        "binding": BINDING, "operation": OPERATION, "config": {}, "interval_ms": 60000}),
    ) {
        let _ = kernel.shutdown();
        return Err(fail(&mut record, format!("ingest.attach: {error:?}")));
    }
    let wire = match kernel.bind(&paths.socket) {
        Ok(wire) => wire,
        Err(error) => {
            let _ = kernel.shutdown();
            return Err(fail(&mut record, error.to_string()));
        }
    };
    {
        record = record.serving(client.host_incarnation());
        record.graphs = kernel.graphs();
        record.graph_locations = kernel.graph_locations();
        if let Err(error) = record.write(&paths.record) {
            wire.stop();
            let _ = wire.join();
            let _ = kernel.shutdown();
            return Err(fail(&mut record, error.to_string()));
        }
        kernel.set_status(json!({"record": record.to_json()}));
    }
    let waker = wake_rx
        .recv()
        .map_err(|e| fail(&mut record, e.to_string()))?;
    let record = Arc::new(Mutex::new(record));
    let held = record.clone();
    let dirs_log = log.clone();
    let record_path = paths.record.clone();
    kernel.on_dirs(move |dirs| {
        let mut record = match held.lock() {
            Ok(record) => record,
            Err(error) => {
                dirs_log.error("kernel.record_failed", json!({"error": error.to_string()}));
                return false;
            }
        };
        record.dirs = dirs;
        record.write(&record_path).is_ok()
    });
    let ended = wire.ended();
    let (stop, stopping) = bounded(1);
    // This is the wake thread as well as the lifecycle supervisor. It
    // never shares execution with aspc and wakes the same ingest binding.
    let served = std::thread::Builder::new()
        .name("raspd-kernel-wake".into())
        .spawn(move || {
            loop {
                crossbeam_channel::select! {
                    recv(stopping) -> _ => break,
                    recv(ended) -> _ => break,
                    default(WAKE_POLL) => {
                        if observations.take_dirty() && !waker.wake(DOCUMENT, BINDING) { break; }
                    }
                }
            }
            let (done, finished) = bounded(1);
            // Keep the lock and record until teardown actually ends, including
            // after a watchdog timeout. Never terminate the aspd process here.
            runtime.spawn_blocking(move || {
                let _lock = lock;
                wire.stop();
                let wire_result = wire.join().map_err(|e| e.to_string());
                let owner_result = kernel.shutdown().map_err(|e| e.to_string());
                let mut result = wire_result.and(owner_result).and_then(|()| {
                    std::fs::remove_file(&paths.record)
                        .map_err(|e| format!("remove registry record: {e}"))
                });
                if let Err(error) = &result {
                    match record.lock() {
                        Ok(mut record) => {
                            *record = record.clone().failed(
                                &Failure::new(
                                    "kernel_teardown_failed",
                                    error.clone(),
                                    "read the kernel log before starting aspd again",
                                ),
                                paths.log.clone(),
                            );
                            let _ = record.write(&paths.record);
                        }
                        Err(poison) => {
                            result = Err(format!(
                                "{error}; kernel registry record poisoned: {poison}"
                            ));
                        }
                    }
                    log.error(
                        "kernel.teardown_failed",
                        json!({"error": result.as_ref().err()}),
                    );
                } else {
                    log.info("kernel.stopped", json!({}));
                }
                let _ = done.send(result);
            });
            finished
                .recv_timeout(watchdog)
                .map_err(|e| format!("kernel teardown watchdog: {e}"))?
        })
        .map_err(|e| e.to_string())?;
    Ok(Kernel { stop, served })
}
