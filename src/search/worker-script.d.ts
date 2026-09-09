/**
 * Ambient declaration for the esbuild virtual module that inlines the built
 * reranker worker source into main.js (see esbuild.config.mjs). This module
 * only exists at bundle time, so tsc needs this declaration to typecheck.
 */
declare module '~worker-script' {
    export const RERANKER_WORKER_SCRIPT: string;
}