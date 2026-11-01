#!/bin/sh
# Proves that a database volume survives the move to v0.2 (Phase 3 Milestone 3, SC-010, research #15).
#
# v0.1 and Milestone 2 ran on postgres:16-alpine, whose C library (musl) sorts text by code point. pgvector's only image is
# Debian-based, and glibc sorts the same locale linguistically. A volume moved from one to the other keeps B-tree indexes in
# the old order, and they silently return wrong answers. Migration 017 rebuilds every index. This script shows, on a volume of
# its own, that it does:
#
#   1. a volume on the old image, migrated to 016, holding rows whose text sorts differently in the two collations;
#   2. migration 017 refusing there, with its message, and changing nothing;
#   3. the same volume on the new image: amcheck must now report broken indexes (the NEGATIVE CONTROL: if nothing is broken,
#      a clean result after 017 would prove nothing, and the script stops);
#   4. migration 017 applied: every B-tree index passes bt_index_check(index, true), and no row was lost.
#
# Needs docker, pnpm and the workspace's dependencies. It uses throwaway containers and a volume of its own, and removes them.
# Usage: scripts/check-db-upgrade.sh

set -eu

OLD_IMAGE='postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
NEW_IMAGE='pgvector/pgvector:0.8.7-pg16-trixie@sha256:9cf8b511f0e9a2c209b61430fc139f1ab9c75edbb31fb1751db6617b246a897a'
PASSWORD='upgrade-check-only'

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN_ID="$$"
VOLUME="scrylux-upgrade-check-$RUN_ID"
OLD="scrylux-upgrade-old-$RUN_ID"
NEW="scrylux-upgrade-new-$RUN_ID"

cleanup() {
  docker rm -f "$OLD" "$NEW" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}

# q CONTAINER SQL: one value, no decoration, stops on the first error.
q() {
  docker exec -i "$1" psql -U postgres -d threats -v ON_ERROR_STOP=1 -X -qAt -c "$2"
}

wait_ready() {
  i=0
  until docker exec "$1" pg_isready -U postgres -d threats >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || fail "$1 did not become ready"
    sleep 1
  done
  # The entrypoint starts a temporary server to initialise a new data directory and then restarts: wait for the real one.
  sleep 2
  until docker exec "$1" pg_isready -U postgres -d threats >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || fail "$1 did not become ready"
    sleep 1
  done
}

host_port() {
  docker port "$1" 5432/tcp | head -n 1 | sed 's/.*://'
}

# migrate CONTAINER: runs Scrylux's own migrator against the container, printing what it printed. Its exit status is returned.
migrate() {
  port=$(host_port "$1")
  (
    cd "$ROOT"
    DB_HOST=127.0.0.1 DB_PORT="$port" DB_NAME=threats DB_USER=postgres DB_PASSWORD="$PASSWORD" \
      JWT_SECRET=upgrade-check-only ADMIN_USERNAME=admin ADMIN_PASSWORD=admin \
      pnpm --silent --filter @scrylux/api migrate 2>&1
  )
}

# broken_indexes CONTAINER: how many B-tree indexes of the public schema bt_index_check(index, true) rejects. Sets BROKEN.
broken_indexes() {
  BROKEN=0
  names=$(q "$1" "SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_am a ON a.oid = c.relam JOIN pg_namespace n ON n.oid = c.relnamespace WHERE a.amname = 'btree' AND n.nspname = 'public' AND c.relpersistence = 'p' AND i.indisvalid ORDER BY 1")
  for name in $names; do
    if ! q "$1" "SELECT bt_index_check('public.\"$name\"'::regclass, true)" >/dev/null 2>&1; then
      BROKEN=$((BROKEN + 1))
      say "  rejected by bt_index_check: $name"
    fi
  done
}

# counts CONTAINER LIST: the row count of each listed table, in one line.
counts() {
  q "$1" "SELECT string_agg(relname || '=' || n, ',' ORDER BY relname) FROM (SELECT c.relname, (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.' || quote_ident(c.relname), false, true, '')))[1]::text AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ($2)) t"
}

locale_of() {
  q "$1" "SELECT 'datlocprovider=' || coalesce(datlocprovider::text, '-') || ' datcollate=' || datcollate || ' datctype=' || datctype FROM pg_database WHERE datname = 'threats'" 2>/dev/null ||
    q "$1" "SELECT 'datcollate=' || datcollate || ' datctype=' || datctype FROM pg_database WHERE datname = 'threats'"
}

# ---- 1. A volume on the old image, migrated to 016 ----------------------------------------------------------------------

say "1. A volume on the old image ($OLD_IMAGE)"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$OLD" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=threats -v "$VOLUME":/var/lib/postgresql/data -p 127.0.0.1::5432 "$OLD_IMAGE" >/dev/null
wait_ready "$OLD"
OLD_LOCALE=$(locale_of "$OLD")
say "   $OLD_LOCALE"

# On the old image the migrator applies 001 to 016 and then refuses 017, which is the state of every v0.1 install.
OUTPUT=$(migrate "$OLD" || true)
case "$OUTPUT" in
  *'does not have the pgvector extension'*'docs/install.md#upgrading-to-v02'*) ;;
  *) printf '%s\n' "$OUTPUT" >&2; fail 'migration 017 did not refuse on the old image with its SX001 message' ;;
esac
say '   migration 017 refused, with its message'

[ "$(q "$OLD" "SELECT count(*) FROM schema_migrations WHERE name LIKE '017%'")" = 0 ] || fail 'schema_migrations has a 017 row after the refusal'
[ "$(q "$OLD" "SELECT to_regclass('public.sources') IS NULL")" = t ] || fail 'a sources table exists after the refusal'
TABLES_AT_016=$(q "$OLD" "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'")

# Text that sorts differently by code point (the old image) and by glibc's rules (the new one): case and accents.
q "$OLD" "INSERT INTO users (username, password_hash) VALUES ('alice','x'),('Bob','x'),('Émile','x'),('zoe','x'),('Zed','x'),('eve','x'),('Ångström','x'),('bob2','x'),('Alpha','x'),('beta','x')" >/dev/null
ADMIN=$(q "$OLD" "SELECT id FROM users WHERE username = 'alice'")
q "$OLD" "INSERT INTO projects (name, created_by) VALUES ('alpha',$ADMIN),('Beta',$ADMIN),('Élan',$ADMIN),('zulu',$ADMIN),('Zebra',$ADMIN),('éclair',$ADMIN),('Ångström lab',$ADMIN),('gamma',$ADMIN)" >/dev/null
q "$OLD" "INSERT INTO threat_models (project_id, name) SELECT p.id, m.name FROM projects p CROSS JOIN (VALUES ('payments'),('Payments v2'),('édition'),('Zones'),('zeta'),('Alpha')) AS m(name)" >/dev/null
# schema_migrations is left out of the comparison: it gains the row of 017, which is checked on its own.
LIST=$(q "$OLD" "SELECT string_agg(quote_literal(tablename), ',') FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")
COUNTS_BEFORE=$(counts "$OLD" "$LIST")
say "   rows: $COUNTS_BEFORE"

# A second try changes nothing either: the same tables, no 017.
OUTPUT=$(migrate "$OLD" || true)
case "$OUTPUT" in *'upgrading-to-v02'*) ;; *) fail 'the second try did not refuse' ;; esac
[ "$(q "$OLD" "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'")" = "$TABLES_AT_016" ] || fail 'a refused migration changed the tables'
say '   a refused migration changes 0 tables'

# ---- 2. The same volume on the new image ----------------------------------------------------------------------------------

say "2. The same volume on the new image ($NEW_IMAGE)"
docker stop -t 60 "$OLD" >/dev/null
docker rm "$OLD" >/dev/null
docker run -d --name "$NEW" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=threats -v "$VOLUME":/var/lib/postgresql/data -p 127.0.0.1::5432 "$NEW_IMAGE" >/dev/null
wait_ready "$NEW"
NEW_LOCALE=$(locale_of "$NEW")
say "   $NEW_LOCALE"
q "$NEW" 'CREATE EXTENSION IF NOT EXISTS amcheck' >/dev/null

# The negative control: before 017, the indexes the collation change broke must be reported as broken.
broken_indexes "$NEW"
if [ "$BROKEN" -eq 0 ]; then
  say 'The negative control found no broken index on the new image before migration 017.' >&2
  say "   old image: $OLD_LOCALE" >&2
  say "   new image: $NEW_LOCALE" >&2
  say 'Do not tune the data until it does. Stop and ask the maintainer: the reindex of migration 017 would then rest on a wrong premise (research #15).' >&2
  exit 2
fi
say "   negative control: $BROKEN indexes are broken before migration 017, as they should be"

# ---- 3. Migration 017 ---------------------------------------------------------------------------------------------------

say '3. Migration 017 on the new image'
OUTPUT=$(migrate "$NEW") || { printf '%s\n' "$OUTPUT" >&2; fail 'migration 017 failed on the new image'; }
[ "$(q "$NEW" "SELECT count(*) FROM schema_migrations WHERE name LIKE '017%'")" = 1 ] || fail 'schema_migrations has no 017 row'
[ "$(q "$NEW" "SELECT to_regclass('public.sources') IS NOT NULL")" = t ] || fail 'there is no sources table after 017'

broken_indexes "$NEW"
[ "$BROKEN" -eq 0 ] || fail "$BROKEN indexes are still rejected by bt_index_check after migration 017"
say '   every B-tree index passes bt_index_check(index, true)'

COUNTS_AFTER=$(counts "$NEW" "$LIST")
[ "$COUNTS_AFTER" = "$COUNTS_BEFORE" ] || { say "   before: $COUNTS_BEFORE" >&2; say "   after:  $COUNTS_AFTER" >&2; fail 'row counts changed'; }
[ "$(q "$NEW" 'SELECT count(*) FROM schema_migrations')" = 17 ] || fail 'schema_migrations does not hold 17 rows'
say '   no row was lost'

say 'OK: a v0.1 or Milestone 2 volume survives the move to the pgvector image and migration 017.'
