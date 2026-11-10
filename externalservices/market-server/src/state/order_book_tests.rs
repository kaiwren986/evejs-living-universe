use super::*;

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
        params![station_id, price, now_rfc3339()],
    )?;
    Ok(())
}

fn insert_player_bid(
    connection: &Connection,
    order_id: u64,
    station_id: u64,
    price: f64,
) -> Result<()> {
    connection.execute(
        "INSERT INTO market_orders (
           order_id, owner_id, station_id, solar_system_id, constellation_id, region_id,
           type_id, price, vol_entered, vol_remaining, bid, range_value, min_volume,
           state, source, issued_at, updated_at
         ) VALUES (?1, 99, ?2, 2, 4, 1, 34, ?3, 100, 100, 1, -1, 1,
                   'open', 'player', ?4, ?4)",
        params![order_id, station_id, price, now_rfc3339()],
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
fn mixed_buy_book_keeps_deterministic_station_and_order_ties() -> Result<()> {
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
