# Vendored reference code

Upstream package sources copied here **for reading only** while rewriting
them as blueberry extensions. Never load, import, or execute anything in
this directory. Never wire these paths into the `pi` manifest in
`package.json`.

| Directory | Upstream | Version | Copy date | Rewrite target |
| ----------- | ---------- | --------- | ----------- | ---------------- |
| `pi-plan-mode/` | [@narumitw/pi-plan-mode](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-plan-mode) | 0.52.0 | 2025-08-24 | `extensions/plan/` |
| `rpiv-todo/` | [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 2.7.0 | 2025-08-24 | `extensions/todo/` |
| `pi-fff/` | [@ff-labs/pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) | 0.10.5 | 2025-08-24 | `extensions/search/` |

Copies are unmodified snapshots from the installed npm packages
(`~/.pi/agent/npm/node_modules/...`), including their dist artifacts.
Upstream licenses are included in each directory.

When a rewrite ships and is stable, delete the corresponding vendored
directory and its row here.
