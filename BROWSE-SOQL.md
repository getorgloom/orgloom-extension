# Browse and SOQL — desktop 0.9.0

The existing canvas screens use local extension-host implementations. Reads use the connected user's native Salesforce REST endpoints; no Org Loom service or managed package is involved. Production connections require explicit confirmation.

## Implemented

- Browse accessible standard/custom objects; search names, Case subjects/numbers and exact record IDs.
- Filter text, numeric, picklist, date/datetime, boolean and reference fields using metadata-supported operators. Filter fields must be filterable; sort fields must be sortable. Values are escaped or validated by type.
- Exact matching counts and already-on-canvas counts, sortable preview columns and offset paging. The inherited selection basket supports selecting records across pages and objects.
- SOQL preview/import with WHERE, ordering, limits, offsets, parent field projections and nested child SELECT queries. Child relationship names resolve against the current org's metadata. Child records become cards with their relationship edges. Parent projections alone do not create additional parent cards, matching the hosted importer.
- Up to 500 imported records total, including child records. Missing root Id is added automatically; child SELECT queries must include Id. Native continuation pages are followed through validated Salesforce query locators.
- Full record hydration before import with four concurrent reads per import. Host-owned upload baselines are staged until the entire import succeeds and existing baselines are preserved on repeated previews/imports.

## Retained boundaries

- At most 12 Browse filters, 200 rows per preview page and Salesforce's maximum OFFSET of 2,000. Later Browse pages produce a clear message to narrow filters or use SOQL. Counts are not capped to the preview size.
- Import cap is 500 distinct records across all objects and levels, query text at most 20,000 characters, and up to five nested query levels. Oversized combined results and incomplete child pages return explicit `capped`/`truncated` indicators; users can narrow the query to import remaining records. Duplicated records are represented once.
- WHERE semi/anti-joins are supported and do not create child cards. Referenced objects still pass the same object policy. Aggregates, locking/tracking/access-mode clauses, comments and multiple statements remain unsupported. Setup/security/code objects and specialized event/external/big objects are excluded from this importer.
- Full hydration is bounded concurrency rather than a single bulk request; large imports can take longer and consume additional Salesforce API requests.
- Salesforce remains authoritative for query syntax and access. No writes occur from Browse or SOQL.

## Source isolation

The pure query parser/flattening, search/literal helpers and object policy were adapted from the local canvas core into src/soql-import-results.cjs, src/sf-soql.cjs and src/soql-policy.cjs under the existing PolyForm Internal Use license. The pinned vendor snapshot and original hosted repository are unchanged.

## Verification

Unit tests cover filter types, escaping, invalid metadata, counts, paging, child relationships, continuation validation, caps and baseline preservation. The VS Code integration test exercises the real Browse filter/selection/import screen and SOQL preview with controlled transport. The opt-in live-read script uses existing UAT records with writes prohibited at the transport boundary.
