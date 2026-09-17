export { CoreClient, CoreRpcError, resolveCoreAddress, type CoreAddress } from "./coreClient.js";
export { CallerIdentity, attributionFor, callerAgentId, type Caller } from "./identity.js";
export {
  createCompanionServer,
  COMPANION_NAME,
  COMPANION_VERSION,
  type CompanionOptions,
} from "./server.js";
export {
  DELIVERY_TIERS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  capabilityRef,
  deliverySchema,
  errorPayload,
  nativeSessionId,
  resolveSummary,
  toCoreDelivery,
  toolSchemas,
} from "./tools.js";
export { main } from "./cli.js";
