#!/usr/bin/env bash
set -Eeuo pipefail

readonly DATA_ROOT="${EVEJS_DATA_ROOT:-/var/lib/evejs}"
readonly GAMESTORE_ROOT="${DATA_ROOT}/gameStore"
readonly LOGS_ROOT="${DATA_ROOT}/logs"
readonly GAMESTORE_DATA="${GAMESTORE_ROOT}/data"
readonly GAMESTORE_IMAGES="${GAMESTORE_ROOT}/images"
readonly GAMESTORE_MANIFEST="${GAMESTORE_ROOT}/manifest.json"
readonly DOWNLOAD_ROOT="${DATA_ROOT}/downloads/sde"
readonly SDE_BUILD="3396210"
readonly SDE_URL="${EVEJS_SDE_URL:-https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${SDE_BUILD}-jsonl.zip}"
readonly SDE_ZIP="${DOWNLOAD_ROOT}/eve-online-static-data-${SDE_BUILD}-jsonl.zip"
readonly SDE_ROOT="${DATA_ROOT}/sde/eve-online-static-data-${SDE_BUILD}-jsonl"
readonly MARKET_ROOT="${DATA_ROOT}/market"
readonly MARKET_DATABASE="${MARKET_ROOT}/market.sqlite"
readonly MARKET_CANDIDATE="${MARKET_ROOT}/market.sqlite.candidate"
readonly MARKET_BACKUP_ROOT="${MARKET_ROOT}/backups"
readonly MARKET_LOCK="${MARKET_ROOT}/.market.lock"
readonly MARKET_DATABASE_TOOL="/app/docker/market-database-tool.js"
readonly MARKET_SERVER_CONFIG="/app/docker/market-server.toml"
readonly MARKET_CANDIDATE_SERVER_CONFIG="/app/docker/market-server-candidate.toml"
readonly MARKET_SEED_V1_CONFIG="/app/docker/market-seed.toml"
readonly MARKET_SEED_V2_CONFIG="/app/docker/market-seed-v2.toml"
readonly MARKET_SEED_V3_CONFIG="/app/docker/market-seed-v3.toml"

log() {
  printf '[evejs-docker] %s\n' "$*"
}

ensure_sde() {
  mkdir -p "${DOWNLOAD_ROOT}" "$(dirname "${SDE_ROOT}")"

  if [[ -f "${SDE_ZIP}" ]] && ! unzip -tq "${SDE_ZIP}" >/dev/null 2>&1; then
    log "Discarding an incomplete cached SDE download."
    rm -f "${SDE_ZIP}"
  fi

  if [[ ! -f "${SDE_ZIP}" ]]; then
    log "Downloading EVE static data build ${SDE_BUILD} (first start only)."
    curl --fail --location --retry 5 --retry-all-errors \
      --output "${SDE_ZIP}.partial" "${SDE_URL}"
    mv "${SDE_ZIP}.partial" "${SDE_ZIP}"
  fi

  if [[ ! -f "${SDE_ROOT}/_sde.jsonl" ]]; then
    log "Extracting EVE static data (first start only)."
    rm -rf "${SDE_ROOT}.partial"
    mkdir -p "${SDE_ROOT}.partial"
    unzip -q "${SDE_ZIP}" -d "${SDE_ROOT}.partial"
    rm -rf "${SDE_ROOT}"
    mv "${SDE_ROOT}.partial" "${SDE_ROOT}"
  fi
}

ensure_gamestore() {
  if [[ -f "${GAMESTORE_MANIFEST}" && -f "${GAMESTORE_DATA}/itemTypes/data.json" ]]; then
    log "Existing game database found; keeping persisted state."
    return
  fi

  ensure_sde
  log "Building the game database (first start only)."
  node --max-old-space-size=8192 /app/tools/DatabaseCreator/database-creator.js \
    --sde-dir "${SDE_ROOT}" \
    --out "${GAMESTORE_DATA}" \
    --build "${SDE_BUILD}" \
    --sde-url "${SDE_URL}" \
    --force
}

initialize() {
  mkdir -p "${DATA_ROOT}"
  ensure_gamestore
  # Runtime-generated images (character portraits, alliance logos) live beside
  # the game database so the volume carries them. Pre-create the directory with
  # the runtime user's ownership rather than letting the server create it.
  mkdir -p "${GAMESTORE_IMAGES}"
  log "Persistent game data initialization is complete."
}

require_market_database() {
  if [[ ! -s "${MARKET_DATABASE}" ]]; then
    log "No market database exists at ${MARKET_DATABASE}."
    log "Choose a seed engine explicitly before startup, for example:"
    log "  docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_new_caldari"
    return 1
  fi
}

acquire_market_exclusive_lock() {
  mkdir -p "${MARKET_ROOT}"
  exec 8>"${MARKET_LOCK}"
  if ! flock --nonblock --exclusive 8; then
    log "The market database is currently in use."
    log "Stop the runtime first: docker compose stop server market"
    return 1
  fi
}

clean_market_candidate() {
  rm -f \
    "${MARKET_CANDIDATE}" \
    "${MARKET_CANDIDATE}-shm" \
    "${MARKET_CANDIDATE}-wal" \
    "${MARKET_CANDIDATE}.building" \
    "${MARKET_CANDIDATE}.building-shm" \
    "${MARKET_CANDIDATE}.building-wal" \
    "${MARKET_CANDIDATE}.previous" \
    "${MARKET_CANDIDATE}.previous-shm" \
    "${MARKET_CANDIDATE}.previous-wal"
}

run_market_daemon() {
  require_market_database
  acquire_market_exclusive_lock
  exec market-server --config "${MARKET_SERVER_CONFIG}" serve
}

run_market() {
  run_market_daemon
}

run_server() {
  cd /app/server
  mkdir -p "${LOGS_ROOT}/node-reports"
  exec node \
    --report-on-fatalerror \
    --report-uncaught-exception \
    --report-dir="${LOGS_ROOT}/node-reports" \
    --max-old-space-size=8192 \
    .
}

run_all() {
  initialize
  require_market_database

  (run_market_daemon) &
  local market_pid=$!
  local market_ready=0

  for _ in $(seq 1 300); do
    if curl --fail --silent http://127.0.0.1:40110/health >/dev/null; then
      market_ready=1
      break
    fi
    if ! kill -0 "${market_pid}" 2>/dev/null; then
      wait "${market_pid}"
      return $?
    fi
    sleep 1
  done

  if [[ "${market_ready}" -ne 1 ]]; then
    log "Market server did not become healthy within 300 seconds."
    kill -TERM "${market_pid}" 2>/dev/null || true
    wait "${market_pid}" 2>/dev/null || true
    return 1
  fi

  mkdir -p "${LOGS_ROOT}/node-reports"
  (cd /app/server && exec node \
    --report-on-fatalerror \
    --report-uncaught-exception \
    --report-dir="${LOGS_ROOT}/node-reports" \
    --max-old-space-size=8192 \
    .) &
  local server_pid=$!

  shutdown() {
    trap - INT TERM
    kill -TERM "${server_pid}" "${market_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
    wait "${market_pid}" 2>/dev/null || true
  }
  trap shutdown INT TERM

  set +e
  wait -n "${server_pid}" "${market_pid}"
  local status=$?
  set -e
  shutdown
  return "${status}"
}

market_tools_help() {
  cat <<'EOF'
EvEJS Docker market tools

Usage:
  docker compose run --rm --no-deps market-tools <command> [arguments]

Commands:
  engines                    Explain the v1, v2, v3, and v4 seed types.
  rebuild v1 [seed args]     Replace market.sqlite with a synthetic v1 seed.
  rebuild v2 [import args]   Replace market.sqlite from the latest EVE Ref snapshot.
  rebuild v3 [build args]    Replace market.sqlite with the Jita index seed over the TQ
                             NPC catalog, gated on the pump audit.
  rebuild v4 [import args]   Replace market.sqlite with Iron Man NPC-only stock.
  status                     Show the persisted manifest, table counts, and backup count.
  doctor                     Validate the final database (market must be stopped).
  backup [label]             Create a retained SQLite backup (market must be stopped).
  backups                    List retained backups.
  restore <latest|filename>  Restore a retained backup (market must be stopped).
  presets                    List v1 geography presets.
  snapshot-info              Inspect the current v2 source snapshot without rebuilding.
  help                       Show this message.

Rebuild, doctor, backup, and restore are deliberately offline operations. Stop both services first:
  docker compose stop server market

V2, v3, and v4 reuse the matching cached snapshot by default. Add --fresh-download to a
rebuild command when you need to download the published snapshot again.

A v3 rebuild downloads its snapshot in an explicit step first, because the v3 build
itself never downloads, and then refuses to install a candidate whose pump audit fails.
EOF
}

market_engines() {
  cat <<'EOF'
v1  Synthetic, deterministic liquidity generated from local static data.
    Presets: jita_new_caldari, jita_only, new_caldari_only, full_universe.

v2  Current Tranquility station-market liquidity imported from EVE Ref.
    Filters: all-station, npc-only, player-only, market-scope,
    market-scope-with-npc. Player-structure orders are intentionally excluded.

v3  The Tranquility NPC catalog (T1 blueprints, skillbooks, trade goods) overlaid
    universe-wide, plus a Jita 4-4 index seed priced from each type's own bottom-up
    manufacturing cost: sold at 3x cost, bought back at 1x. Prices come from a price
    manifest committed to the repo, so every deployment seeds identical economics.
    The rebuild will not install a candidate that fails the money-pump audit.

v4  Iron Man: only authentic NPC station orders (BPOs, skillbooks, command centers,
    trade goods and other NPC stock), including NPC buybacks. No player liquidity,
    synthetic Jita hub or custom-station stock. Uses the v2 snapshot importer.

All four seed types replace the same market.sqlite used by the same Rust market daemon.
EOF
}

market_v1_has_selection() {
  local argument
  for argument in "$@"; do
    case "${argument}" in
      --preset|--preset=*|--solar-system-id|--solar-system-id=*|--solar-system-name|--solar-system-name=*)
        return 0
        ;;
    esac
  done
  return 1
}

market_v2_has_reuse_download() {
  local argument
  for argument in "$@"; do
    if [[ "${argument}" == "--reuse-download" ]]; then
      return 0
    fi
  done
  return 1
}

# The v3 rebuild has to look at two of the build flags it forwards, so the flag is a
# parameter here rather than one function per flag.
market_v3_has_argument() {
  local wanted="$1"
  shift
  local argument
  for argument in "$@"; do
    if [[ "${argument}" == "${wanted}" ]]; then
      return 0
    fi
  done
  return 1
}

install_market_candidate() {
  local backup_label="$1"
  local rollback_backup=""

  rollback_backup="$(node "${MARKET_DATABASE_TOOL}" backup \
    "${MARKET_DATABASE}" "${MARKET_BACKUP_ROOT}" "${backup_label}")"

  rm -f "${MARKET_DATABASE}-wal" "${MARKET_DATABASE}-shm"
  mv -f "${MARKET_CANDIDATE}" "${MARKET_DATABASE}"

  if market-server --config "${MARKET_SERVER_CONFIG}" doctor; then
    if [[ -n "${rollback_backup}" ]]; then
      log "Previous market retained at ${rollback_backup}."
    fi
    return 0
  fi

  log "Installed market validation failed. Attempting automatic rollback."
  if [[ -z "${rollback_backup}" ]]; then
    log "No previous market database was available to restore."
    return 1
  fi

  clean_market_candidate
  node "${MARKET_DATABASE_TOOL}" stage-restore \
    "${MARKET_BACKUP_ROOT}" "$(basename "${rollback_backup}")" "${MARKET_CANDIDATE}" \
    >/dev/null
  rm -f "${MARKET_DATABASE}" "${MARKET_DATABASE}-wal" "${MARKET_DATABASE}-shm"
  mv "${MARKET_CANDIDATE}" "${MARKET_DATABASE}"
  market-server --config "${MARKET_SERVER_CONFIG}" doctor
  log "Rollback restored ${rollback_backup}."
  return 1
}

market_rebuild() {
  local engine="${1:-}"
  if [[ -z "${engine}" ]]; then
    log "Choose a seed engine: rebuild v1 ..., rebuild v2 ..., rebuild v3 ..., or rebuild v4 ..."
    return 2
  fi
  shift

  case "${engine}" in
    v1|v2|v3|v4) ;;
    *)
      log "Unknown market seed engine '${engine}'. Expected v1, v2, v3, or v4."
      return 2
      ;;
  esac

  acquire_market_exclusive_lock
  ensure_gamestore
  clean_market_candidate

  log "WARNING: rebuilding replaces seeded liquidity, player orders, events, and history."
  log "Building market candidate with seed engine ${engine}."

  if [[ "${engine}" == "v1" ]]; then
    local -a v1_arguments=("$@")
    if ! market_v1_has_selection "${v1_arguments[@]}"; then
      v1_arguments+=(--preset jita_new_caldari)
      log "No v1 geography was supplied; using safe default jita_new_caldari."
    fi
    market-seed \
      --config "${MARKET_SEED_V1_CONFIG}" \
      build \
      --force \
      "${v1_arguments[@]}"
  elif [[ "${engine}" == "v2" || "${engine}" == "v4" ]]; then
    local -a v2_arguments=("$@")
    local -a filtered_v2_arguments=()
    local fresh_download=0
    local argument
    for argument in "${v2_arguments[@]}"; do
      if [[ "${argument}" == "--fresh-download" ]]; then
        fresh_download=1
      else
        filtered_v2_arguments+=("${argument}")
      fi
    done
    if [[ "${fresh_download}" -eq 1 ]] && market_v2_has_reuse_download "${filtered_v2_arguments[@]}"; then
      log "Do not combine --fresh-download with --reuse-download."
      return 2
    fi
    if [[ "${fresh_download}" -eq 0 ]] && ! market_v2_has_reuse_download "${filtered_v2_arguments[@]}"; then
      filtered_v2_arguments+=(--reuse-download)
    fi
    if [[ "${fresh_download}" -eq 1 ]]; then
      log "Ignoring the cached v2 snapshot for this rebuild."
    fi
    v2_arguments=("${filtered_v2_arguments[@]}")
    if [[ "${engine}" == "v4" ]]; then
      # Appending the strict filter also makes conflicting --order-filter arguments
      # fail in clap instead of silently changing the Iron Man seed type.
      v2_arguments+=(--order-filter iron-man)
      log "Iron Man: importing only NPC orders at their original stations."
    fi
    market-seederv2 \
      --config "${MARKET_SEED_V2_CONFIG}" \
      build \
      --yes \
      "${v2_arguments[@]}"
  else
    local -a v3_arguments=("$@")
    local -a filtered_v3_arguments=()
    local fresh_download=0
    local argument
    for argument in "${v3_arguments[@]}"; do
      if [[ "${argument}" == "--fresh-download" ]]; then
        fresh_download=1
      else
        filtered_v3_arguments+=("${argument}")
      fi
    done
    v3_arguments=("${filtered_v3_arguments[@]}")

    # A dry run builds no candidate, so the install machinery below would fail on a
    # missing file after an hour of work. Refuse it here and say where a preview lives.
    if market_v3_has_argument --dry-run "${v3_arguments[@]}"; then
      log "A v3 rebuild installs what it builds, so --dry-run has nothing to install."
      log "Preview it instead with: market-seederv3 --config ${MARKET_SEED_V3_CONFIG} build --dry-run"
      return 2
    fi

    # The audit reconstructs the same seed the build wrote, so it has to be told about
    # --skip-overlay too. Otherwise it would re-import the NPC catalog and grade a
    # database this rebuild never produced.
    local -a v3_audit_arguments=()
    if market_v3_has_argument --skip-overlay "${v3_arguments[@]}"; then
      v3_audit_arguments+=(--skip-overlay)
      log "Skipping the TQ overlay: this database gets no skillbooks, T1 blueprints, or NPC buybacks."
    else
      # The v3 build deliberately never downloads, so that builds stay offline and
      # reproducible. Caching the snapshot is an explicit step of its own.
      local -a v3_snapshot_arguments=(--download)
      if [[ "${fresh_download}" -eq 1 ]]; then
        log "Ignoring the cached v3 snapshot for this rebuild."
      else
        v3_snapshot_arguments+=(--reuse-download)
      fi
      log "Caching the Tranquility market-order snapshot the v3 overlay imports."
      if ! market-seederv3 \
        --config "${MARKET_SEED_V3_CONFIG}" \
        snapshot-info \
        "${v3_snapshot_arguments[@]}"; then
        log "Could not fetch the Tranquility market-order snapshot that v3 needs."
        log "The v3 build never downloads, so the rebuild stops here instead of seeding without the NPC catalog."
        return 1
      fi
    fi

    market-seederv3 \
      --config "${MARKET_SEED_V3_CONFIG}" \
      build \
      --yes \
      "${v3_arguments[@]}"

    log "Auditing the candidate for money pumps before it is installed."
    if ! market-seederv3 \
      --config "${MARKET_SEED_V3_CONFIG}" \
      audit \
      "${v3_audit_arguments[@]}"; then
      log "The v3 money-pump audit failed, so this candidate was NOT installed."
      log "A seed players can turn back into more ISK than it cost must never be promoted."
      log "The live market database is untouched. Fix the pricing, then rebuild."
      return 1
    fi
  fi

  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  market-server --config "${MARKET_CANDIDATE_SERVER_CONFIG}" doctor
  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  install_market_candidate "before-${engine}-rebuild"
  clean_market_candidate
  log "Market rebuild with ${engine} completed successfully."
}

market_backup() {
  local label="${1:-manual}"
  acquire_market_exclusive_lock
  require_market_database
  local backup_path
  backup_path="$(node "${MARKET_DATABASE_TOOL}" backup \
    "${MARKET_DATABASE}" "${MARKET_BACKUP_ROOT}" "${label}")"
  log "Market backup created: ${backup_path}"
}

market_doctor() {
  acquire_market_exclusive_lock
  require_market_database
  market-server --config "${MARKET_SERVER_CONFIG}" doctor
}

market_restore() {
  local selector="${1:-}"
  if [[ -z "${selector}" ]]; then
    log "Choose a backup filename or use: restore latest"
    return 2
  fi

  acquire_market_exclusive_lock
  clean_market_candidate
  local selected_backup
  selected_backup="$(node "${MARKET_DATABASE_TOOL}" stage-restore \
    "${MARKET_BACKUP_ROOT}" "${selector}" "${MARKET_CANDIDATE}")"
  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  market-server --config "${MARKET_CANDIDATE_SERVER_CONFIG}" doctor
  node "${MARKET_DATABASE_TOOL}" prepare \
    "${MARKET_CANDIDATE}" "${MARKET_DATABASE}" >/dev/null
  install_market_candidate "before-restore"
  clean_market_candidate
  log "Restored market backup ${selected_backup}."
}

market_tools() {
  local command="${1:-help}"
  shift || true
  case "${command}" in
    engines)
      market_engines
      ;;
    rebuild)
      market_rebuild "$@"
      ;;
    status)
      node "${MARKET_DATABASE_TOOL}" status "${MARKET_DATABASE}" "${MARKET_BACKUP_ROOT}"
      ;;
    doctor)
      market_doctor
      ;;
    backup)
      market_backup "$@"
      ;;
    backups)
      node "${MARKET_DATABASE_TOOL}" backups "${MARKET_BACKUP_ROOT}"
      ;;
    restore)
      market_restore "$@"
      ;;
    presets)
      market-seed --config "${MARKET_SEED_V1_CONFIG}" presets
      ;;
    snapshot-info)
      market-seederv2 --config "${MARKET_SEED_V2_CONFIG}" snapshot-info
      ;;
    help|--help|-h)
      market_tools_help
      ;;
    *)
      log "Unknown market-tools command '${command}'."
      market_tools_help
      return 2
      ;;
  esac
}

content_tools() {
  node /app/tools/ContentPacks/index.js "$@" --store-root "${GAMESTORE_ROOT}"
}

maintenance_tools_help() {
  cat <<'EOF'
EvEJS Docker maintenance tools

Usage:
  docker compose run --rm --no-deps maintenance <command> [arguments]

Commands:
  reset-sovereignty [--dry-run] [--force]
                             One-time reset to retail-parity sovereignty. Backs the game
                             database up to /var/lib/evejs/backups/, removes every claim,
                             Hub, command node, Skyhook, Mercenary Den and FLEX structure,
                             and records a marker so a second run does nothing.
                             The server also runs this reset itself at startup
                             when the marker is missing.
  help                       Show this message.

These are offline operations. Stop the server first:
  docker compose stop server
EOF
}

maintenance_tools() {
  local command="${1:-help}"
  shift || true
  case "${command}" in
    reset-sovereignty)
      EVEJS_GAMESTORE_DATA_DIR="${GAMESTORE_DATA}" \
        node /app/tools/Maintenance/reset-sovereignty.js "$@"
      ;;
    help|--help|-h)
      maintenance_tools_help
      ;;
    *)
      log "Unknown maintenance command '${command}'."
      maintenance_tools_help
      return 2
      ;;
  esac
}

case "${1:-all}" in
  init)
    initialize
    ;;
  market)
    run_market
    ;;
  server)
    run_server
    ;;
  all)
    run_all
    ;;
  market-tools)
    shift
    market_tools "$@"
    ;;
  content-tools)
    shift
    content_tools "$@"
    ;;
  maintenance)
    shift
    maintenance_tools "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
