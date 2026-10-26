//! raspd's embedded cardo kernel (cardo embedding guide §3), composed like
//! hrc-kernel: one rebuildable, ingest-only `aspd` document fed by the
//! in-process `aspd.observe` provider, served as cardo wire on its own socket.
//!
//! It runs on its own threads and never on the aspc request path: the request
//! path only records into [`Observations`]; a wake thread here notices the
//! change and wakes the binding.
use aspd_domain::{BINDING, DOCUMENT, OPERATION, Observations, PROVIDER, observations::Observer};
use cardo_core::{Format, document::CoreDomain};
use cardo_runtime::{core_adapter::CoreAdapter, service::*, wire};
use crossbeam_channel::Sender;
use serde_json::{Value, json};
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// How often the wake thread checks for new observations.
const WAKE_POLL: Duration = Duration::from_millis(250);

struct NoWork;
impl WorkExecutor for NoWork {
    fn start(&self, _: WorkRequest, _: Sender<WorkCompletion>) -> Result<(), ExecutorFailure> {
        Err(ExecutorFailure {
            code: "unsupported".into(),
            message: "raspd's kernel runs no async product operations".into(),
        })
    }
    fn cancel(&self, _: WorkId) -> Result<ExecutionCancel, ExecutorFailure> {
        Ok(ExecutionCancel::Unsupported)
    }
}

struct Lifecycle;
impl LifecycleParticipant for Lifecycle {
    fn request(
        &mut self,
        r: LifecycleRequest,
        completion: Sender<Result<LifecycleCompletion, LifecycleFailure>>,
    ) -> Result<(), LifecycleFailure> {
        let result = match r {
            LifecycleRequest::Stop { .. } => LifecycleCompletion::Stopped(ParticipantStopped {
                retired_generation: 1,
                settled: vec![],
                cancelled: vec![],
                uncertain: vec![],
            }),
            LifecycleRequest::ResetActor => LifecycleCompletion::Reset(ActorResetReport {
                retired_generation: 1,
                active_generation: 2,
                settled: vec![],
                cancelled: vec![],
                uncertain: vec![],
            }),
        };
        let _ = completion.send(Ok(result));
        Ok(())
    }
    fn join(self: Box<Self>) -> Result<(), LifecycleFailure> {
        Ok(())
    }
}

fn call(client: &KernelClient, operation: &str, arguments: Value) -> Result<Value, String> {
    let receipt = client
        .request(Request::Command(CommandRequest::Unguarded(KernelCommand {
            operation: operation.into(),
            arguments,
            persistence: None,
            cause: None,
        })))
        .map_err(|e| e.message)?;
    let reply = receipt.reply.recv().map_err(|e| e.to_string())?;
    match reply.outcome {
        RequestOutcome::Command(CommandOutcome::Succeeded { value }) => Ok(value),
        other => Err(format!("{operation}: {other:?}")),
    }
}

/// A running kernel. Dropping it leaves the threads running for the life of
/// the process, which is the intent.
pub struct Kernel {
    _owner: RuntimeOwner,
}

/// Compose the kernel and serve its wire on `socket`. Returns once the wire
/// is bound (the kernel is accepting); the document fills in on its own.
pub fn start(observations: Arc<Observations>, socket: &Path) -> Result<Kernel, String> {
    if std::os::unix::net::UnixStream::connect(socket).is_ok() {
        return Err(format!(
            "a server is already listening on {}",
            socket.display()
        ));
    }
    let _ = std::fs::remove_file(socket);
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
        Box::new(Lifecycle),
        RuntimeConfig {
            command_capacity: 64,
            subscription_capacity: 4096,
            terminal_tombstone_capacity: NonZeroUsize::new(64).expect("nonzero"),
            control_poll_millis: 10,
            ring_events: 4096,
            ring_bytes: 33_554_432,
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
    std::thread::Builder::new()
        .name("raspd-kernel-wire".into())
        .spawn(move || {
            if let Err(error) = server.run() {
                eprintln!("raspd kernel wire stopped: {error:?}");
            }
        })
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
    Ok(Kernel { _owner: owner })
}
