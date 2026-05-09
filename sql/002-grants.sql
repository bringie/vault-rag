-- vault-rag grants. Idempotent.
-- Creates read-only role vaultrag_grafana for Grafana + postgres-exporter custom queries.
-- Apply: docker exec -i vault-rag-postgres psql -U postgres -d vault_rag \
--          -v grafana_pass="'<password>'" < 002-grants.sql

SELECT 'CREATE ROLE vaultrag_grafana LOGIN PASSWORD ' || quote_literal(:'grafana_pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vaultrag_grafana')
\gexec
SELECT 'ALTER ROLE vaultrag_grafana PASSWORD ' || quote_literal(:'grafana_pass')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vaultrag_grafana')
\gexec

GRANT CONNECT ON DATABASE vault_rag TO vaultrag_grafana;
GRANT USAGE   ON SCHEMA public      TO vaultrag_grafana;
GRANT SELECT  ON jobs, job_runs, ingest_log, chunks, meta, backlinks, vault_audit
                                    TO vaultrag_grafana;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO vaultrag_grafana;
