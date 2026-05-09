# vt - Vault Task Tracker

Tasks live as markdown in `<vault>/06-tasks/vt-NNNN-slug.md`. Counter at `<vault>/.vt/seq`. Edit by hand if needed.

## Setup

```bash
export VAULT_RAG_URL=https://brain.itiswednesdaymydud.es
export VAULT_RAG_API_TOKEN=<token>
export VT_AGENT=<your-name>     # optional
```

## Commands

| Command | Purpose |
|---|---|
| `vt create [-t TYPE] [-p N] "title"` | Create task. TYPE in task/epic/bug/chore (default task). N in 0..3 (default 2). |
| `vt list [--all] [--status S] [--type T]` | List tasks. Default: open only. |
| `vt ready` | Show unblocked open tasks, priority asc. |
| `vt show <id> [--json]` | Show task body or JSON object. |
| `vt claim <id> [--by NAME] [--force]` | Set in_progress + claimed_by. |
| `vt close <id> --reason "..."` | Mark closed with reason. |
| `vt update <id> [--status S] [--priority P] [--body TEXT|-]` | Update fields. `--body -` reads stdin. |
| `vt dep add <id> --blocked-by <other>` | Add dependency. |
| `vt dep rm <id> --blocked-by <other>` | Remove dependency. |
| `vt remember "note" [--tags a,b]` | Save note to `09-resources/notes/`. |

## Agent workflow

1. `vt ready` - find unblocked work.
2. `vt claim <id>` - mark yourself as owner.
3. Do the work.
4. `vt close <id> --reason "..."` - report outcome.
5. Side quests: `vt create -t bug --blocked-by <current>` - file blocker, keep working on parent.

## MCP

Same operations available as MCP tools `task_create`, `task_list`, `task_ready`, `task_show`, `task_claim`, `task_close`, `task_update`, `task_dep_add`, `task_dep_rm`. Argument schemas mirror REST bodies.
