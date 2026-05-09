# vault-skeleton

Reference layout for the Obsidian vault that vault-rag indexes.

## Structure

| Dir | Purpose |
|-----|---------|
| `00-inbox/` | Quick captures, unsorted notes |
| `01-daily/` | Daily notes (one file per day) |
| `02-projects/` | Long-running projects, each in its own subfolder |
| `05-sessions/` | Conversation transcripts, agent session logs |
| `09-resources/` | Reference material, prompts, snippets |

## How vault-rag uses it

1. The `vault-indexer` job (cron `*/5 * * * *`) walks every `.md` file under the mount.
2. New or changed files are chunked, embedded with Ollama (`nomic-embed-text`, 768 dims), upserted into `chunks`.
3. `[[wikilink]]` references populate the `backlinks` table.
4. Frontmatter (`---` block at the top of a file) is parsed into `chunks.fm` JSONB.

## Bootstrap

`deploy.sh --bootstrap-vault` copies this skeleton to the runtime vault path
(default `/opt/vault-rag-data/obsidian-vault`) only when that directory is empty.
Existing vaults are never touched.

## Notes

- Numeric prefixes are convention only - vault-rag does not require them.
- Hidden dirs (starting with `.`) are skipped by the indexer.
- File renames are detected by `mtime` change; old chunks are pruned.
