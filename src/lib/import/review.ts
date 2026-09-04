/**
 * Back-compatible re-export surface.
 *
 * Commit-readiness and validation state have exactly one implementation, in
 * `invariants.ts`, so the landing/waypoint boundary is enforced in a single
 * place. This module stays for the existing import sites.
 */
export {
  importProposalValidationState,
  isImportProposalCommitReady,
} from "./invariants";
