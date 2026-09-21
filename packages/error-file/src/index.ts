// @actual-app/error-file — the UNIVERSAL entry (pm/error_err.mdx §4.1, §5).
//
// This is the only entry ordinary source files import. It never touches `fs`, the DOM, React or
// loot-core, so it is safe in a browser tab, a web worker, Electron and node alike. Hosts import
// `./node` or `./browser` exactly once, at boot (§7).

export {
  errorFileFor,
  flushErrorFile,
  guard,
  hasErrorSink,
  isReported,
  reportBoundaryError,
  reportRejection,
  setErrorSink,
  tryOr,
  tryOrAsync,
} from './core.ts';
export type {
  ErrorData,
  ErrorDataValue,
  ErrorFile,
  ErrorLevel,
  ErrorRecord,
  ErrorSink,
} from './core.ts';
export { describeError } from './describe.ts';
