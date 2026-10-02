// Root entrypoint shim.
//
// OpenCode resolves a plugin directory as `<dir>/server.js`, then `<dir>/index.js`.
// It does not read `main` or `exports` from package.json, so the built bundle in
// `dist/` needs this shim to be discoverable when the repo itself is configured
// as a local plugin path.
export { default } from "./dist/index.js"