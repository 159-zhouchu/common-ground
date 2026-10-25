// Saved configurations, participants and simultaneous requests are different limits.
export const MAX_CONNECTIONS = 10;
export const MAX_CONCURRENT_REQUESTS = 2;
export const MAX_BLOCK_CHARACTERS = 50000;
export const MAX_DOCUMENT_CHARACTERS = 150000;
export const MAX_MODEL_INPUT_BYTES = 100000;
export const MAX_AGENT_INITIAL_BYTES = 70000;
export const MAX_DOCUMENT_MULTISTEP_BYTES = 80000;
// Bound accepted JSON before forwarding it to later steps. Never truncate advice.
export const MAX_MODEL_OUTPUT_BYTES = 9000;
// Includes provider metadata; bound the decompressed HTTP body before JSON.parse.
export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export const PRIOR_OUTPUT_RESERVE_BYTES = MAX_MODEL_OUTPUT_BYTES + 512;
export const MAX_JSON_BODY_BYTES = 600000;
export const MAX_UPLOAD_BODY_BYTES = 6 * 1024 * 1024;
