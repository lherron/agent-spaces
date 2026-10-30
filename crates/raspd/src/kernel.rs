//! raspd's embedded cardo kernel (cardo embedding guide §3), composed like
//! hrc-kernel: one rebuildable, ingest-only `aspd` document fed by the
//! in-process `aspd.observe` provider, served as cardo wire on its own socket.
//!
//! It runs on its own threads and never on the aspc request path: the request
//! path only records into [`Observations`]; a wake thread here notices the
//! change and wakes the binding.
use aspd_domain::{BINDING, DOCUMENT, OPERATION, Observations, PROVIDER, observations::Observer};
use cardo_core::{Format, document::CoreDomain};
use cardo_host::{HostDefault, Idle, NoWork, Shutdown, SingleInstance};
use cardo_runtime::{core_adapter::CoreAdapter, service::*, wire};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// How often the wake thread checks for new observations.
const WAKE_POLL: Duration = Duration::from_millis(250);

/// `cardo_host::send` with the failure as text: raspd logs a kernel that
/// fails to set up and keeps serving aspc, so no `expect_ok` here.
fn call(client: &KernelClient, operation: &str, arguments: Value) -> Result<Value, String> {
    cardo_host::send(client, operation, arguments)
        .map_err(|failed| format!("{operation}: {failed:?}"))
}

/// A running kernel. It stops on SIGTERM or SIGINT, alongside aspc's retire;
/// [`Kernel::join`] waits for that teardown.
pub struct Kernel {
    served: JoinHandle<Result<(), String>>,
    _lock: SingleInstance,
}

impl Kernel {
    /// Waits for the ordered teardown (wire, then owner) to finish.
    pub fn join(self) -> Result<(), String> {
        self.served
            .join()
            .map_err(|_| "the kernel thread panicked".to_string())?
    }
}

/// Compose the kernel and serve its wire on `socket`. Returns once the wire
/// is bound (the kernel is accepting); the document fills in on its own.
///
/// Call it before tokio registers its own SIGTERM/SIGINT handlers: tokio's
/// handler chains to the one `Shutdown::on_signal` installs here, so one
/// signal reaches both the kernel and aspc's retire. `watchdog` bounds the
/// kernel's teardown.
pub fn start(
    observations: Arc<Observations>,
    socket: &Path,
    watchdog: Duration,
) -> Result<Kernel, String> {
    let lock = SingleInstance::acquire(socket).map_err(|e| e.to_string())?;
    let triggers = vec![Shutdown::on_signal()];
    let mut adapter = CoreAdapter::<CoreDomain>::new(
        || CoreDomain,
        aspd_domain::decode_edits,
        Duration::from_secs(10),
    )
    .with_format(Format::new("aspd", 1));
    let provider = observations.clone();
    adapter.in_process_worker(PROVIDER, move || Box::new(Observer(provider.clone())));
    let waker = adapter.ingest_waker();
    let owner = RuntimeOwner::start(
        adapter,
        Arc::new(NoWork),
        Box::new(Idle),
        RuntimeConfig {
            control_poll_millis: 10,
            ..RuntimeConfig::host_default()
        },
    );
    let client = owner.client(ClientRole::Tui);
    call(
        &client,
        "registry.enable",
        aspd_domain::declarations::declarations(),
    )?;
    call(
        &client,
        "document.open",
        json!({"document_id": DOCUMENT, "rebuildable": true, "ingest_only": true, "durability": {"mode": "none"}}),
    )?;
    call(
        &client,
        "ingest.attach",
        json!({"document_id": DOCUMENT, "binding": BINDING, "operation": OPERATION, "config": {}, "interval_ms": 60000}),
    )?;
    let server = wire::bind(client, socket).map_err(|e| format!("{e:?}"))?;
    let served = std::thread::Builder::new()
        .name("raspd-kernel".into())
        .spawn(move || cardo_host::run(server, owner, triggers, watchdog))
        .map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("raspd-kernel-wake".into())
        .spawn(move || {
            loop {
                std::thread::sleep(WAKE_POLL);
                if observations.take_dirty() && !waker.wake(DOCUMENT, BINDING) {
                    return;
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Kernel {
        served,
        _lock: lock,
    })
}
