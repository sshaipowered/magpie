/**
 * @magpie/client — wraps a WebSocket to the relay plus the per-call
 * pairing crypto. The relay only ever sees ciphertext.
 */
export { MagpieClient } from './client.js';
export type {
  ClientToRelay,
  RelayToClient,
  OpenFrame,
  JoinFrame,
  SendFrame,
  HangupFrame,
  OpenedFrame,
  JoinedFrame,
  PeerJoinedFrame,
  DeliverFrame,
  HangupDeliverFrame,
  ErrorFrame,
} from './wire.js';
export { parseRelayFrame } from './wire.js';
export { magpieHome } from './home.js';
export {
  loadOrCreateIdentity,
  fingerprintOf,
  identityDir,
  toRef,
  IDENTITY_DIR,
  IDENTITY_KEY_FILE,
  IDENTITY_PUB_FILE,
} from './identity.js';
export type { Identity } from './identity.js';
export {
  saveReport,
  listReports,
  readReport,
  renderReport,
  outcomeLabel,
  callsDir,
  CALLS_DIR,
} from './reports.js';
