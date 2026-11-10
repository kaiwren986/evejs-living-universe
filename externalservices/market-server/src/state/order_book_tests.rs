use super::*;

const ISSUE_TIME: &str = "2026-06-01T00:00:00Z";

// All query fixtures are in-memory; never open the configured market database.
fn order_book_database() -> Result<Connection> {
    let connection = Connection::open_in_memory()?;
    connection.execute_batch(SCHEMA_SQL)?;
    Ok(connection)
}

fn insert_seed_bid(connection: &Connection, station_id: u64, price: f64) -> Result<()> {
    connection.execute(
        "INSERT INTO seed_buy_orders (
           station_id, solar_system_id, constellation_id, region_id, type_id,
           price, quantity, initial_quantity, updated_at
         ) VALUES (?1, 2, 4, 1, 34, ?2, 100, 100, ?3)",
        params![station_id, price, ISSUE_TIME],
    )?;
    Ok(())
}

fn insert_player_bid(
    connection: &Connection,
    order_id: u64,
    station_id: u64,
    price: f64,
) -> Result<()> {
    insert_player_order(connection, order_id, station_id, price, true, ISSUE_TIME)
}

fn insert_player_order(
    connection: &Connection,
    order_id: u64,
    station_id: u64,
    price: f64,
    bid: bool,
    issued_at: &str,
) -> Result<()> {
    connection.execute(
        "INSERT INTO market_orders (
           order_id, owner_id, station_id, solar_system_id, constellation_id, region_id,
           type_id, price, vol_entered, vol_remaining, bid, range_value, min_volume,
           state, source, issued_at, updated_at
         ) VALUES (?1, 99, ?2, 2, 4, 1, 34, ?3, 100, 100, ?4, -1, 1,
                   'open', 'player', ?5, ?5)",
        params![order_id, station_id, price, bid, issued_at],
    )?;
    Ok(())
}

#[test]
fn mixed_buy_book_prioritizes_price_across_seed_and_player_orders() -> Result<()> {
    let connection = order_book_database()?;
    insert_seed_bid(&connection, 3, 11_723.87)?;
    insert_seed_bid(&connection, 5, 10_000.0)?;
    insert_player_bid(&connection, 42, 3, 13_400.0)?;
    insert_player_bid(&connection, 43, 3, 11_000.0)?;
    insert_player_bid(&connection, 44, 4, 12_000.0)?;

    let book = query_order_book_rows_with_connection(&connection, 1, 34)?;
    assert_eq!(
        book.buys.iter().map(|row| row.order_id).collect::<Vec<_>>(),
        vec![
            42,
            44,
            seed_buy_order_id(3, 34),
            43,
            seed_buy_order_id(5, 34)
        ],
        "neither source may take precedence over a better-priced bid",
    );
    assert_eq!(book.buys[0].source, "player");
    assert_eq!(book.buys[0].range_value, -1);
    assert_eq!(book.buys[0].min_volume, 1);
    assert_eq!(book.buys[0].vol_remaining, 100);
    assert!(book.sells.is_empty());
    Ok(())
}

#[test]
fn equal_issue_times_keep_deterministic_station_and_order_ties() -> Result<()> {
    let connection = order_book_database()?;
    insert_seed_bid(&connection, 3, 12.0)?;
    // Deliberately insert in a different order from the expected result.
    insert_player_bid(&connection, 45, 4, 12.0)?;
    insert_player_bid(&connection, 44, 3, 12.0)?;
    insert_player_bid(&connection, 42, 2, 12.0)?;
    insert_player_bid(&connection, 43, 3, 12.0)?;

    let book = query_order_book_rows_with_connection(&connection, 1, 34)?;
    assert_eq!(
        book.buys.iter().map(|row| row.order_id).collect::<Vec<_>>(),
        vec![42, 43, 44, seed_buy_order_id(3, 34), 45],
    );
    Ok(())
}

fn side_order_ids(connection: &Connection, bid: bool) -> Result<Vec<i64>> {
    let book = query_order_book_rows_with_connection(connection, 1, 34)?;
    let rows = if bid { book.buys } else { book.sells };
    Ok(rows.iter().map(|row| row.order_id).collect())
}

#[test]
fn equal_price_asks_and_bids_choose_age_before_station_or_order_id() -> Result<()> {
    for bid in [false, true] {
        for newer_station in [1, 9] {
            let connection = order_book_database()?;
            // Age must win despite a larger order ID and an equal/larger station.
            insert_player_order(&connection, 45, 9, 12.0, bid, ISSUE_TIME)?;
            insert_player_order(
                &connection,
                42,
                newer_station,
                12.0,
                bid,
                "2026-06-01T00:00:01Z",
            )?;
            assert_eq!(side_order_ids(&connection, bid)?, vec![45, 42]);
        }
    }
    Ok(())
}

#[test]
fn price_still_outranks_issue_time_on_both_sides() -> Result<()> {
    for bid in [false, true] {
        let connection = order_book_database()?;
        insert_player_order(
            &connection,
            45,
            9,
            if bid { 11.0 } else { 13.0 },
            bid,
            ISSUE_TIME,
        )?;
        insert_player_order(&connection, 42, 1, 12.0, bid, "2026-06-01T00:00:01Z")?;
        assert_eq!(side_order_ids(&connection, bid)?, vec![42, 45]);
    }
    Ok(())
}

#[test]
fn merged_seed_and_player_books_use_issue_time_on_both_sides() -> Result<()> {
    for bid in [false, true] {
        for seed_older in [false, true] {
            let connection = order_book_database()?;
            let later = "2026-06-01T00:00:01Z";
            let (seed_time, player_time) = if seed_older {
                (ISSUE_TIME, later)
            } else {
                (later, ISSUE_TIME)
            };
            let table = if bid { "seed_buy_orders" } else { "seed_stock" };
            connection.execute(
                &format!(
                    "INSERT INTO {table}
                (station_id,solar_system_id,constellation_id,region_id,type_id,
                 price,quantity,initial_quantity,updated_at)
                VALUES (9,2,4,1,34,12.0,100,100,?1)"
                ),
                params![seed_time],
            )?;
            insert_player_order(&connection, 42, 1, 12.0, bid, player_time)?;
            let seed_id = if bid {
                seed_buy_order_id(9, 34)
            } else {
                seed_sell_order_id(9, 34)
            };
            let expected = if seed_older {
                vec![seed_id, 42]
            } else {
                vec![42, seed_id]
            };
            assert_eq!(side_order_ids(&connection, bid)?, expected);
        }
    }
    Ok(())
}

#[test]
fn issue_time_is_chronological_with_offsets_and_optional_fractions() -> Result<()> {
    for bid in [false, true] {
        for (older, newer) in [
            ("2026-06-01T01:00:00+01:00", "2026-06-01T00:30:00Z"),
            ("2026-06-01T00:00:00Z", "2026-06-01T00:00:00.1Z"),
        ] {
            let connection = order_book_database()?;
            insert_player_order(&connection, 45, 9, 12.0, bid, older)?;
            insert_player_order(&connection, 42, 1, 12.0, bid, newer)?;
            assert_eq!(side_order_ids(&connection, bid)?, vec![45, 42]);
        }
    }
    Ok(())
}

#[test]
fn invalid_issue_times_follow_known_dates_with_deterministic_ties() -> Result<()> {
    for bid in [false, true] {
        let connection = order_book_database()?;
        insert_player_order(&connection, 45, 9, 12.0, bid, ISSUE_TIME)?;
        insert_player_order(&connection, 43, 2, 12.0, bid, "unknown")?;
        insert_player_order(&connection, 42, 1, 12.0, bid, "")?;
        assert_eq!(side_order_ids(&connection, bid)?, vec![45, 42, 43]);
    }
    Ok(())
}

#[test]
fn order_book_still_excludes_closed_empty_and_other_scope_orders() -> Result<()> {
    for bid in [false, true] {
        let connection = order_book_database()?;
        for id in 41..=45 {
            insert_player_order(&connection, id, 1, 12.0, bid, ISSUE_TIME)?;
        }
        connection.execute(
            "UPDATE market_orders SET state='cancelled' WHERE order_id=41",
            [],
        )?;
        connection.execute(
            "UPDATE market_orders SET vol_remaining=0 WHERE order_id=42",
            [],
        )?;
        connection.execute("UPDATE market_orders SET region_id=2 WHERE order_id=43", [])?;
        connection.execute("UPDATE market_orders SET type_id=35 WHERE order_id=44", [])?;
        assert_eq!(side_order_ids(&connection, bid)?, vec![45]);
    }
    Ok(())
}
