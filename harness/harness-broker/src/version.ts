/**
 * One version string for the broker process and for the `normalizer.version`
 * stamped into every broker-authored {@link EventProvenance}. Shared so the
 * `broker.hello` version and event provenance cannot drift apart.
 */
export const HARNESS_BROKER_VERSION = '0.1.0'
