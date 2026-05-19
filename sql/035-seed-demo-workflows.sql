-- vt-0447 / vt-0431 epic: seed demo workflows so new operators see
-- working examples on first login, and e2e tests can drive real runs.
--
-- All entries are namespaced 'demo-*' so the cleanup script (and the
-- recycle-bin) can identify them. Definitions are valid against the
-- fleet-workflow-runner schema (node types: claude, log, branch,
-- set_variable, fan_out, aggregate, transform).
--
-- Idempotent: skip on name collision.

INSERT INTO fleet_workflows (name, description, definition) VALUES
  ('demo-echo-pong',
   'Smoke test: spawn a claude session that replies PONG. Useful for verifying daemon connectivity end-to-end.',
   $J${
      "nodes": [
        {
          "id": "n1", "type": "claude",
          "prompt": "Reply with exactly the word PONG and nothing else.",
          "timeout_seconds": 30
        },
        {
          "id": "n2", "type": "log",
          "message": "echo-pong completed: ${nodes.n1.output}"
        }
      ],
      "edges": [{"from":"n1","to":"n2"}]
    }$J$::jsonb),

  ('demo-vault-search-summary',
   'Search the obsidian vault for a topic and summarise the top hits via a Claude turn. Demonstrates RAG integration.',
   $J${
      "nodes": [
        {
          "id": "search", "type": "http_request",
          "method": "POST", "url": "http://vault-rag-api:5679/api/search",
          "body": {"query": "${vars.query}", "k": 5},
          "headers": {"Authorization": "Bearer ${vars.api_token}"}
        },
        {
          "id": "summarise", "type": "claude",
          "prompt": "Summarise these vault chunks in 3 bullet points:\n${nodes.search.body.results}",
          "timeout_seconds": 90
        },
        {
          "id": "done", "type": "log",
          "message": "summary: ${nodes.summarise.output}"
        }
      ],
      "edges": [{"from":"search","to":"summarise"},{"from":"summarise","to":"done"}],
      "vars": {"query":"INFRA-1000","api_token":"$VAULT_RAG_API_TOKEN"}
    }$J$::jsonb),

  ('demo-parallel-fanout-merge',
   'Fan-out three independent Claude calls in parallel, then aggregate their answers. Demonstrates fan_out + aggregate.',
   $J${
      "nodes": [
        {
          "id": "split", "type": "fan_out",
          "items": ["security audit", "performance review", "doc quality"],
          "inner": {
            "type": "claude",
            "prompt": "In 2 sentences, summarise the typical scope of a ${item}.",
            "timeout_seconds": 60
          }
        },
        {
          "id": "merge", "type": "aggregate",
          "from": "split",
          "format": "bullets"
        },
        {
          "id": "report", "type": "log",
          "message": "merged summary:\n${nodes.merge.result}"
        }
      ],
      "edges": [{"from":"split","to":"merge"},{"from":"merge","to":"report"}]
    }$J$::jsonb),

  ('demo-sequential-pipeline',
   'Sequential 3-step pipeline: outline → expand → critique. Each step uses the previous output.',
   $J${
      "nodes": [
        {
          "id": "outline", "type": "claude",
          "prompt": "Outline a 4-section blog post about WebSocket health checks. Return numbered list only.",
          "timeout_seconds": 60
        },
        {
          "id": "expand", "type": "claude",
          "prompt": "Expand each item of this outline into a 2-sentence paragraph:\n${nodes.outline.output}",
          "timeout_seconds": 120
        },
        {
          "id": "critique", "type": "claude",
          "prompt": "Critique this draft for clarity and technical accuracy. List 3 concrete issues:\n${nodes.expand.output}",
          "timeout_seconds": 60
        }
      ],
      "edges": [
        {"from":"outline","to":"expand"},
        {"from":"expand","to":"critique"}
      ]
    }$J$::jsonb),

  ('demo-branch-decision',
   'Conditional branch: ask Claude whether a YAML snippet is valid; route to fix or accept node. Demonstrates branch + transform.',
   $J${
      "nodes": [
        {
          "id": "validate", "type": "claude",
          "prompt": "Return ONLY the JSON {\"valid\": true} or {\"valid\": false} for whether this YAML parses:\n---\n${vars.yaml}",
          "timeout_seconds": 30
        },
        {
          "id": "parse", "type": "transform",
          "expr": "JSON.parse(nodes.validate.output)"
        },
        {
          "id": "decide", "type": "branch",
          "condition": "nodes.parse.result.valid === true"
        },
        {
          "id": "accept", "type": "log",
          "message": "YAML accepted as-is"
        },
        {
          "id": "fix", "type": "claude",
          "prompt": "Fix this YAML and return only the corrected document, no commentary:\n${vars.yaml}",
          "timeout_seconds": 60
        }
      ],
      "edges": [
        {"from":"validate","to":"parse"},
        {"from":"parse","to":"decide"},
        {"from":"decide","to":"accept","label":"then"},
        {"from":"decide","to":"fix","label":"else"}
      ],
      "vars": {"yaml":"name: test\nsteps:\n  - run: echo hi"}
    }$J$::jsonb)
ON CONFLICT (name) DO NOTHING;
