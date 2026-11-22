# Site API

The site API lets tools work on a running playground: read and write its files, search them, run PHP code, send
requests to the site and run Joomla's console. It is the base for a code editor and for an MCP connection, so that
an AI assistant can work on a playground site.

The code is in [web/src/site-api.js](../web/src/site-api.js). The PHP worker runs each operation in its request
queue, between the requests of the page, so an operation never overlaps a page request. A change to a saved site
goes into its snapshot right after the operation.

## Calling it

On the playground page:

```js
const file = await window.joomlaPlaygroundSite('read', { path: 'templates/cassiopeia/index.php' });

await window.joomlaPlaygroundSite('write', {
  path: 'templates/cassiopeia/index.php',
  text: file.text.replace('</body>', '<!-- edited --></body>'),
  revision: file.revision,
});
```

A failed operation rejects with an `Error` that has a `code` (see [Errors](#errors)).

## Paths

Paths are relative to the site's root (`/var/www/html`); a leading `/` is allowed. `..`, backslashes and NUL
characters are refused. A symbolic link is followed only when its target is inside the root.

## Operations

| Operation | Arguments | Result |
|---|---|---|
| `info` | | `{ siteUrl, root, php, joomla, limits }` |
| `stat` | `path` | `{ path, type }`: `file` (with `size` and `revision`), `directory`, `symlink` (with `target`) or `null` |
| `list` | `path` | `[{ name, type }]`, folders first, then by name |
| `read` | `path` | `{ path, size, revision, text }` for UTF-8, otherwise `base64` instead of `text` |
| `write` | `path`, `text` or `base64`, `revision?` | `{ path, size, revision, created }`. Creates missing folders. |
| `mkdir` | `path` | `{ path, created }` (`false` when it exists) |
| `rename` | `from`, `to`, `overwrite?` | `{ from, to }` |
| `delete` | `path`, `recursive?` | `{ path, deleted }`: the type that was deleted. A link is deleted, not its target. |
| `search` | `query`, `path?`, `regex?`, `caseSensitive?`, `glob?`, `all?`, `limit?` | `{ results: [{ path, line, text }], truncated }` |
| `runPhp` | `code` | `{ exitCode, output, errors }`. Runs in the root folder; `<?php` may be left out. |
| `request` | `path`, `method?`, `headers?`, `body` or `base64` | `{ status, headers, text }` or `{ ..., base64 }` |
| `cli` | `args` | `{ exitCode, output, errors }` of `cli/joomla.php`, with `--no-interaction` |

Notes:

- **Revisions.** `revision` is the SHA-256 of the file's content. A `write` with a revision only succeeds when the
  file still has that content, so an editor does not overwrite a change Joomla made meanwhile (`CONFLICT`). With
  `revision: null` the file must not exist yet (`EXISTS`). Without a revision, the file is overwritten.
- **PHP files.** After a write, rename or delete, the API clears OPcache for the PHP files involved, so a saved file
  counts from the next request on.
- **Search** skips `tmp`, `cache`, `administrator/cache`, `administrator/logs` and `media/vendor`, unless `all` is
  true. It skips files larger than 1 MB and stops at `limit` results (at most 200); `truncated` then is true.
- **Requests** run as the playground's own session, logged in to the administrator when the playground is.
- **The console** runs in the same PHP instance as the site. Commands that wait for input get none.

## Limits

Files up to 32 MB, lists up to 20,000 entries, searches through up to 50,000 files. The values are in
`SITE_API_LIMITS` and in the result of `info`.

## Errors

| Code | Meaning |
|---|---|
| `INVALID_PATH` | The path has `..`, a backslash or a NUL character |
| `OUTSIDE_ROOT` | A symbolic link points outside the site's root |
| `ROOT_PROTECTED` | The root itself cannot be written, moved or deleted |
| `NOT_FOUND` | No such file or folder |
| `NOT_DIRECTORY` / `IS_DIRECTORY` | A file where a folder was expected, or the other way around |
| `EXISTS` | The target exists (a `write` with `revision: null`, a `rename` without `overwrite`) |
| `CONFLICT` | The file changed since the given revision |
| `NOT_EMPTY` | A folder with content, deleted without `recursive` |
| `TOO_LARGE` | Over a limit |
| `INVALID_ARGUMENT` | A wrong or missing argument, such as an invalid regular expression |
| `UNKNOWN_OPERATION` | No such operation |

## Tests

```sh
npm run bundle -- --no-languages   # once: the Joomla bundle the tests unpack
npm run test:site-api
```

The tests run the API with PHP in WebAssembly in Node (`@php-wasm/node`) on the playground's own Joomla bundle. The
browser tests check it in the playground itself, including that a change to a saved site stays after a reload.
