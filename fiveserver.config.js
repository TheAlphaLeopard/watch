/**
 * Five Server config (for the VS Code "Five Server" extension or `npx five-server`)
 *
 * This makes Five Server treat THIS folder as the web root, so /assets/...,
 * /config/... and /manifest.json resolve correctly.
 *
 * NOTE: Five Server reads this file from the folder it is started in.
 * - If you open THIS folder in VS Code (File > Open Folder), keep root: "." as is.
 * - If you open the PARENT folder instead (e.g. Downloads\sgvm), either
 *     a) change this to:  root: "animetsu-static-mirror",  or
 *     b) better: just open the animetsu-static-mirror folder directly.
 */
module.exports = {
  root: ".",
  port: 5500,
  open: true,
  injectBody: true,
  cache: 5,
};
