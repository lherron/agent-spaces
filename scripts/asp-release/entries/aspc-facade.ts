// Release entrypoint: bind the existing preparation facade into one Bun-compiled
// executable so runtime imports cannot escape into a checkout or consumer tree.
import '../../../harness/aspc-facade/src/cli.js'
