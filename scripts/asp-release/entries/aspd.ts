// Release entrypoint: the ASPC compile plane as a preparation-only daemon on a
// Unix socket (T-08539). Imports the daemon module directly so the cohosted
// facade and its broker are not part of this executable.
import { runAspdCli } from '../../../harness/aspc-facade/src/aspd.js'
import { embeddedReleaseIdentity } from './embedded-identity.js'

await runAspdCli(process.argv.slice(2), { releaseIdentity: embeddedReleaseIdentity })
