use std::sync::Barrier;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

const STATION: u64 = 60_000_610;
const SYSTEM: u32 = 30_002_775;
const REGION: u32 = 10_000_033;
static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDatabase(PathBuf);

impl TestDatabase {
    fn new() -> Result<Self> {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let fixture = Self(std::env::temp_dir().join(format!(
            "evejs-market-transactions-{}-{unique}-{sequence}.sqlite",
            std::process::id()
        )));
        let connection = load_connection(&fixture.0).context("open isolated market fixture")?;
        connection
            .execute_batch(SCHEMA_SQL)
            .context("initialize isolated market fixture schema")?;
        connection.execute(
            "INSERT INTO stations VALUES (?1, ?2, 4, ?3, 'Test station', 0.9)",
            params![STATION, SYSTEM, REGION],
        )?;
        connection.execute_batch(
            "CREATE TABLE market_fill_receipts (
               idempotency_key TEXT PRIMARY KEY, order_id INTEGER NOT NULL,
               fill_quantity INTEGER NOT NULL, response_json TEXT NOT NULL,
               created_at TEXT NOT NULL
             );",
        )?;
        for type_id in [34, 35] {
            connection.execute(
                "INSERT INTO market_orders (
                   order_id, owner_id, station_id, solar_system_id, constellation_id, region_id,
                   type_id, price, vol_entered, vol_remaining, bid, issued_at, updated_at
                 ) VALUES (?1, 99, ?2, ?3, 4, ?4, ?5, 5.0, 1000, 1000, ?6, ?7, ?7)",
                params![
                    type_id + 8,
                    STATION,
                    SYSTEM,
                    REGION,
                    type_id,
                    i32::from(type_id == 34),
                    now_rfc3339()
                ],
            )?;
            for table in ["seed_stock", "seed_buy_orders"] {
                connection.execute(
                    &format!(
                        "INSERT INTO {table} (
                       station_id, solar_system_id, constellation_id, region_id, type_id,
                       price, quantity, initial_quantity, updated_at
                     ) VALUES (?1, ?2, 4, ?3, ?4, 5.0, 1000, 1000, ?5)"
                    ),
                    params![STATION, SYSTEM, REGION, type_id, now_rfc3339()],
                )?;
            }
        }
        Ok(fixture)
    }

    fn quantity(&self, order_id: i64) -> Result<u64> {
        let connection = load_connection(&self.0)?;
        if let Some((station, type_id)) = try_decode_seed_buy_order_id(order_id) {
            return Ok(connection.query_row(
                "SELECT quantity FROM seed_buy_orders WHERE station_id=?1 AND type_id=?2",
                params![station, type_id],
                |row| row.get(0),
            )?);
        }
        if let Some((station, type_id)) = try_decode_seed_sell_order_id(order_id) {
            return Ok(connection.query_row(
                "SELECT quantity FROM seed_stock WHERE station_id=?1 AND type_id=?2",
                params![station, type_id],
                |row| row.get(0),
            )?);
        }
        Ok(connection.query_row(
            "SELECT vol_remaining FROM market_orders WHERE order_id=?1",
            params![order_id],
            |row| row.get(0),
        )?)
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(PathBuf::from(format!("{}{suffix}", self.0.display())));
        }
    }
}

fn unseeded_station_order() -> Result<PlaceOrderRequest> {
    Ok(serde_json::from_value(serde_json::json!({
        "owner_id": 77, "is_corp": false, "station_id": STATION + 1,
        "type_id": 34, "price": 7.0, "quantity": 114, "bid": false,
        "station_metadata": {
            "station_id": STATION + 1, "solar_system_id": SYSTEM,
            "constellation_id": 4, "region_id": REGION,
            "station_name": "Unseeded native station", "security": 0.9
        }
    }))?)
}

#[test]
fn native_station_metadata_allows_unseeded_trade_without_overwriting_the_catalog() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let mut missing = unseeded_station_order()?;
    missing.station_metadata = None;
    assert!(insert_order(&fixture.0, missing).is_err());
    let created = insert_order(&fixture.0, unseeded_station_order()?)?;
    assert_eq!(created.station_id, STATION + 1);
    assert_eq!(created.solar_system_id, SYSTEM);
    assert_eq!(created.region_id, REGION);
    let mut conflicting = unseeded_station_order()?;
    conflicting.station_metadata.as_mut().unwrap().solar_system_id = SYSTEM + 1;
    let repeated = insert_order(&fixture.0, conflicting)?;
    assert_eq!(repeated.solar_system_id, SYSTEM, "existing station metadata stays authoritative");
    let connection = load_connection(&fixture.0)?;
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM stations WHERE station_id=?1", params![STATION + 1], |row| row.get::<_, u64>(0))?, 1);
    assert_eq!(fixture.quantity(42)?, 1000, "seed stock is unchanged");
    Ok(())
}

#[test]
fn invalid_native_station_metadata_cannot_create_a_station_or_an_order() -> Result<()> {
    let fixture = TestDatabase::new()?;
    for boundary in 0..5 {
        let mut request = unseeded_station_order()?;
        let metadata = request.station_metadata.as_mut().unwrap();
        match boundary {
            0 => metadata.station_id += 1,
            1 => metadata.solar_system_id = 0,
            2 => metadata.region_id = 0,
            3 => metadata.station_name = " ".to_string(),
            _ => metadata.security = 2.0,
        }
        assert!(insert_order(&fixture.0, request).is_err());
    }
    let connection = load_connection(&fixture.0)?;
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM stations WHERE station_id=?1", params![STATION + 1], |row| row.get::<_, u64>(0))?, 0);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM market_orders WHERE owner_id=77", [], |row| row.get::<_, u64>(0))?, 0);
    Ok(())
}

#[test]
fn station_catalog_and_order_commit_together_and_retry_after_an_interrupted_write() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let connection = load_connection(&fixture.0)?;
    connection.execute_batch("CREATE TRIGGER refuse_new_order BEFORE INSERT ON market_orders BEGIN SELECT RAISE(ABORT, 'interrupted order'); END;")?;
    assert!(insert_order(&fixture.0, unseeded_station_order()?).is_err());
    assert!(lookup_station_meta(&connection, STATION + 1).is_err(), "rolled back catalog admission");
    connection.execute_batch("DROP TRIGGER refuse_new_order;")?;
    let created = insert_order(&fixture.0, unseeded_station_order()?)?;
    drop(connection);
    let fresh = load_connection(&fixture.0)?;
    assert_eq!(lookup_station_meta(&fresh, STATION + 1)?.region_id, REGION);
    assert_eq!(fresh.query_row("SELECT vol_remaining FROM market_orders WHERE order_id=?1", params![created.order_id], |row| row.get::<_, u64>(0))?, 114);
    Ok(())
}

fn run_concurrently<T: Send>(
    workers: usize,
    rounds: usize,
    work: impl Fn(usize, usize) -> Result<T> + Sync,
) -> Result<Vec<T>> {
    let barrier = Barrier::new(workers);
    let results = thread::scope(|scope| {
        let work = &work;
        let barrier = &barrier;
        let handles: Vec<_> = (0..workers)
            .map(|worker| {
                scope.spawn(move || {
                    (0..rounds)
                        .map(|round| {
                            barrier.wait();
                            // Keep participating after errors so peers never strand at a barrier.
                            work(worker, round)
                                .with_context(|| format!("worker={worker} round={round}"))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("market worker panicked"))
            .collect::<Vec<_>>()
    });
    results.into_iter().collect()
}

#[test]
fn concurrent_player_and_seed_fills_and_history_preserve_all_writes() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let orders = [
        42,
        43,
        seed_buy_order_id(STATION, 34),
        seed_sell_order_id(STATION, 35),
    ];
    let rounds = 50;
    let responses = run_concurrently(4, rounds, |worker, round| {
        let response = fill_order_in_db(
            &fixture.0,
            FillOrderRequest {
                order_id: orders[worker],
                fill_quantity: 2,
                idempotency_key: Some(format!("concurrent:{worker}:{round}")),
            },
        )?;
        record_trade_in_db(
            &fixture.0,
            RecordTradeRequest {
                type_id: 34,
                price: (worker + 1) as f64,
                quantity: (worker + 1) as u64,
            },
        )?;
        Ok(response)
    })?;
    assert_eq!(responses.len(), 4 * rounds);
    assert!(
        responses
            .iter()
            .all(|response| !response.duplicate && response.filled_quantity == 2)
    );
    for order in orders {
        assert_eq!(fixture.quantity(order)?, 900);
    }
    let connection = load_connection(&fixture.0)?;
    let receipt_count: u64 =
        connection.query_row("SELECT COUNT(*) FROM market_fill_receipts", [], |row| {
            row.get(0)
        })?;
    assert_eq!(receipt_count, 200);
    let history = connection.query_row(
        "SELECT SUM(volume), SUM(order_count), SUM(avg_price * volume) / SUM(volume), MIN(low_price), MAX(high_price)
         FROM price_history WHERE type_id=34", [],
        |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?, row.get::<_, f64>(2)?, row.get::<_, f64>(3)?, row.get::<_, f64>(4)?)),
    )?;
    assert_eq!((history.0, history.1), (500, 200));
    assert!((history.2 - 3.0).abs() < 1e-10);
    assert_eq!((history.3, history.4), (1.0, 4.0));
    let region_bid: u64 = connection.query_row(
        "SELECT total_bid_quantity FROM region_summaries WHERE region_id=?1 AND type_id=34",
        params![REGION],
        |row| row.get(0),
    )?;
    let seed_ask: u64 = connection.query_row(
        "SELECT total_ask_quantity FROM system_seed_summaries WHERE solar_system_id=?1 AND type_id=35",
        params![SYSTEM], |row| row.get(0),
    )?;
    assert_eq!(region_bid, 1800);
    assert_eq!(seed_ask, 900);
    Ok(())
}

#[test]
fn concurrent_duplicate_fills_decrement_once_per_receipt() -> Result<()> {
    for order in [
        42,
        seed_buy_order_id(STATION, 34),
        seed_sell_order_id(STATION, 35),
    ] {
        let fixture = TestDatabase::new()?;
        let responses = run_concurrently(4, 25, |_, round| {
            fill_order_in_db(
                &fixture.0,
                FillOrderRequest {
                    order_id: order,
                    fill_quantity: 2,
                    idempotency_key: Some(format!("duplicate:{round}")),
                },
            )
        })?;
        assert_eq!(
            responses
                .iter()
                .filter(|response| !response.duplicate)
                .count(),
            25
        );
        assert_eq!(
            responses
                .iter()
                .filter(|response| response.duplicate)
                .count(),
            75
        );
        assert_eq!(fixture.quantity(order)?, 950);
        let connection = load_connection(&fixture.0)?;
        let receipts: u64 =
            connection.query_row("SELECT COUNT(*) FROM market_fill_receipts", [], |row| {
                row.get(0)
            })?;
        assert_eq!(receipts, 25);
    }
    Ok(())
}

#[test]
fn summary_failure_rolls_back_fill_and_receipt_before_retry() -> Result<()> {
    for (order, summary_table) in [
        (42, "region_summaries"),
        (43, "region_summaries"),
        (seed_buy_order_id(STATION, 34), "region_summaries"),
        (seed_buy_order_id(STATION, 34), "system_seed_summaries"),
        (seed_sell_order_id(STATION, 35), "system_seed_summaries"),
    ] {
        let fixture = TestDatabase::new()?;
        let connection = load_connection(&fixture.0)?;
        connection.execute_batch(&format!(
            "CREATE TRIGGER fail_summary BEFORE INSERT ON {summary_table}
             BEGIN SELECT RAISE(ABORT, 'test summary failure'); END;"
        ))?;
        let request = FillOrderRequest {
            order_id: order,
            fill_quantity: 3,
            idempotency_key: Some("summary-failure".to_string()),
        };
        let error = fill_order_in_db(&fixture.0, request.clone())
            .expect_err("summary and fill must commit together");
        assert!(error.to_string().contains("test summary failure"));
        assert_eq!(fixture.quantity(order)?, 1000);
        let receipts: u64 =
            connection.query_row("SELECT COUNT(*) FROM market_fill_receipts", [], |row| {
                row.get(0)
            })?;
        assert_eq!(receipts, 0);
        let summaries: u64 =
            connection.query_row("SELECT COUNT(*) FROM region_summaries", [], |row| {
                row.get(0)
            })?;
        assert_eq!(summaries, 0);
        connection.execute_batch("DROP TRIGGER fail_summary")?;
        assert!(!fill_order_in_db(&fixture.0, request.clone())?.duplicate);
        assert!(fill_order_in_db(&fixture.0, request)?.duplicate);
        assert_eq!(fixture.quantity(order)?, 997);
    }
    Ok(())
}

#[test]
fn rejected_overfill_leaves_quantity_and_receipts_unchanged() -> Result<()> {
    let fixture = TestDatabase::new()?;
    for order in [
        42,
        seed_buy_order_id(STATION, 34),
        seed_sell_order_id(STATION, 35),
    ] {
        let error = fill_order_in_db(
            &fixture.0,
            FillOrderRequest {
                order_id: order,
                fill_quantity: 1001,
                idempotency_key: Some(format!("overfill:{order}")),
            },
        )
        .expect_err("overfills must still be rejected");
        assert!(error.to_string().contains("exceeds remaining order volume"));
        assert_eq!(fixture.quantity(order)?, 1000);
    }
    let connection = load_connection(&fixture.0)?;
    let receipts: u64 =
        connection.query_row("SELECT COUNT(*) FROM market_fill_receipts", [], |row| {
            row.get(0)
        })?;
    assert_eq!(receipts, 0);
    Ok(())
}

#[test]
fn writer_lock_precedes_reads_and_busy_wait_is_bounded() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let mut first = load_connection(&fixture.0)?;
    let mut second = load_connection(&fixture.0)?;
    let timeout: u32 = second.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
    assert_eq!(timeout, 5000);
    // Use a shorter wait for this contention test, retaining production behavior.
    second.busy_timeout(StdDuration::from_millis(20))?;
    let transaction = begin_write_transaction(&mut first)?;
    let reader = open_read_connection(
        &fixture.0,
        &ReadConnectionTuning {
            cache_size_kib: 1000,
            mmap_size_bytes: 0,
            statement_cache_capacity: 16,
        },
    )?;
    let quantity: u64 = reader.query_row(
        "SELECT vol_remaining FROM market_orders WHERE order_id=42",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(
        quantity, 1000,
        "WAL readers must remain available during a write transaction"
    );
    let error = begin_write_transaction(&mut second)
        .expect_err("writer must be reserved even before the first read");
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
    transaction.rollback()?;
    begin_write_transaction(&mut second)?.commit()?;
    assert_eq!(fixture.quantity(42)?, 1000);
    Ok(())
}

#[test]
fn concurrent_order_maintenance_preserves_quantities_and_terminal_events() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let connection = load_connection(&fixture.0)?;
    connection.execute(
        "INSERT INTO market_orders (
           order_id, owner_id, station_id, solar_system_id, constellation_id, region_id,
           type_id, price, vol_entered, vol_remaining, bid, issued_at, updated_at
         ) VALUES (44, 99, ?1, ?2, 4, ?3, 34, 5.0, 1000, 1000, 1, '2010-01-01', '2010-01-01')",
        params![STATION, SYSTEM, REGION],
    )?;
    run_concurrently(5, 25, |worker, round| {
        match worker {
            0 => {
                modify_order_in_db(
                    &fixture.0,
                    ModifyOrderRequest {
                        order_id: 42,
                        new_price: (round + 1) as f64,
                    },
                )?;
            }
            1 => {
                adjust_seed_stock_in_db(
                    &fixture.0,
                    AdjustSeedStockRequest {
                        station_id: STATION,
                        type_id: 35,
                        delta_quantity: Some(1),
                        new_quantity: None,
                        new_price: None,
                        reason: None,
                    },
                )?;
            }
            2 => {
                expire_due_orders_in_db(&fixture.0, &now_rfc3339(), EXPIRY_SWEEP_BATCH_LIMIT)?;
            }
            3 => {
                cancel_order_in_db(&fixture.0, 43)?;
            }
            _ => {
                rebuild_region_summary_cache(&fixture.0, None)?;
            }
        }
        Ok(())
    })?;
    assert_eq!(fixture.quantity(seed_sell_order_id(STATION, 35))?, 1025);
    let price: f64 = connection.query_row(
        "SELECT price FROM market_orders WHERE order_id=42",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(price, 25.0);
    for (order, state) in [(43, "cancelled"), (44, "expired")] {
        let row = connection.query_row(
            "SELECT state, (SELECT COUNT(*) FROM market_order_events WHERE order_id=?1 AND event_type=?2)
             FROM market_orders WHERE order_id=?1", params![order, state],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
        )?;
        assert_eq!(row, (state.to_string(), 1));
    }
    Ok(())
}

async fn load_test_runtime(fixture: &TestDatabase) -> Result<MarketRuntime> {
    let connection = load_connection(&fixture.0)?;
    let manifest = MarketManifest {
        schema_version: 1,
        generated_at: now_rfc3339(),
        static_data_dir: String::new(),
        database_path: fixture.0.to_string_lossy().into_owned(),
        selection_mode: String::new(),
        selection_label: "transaction test".to_string(),
        selected_solar_system_ids: vec![SYSTEM],
        selected_solar_system_names: vec![],
        region_count: 1,
        solar_system_count: 1,
        station_count: 1,
        market_type_count: 2,
        seed_row_count: 4,
        default_quantity_per_station_type: 1000,
        seed_buy_orders_enabled: true,
        history_days_seeded: 0,
        seed_markup_percent: 0.0,
        station_jitter_percent: 0.0,
        region_jitter_percent: 0.0,
    };
    connection.execute(
        "INSERT INTO manifest VALUES (?1, ?2)",
        params![MANIFEST_KEY, serde_json::to_string(&manifest)?],
    )?;
    for type_id in [34, 35] {
        refresh_single_region_summary_row(&fixture.0, REGION, type_id)?;
        refresh_single_system_seed_summary_row(&fixture.0, SYSTEM, type_id)?;
    }
    let mut config = MarketServerConfig::default();
    config.storage.database_path = fixture.0.clone();
    config.runtime.read_connection_pool_size = 2;
    config.runtime.sqlite_mmap_size_mb = 0;
    config.runtime.preload_system_seed_summaries = true;
    config.runtime.cache_system_summaries = true;
    MarketRuntime::load(config).await
}

#[tokio::test]
async fn runtime_invalidates_cached_summaries_after_atomic_seed_fills() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let runtime = load_test_runtime(&fixture).await?;
    assert_eq!(
        runtime.get_region_summary(REGION).await?[0].total_bid_quantity,
        2000
    );
    runtime.get_system_summary(SYSTEM).await?;
    runtime.get_order_book(REGION, 34).await?;
    let (buy, sell) = tokio::join!(
        runtime.fill_order(FillOrderRequest {
            order_id: seed_buy_order_id(STATION, 34),
            fill_quantity: 10,
            idempotency_key: Some("runtime-buy".to_string()),
        }),
        runtime.fill_order(FillOrderRequest {
            order_id: seed_sell_order_id(STATION, 35),
            fill_quantity: 20,
            idempotency_key: Some("runtime-sell".to_string()),
        }),
    );
    assert_eq!(buy?.vol_remaining, 990);
    assert_eq!(sell?.vol_remaining, 980);
    let region = runtime.get_region_summary(REGION).await?;
    let system = runtime.get_system_summary(SYSTEM).await?;
    for summary in [&region, &system] {
        assert_eq!(
            summary
                .iter()
                .find(|row| row.type_id == 34)
                .unwrap()
                .total_bid_quantity,
            1990
        );
        assert_eq!(
            summary
                .iter()
                .find(|row| row.type_id == 35)
                .unwrap()
                .total_ask_quantity,
            1980
        );
    }
    let book = runtime.get_order_book(REGION, 34).await?;
    assert_eq!(
        book.buys
            .iter()
            .find(|row| row.order_id == seed_buy_order_id(STATION, 34))
            .unwrap()
            .vol_remaining,
        990
    );
    Ok(())
}

fn total_bid(rows: &[SummaryRow], type_id: u32) -> u64 {
    rows.iter()
        .find(|row| row.type_id == type_id)
        .unwrap()
        .total_bid_quantity
}

#[tokio::test]
async fn fill_invalidates_summary_rebuilt_during_cache_invalidation() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let runtime = load_test_runtime(&fixture)
        .await
        .context("load cache-invalidation fixture runtime")?;
    assert_eq!(
        total_bid(&runtime.get_system_summary(SYSTEM).await?, 34),
        2000
    );
    // Hold the next cache lock so the fill pauses after its first system-cache
    // invalidation, while the previous seed-summary cache is still readable.
    let station_guard = runtime.station_summaries.write().await;
    let filling_runtime = runtime.clone();
    let fill = tokio::spawn(async move {
        filling_runtime
            .fill_order(FillOrderRequest {
                order_id: seed_buy_order_id(STATION, 34),
                fill_quantity: 10,
                idempotency_key: Some("interleaved-cache-fill".to_string()),
            })
            .await
    });
    tokio::time::timeout(StdDuration::from_secs(10), async {
        while runtime.system_summaries.read().await.contains_key(&SYSTEM) {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    assert_eq!(
        total_bid(&runtime.get_system_summary(SYSTEM).await?, 34),
        2000
    );
    drop(station_guard);
    assert_eq!(
        fill.await?
            .context("complete interleaved cache fill")?
            .vol_remaining,
        990
    );
    assert_eq!(
        total_bid(&runtime.get_system_summary(SYSTEM).await?, 34),
        1990
    );
    assert_eq!(fixture.quantity(seed_buy_order_id(STATION, 34))?, 990);
    Ok(())
}

#[tokio::test]
async fn summary_read_started_before_fill_cannot_repopulate_invalidated_cache() -> Result<()> {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    let fixture = TestDatabase::new()?;
    let runtime = load_test_runtime(&fixture).await?;
    // Exhaust the two read connections. The summary call can capture cached seed
    // totals but cannot finish its player-order query until after the fill.
    let first_lease = runtime.read_pool.acquire()?;
    let second_lease = runtime.read_pool.acquire()?;
    let mut summary = Box::pin(runtime.get_system_summary(SYSTEM));
    poll_fn(|cx| {
        assert!(summary.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    let fill = runtime
        .fill_order(FillOrderRequest {
            order_id: seed_buy_order_id(STATION, 34),
            fill_quantity: 10,
            idempotency_key: Some("late-summary-read".to_string()),
        })
        .await?;
    assert_eq!(fill.vol_remaining, 990);
    drop(first_lease);
    drop(second_lease);
    let old_rows = summary.await?;
    assert_eq!(
        total_bid(&old_rows, 34),
        2000,
        "the in-flight reader captured the old seed totals"
    );
    // The already-running request may finish with its earlier view, but must not
    // poison subsequent reads by publishing that view after invalidation.
    assert_eq!(
        total_bid(&runtime.get_system_summary(SYSTEM).await?, 34),
        1990
    );
    Ok(())
}

#[tokio::test]
async fn late_seed_summary_publication_cannot_restore_pre_fill_totals() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let runtime = load_test_runtime(&fixture).await?;
    let generation = runtime.system_summary_generation(SYSTEM).await;
    let old_rows = runtime
        .get_or_load_system_seed_summary_rows(SYSTEM)
        .await?
        .unwrap();
    assert_eq!(total_bid(&old_rows, 34), 1000);
    runtime
        .fill_order(FillOrderRequest {
            order_id: seed_buy_order_id(STATION, 34),
            fill_quantity: 10,
            idempotency_key: Some("late-seed-cache-fill".to_string()),
        })
        .await?;
    // Simulate a seed-loader result ready to publish after the fill completed.
    // This is the same publication boundary used by actual seed-cache misses.
    runtime
        .cache_system_summary_rows(&runtime.system_seed_summaries, SYSTEM, generation, old_rows)
        .await;
    assert!(
        !runtime
            .system_seed_summaries
            .read()
            .await
            .contains_key(&SYSTEM)
    );
    assert_eq!(
        total_bid(&runtime.get_system_summary(SYSTEM).await?, 34),
        1990
    );
    assert_eq!(
        total_bid(
            &runtime
                .get_or_load_system_seed_summary_rows(SYSTEM)
                .await?
                .unwrap(),
            34
        ),
        990
    );
    Ok(())
}

#[tokio::test]
async fn system_cache_invalidation_does_not_discard_unrelated_system_reads() -> Result<()> {
    let fixture = TestDatabase::new()?;
    let runtime = load_test_runtime(&fixture).await?;
    let generation = runtime.system_summary_generation(SYSTEM).await;
    let rows = runtime
        .get_or_load_system_seed_summary_rows(SYSTEM)
        .await?
        .unwrap();
    runtime
        .invalidate_system_summary_caches(SYSTEM + 1, true)
        .await;
    runtime
        .cache_system_summary_rows(&runtime.system_summaries, SYSTEM, generation, rows)
        .await;
    assert!(runtime.system_summaries.read().await.contains_key(&SYSTEM));
    assert_eq!(runtime.system_summary_generation(SYSTEM).await, generation);
    Ok(())
}
