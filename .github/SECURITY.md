# Security

## Report a problem

Report it privately on GitHub: open the [Security tab](https://github.com/codepawl/crucible/security/advisories/new) and choose "Report a vulnerability", with the steps to reproduce the problem. If you cannot use GitHub, email legal@codepawl.com. Do not open a public issue for a vulnerability.

## Supported versions

Only the latest published version of `@codepawlhq/crucible` gets security fixes.

## What the MCP server protects

The MCP server takes input from AI agents, and that input can come from a prompt injection. The server must therefore hold these limits:

- It runs no code that a tool call supplies. One startup exception exists: `--addons <folder>` with `--allow-addon <package>` loads the named npm packages from that folder into the preview page. The person who starts the server chooses them, never a tool call, and an addon runs with the full rights of the preview page. The server serves only the allowlisted packages' own files, requires each to pass the addon contract, and refuses any real path outside the folder ([docs/addons.md](docs/addons.md#the-mcp-server-and-addons)).
- It reads assets only from the configured catalog, and it fetches no remote URLs for assets.
- It writes render output and GLB exports (`scene_export_glb`, under `exports/`, server-chosen names) only to the configured jobs folder.
- It bounds every collection, count and size before it allocates memory.
- `CRUCIBLE_ASK_USER_FIXTURE` is a test-only environment variable, set only by whoever starts the server: `scene_ask_user` then answers from a bounded JSON file of marks (absolute path, under 64 KB, validated) and opens no browser. No tool call can set it and it is in no tool schema.
- `CRUCIBLE_TEST_PREVIEW_DEADLINE_SECONDS` is a test-only environment variable, set only by whoever starts the server: it raises the 30 second deadline of a preview call and a review to at most 180 seconds, and anything else is refused at start. No tool call can set it and it is in no tool schema.
- Its one outbound request is a fixed GET to the npm registry for the latest version number, in the background, at most once a day, off with `CRUCIBLE_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1` or `CI`. No tool call can change the URL or send data ([docs/mcp.md](docs/mcp.md#updates)).
- A native render job moves the scene tables from the job page to the server over the DevTools connection the server already holds to its own browser (`IO.resolveBlob` and `IO.read` of a Blob). It opens no port, no WebSocket and no HTTP route for them, so no other page or process on the machine can post into or read from that transfer. The read is bounded by the size the page announced (at most 2 GiB) and the adapter capacity, and the page drops its copy when the read ends or fails.

`docs/mcp.md` describes each limit and its boundary tests.

## Dependencies

The `Test` workflow runs `npm audit` on each pull request and fails on a high or critical advisory. `zod` and other packages count even when they are development dependencies, because the build bundles them into the MCP server. Dependabot opens grouped updates each week.
