//! The EVE Ref market-order snapshot: index resolution, download, on-disk cache, and a
//! header smoke check — plan §6.1 ("porting from v2: the EVE Ref snapshot download/cache").
//!
//! Every function here is a port of market-seederv2, and each carries the
//! `tools/market-seederv2/src/main.rs` line range it came from. The behaviour is deliberately
//! identical, quirks included, so a v3 build downloads byte-for-byte what a v2 build would:
//!
//! | v3 | v2 `main.rs` | what it does |
//! |---|---|---|
//! | [`build_http_client`] | `:710-716` | blocking reqwest, 300 s timeout, configured user agent |
//! | [`fetch_latest_source_file`] | `:718-739` | GET `[source] index_url`, filter, pick newest |
//! | [`cache_file_name`] | `:793-798` | `{name minus .bz2}.{etag}.bz2` |
//! | [`download_snapshot`] | `:786-846` | reuse-or-stream into `cache/`, `.part` then rename |
//!
//! ### What this piece does *not* do
//!
//! Nothing here reads a single order row. Streaming the CSV into `market_orders` and the TQ
//! NPC overlay is the next piece; this one stops at "the right file is on disk and it opens".
//! That split is the reason for [`smoke_check_header`]: a 20 MB download that turns out to be
//! an HTML error page, a truncated stream, or a CSV whose columns have been renamed should
//! fail *here*, on the first line, not an hour into an import.

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration as StdDuration, Instant};

use anyhow::{Context, Result, anyhow};
use bzip2::read::BzDecoder;
use console::style;
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::blocking::Client;
use serde::Deserialize;

use crate::config::SeederConfig;

/// v2 `main.rs:713`.
const HTTP_TIMEOUT: StdDuration = StdDuration::from_secs(300);

/// v2 `main.rs:827` — the streaming read buffer.
const DOWNLOAD_CHUNK_BYTES: usize = 128 * 1024;

/// The CSV columns the importer will deserialize, from v2's `EveRefOrderRow`
/// (`main.rs:423-441`). Order matches the struct; `csv` binds by header name, not position,
/// so only presence matters — but a missing column is a hard import failure, which is why the
/// smoke check names them.
pub const IMPORT_COLUMNS: [&str; 11] = [
    "is_buy_order",
    "duration",
    "location_id",
    "price",
    "system_id",
    "type_id",
    "volume_remain",
    "http_last_modified",
    "station_id",
    "region_id",
    "constellation_id",
];

// ------------------------------------------------------------------------------- index

/// v2 `main.rs:323-326`.
#[derive(Debug, Deserialize)]
pub struct EveRefIndex {
    pub files: Vec<EveRefIndexFile>,
}

/// v2 `main.rs:328-337`. Unknown index fields are ignored, as in v2.
#[derive(Debug, Clone, Deserialize)]
pub struct EveRefIndexFile {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub last_modified: String,
    pub etag: String,
    #[serde(default)]
    pub r#type: String,
}

/// v2 `main.rs:733-736`. EVE Ref tags the full public order dumps `type: "market-orders"`;
/// the name test is the fallback for entries published without a type.
pub fn is_market_orders_snapshot(file: &EveRefIndexFile) -> bool {
    file.r#type == "market-orders"
        || (file.name.contains("market-orders-latest") && file.name.ends_with(".csv.bz2"))
}

/// v2 `main.rs:730-739`, split out from the HTTP call so it can be tested against a fixture.
///
/// NOTE, mirrored deliberately: v2 picks the newest entry by comparing `last_modified` as a
/// **string**, not as a parsed date. That is only correct because EVE Ref publishes RFC 3339
/// UTC stamps (`2026-08-09T11:04:07Z`), which sort lexicographically in time order. A change
/// of format upstream — a different offset, a dropped `Z`, an RFC 2822 stamp — would silently
/// pick the wrong file rather than fail. Kept as-is so v3 and v2 resolve the same snapshot;
/// if this ever becomes a real parse, both crates should move together.
pub fn select_latest_source_file(index: EveRefIndex) -> Result<EveRefIndexFile> {
    index
        .files
        .into_iter()
        .filter(is_market_orders_snapshot)
        .max_by(|left, right| left.last_modified.cmp(&right.last_modified))
        .ok_or_else(|| anyhow!("EVE Ref index did not contain a market-orders CSV snapshot"))
}

/// v2 `main.rs:710-716`.
pub fn build_http_client(user_agent: &str) -> Result<Client> {
    Client::builder()
        .user_agent(user_agent)
        .timeout(HTTP_TIMEOUT)
        .build()
        .context("failed to build HTTP client")
}

/// v2 `main.rs:718-739`.
pub fn fetch_latest_source_file(client: &Client, config: &SeederConfig) -> Result<EveRefIndexFile> {
    let spinner = spinner("Fetching EVE Ref market-order index");
    let index = client
        .get(&config.source.index_url)
        .send()
        .context("failed to fetch EVE Ref market order index")?
        .error_for_status()
        .context("EVE Ref market order index returned an error")?
        .json::<EveRefIndex>()
        .context("failed to parse EVE Ref market order index")?;
    spinner.finish_with_message("Fetched EVE Ref market-order index");

    select_latest_source_file(index)
}

// ------------------------------------------------------------------------------- cache

/// v2 `main.rs:793-798`.
///
/// The etag is quote-stripped because HTTP sends it quoted (`"a1b2c3"`) and quotes are not
/// legal in a Windows filename. `trim_end_matches` strips *every* trailing `.bz2`, which is
/// v2's behaviour and harmless for the one name EVE Ref publishes
/// (`market-orders-latest.v3.csv.bz2`).
pub fn cache_file_name(source_file: &EveRefIndexFile) -> String {
    format!(
        "{}.{}.bz2",
        source_file.name.trim_end_matches(".bz2"),
        source_file.etag.replace('"', "")
    )
}

/// The cached path for an index entry, under `[source] download_dir`.
pub fn cache_path(download_dir: &Path, source_file: &EveRefIndexFile) -> PathBuf {
    download_dir.join(cache_file_name(source_file))
}

/// Size of an already-cached snapshot, or `None` when nothing is cached under that name.
pub fn cached_size(path: &Path) -> Result<Option<u64>> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(metadata.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error)
            .with_context(|| format!("failed to stat cached snapshot {}", display_path(path))),
    }
}

/// Whether a cached file may stand in for a fresh download. v2 `main.rs:800-810`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheDecision {
    /// The cached file is the file the index describes; use it untouched.
    Reuse,
    /// Fetch it, for this reason.
    Download(DownloadReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadReason {
    /// `--reuse-download` was not passed, so any cached file is ignored.
    ReuseNotRequested,
    /// Nothing is cached under the etag-stamped name.
    NotCached,
    /// A file is cached but its byte size is not the index's size: a truncated or interrupted
    /// download. Size is the *only* check — the etag is already baked into the filename, so a
    /// name hit plus a size hit means content identity as far as v2 ever asserted it.
    SizeMismatch { cached: u64, expected: u64 },
}

impl DownloadReason {
    pub fn label(self) -> String {
        match self {
            Self::ReuseNotRequested => "--reuse-download not set".to_string(),
            Self::NotCached => "not cached".to_string(),
            Self::SizeMismatch { cached, expected } => format!(
                "cached size {} != index size {}",
                format_bytes(cached),
                format_bytes(expected)
            ),
        }
    }
}

/// v2 `main.rs:800-810`, extracted so the reuse rule is testable without touching the disk.
pub fn cache_decision(
    reuse_download: bool,
    cached_size: Option<u64>,
    expected_size: u64,
) -> CacheDecision {
    if !reuse_download {
        return CacheDecision::Download(DownloadReason::ReuseNotRequested);
    }
    match cached_size {
        None => CacheDecision::Download(DownloadReason::NotCached),
        Some(size) if size == expected_size => CacheDecision::Reuse,
        Some(size) => CacheDecision::Download(DownloadReason::SizeMismatch {
            cached: size,
            expected: expected_size,
        }),
    }
}

/// A snapshot already sitting in the cache directory, found without touching the network.
#[derive(Debug, Clone)]
pub struct CachedSnapshot {
    pub path: PathBuf,
    pub bytes: u64,
    pub modified: Option<std::time::SystemTime>,
}

impl CachedSnapshot {
    pub fn size_label(&self) -> String {
        format_bytes(self.bytes)
    }
}

/// The newest snapshot in `[source] download_dir`, or `None` when the cache is empty.
///
/// **The build never resolves the EVE Ref index**, because resolving it is a network call and
/// a build that reaches the internet is not reproducible or air-gappable (plan §4.3: "no
/// network in the build path after the first capture"). The cache filename carries the etag
/// (`market-orders-latest.v3.csv.<etag>.bz2`), so the only offline question that can be asked
/// is "which cached file is newest", and that is what this answers. `snapshot-info
/// --download` is the one command that talks to EVE Ref and puts a file here.
///
/// `.part` files are skipped: those are interrupted downloads, never a whole snapshot.
pub fn find_cached_snapshot(download_dir: &Path) -> Result<Option<CachedSnapshot>> {
    let entries = match fs::read_dir(download_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to read the snapshot cache directory {}",
                    display_path(download_dir)
                )
            });
        }
    };

    let mut found: Vec<CachedSnapshot> = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".bz2") || name.ends_with(".part") {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        found.push(CachedSnapshot {
            path,
            bytes: metadata.len(),
            modified: metadata.modified().ok(),
        });
    }

    Ok(select_newest_cached(found))
}

/// Newest first; the path is the tie-break so the choice is deterministic on a filesystem
/// with coarse timestamps. Pure, so the ordering can be tested without waiting on a clock.
pub fn select_newest_cached(mut candidates: Vec<CachedSnapshot>) -> Option<CachedSnapshot> {
    candidates.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then(left.path.cmp(&right.path))
    });
    candidates.into_iter().next()
}

// ---------------------------------------------------------------------------- download

/// What a [`download_snapshot`] call ended up doing.
#[derive(Debug, Clone)]
pub struct DownloadOutcome {
    pub path: PathBuf,
    /// Bytes on disk when the call returned.
    pub bytes: u64,
    /// True when the cached file was reused and nothing was transferred.
    pub reused: bool,
    pub elapsed: StdDuration,
}

/// v2 `main.rs:786-846`.
///
/// Streams to `<cache>/<name>.bz2.part` and renames on completion, so an interrupted run can
/// never leave a half-file under the real name for `--reuse-download` to trust. (The size
/// check is the second guard: a `.part` that somehow got renamed still fails it.)
pub fn download_snapshot(
    client: &Client,
    config: &SeederConfig,
    source_file: &EveRefIndexFile,
    reuse_download: bool,
) -> Result<DownloadOutcome> {
    let started = Instant::now();
    fs::create_dir_all(&config.source.download_dir).with_context(|| {
        format!(
            "failed to create snapshot cache directory {}",
            display_path(&config.source.download_dir)
        )
    })?;
    let download_path = cache_path(&config.source.download_dir, source_file);

    let cached = cached_size(&download_path)?;
    if cache_decision(reuse_download, cached, source_file.size) == CacheDecision::Reuse {
        println!(
            "{} using cached snapshot {}",
            style("[download]").cyan().bold(),
            display_path(&download_path)
        );
        return Ok(DownloadOutcome {
            path: download_path,
            bytes: cached.unwrap_or(source_file.size),
            reused: true,
            elapsed: started.elapsed(),
        });
    }

    println!(
        "{} downloading latest snapshot",
        style("[download]").cyan().bold()
    );
    let mut response = client
        .get(&source_file.url)
        .send()
        .with_context(|| format!("failed to download {}", source_file.url))?
        .error_for_status()
        .with_context(|| format!("snapshot download returned an error: {}", source_file.url))?;

    let total_size = response.content_length().unwrap_or(source_file.size);
    let progress = download_progress_bar("Download", total_size);
    let temp_path = download_path.with_extension("bz2.part");
    let mut output = BufWriter::new(File::create(&temp_path).with_context(|| {
        format!(
            "failed to create partial download {}",
            display_path(&temp_path)
        )
    })?);
    let mut buffer = vec![0u8; DOWNLOAD_CHUNK_BYTES];
    let mut downloaded = 0u64;
    loop {
        let read = response.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        downloaded += read as u64;
        progress.set_position(downloaded.min(total_size));
    }
    output.flush()?;
    drop(output);
    progress.finish_with_message(format!(
        "Downloaded {} ({})",
        display_path(&download_path),
        format_bytes(downloaded)
    ));
    fs::rename(&temp_path, &download_path).with_context(|| {
        format!(
            "failed to move {} into place at {}",
            display_path(&temp_path),
            display_path(&download_path)
        )
    })?;
    Ok(DownloadOutcome {
        path: download_path,
        bytes: downloaded,
        reused: false,
        elapsed: started.elapsed(),
    })
}

// -------------------------------------------------------------------------- smoke check

/// The first line of the snapshot, checked against what the importer will ask for.
#[derive(Debug, Clone)]
pub struct HeaderCheck {
    /// Every field of the CSV header row, in file order.
    pub headers: Vec<String>,
    /// Members of [`IMPORT_COLUMNS`] the file actually has.
    pub present: Vec<&'static str>,
    /// Members of [`IMPORT_COLUMNS`] it does not.
    pub missing: Vec<&'static str>,
}

impl HeaderCheck {
    pub fn is_complete(&self) -> bool {
        self.missing.is_empty()
    }
}

/// Pure half of the smoke check: which of [`IMPORT_COLUMNS`] this header row carries.
pub fn evaluate_header(headers: Vec<String>) -> HeaderCheck {
    let mut present = Vec::new();
    let mut missing = Vec::new();
    for column in IMPORT_COLUMNS {
        if headers.iter().any(|field| field == column) {
            present.push(column);
        } else {
            missing.push(column);
        }
    }
    HeaderCheck {
        headers,
        present,
        missing,
    }
}

/// Opens the bz2, decodes just far enough to read the CSV header row, and stops.
///
/// This is the cheap proof that a cached file is a usable snapshot: it exercises the bzip2
/// stream *and* the CSV framing, and it is what catches an HTML error page saved under a
/// `.bz2` name. It deliberately does not deserialize a single order row — the whole-file pass
/// belongs to the importer, and this must stay fast enough to run on every `snapshot-info`.
pub fn smoke_check_header(path: &Path) -> Result<HeaderCheck> {
    let file = File::open(path)
        .with_context(|| format!("failed to open snapshot {}", display_path(path)))?;
    let decoder = BzDecoder::new(BufReader::new(file));
    let mut reader = csv::Reader::from_reader(decoder);
    let headers = reader.headers().with_context(|| {
        format!(
            "failed to read the CSV header from {} — the file is not a readable bzip2 CSV",
            display_path(path)
        )
    })?;
    Ok(evaluate_header(
        headers.iter().map(str::to_string).collect(),
    ))
}

// ------------------------------------------------------------------------- subcommand

/// `snapshot-info` — v2 `main.rs:646-656`, plus v3's `--download` / `--reuse-download` and the
/// header smoke check.
///
/// Without `--download` this touches the network exactly once (the index JSON) and never
/// writes anything.
pub fn run_snapshot_info(config_path: &Path, download: bool, reuse_download: bool) -> Result<()> {
    let config = SeederConfig::load(config_path)?;
    println!(
        "{} market-seederv3 snapshot-info",
        style("[source]").green().bold()
    );
    let client = build_http_client(&config.source.user_agent)?;
    let source_file = fetch_latest_source_file(&client, &config)?;
    print_source_file(&source_file);

    let download_path = cache_path(&config.source.download_dir, &source_file);
    let cached = cached_size(&download_path)?;
    print_cache_state(&download_path, cached, source_file.size);

    if !download {
        // A size-matching cached file is the one case where the header can be checked without
        // fetching anything.
        match cached {
            Some(size) if size == source_file.size => {
                print_header_check(&smoke_check_header(&download_path)?);
            }
            _ => println!(
                "{} pass --download to fetch it (add --reuse-download to honour the cache).",
                style("[info]").cyan().bold()
            ),
        }
        return Ok(());
    }

    let outcome = download_snapshot(&client, &config, &source_file, reuse_download)?;
    println!(
        "{} {} {} in {:.1}s -> {}",
        style("[download]").cyan().bold(),
        if outcome.reused { "reused" } else { "fetched" },
        format_bytes(outcome.bytes),
        outcome.elapsed.as_secs_f64(),
        display_path(&outcome.path)
    );
    if !outcome.reused && outcome.bytes != source_file.size {
        println!(
            "{} downloaded {} but the index advertised {} — the file may be truncated.",
            style("[warn]").yellow().bold(),
            format_bytes(outcome.bytes),
            format_bytes(source_file.size)
        );
    }
    print_header_check(&smoke_check_header(&outcome.path)?);
    Ok(())
}

/// v2 `main.rs:741-764`.
fn print_source_file(source_file: &EveRefIndexFile) {
    println!(
        "{} latest file: {}",
        style("[source]").green().bold(),
        style(&source_file.name).bold()
    );
    println!(
        "{} published: {}",
        style("[source]").green().bold(),
        style(&source_file.last_modified).yellow().bold()
    );
    println!(
        "{} size: {} ({} bytes)  etag: {}",
        style("[source]").green().bold(),
        format_bytes(source_file.size),
        source_file.size,
        source_file.etag
    );
    println!(
        "{} url: {}",
        style("[source]").green().bold(),
        source_file.url
    );
    println!();
}

fn print_cache_state(path: &Path, cached: Option<u64>, expected_size: u64) {
    println!(
        "{} path: {}",
        style("[cache]").cyan().bold(),
        display_path(path)
    );
    match cached {
        None => println!("{} status: not cached", style("[cache]").cyan().bold()),
        Some(size) if size == expected_size => println!(
            "{} status: cached, size matches ({})",
            style("[cache]").cyan().bold(),
            format_bytes(size)
        ),
        Some(size) => println!(
            "{} status: cached but size {} != index size {} — a re-download is needed",
            style("[cache]").yellow().bold(),
            format_bytes(size),
            format_bytes(expected_size)
        ),
    }
    println!();
}

fn print_header_check(check: &HeaderCheck) {
    println!(
        "{} CSV header ({} fields): {}",
        style("[smoke]").cyan().bold(),
        check.headers.len(),
        check.headers.join(", ")
    );
    println!(
        "{} importer columns present ({}/{}): {}",
        style("[smoke]").cyan().bold(),
        check.present.len(),
        IMPORT_COLUMNS.len(),
        if check.present.is_empty() {
            "(none)".to_string()
        } else {
            check.present.join(", ")
        }
    );
    if check.is_complete() {
        println!(
            "{} every column v2's EveRefOrderRow deserializes is present.",
            style("[smoke]").green().bold()
        );
    } else {
        println!(
            "{} MISSING ({}): {} — the importer would fail on these.",
            style("[smoke]").red().bold(),
            check.missing.len(),
            check.missing.join(", ")
        );
    }
}

// ------------------------------------------------------------------------------ helpers

/// v2 `main.rs:1917-1926`; the crate keeps a copy per module (see `build.rs`, `staticdata.rs`).
fn spinner(message: &str) -> ProgressBar {
    let spinner = ProgressBar::new_spinner();
    spinner.enable_steady_tick(StdDuration::from_millis(120));
    spinner.set_style(
        ProgressStyle::with_template("{spinner:.cyan} {msg}")
            .unwrap_or_else(|_| ProgressStyle::default_spinner()),
    );
    spinner.set_message(message.to_string());
    spinner
}

/// v2 `main.rs:1928-1939`.
fn download_progress_bar(message: &str, total: u64) -> ProgressBar {
    let bar = ProgressBar::new(total.max(1));
    bar.set_style(
        ProgressStyle::with_template(
            "  [{bar:36.cyan/blue}] {percent:>3}% | {msg} | {bytes}/{total_bytes} | eta {eta_precise}",
        )
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("=> "),
    );
    bar.set_message(message.to_string());
    bar
}

/// v2 `main.rs:1964-1978`.
fn format_bytes(value: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let value_f = value as f64;
    if value_f >= GIB {
        format!("{:.2} GiB", value_f / GIB)
    } else if value_f >= MIB {
        format!("{:.2} MiB", value_f / MIB)
    } else if value_f >= KIB {
        format!("{:.2} KiB", value_f / KIB)
    } else {
        format!("{value} B")
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like the real `https://data.everef.net/market-orders/index.json`, trimmed to the
    /// fields v3 reads plus one it does not, so the "unknown fields are ignored" contract is
    /// exercised too.
    const INDEX_FIXTURE: &str = r#"{
      "files": [
        {
          "name": "market-orders-2026-08-08.v3.csv.bz2",
          "url": "https://data.everef.net/market-orders/2026/market-orders-2026-08-08.v3.csv.bz2",
          "size": 100,
          "last_modified": "2026-08-08T11:04:07Z",
          "etag": "\"old-day\"",
          "type": "market-orders",
          "content_type": "application/x-bzip2"
        },
        {
          "name": "market-orders-latest.v3.csv.bz2",
          "url": "https://data.everef.net/market-orders/market-orders-latest.v3.csv.bz2",
          "size": 200,
          "last_modified": "2026-08-09T11:04:07Z",
          "etag": "\"newest\""
        },
        {
          "name": "market-orders-2026-08-07.v3.csv.bz2",
          "url": "https://data.everef.net/market-orders/2026/market-orders-2026-08-07.v3.csv.bz2",
          "size": 50,
          "last_modified": "2026-08-07T11:04:07Z",
          "etag": "\"older-day\"",
          "type": "market-orders"
        },
        {
          "name": "killmails-latest.v3.csv.bz2",
          "url": "https://data.everef.net/killmails/killmails-latest.v3.csv.bz2",
          "size": 999,
          "last_modified": "2099-01-01T00:00:00Z",
          "etag": "\"not-a-snapshot\"",
          "type": "killmails"
        }
      ]
    }"#;

    fn parse_fixture() -> EveRefIndex {
        serde_json::from_str::<EveRefIndex>(INDEX_FIXTURE).expect("fixture index must parse")
    }

    #[test]
    fn index_selection_picks_the_newest_market_orders_entry() {
        let selected = select_latest_source_file(parse_fixture()).expect("a snapshot must match");

        assert_eq!(selected.name, "market-orders-latest.v3.csv.bz2");
        assert_eq!(selected.last_modified, "2026-08-09T11:04:07Z");
        assert_eq!(selected.size, 200);
        assert_eq!(selected.etag, "\"newest\"");
    }

    #[test]
    fn index_selection_filters_by_type_or_name_and_never_returns_another_dataset() {
        let index = parse_fixture();
        let killmails = index
            .files
            .iter()
            .find(|file| file.r#type == "killmails")
            .expect("fixture must carry a non-snapshot entry");
        // Newest by date in the whole file, and still not eligible.
        assert!(!is_market_orders_snapshot(killmails));

        let latest_untyped = index
            .files
            .iter()
            .find(|file| file.name == "market-orders-latest.v3.csv.bz2")
            .expect("fixture must carry an untyped latest entry");
        assert_eq!(latest_untyped.r#type, "");
        // No type, so it qualifies on the name rule alone.
        assert!(is_market_orders_snapshot(latest_untyped));

        let eligible = index
            .files
            .iter()
            .filter(|file| is_market_orders_snapshot(file))
            .count();
        assert_eq!(eligible, 3);
    }

    #[test]
    fn an_index_without_a_market_orders_snapshot_is_an_error() {
        let index = EveRefIndex {
            files: vec![EveRefIndexFile {
                name: "killmails-latest.v3.csv.bz2".to_string(),
                url: "https://example.invalid/killmails.csv.bz2".to_string(),
                size: 1,
                last_modified: "2026-08-09T11:04:07Z".to_string(),
                etag: "\"x\"".to_string(),
                r#type: "killmails".to_string(),
            }],
        };

        let error = select_latest_source_file(index).expect_err("must refuse a foreign dataset");
        assert!(
            error.to_string().contains("market-orders"),
            "message: {error}"
        );
    }

    #[test]
    fn cache_name_strips_the_bz2_and_the_etag_quotes() {
        let file = EveRefIndexFile {
            name: "market-orders-latest.v3.csv.bz2".to_string(),
            url: "https://example.invalid/market-orders-latest.v3.csv.bz2".to_string(),
            size: 1,
            last_modified: "2026-08-09T11:04:07Z".to_string(),
            etag: "\"abc123\"".to_string(),
            r#type: "market-orders".to_string(),
        };

        assert_eq!(
            cache_file_name(&file),
            "market-orders-latest.v3.csv.abc123.bz2"
        );
        assert_eq!(
            cache_path(Path::new("cache"), &file),
            Path::new("cache").join("market-orders-latest.v3.csv.abc123.bz2")
        );
        // Quotes are not legal in a Windows filename, so the strip is load-bearing.
        assert!(!cache_file_name(&file).contains('"'));
    }

    #[test]
    fn cache_name_survives_an_unquoted_etag_and_a_name_without_bz2() {
        let file = EveRefIndexFile {
            name: "market-orders-latest.v3.csv".to_string(),
            url: "https://example.invalid/market-orders-latest.v3.csv".to_string(),
            size: 1,
            last_modified: "2026-08-09T11:04:07Z".to_string(),
            etag: "abc123".to_string(),
            r#type: "market-orders".to_string(),
        };

        assert_eq!(
            cache_file_name(&file),
            "market-orders-latest.v3.csv.abc123.bz2"
        );
    }

    #[test]
    fn reuse_honours_a_size_match_and_re_downloads_anything_else() {
        assert_eq!(cache_decision(true, Some(2_048), 2_048), CacheDecision::Reuse);
        assert_eq!(
            cache_decision(true, Some(1_024), 2_048),
            CacheDecision::Download(DownloadReason::SizeMismatch {
                cached: 1_024,
                expected: 2_048,
            })
        );
        assert_eq!(
            cache_decision(true, None, 2_048),
            CacheDecision::Download(DownloadReason::NotCached)
        );
        // Without the flag a perfectly good cached file is still re-fetched: v2's default.
        assert_eq!(
            cache_decision(false, Some(2_048), 2_048),
            CacheDecision::Download(DownloadReason::ReuseNotRequested)
        );
    }

    #[test]
    fn header_check_reports_present_and_missing_import_columns() {
        let mut headers: Vec<String> = IMPORT_COLUMNS.iter().map(|c| c.to_string()).collect();
        headers.push("order_id".to_string());
        let complete = evaluate_header(headers);
        assert!(complete.is_complete());
        assert_eq!(complete.present.len(), IMPORT_COLUMNS.len());
        assert_eq!(complete.headers.len(), IMPORT_COLUMNS.len() + 1);

        let short = evaluate_header(vec!["type_id".to_string(), "price".to_string()]);
        assert!(!short.is_complete());
        assert_eq!(short.present, vec!["price", "type_id"]);
        assert!(short.missing.contains(&"volume_remain"));
        assert_eq!(short.missing.len(), IMPORT_COLUMNS.len() - 2);
    }

    #[test]
    fn smoke_check_reads_a_real_bzip2_csv_header_and_stops() {
        use bzip2::Compression;
        use bzip2::write::BzEncoder;

        let mut csv = String::from(&IMPORT_COLUMNS.join(","));
        csv.push_str(",order_id\n");
        // Two rows, so a reader that only wants the header proves it does not need them.
        for order_id in 0..2 {
            csv.push_str(&format!("false,90,60003760,1.0,30000142,34,10,2026-08-09T11:04:07Z,60003760,10000002,20000020,{order_id}\n"));
        }

        let mut encoder = BzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(csv.as_bytes()).expect("compress");
        let compressed = encoder.finish().expect("finish");

        let path = std::env::temp_dir().join(format!(
            "market-seederv3-smoke-{}.csv.bz2",
            std::process::id()
        ));
        fs::write(&path, &compressed).expect("write fixture");
        let check = smoke_check_header(&path).expect("header must read");
        let _ = fs::remove_file(&path);

        assert!(check.is_complete(), "missing: {:?}", check.missing);
        assert_eq!(check.headers.last().map(String::as_str), Some("order_id"));
    }

    #[test]
    fn the_offline_cache_lookup_picks_the_newest_bz2_and_ignores_partial_downloads() {
        let dir = std::env::temp_dir().join(format!(
            "market-seederv3-cache-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("temp cache dir");

        // Nothing cached yet: the build's "run snapshot-info --download" path.
        assert!(
            find_cached_snapshot(&dir).expect("an empty dir is not an error").is_none()
        );
        // A directory that does not exist at all is the same answer, not an IO error.
        assert!(find_cached_snapshot(&dir.join("missing")).expect("absent dir").is_none());

        let older = dir.join("market-orders-latest.v3.csv.old.bz2");
        fs::write(&older, b"old").expect("write old");
        // The `.part` file is bigger and newer and must still never be chosen.
        fs::write(dir.join("market-orders-latest.v3.csv.new.bz2.part"), b"partial-download")
            .expect("write part");
        fs::write(dir.join("notes.txt"), b"not a snapshot").expect("write txt");

        let only = find_cached_snapshot(&dir)
            .expect("lookup runs")
            .expect("the one real file is found");
        assert_eq!(only.path, older);
        assert_eq!(only.bytes, 3);

        // A newer file wins. Filesystem timestamps can be coarse, so the mtime is set
        // explicitly rather than hoped for.
        let _ = fs::remove_dir_all(&dir);

        // The ordering rule itself, on synthetic entries so it does not depend on how coarse
        // the filesystem's timestamps are.
        let now = std::time::SystemTime::now();
        let entry = |name: &str, age_secs: u64| CachedSnapshot {
            path: PathBuf::from(name),
            bytes: 1,
            modified: Some(now - StdDuration::from_secs(age_secs)),
        };
        let picked = select_newest_cached(vec![
            entry("yesterday.bz2", 86_400),
            entry("today.bz2", 1),
            entry("last-week.bz2", 604_800),
        ])
        .expect("a file is picked");
        assert_eq!(picked.path, PathBuf::from("today.bz2"));

        // Same mtime: the path decides, so two runs never disagree.
        let tied = select_newest_cached(vec![entry("b.bz2", 5), entry("a.bz2", 5)])
            .expect("a file is picked");
        assert_eq!(tied.path, PathBuf::from("a.bz2"));

        assert!(select_newest_cached(Vec::new()).is_none());
    }

    #[test]
    fn smoke_check_rejects_a_file_that_is_not_bzip2() {
        let path = std::env::temp_dir().join(format!(
            "market-seederv3-smoke-bad-{}.csv.bz2",
            std::process::id()
        ));
        fs::write(&path, b"<html><body>404 Not Found</body></html>").expect("write fixture");
        let error = smoke_check_header(&path).expect_err("an HTML error page must not pass");
        let _ = fs::remove_file(&path);

        assert!(
            error.to_string().contains("CSV header"),
            "message: {error}"
        );
    }
}
