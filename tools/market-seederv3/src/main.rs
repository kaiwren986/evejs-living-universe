//! Public EveJS market-seederv3 — the Jita index seeder.
//!
//! Design: `doc/JITA_INDEX_SEED_PLAN.md`. This binary is being built in pieces; today it
//! carries the config, the static-data loader, a `doctor` report, the bucket classifier
//! (`classify`), the bottom-up cost map (`cost`), the price manifest plus its ESI capture
//! (`manifest`, `refresh-prices`), the SQLite build (`build`), the cross-bucket pump
//! audit (`audit`, §8.3 + §8.6 — the one subcommand with a non-zero exit code, so it can gate
//! a build), the EVE Ref snapshot download/cache (`snapshot`, `snapshot-info`), the TQ NPC
//! catalog overlay that consumes it (`overlay`, plan §2.3) and the synthetic price charts
//! (`history`, plan piece 12).
//!
//! A `build` therefore writes two seed passes over one database — the NPC overlay at TQ's own
//! stations, prices and volumes, then the Jita 4-4 index + junk seed on top of it — and then
//! `[history] days` of `price_history` drawn around the finished book's best ask, so the
//! client's market charts are not empty. Still missing: the docker rebuild wiring.

// Still scaffolding: SDE record fields (item mass and volume, blueprint names and limits,
// invention probabilities) are parsed but not read until the snapshot price harvest lands.
#![allow(dead_code)]

mod audit;
mod build;
mod classify;
mod config;
mod cost;
mod history;
mod manifest;
mod overlay;
mod seedplan;
mod snapshot;
mod staticdata;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use console::style;

use crate::classify::{Classification, EXCLUDED_CATEGORY_IDS};
use crate::config::{PricingModel, SeederConfig};
use crate::cost::{
    CapturedLeafPrices, CostInputs, CostMap, CostReport, FloorAsk, OverridePrices,
    REPROCESSING_FLOOR_MAX_PASSES, apply_pricing_rules,
};
use crate::manifest::{
    CaptureBatch, CapturePolicy, ForceContext, ForceSpec, LocalPrice, MergeInput, PriceManifest,
    PriceSource, RetainedCapture, SnapshotCaptureStats, collect_esi_capture,
    collect_snapshot_capture, combine_captures, cost_model_key, fetch_esi_body,
    local_prices_from_report, now_timestamp, parse_esi_price_rows, parse_force_refetch,
    read_esi_file, read_sde_build,
};
use crate::overlay::{ReferenceBook, ReferenceCaptureSource};
use crate::seedplan::{DropReason, NpcCatalog, SeedPlan};
use crate::staticdata::{ReprocessingStatic, StaticData, resolve_static_data_dir};

#[derive(Debug, Parser)]
#[command(
    author,
    version,
    about = "Builds the Public EveJS market database with a Jita 4-4 index seed over the TQ NPC overlay"
)]
struct Cli {
    #[arg(
        long,
        global = true,
        default_value = "config/market-seederv3.local.toml",
        help = "Path to the market-seederv3 TOML config"
    )]
    config: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Load the config and static data, then report what the seeder sees.
    Doctor,
    /// Classify the seed universe into buckets A/B/D (plan §2).
    Classify,
    /// Resolve the bottom-up unit cost of every seeded type (plan §3.3).
    Cost {
        /// Override `[index_seed] pricing` for this run.
        #[arg(long, value_enum)]
        pricing: Option<PricingArg>,
        /// How many needs-capture leaves to list, most blocking first.
        #[arg(long, default_value_t = 20)]
        top_leaves: usize,
    },
    /// Fetch missing price-manifest entries and recompute local ones (plan §4.3).
    RefreshPrices {
        /// Report what would change without writing the manifest.
        #[arg(long)]
        dry_run: bool,
        /// Refetch entries that captures would otherwise make permanent: a comma-separated
        /// list of type IDs and/or the bucket words a, b, d, leaves, all.
        #[arg(long, value_name = "SPEC")]
        force_refetch: Option<String>,
        /// Merge an ESI-shaped JSON array from disk instead of calling ESI. Reproducible
        /// builds, air-gapped machines, and replaying a captured payload.
        #[arg(long, value_name = "PATH")]
        from_file: Option<PathBuf>,
        /// How many still-blocking leaves to list, most blocking first.
        #[arg(long, default_value_t = 20)]
        top_leaves: usize,
    },
    /// Report the latest EVE Ref market-order snapshot, and optionally download and cache it.
    SnapshotInfo {
        /// Download the snapshot into `[source] download_dir` instead of only reporting it.
        #[arg(long)]
        download: bool,
        /// With `--download`, reuse an already-cached file when its size matches the index.
        #[arg(long)]
        reuse_download: bool,
    },
    /// Build the market database: the TQ NPC catalog overlay from the cached snapshot, then
    /// the Jita 4-4 index + junk seed over it. Never downloads — run `snapshot-info
    /// --download` first.
    Build {
        /// Replace an existing database without the interactive OVERWRITE prompt.
        #[arg(long)]
        yes: bool,
        /// Resolve the seed plan and print exactly what would be written, writing nothing.
        #[arg(long)]
        dry_run: bool,
        /// Skip the TQ NPC overlay and build the index + junk seed alone. The database then
        /// has no skillbooks, no T1 BPOs and no NPC trade-good buybacks anywhere.
        #[arg(long)]
        skip_overlay: bool,
    },
    /// Cross-bucket pump audit (plan §8.3): every reprocess, manufacture and compression
    /// loop that turns seed-bought goods back into more ISK than they cost. Exits 1 when any
    /// loop survives the 8% transaction tax at perfect refine, so it can gate a build.
    Audit {
        /// Refine recovery for the reprocess check, 0 < f <= 1. The default 1.0 is the worst
        /// case for the seed: a loop that does not pay at perfect refine is not exploitable
        /// at all. The build gate is always evaluated at 1.0 whatever this is set to.
        #[arg(long = "yield", value_name = "F", default_value_t = audit::PERFECT_YIELD)]
        refine_yield: f64,
        /// How many worst offenders to table, most profitable first.
        #[arg(long, default_value_t = 20)]
        top: usize,
        /// Exit 0 even when violations survive the tax. Exploratory runs only — never a
        /// real seed build.
        #[arg(long)]
        allow_violations: bool,
        /// Audit the index + junk seed alone, without re-importing the NPC overlay from the
        /// cached snapshot. Fast, but check 4 then only sees one station and checks 1-3 price
        /// every type as if the overlay did not exist.
        #[arg(long)]
        skip_overlay: bool,
    },
}

/// CLI spelling of [`PricingModel`], kept separate so the config enum stays a pure serde
/// type.
#[derive(Debug, Clone, Copy, ValueEnum)]
enum PricingArg {
    #[value(name = "recursive")]
    Recursive,
    #[value(name = "shallow_eiv")]
    ShallowEiv,
}

impl From<PricingArg> for PricingModel {
    fn from(value: PricingArg) -> Self {
        match value {
            PricingArg::Recursive => Self::Recursive,
            PricingArg::ShallowEiv => Self::ShallowEiv,
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Doctor => run_doctor(&cli.config),
        Command::Classify => run_classify(&cli.config),
        Command::Cost {
            pricing,
            top_leaves,
        } => run_cost(&cli.config, pricing.map(PricingModel::from), top_leaves),
        Command::SnapshotInfo {
            download,
            reuse_download,
        } => snapshot::run_snapshot_info(&cli.config, download, reuse_download),
        Command::RefreshPrices {
            dry_run,
            force_refetch,
            from_file,
            top_leaves,
        } => run_refresh_prices(
            &cli.config,
            dry_run,
            force_refetch.as_deref(),
            from_file.as_deref(),
            top_leaves,
        ),
        Command::Build {
            yes,
            dry_run,
            skip_overlay,
        } => build::run_build(&cli.config, yes, dry_run, skip_overlay),
        // The one subcommand with a meaningful exit code: a surviving pump must be able to
        // fail a build script, and that is not an error to print a backtrace for — the report
        // above it *is* the message.
        Command::Audit {
            refine_yield,
            top,
            allow_violations,
            skip_overlay,
        } => {
            let passed = audit::run_audit(
                &cli.config,
                refine_yield,
                top,
                allow_violations,
                skip_overlay,
            )?;
            if !passed {
                std::process::exit(1);
            }
            Ok(())
        }
    }
}

fn run_doctor(config_path: &Path) -> Result<()> {
    let config = SeederConfig::load(config_path)?;
    let (static_data_dir, static_data_dir_source) =
        resolve_static_data_dir(config.input.static_data_dir.as_deref());

    println!(
        "{} market-seederv3 doctor",
        style("[config]").cyan().bold()
    );
    print_path("config file", config_path);
    println!(
        "  {:<24}: {} (from {})",
        "static data dir",
        display_path(&static_data_dir),
        static_data_dir_source.label()
    );
    print_path("output database", &config.output.database_path);
    print_path("snapshot cache dir", &config.source.download_dir);
    print_path("price manifest", &config.price_manifest.path);
    println!("  {:<24}: {}", "snapshot index url", config.source.index_url);
    println!(
        "  {:<24}: {}",
        "esi prices url", config.price_manifest.esi_prices_url
    );
    println!(
        "  {:<24}: {} ({}), npc duration threshold {} days",
        "order filter",
        config.import.order_filter.mode_key(),
        config.import.order_filter.summary_label(),
        config.import.npc_order_duration_threshold_days
    );
    println!(
        "  {:<24}: station {}, sell x{}, buy x{}, quantity {}, pricing {}, floor {}",
        "index seed",
        config.index_seed.station_id,
        config.index_seed.sell_multiplier,
        config.index_seed.buy_multiplier,
        config.index_seed.quantity,
        config.index_seed.pricing.mode_key(),
        config.index_seed.price_floor
    );
    println!(
        "  {:<24}: {}, categories [{}], sell x{}, buy x{}, quantity {}",
        "junk seed",
        if config.junk_seed.enabled {
            "enabled"
        } else {
            "disabled"
        },
        config.junk_seed.categories.join(", "),
        config.junk_seed.sell_multiplier,
        config.junk_seed.buy_multiplier,
        config.junk_seed.quantity
    );
    println!(
        "  {:<24}: {} (synthetic price_history, drifted around each type's best seeded ask)",
        "price history",
        config.history.label()
    );

    println!();
    let static_data = StaticData::load(&static_data_dir)?;

    let marketable = static_data.marketable_item_types().count();
    let mut tech_two_plus = 0_usize;
    let mut meta_group_three_plus = 0_usize;
    for projection in static_data.dogma.values() {
        if projection
            .tech_level
            .is_some_and(|value| value.round() as i64 >= 2)
        {
            tech_two_plus += 1;
        }
        if projection.meta_group_id.is_some_and(|value| value >= 3) {
            meta_group_three_plus += 1;
        }
    }
    let mut marketable_tech_two_plus = 0_usize;
    let mut marketable_meta_group_three_plus = 0_usize;
    for item in static_data.marketable_item_types() {
        if static_data.tech_level(item.type_id) >= 2 {
            marketable_tech_two_plus += 1;
        }
        if static_data
            .meta_group_id(item.type_id)
            .is_some_and(|value| value >= 3)
        {
            marketable_meta_group_three_plus += 1;
        }
    }

    let manufacturing = static_data
        .blueprints
        .iter()
        .filter(|blueprint| blueprint.activities.manufacturing.is_some())
        .count();
    let reaction = static_data
        .blueprints
        .iter()
        .filter(|blueprint| blueprint.activities.reaction.is_some())
        .count();
    let invention = static_data
        .blueprints
        .iter()
        .filter(|blueprint| blueprint.activities.invention.is_some())
        .count();

    println!("{} static data", style("[counts]").cyan().bold());
    println!("  {:<24}: {}", "stations", static_data.stations.len());
    println!(
        "  {:<24}: {}",
        "solar systems",
        static_data.solar_systems.len()
    );
    println!("  {:<24}: {}", "item types", static_data.item_types.len());
    println!(
        "  {:<24}: {} (published with a market group)",
        "seed universe", marketable
    );
    println!(
        "  {:<24}: {} (manufacturing {}, reaction {}, invention {})",
        "blueprint definitions",
        static_data.blueprints.len(),
        manufacturing,
        reaction,
        invention
    );
    println!("  {:<24}: {}", "dogma entries", static_data.dogma.len());
    println!(
        "  {:<24}: {} ({} in the seed universe)",
        "techLevel >= 2", tech_two_plus, marketable_tech_two_plus
    );
    println!(
        "  {:<24}: {} ({} in the seed universe)",
        "metaGroup >= 3", meta_group_three_plus, marketable_meta_group_three_plus
    );

    println!();
    match static_data.station(config.index_seed.station_id) {
        Some(station) => println!(
            "{} index seed station {} resolves to {} ({})",
            style("[ok]").green().bold(),
            station.station_id,
            station.station_name,
            station.region_name
        ),
        None => println!(
            "{} index seed station {} is not present in {}",
            style("[warn]").yellow().bold(),
            config.index_seed.station_id,
            display_path(&static_data_dir.join("stations").join("data.json"))
        ),
    }

    Ok(())
}

/// `classify` — the bucket report from plan §2, and the regression surface for the two
/// classification traps (reaction products, the 714-item faction leak).
fn run_classify(config_path: &Path) -> Result<()> {
    let config = SeederConfig::load(config_path)?;
    let (static_data_dir, static_data_dir_source) =
        resolve_static_data_dir(config.input.static_data_dir.as_deref());

    println!("{} market-seederv3 classify", style("[config]").cyan().bold());
    print_path("config file", config_path);
    println!(
        "  {:<24}: {} (from {})",
        "static data dir",
        display_path(&static_data_dir),
        static_data_dir_source.label()
    );

    println!();
    let static_data = StaticData::load(&static_data_dir)?;
    let classification = Classification::compute(&static_data, &config.junk_seed)?;
    let funnel = classification.funnel;

    println!();
    println!(
        "{} {} published item types carry a market group",
        style("[universe]").cyan().bold(),
        classification.universe_size
    );
    println!(
        "  excluded categories: {}",
        EXCLUDED_CATEGORY_IDS
            .iter()
            .map(|(id, label)| format!("{id} {label}"))
            .collect::<Vec<_>>()
            .join(", ")
    );

    println!();
    println!(
        "{} bucket A - manufacturable T1, one rule at a time",
        style("[funnel]").cyan().bold()
    );
    print_funnel_row("seed universe", funnel.universe, None);
    print_funnel_row(
        "manufacturable",
        funnel.manufacturable,
        Some(funnel.removed_as_not_manufacturable()),
    );
    print_funnel_row(
        "- excluded categories",
        funnel.after_category_exclusions,
        Some(funnel.removed_by_category_exclusions()),
    );
    print_funnel_row(
        "- invention lineage",
        funnel.after_invention_lineage,
        Some(funnel.removed_by_invention_lineage()),
    );
    print_funnel_row(
        "- techLevel >= 2",
        funnel.after_tech_level,
        Some(funnel.removed_by_tech_level()),
    );
    print_funnel_row(
        "- metaGroup >= 3",
        funnel.after_meta_group,
        Some(funnel.removed_by_meta_group()),
    );
    print_funnel_row("= bucket A", classification.bucket_a.len(), None);
    println!(
        "  note: {} universe types carry metaGroup >= 3 before any other rule; the {} above",
        funnel.universe_meta_group_three_plus,
        funnel.removed_by_meta_group()
    );
    println!(
        "        is what the rule removes in place, after category, lineage and tech level."
    );

    println!();
    println!("{} sizes", style("[buckets]").cyan().bold());
    println!(
        "  {:<34}: {}",
        "A manufacturable T1",
        classification.bucket_a.len()
    );
    println!(
        "  {:<34}: {}",
        "B ores / minerals / materials",
        classification.bucket_b.len()
    );
    println!(
        "  {:<34}: {} (manufacturable materials; priced from A's blueprint)",
        "A and B (overlap)",
        classification.overlap_ab().len()
    );
    println!(
        "  {:<34}: {} (the index seed set)",
        "A or B (union)",
        classification.union_ab().len()
    );
    println!(
        "  {:<34}: {} ({})",
        "D junk candidates",
        classification.bucket_d.len(),
        if classification.junk_enabled {
            "junk seed enabled"
        } else {
            "junk seed DISABLED - not seeded"
        }
    );
    for category in &classification.junk_categories {
        println!(
            "    {:<32}: {}",
            format!("{} (category {})", category.config_name, category.category_id),
            classification
                .junk_counts_by_category
                .get(&category.category_id)
                .copied()
                .unwrap_or(0)
        );
    }
    println!(
        "  {:<34}: {} (A or B or D, each type counted once)",
        "seeded types total",
        classification.seeded_types().len()
    );
    println!(
        "  {:<34}: {}",
        "  composition",
        classification
            .seeded_composition()
            .iter()
            .map(|(label, count)| format!("{label} {count}"))
            .collect::<Vec<_>>()
            .join(", ")
    );

    println!();
    println!("{} bucket A by category", style("[breakdown]").cyan().bold());
    for (category_id, count, samples) in classification.bucket_a_by_category(&static_data) {
        println!(
            "  category {:<6} {:>5}  {}",
            category_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "-".to_string()),
            count,
            samples.join(" | ")
        );
    }

    println!();
    println!("{} index health", style("[producers]").cyan().bold());
    println!(
        "  {:<34}: {}",
        "product types with a producer",
        classification.producers.len()
    );
    println!(
        "  {:<34}: {}",
        "invention-lineage blueprints",
        classification.invention_lineage.len()
    );
    println!(
        "  {:<34}: {} (reaction products are found only by scanning activity products)",
        "reaction-produced types in A",
        classification.reaction_produced_in_a()
    );
    println!(
        "  {:<34}: {} (cost map must divide by per-run output)",
        "multi-output blueprints in A",
        classification.multi_output_in_a()
    );
    let (materials, leaves) = classification.bucket_a_material_surface();
    println!(
        "  {:<34}: {} ({} outside A or B - future cost-map leaves)",
        "distinct A input materials", materials, leaves
    );
    let collisions = classification.producers.collisions();
    println!(
        "  {:<34}: {} ({} disagree on per-run output or published flag)",
        "producer collisions",
        collisions.len(),
        collisions
            .iter()
            .filter(|collision| collision.is_material_disagreement())
            .count()
    );
    println!(
        "  {:<34}  tie-break: published blueprint wins; otherwise first in file order",
        ""
    );
    for collision in collisions {
        let name = static_data
            .item_type(collision.product_type_id)
            .map(|item| item.name.as_str())
            .unwrap_or("<unknown type>");
        let marker = if collision.is_material_disagreement() {
            style("!").yellow().bold().to_string()
        } else {
            " ".to_string()
        };
        println!(
            "  {} product {} {}: kept bp {} ({}, {}/run, published {}), dropped bp {} ({}, {}/run, published {})",
            marker,
            collision.product_type_id,
            name,
            collision.kept_blueprint_type_id,
            collision.kept_activity.label(),
            collision.kept_per_run,
            collision.kept_published,
            collision.dropped_blueprint_type_id,
            collision.dropped_activity.label(),
            collision.dropped_per_run,
            collision.dropped_published
        );
    }

    Ok(())
}

/// Plan §9's price anchors: the Venture EIV is the server's own parity fixture, and
/// Tungsten Carbide is the 10,000-per-run reaction the producer tie-break rescued.
const ANCHOR_VENTURE: u32 = 32_880;
const ANCHOR_TUNGSTEN_CARBIDE: u32 = 16_672;
/// Bucket order for the per-bucket histogram. Matches `BucketFlags::label`.
const BUCKET_LABELS: &[&str] = &["A", "A+B", "B", "D"];
/// Ship-rig groups all live in category 7 and are named "Rig <something>". Plan §3.2
/// singles them out as the EIV = 0 class: their inputs are salvage, which has no basePrice.
const MODULE_CATEGORY_ID: u32 = 7;

/// The two seed prices rule C floors against, built from the config exactly as the build
/// prices its rows: the `[index_seed]` multiplier pair for A∪B and the `[junk_seed]` pair for
/// bucket D (`build::plan_seed_rows` splits on the same predicate — a type outside A∪B is a
/// junk row).
///
/// Both `cost` and `refresh-prices` build it the same way, so the report and the manifest
/// cannot disagree about what the floor was computed against.
fn floor_ask<'a>(config: &SeederConfig, union_ab: &'a BTreeSet<u32>) -> FloorAsk<'a> {
    FloorAsk {
        index_sell_multiplier: config.index_seed.sell_multiplier,
        index_buy_multiplier: config.index_seed.buy_multiplier,
        junk_sell_multiplier: config.junk_seed.sell_multiplier,
        junk_buy_multiplier: config.junk_seed.buy_multiplier,
        index_types: union_ab,
        margin: config.index_seed.reprocessing_floor_margin,
    }
}

/// `cost` — resolve the bottom-up unit cost of every seeded type (plan §3.3) and report
/// where the prices came from, what is still missing, and how the model diverges from the
/// server's job-tax EIV.
fn run_cost(config_path: &Path, pricing_override: Option<PricingModel>, top_leaves: usize) -> Result<()> {
    let config = SeederConfig::load(config_path)?;
    let (static_data_dir, static_data_dir_source) =
        resolve_static_data_dir(config.input.static_data_dir.as_deref());
    let pricing = pricing_override.unwrap_or(config.index_seed.pricing);
    let leaf_source = config.index_seed.leaf_price_source;

    println!("{} market-seederv3 cost", style("[config]").cyan().bold());
    print_path("config file", config_path);
    println!(
        "  {:<24}: {} (from {})",
        "static data dir",
        display_path(&static_data_dir),
        static_data_dir_source.label()
    );
    println!(
        "  {:<24}: {}{}",
        "pricing model",
        pricing.mode_key(),
        if pricing_override.is_some() {
            " (--pricing override)"
        } else {
            " (from config)"
        }
    );
    println!(
        "  {:<24}: {} (plan §11: which rung a leaf tries first)",
        "leaf price source",
        leaf_source.key()
    );
    println!(
        "  {:<24}: sell x{}, buy x{}, floor {}",
        "index seed multipliers",
        config.index_seed.sell_multiplier,
        config.index_seed.buy_multiplier,
        config.index_seed.price_floor
    );

    // The manifest is optional here: `cost` is a report, and reading it with no captures is
    // exactly the "before the first capture" picture. `refresh-prices` is what creates it.
    let loaded_manifest = PriceManifest::load(&config.price_manifest.path)?;
    let policy = CapturePolicy::from_config(&config);
    let captures = loaded_manifest
        .as_ref()
        .map(|manifest| manifest.captured_leaf_prices(policy))
        .unwrap_or_default();
    println!(
        "  {:<24}: {} ({})",
        "price manifest",
        display_path(&config.price_manifest.path),
        match &loaded_manifest {
            Some(manifest) => format!(
                "{} entries, {} captures, sdeBuild {}",
                manifest.prices.len(),
                manifest.capture_count(),
                manifest
                    .sde_build
                    .map(|build| build.to_string())
                    .unwrap_or_else(|| "null".to_string())
            ),
            None => "absent — every price-less leaf blocks its tree".to_string(),
        }
    );

    println!();
    let static_data = StaticData::load(&static_data_dir)?;
    let reprocessing = ReprocessingStatic::load(&static_data_dir)?;
    let classification = Classification::compute(&static_data, &config.junk_seed)?;

    let no_twins = OverridePrices::new();
    let no_floors = OverridePrices::new();
    let natural = CostInputs {
        data: &static_data,
        producers: &classification.producers,
        invention_lineage: &classification.invention_lineage,
        captures: &captures,
        model: pricing,
        leaf_source,
        twins: &no_twins,
        floors: &no_floors,
    };
    let seeded = classification.seeded_types();
    let union_ab = classification.union_ab();
    // The same rules the refresh applies, so this report's anchors are the seeded prices and
    // not a pre-rule shadow of them.
    let seed_captures = if leaf_source.prefers_capture() {
        captures.clone()
    } else {
        captures
            .iter()
            .filter(|(type_id, _)| natural.base_price(*type_id) <= 0.0)
            .collect::<CapturedLeafPrices>()
    };
    let rules = apply_pricing_rules(
        natural,
        &reprocessing,
        &seeded,
        &seed_captures,
        floor_ask(&config, &union_ab),
        config.index_seed.derive_compressed_from_source,
        config.index_seed.floor_cost_at_reprocessing_value,
        REPROCESSING_FLOOR_MAX_PASSES,
    );
    println!(
        "  {:<24}: {}",
        "pricing rules",
        config.index_seed.pricing_rules().join(", ")
    );
    print_pricing_rule_report(&static_data, &config, &rules);
    let inputs = CostInputs {
        twins: &rules.twins,
        floors: &rules.floors,
        ..natural
    };
    let mut map = CostMap::new(inputs);
    let report = CostReport::build(&mut map, seeded.iter().copied());

    // ---------------------------------------------------------------- price sources
    println!();
    println!(
        "{} price source over the {} seeded types (A or B or D)",
        style("[sources]").cyan().bold(),
        report.outcomes.len()
    );
    let mut by_bucket: BTreeMap<&'static str, [usize; 4]> = BTreeMap::new();
    for (type_id, outcome) in &report.outcomes {
        let label = classification.flags(*type_id).label();
        let row = by_bucket.entry(label).or_insert([0; 4]);
        match outcome.source_label() {
            "cost-recursive" => row[0] += 1,
            "base-price" => row[1] += 1,
            "ccp-capture" => row[2] += 1,
            _ => row[3] += 1,
        }
    }
    println!(
        "  {:<8} {:>15} {:>12} {:>13} {:>15} {:>8}",
        "bucket", "cost-recursive", "base-price", "ccp-capture", "needs-capture", "total"
    );
    let mut totals = [0_usize; 4];
    for label in BUCKET_LABELS {
        let row = by_bucket.get(*label).copied().unwrap_or([0; 4]);
        for (index, value) in row.iter().enumerate() {
            totals[index] += value;
        }
        println!(
            "  {:<8} {:>15} {:>12} {:>13} {:>15} {:>8}",
            label,
            row[0],
            row[1],
            row[2],
            row[3],
            row[0] + row[1] + row[2] + row[3]
        );
    }
    println!(
        "  {:<8} {:>15} {:>12} {:>13} {:>15} {:>8}",
        "total",
        totals[0],
        totals[1],
        totals[2],
        totals[3],
        totals.iter().sum::<usize>()
    );
    println!(
        "  the D row is INFORMATIONAL ONLY: a bucket-D type is priced from its captured"
    );
    println!(
        "  market price and nothing else (§2.4/§3.3), so its local cost — cost-recursive or"
    );
    println!("  base-price alike — is never a seed price. See [junk] below.");

    // ---------------------------------------------------------------- needs-capture
    let blocked_union_ab = report
        .outcomes
        .iter()
        .filter(|(type_id, outcome)| !outcome.is_priced() && union_ab.contains(type_id))
        .count();
    let leaves_blocking_union_ab = report
        .outcomes
        .iter()
        .filter(|(type_id, _)| union_ab.contains(type_id))
        .flat_map(|(_, outcome)| outcome.missing_leaves().iter().copied())
        .collect::<BTreeSet<_>>();

    println!();
    println!(
        "{} unpriced leaves that must come from the CCP capture (plan §4.2)",
        style("[capture]").cyan().bold()
    );
    println!(
        "  {:<38}: {}",
        "distinct blocking leaves (all buckets)",
        report.blocked_by_leaf.len()
    );
    println!("  {:<38}: {}", "blocked seeded products", totals[3]);
    println!(
        "  {:<38}: {} (reconciled against plan §3.2 in [shallow] below)",
        "distinct leaves blocking A or B",
        leaves_blocking_union_ab.len()
    );
    println!(
        "  {:<38}: {} of {} (any still unpriced at build time are dropped and named — §4.1)",
        "blocked A or B products", blocked_union_ab, union_ab.len()
    );
    let leaves_in_seed_set = report
        .blocked_by_leaf
        .keys()
        .filter(|type_id| seeded.contains(type_id))
        .count();
    println!(
        "  {:<38}: {} (the rest are inputs that are never seeded themselves)",
        "blocking leaves that are seeded types", leaves_in_seed_set
    );
    let union_ab_leaves_inside = leaves_blocking_union_ab
        .iter()
        .filter(|type_id| union_ab.contains(type_id))
        .count();
    let union_ab_leaves_self_consuming = leaves_blocking_union_ab
        .iter()
        .filter(|type_id| {
            union_ab.contains(type_id) && inputs.producer_for_expansion(**type_id).is_some()
        })
        .count();
    println!(
        "  {:<38}: {} inside A or B, {} inputs outside it",
        "  of the A-or-B blockers",
        union_ab_leaves_inside,
        leaves_blocking_union_ab.len() - union_ab_leaves_inside
    );
    println!(
        "  {:<38}: {} are craftable types the cycle guard cut to a leaf (they consume",
        "  of those inside", union_ab_leaves_self_consuming
    );
    println!(
        "  {:<38}  themselves and carry no basePrice); the rest are the price-less leaf",
        ""
    );
    println!("  {:<38}  class plan §3.2 counts at 155.", "");
    if !report.blocked_by_leaf.is_empty() {
        println!(
            "  top {} leaves by blocked seeded products:",
            top_leaves.min(report.blocked_by_leaf.len())
        );
        for (type_id, blocked) in report.leaves_by_blast_radius().into_iter().take(top_leaves) {
            let item = static_data.item_type(type_id);
            println!(
                "    {:>7}  {:>5} blocked  {:<38} category {}",
                type_id,
                blocked,
                item.map(|item| item.name.as_str()).unwrap_or("<unknown type>"),
                item.and_then(|item| item.category_id)
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "-".to_string())
            );
        }
    }

    // ---------------------------------------------------------------- bucket D
    // §2.4/§3.3: `cost(type) := manifest.fetchedPrice(type)`. There is no ladder for D — a
    // candidate without a capture is not seeded, and the local cost above is never used.
    let seedability = classification.junk_seedability(|type_id| {
        loaded_manifest
            .as_ref()
            .is_some_and(|manifest| manifest.has_capture(type_id))
    });
    println!();
    println!(
        "{} bucket D is priced from captures only (plan §2.4)",
        style("[junk]").cyan().bold()
    );
    println!(
        "  {:<38}: {}",
        "candidates",
        classification.bucket_d.len()
    );
    if seedability.junk_disabled {
        println!("  [junk_seed] enabled = false, so none of them are seeded at all");
    } else {
        println!(
            "  {:<38}: {} (hold a ccp-* capture)",
            "seedable", seedability.seedable.len()
        );
        println!(
            "  {:<38}: {} (no capture — unseeded by design, never a basePrice fallback)",
            "dropped",
            seedability.dropped.len()
        );
        let would_have_fallen_back = seedability
            .dropped
            .iter()
            .filter(|type_id| {
                report
                    .outcomes
                    .get(type_id)
                    .is_some_and(|outcome| outcome.is_priced())
            })
            .count();
        println!(
            "  {:<38}: {} (the generic cost ladder would have priced these; §2.4 does not)",
            "  of which local cost could price", would_have_fallen_back
        );
    }

    // ---------------------------------------------------------------- distribution
    let priced = report.priced_sorted_by_cost();
    println!();
    println!(
        "{} resolved unit cost over {} priced types",
        style("[distribution]").cyan().bold(),
        priced.len()
    );
    if priced.is_empty() {
        println!("  nothing priced");
    } else {
        let median = priced[priced.len() / 2];
        for (label, (type_id, unit_cost)) in [
            ("min", priced[0]),
            ("median", median),
            ("max", priced[priced.len() - 1]),
        ] {
            println!(
                "  {:<8}: {:>22} ISK  {} ({})",
                label,
                isk(unit_cost),
                type_name(&static_data, type_id),
                type_id
            );
        }
        println!("  10 most expensive:");
        for (type_id, unit_cost) in priced.iter().rev().take(10) {
            println!(
                "    {:>22} ISK  {:>7}  {:<44} sell x{} = {} ISK",
                isk(*unit_cost),
                type_id,
                type_name(&static_data, *type_id),
                config.index_seed.sell_multiplier,
                isk(unit_cost * config.index_seed.sell_multiplier)
            );
        }
    }

    // ---------------------------------------------------------------- anchors
    println!();
    println!("{} plan §9 price anchors", style("[anchors]").cyan().bold());
    for type_id in [ANCHOR_VENTURE, ANCHOR_TUNGSTEN_CARBIDE] {
        print_anchor(&static_data, &classification, &mut map, &report, &config, type_id);
    }

    // ------------------------------------------------ plan §3.2 degradation table
    // Reproduces "Where the shallow formula degrades — measured on A∪B" from the plan, so
    // the recursive model's price-source split can be read against the numbers the plan
    // was written from (1,379 / 445 / 526 / 512 / 155).
    let mut clean_eiv = 0_usize;
    let mut undercounted_eiv = 0_usize;
    let mut zero_eiv = 0_usize;
    let mut leaf_priced = 0_usize;
    let mut leaf_unpriced = 0_usize;
    for type_id in &union_ab {
        let Some(producer) = inputs.producer_for_expansion(*type_id) else {
            if inputs.base_price(*type_id) > 0.0 {
                leaf_priced += 1;
            } else {
                leaf_unpriced += 1;
            }
            continue;
        };
        let usable = producer
            .materials
            .iter()
            .filter(|material| material.type_id != 0 && material.quantity > 0)
            .collect::<Vec<_>>();
        let priced_materials = usable
            .iter()
            .filter(|material| inputs.base_price(material.type_id) > 0.0)
            .count();
        if usable.is_empty() || priced_materials == 0 {
            zero_eiv += 1;
        } else if priced_materials == usable.len() {
            clean_eiv += 1;
        } else {
            undercounted_eiv += 1;
        }
    }
    println!();
    println!(
        "{} plan §3.2, measured over the {} A-or-B types (expected 1379 / 445 / 526 / 512 / 155)",
        style("[shallow]").cyan().bold(),
        union_ab.len()
    );
    println!("  {:<44}: {}", "clean EIV (all materials basePriced)", clean_eiv);
    println!("  {:<44}: {}", "EIV undercounted (some material at 0)", undercounted_eiv);
    println!("  {:<44}: {}", "EIV = 0 (no material carries a basePrice)", zero_eiv);
    println!("  {:<44}: {}", "not craftable, basePrice > 0", leaf_priced);
    println!("  {:<44}: {}", "not craftable, no basePrice", leaf_unpriced);
    println!(
        "  the recursive model prices {} of these; the gap against clean-EIV is products whose",
        report
            .outcomes
            .iter()
            .filter(|(type_id, outcome)| union_ab.contains(type_id) && outcome.is_priced())
            .count()
    );
    println!("  own materials are basePriced but whose deeper tree reaches an unpriced leaf.");

    // ---------------------------------------------------------------- server parity
    let mut producer_types = 0_usize;
    let mut producer_exact = 0_usize;
    let mut producer_unpriced = 0_usize;
    let mut producer_multi_run = 0_usize;
    let mut producer_deep_diff = 0_usize;
    let mut leaf_types = 0_usize;
    let mut leaf_exact = 0_usize;
    let mut parity_fallback_arm = 0_usize;
    for (type_id, outcome) in &report.outcomes {
        let (parity, used_fallback) = map.server_parity_eiv_detail(*type_id);
        let has_producer = classification.producers.get(*type_id).is_some();
        if used_fallback && has_producer {
            parity_fallback_arm += 1;
        }
        let exact = outcome.unit_cost().is_some_and(|cost| cost == parity);
        if has_producer {
            producer_types += 1;
            if exact {
                producer_exact += 1;
            } else if !outcome.is_priced() {
                producer_unpriced += 1;
            } else if classification
                .producers
                .get(*type_id)
                .is_some_and(|producer| producer.per_run > 1)
            {
                producer_multi_run += 1;
            } else {
                producer_deep_diff += 1;
            }
        } else {
            leaf_types += 1;
            if exact {
                leaf_exact += 1;
            }
        }
    }

    println!();
    println!(
        "{} unit cost vs server_parity_eiv (resolveBlueprintActivityPrice, industryPricing.js:136-178)",
        style("[parity]").cyan().bold()
    );
    println!(
        "  {:<38}: {}",
        "seeded types with a producer", producer_types
    );
    println!(
        "  {:<38}: {} (the clean-EIV class; plan §3.2 counts 1,379)",
        "  exact match", producer_exact
    );
    println!(
        "  {:<38}: {} (unpriced here, the server would tax a garbage EIV)",
        "  differ: needs capture", producer_unpriced
    );
    println!(
        "  {:<38}: {} (server does not divide by per-run output)",
        "  differ: multi-output blueprint", producer_multi_run
    );
    println!(
        "  {:<38}: {} (deep expansion changed the value)",
        "  differ: expanded materials", producer_deep_diff
    );
    println!(
        "  {:<38}: {} of which {} match trivially (both basePrice)",
        "seeded leaf types (no producer)", leaf_types, leaf_exact
    );
    println!(
        "  {:<38}: {} producer types (the one arm where this port and Node can disagree:",
        "zero-material-sum fallback fired", parity_fallback_arm
    );
    println!(
        "  {:<38}  Node falls back to the blueprint's basePrice, this port to the product's)",
        ""
    );

    // ---------------------------------------------------------------- health
    println!();
    println!("{} invariants", style("[health]").cyan().bold());
    let degenerate = report.degenerate_prices();
    if degenerate.is_empty() {
        println!(
            "  {} no seeded type resolved to 0, NaN or infinity",
            style("[ok]").green().bold()
        );
    } else {
        println!(
            "  {} {} seeded types resolved to a non-positive or non-finite cost:",
            style("[FAIL]").red().bold(),
            degenerate.len()
        );
        for (type_id, cost) in degenerate.iter().take(20) {
            println!(
                "    {:>7} {:<44} {}",
                type_id,
                type_name(&static_data, *type_id),
                cost
            );
        }
    }
    println!(
        "  {:<38}: {} (cut to a leaf, mirroring industryPricing.js:148-151)",
        "cycles hit during resolution",
        map.cycles().len()
    );
    for cycle in map.cycles().iter().take(10) {
        println!(
            "    re-entered {} ({}) via {:?}",
            cycle.type_id,
            type_name(&static_data, cycle.type_id),
            cycle.path
        );
    }
    if map.cycles().len() > 10 {
        println!("    … and {} more", map.cycles().len() - 10);
    }
    println!(
        "  {:<38}: {} (treated as 1 per run)",
        "producers with per-run output <= 0",
        map.nonpositive_per_run().len()
    );
    println!(
        "  {:<38}: {} (fell back to the leaf ladder){}",
        "producers with no usable materials",
        map.empty_material_sum().len(),
        if map.empty_material_sum().is_empty() {
            String::new()
        } else {
            format!(
                ": {}",
                map.empty_material_sum()
                    .iter()
                    .take(10)
                    .map(|type_id| format!("{} {}", type_id, type_name(&static_data, *type_id)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    );

    let rigs = seeded
        .iter()
        .copied()
        .filter(|type_id| is_ship_rig(&static_data, *type_id))
        .collect::<Vec<_>>();
    let rigs_priced = rigs
        .iter()
        .filter(|type_id| {
            report
                .outcomes
                .get(type_id)
                .is_some_and(|outcome| outcome.is_priced())
        })
        .count();
    let rigs_at_zero = rigs
        .iter()
        .filter(|type_id| {
            report
                .outcomes
                .get(type_id)
                .and_then(|outcome| outcome.unit_cost())
                .is_some_and(|cost| cost <= 0.0)
        })
        .count();
    println!(
        "  {:<38}: {} seeded, {} priced, {} needs-capture, {} priced at zero (plan §3.2's EIV=0 class)",
        "ship rigs (category 7, Rig * groups)",
        rigs.len(),
        rigs_priced,
        rigs.len() - rigs_priced,
        rigs_at_zero
    );

    Ok(())
}

/// `refresh-prices` — the price-manifest lifecycle from plan §4.3.
///
/// Recompute the local entries, fetch only the captures that are missing, never touch a
/// capture that already exists, and say precisely what changed.
fn run_refresh_prices(
    config_path: &Path,
    dry_run: bool,
    force_refetch: Option<&str>,
    from_file: Option<&Path>,
    top_leaves: usize,
) -> Result<()> {
    let config = SeederConfig::load(config_path)?;
    let (static_data_dir, static_data_dir_source) =
        resolve_static_data_dir(config.input.static_data_dir.as_deref());
    // Parsed before the 40 MB of static data is read: a typo in the spec should fail in
    // milliseconds, not after a minute of JSON.
    let force_spec = match force_refetch {
        Some(spec) => parse_force_refetch(spec)?,
        None => ForceSpec::default(),
    };
    let pricing = config.index_seed.pricing;
    let leaf_source = config.index_seed.leaf_price_source;
    let policy = CapturePolicy::from_config(&config);
    let pricing_rules = config.index_seed.pricing_rules();
    let cost_model = cost_model_key(pricing);
    let manifest_path = config.price_manifest.path.clone();
    let generated_at = now_timestamp();

    println!(
        "{} market-seederv3 refresh-prices{}",
        style("[config]").cyan().bold(),
        if dry_run { "  (dry run)" } else { "" }
    );
    print_path("config file", config_path);
    println!(
        "  {:<24}: {} (from {})",
        "static data dir",
        display_path(&static_data_dir),
        static_data_dir_source.label()
    );
    print_path("price manifest", &manifest_path);
    println!("  {:<24}: {} ({})", "cost model", cost_model, pricing.mode_key());
    println!(
        "  {:<24}: {} (plan §11: which rung a leaf tries first)",
        "leaf price source",
        leaf_source.key()
    );
    println!(
        "  {:<24}: {}",
        "pricing rules",
        pricing_rules.join(", ")
    );
    println!(
        "  {:<24}: {} (plan §4.2 source 1, runs first — decision 6)",
        "capture source 1",
        if config.price_manifest.capture_missing_from_snapshot {
            format!(
                "snapshot Jita split, system {}",
                config.price_manifest.reference_solar_system_id
            )
        } else {
            "none ([price_manifest] capture_missing_from_snapshot = false)".to_string()
        }
    );
    match from_file {
        Some(path) => println!(
            "  {:<24}: {} (--from-file; no network)",
            "capture source 2",
            display_path(path)
        ),
        None if config.price_manifest.capture_missing_from_esi => println!(
            "  {:<24}: {} (gap-filler)",
            "capture source 2", config.price_manifest.esi_prices_url
        ),
        None => println!(
            "  {:<24}: none ([price_manifest] capture_missing_from_esi = false)",
            "capture source 2"
        ),
    }
    println!(
        "  {:<24}: {}",
        "force-refetch",
        match force_refetch {
            Some(spec) => spec.to_string(),
            None => "none (captures are permanent)".to_string(),
        }
    );

    println!();
    let static_data = StaticData::load(&static_data_dir)?;
    let classification = Classification::compute(&static_data, &config.junk_seed)?;
    let union_ab = classification.union_ab();

    // ------------------------------------------------------------------- manifest header
    let sde = read_sde_build(&static_data_dir);
    let loaded = PriceManifest::load(&manifest_path)?;
    let existed = loaded.is_some();
    let existing = loaded
        .unwrap_or_else(|| PriceManifest::empty(sde.build, cost_model, &generated_at));

    println!();
    println!("{} state on disk", style("[manifest]").cyan().bold());
    println!(
        "  {:<38}: {}",
        "file",
        if existed {
            format!(
                "loaded, {} entries ({} captures), generatedAt {}",
                existing.prices.len(),
                existing.capture_count(),
                existing.generated_at
            )
        } else {
            "absent — this run creates it".to_string()
        }
    );
    match &sde.warning {
        Some(warning) => println!(
            "  {} sdeBuild recorded as null: {}",
            style("[warn]").yellow().bold(),
            warning
        ),
        None => println!(
            "  {:<38}: {} (from {})",
            "static data build",
            sde.build
                .map(|build| build.to_string())
                .unwrap_or_else(|| "null".to_string()),
            display_path(&sde.path)
        ),
    }
    if existed {
        if existing.sde_build == sde.build {
            println!(
                "  {:<38}: matches the manifest header",
                "static data build"
            );
        } else {
            println!(
                "  {} STALE MANIFEST: header sdeBuild {} != static data build {}.",
                style("[warn]").yellow().bold(),
                existing
                    .sde_build
                    .map(|build| build.to_string())
                    .unwrap_or_else(|| "null".to_string()),
                sde.build
                    .map(|build| build.to_string())
                    .unwrap_or_else(|| "null".to_string())
            );
            println!(
                "         Local entries regenerate against the new static data; every capture"
            );
            println!("         persists unchanged (§4.3). Review the diff.");
        }
        if existing.cost_model != cost_model {
            println!(
                "  {} cost model changed: header {} != configured {}. Every local entry is",
                style("[warn]").yellow().bold(),
                existing.cost_model,
                cost_model
            );
            println!("         recomputed under the new model.");
        }
    }

    // ------------------------------------------------------ pass 1: the permanent leaf list
    // Resolved with **no** captures: this is the shopping list the one-time CCP capture has
    // to satisfy, independent of what has already been captured. `--force-refetch leaves`
    // means exactly this set.
    let no_captures = CapturedLeafPrices::new();
    let no_twins = OverridePrices::new();
    let no_floors = OverridePrices::new();
    let mut natural_map = CostMap::new(CostInputs {
        data: &static_data,
        producers: &classification.producers,
        invention_lineage: &classification.invention_lineage,
        captures: &no_captures,
        model: pricing,
        leaf_source,
        twins: &no_twins,
        floors: &no_floors,
    });
    let natural_report = CostReport::build(&mut natural_map, union_ab.iter().copied());
    // Every leaf that feeds an A∪B type, not just the ones `basePrice` fails to price. Under
    // `capture-first` a leaf's cost *is* its captured price, so a leaf with no capture silently
    // falls back to an SDE constant and re-opens the very seam piece 7 closes; the ask has to
    // be asked for all of them. Membership does not depend on any price, so this set is stable
    // whatever the manifest already holds.
    let all_leaves = natural_map.leaves_seen().clone();
    let natural_leaves = natural_report
        .blocked_by_leaf
        .keys()
        .copied()
        .collect::<BTreeSet<_>>();
    let natural_blocked = natural_report
        .outcomes
        .values()
        .filter(|outcome| !outcome.is_priced())
        .count();

    let existing_captures = existing.captured_leaf_prices(policy);
    let mut before_map = CostMap::new(CostInputs {
        data: &static_data,
        producers: &classification.producers,
        invention_lineage: &classification.invention_lineage,
        captures: &existing_captures,
        model: pricing,
        leaf_source,
        twins: &no_twins,
        floors: &no_floors,
    });
    let before_report = CostReport::build(&mut before_map, union_ab.iter().copied());
    let before_blocked = before_report
        .outcomes
        .values()
        .filter(|outcome| !outcome.is_priced())
        .count();

    // Every type a capture is wanted for: every leaf that feeds an A∪B type (index coverage
    // must be total) plus every bucket-D candidate (D is capture-only, §2.4).
    let mut wanted = all_leaves.clone();
    wanted.extend(classification.bucket_d.iter().copied());
    let held_captures = existing
        .prices
        .iter()
        .filter(|(_, entry)| entry.capture_record().is_some())
        .map(|(type_id, _)| *type_id)
        .collect::<BTreeSet<_>>();
    // A record the policy will not spend is not a captured *price*: the type still has none,
    // so it stays on the shopping list. If ESI has since published an `average_price` for it
    // the merge takes that as a first capture, which §4.3 permits — "never refetch" protects
    // prices, and CCP's industry index is not one.
    let held_market_captures = existing
        .prices
        .iter()
        .filter(|(_, entry)| entry.market_capture_record(policy).is_some())
        .map(|(type_id, _)| *type_id)
        .collect::<BTreeSet<_>>();

    let force = force_spec.resolve(&ForceContext {
        bucket_a: &classification.bucket_a,
        bucket_b: &classification.bucket_b,
        bucket_d: &classification.bucket_d,
        blocking_leaves: &all_leaves,
        wanted: &wanted,
        held_captures: &held_captures,
    });
    let mut fetch_targets = wanted
        .iter()
        .copied()
        .filter(|type_id| !held_market_captures.contains(type_id))
        .collect::<BTreeSet<_>>();
    fetch_targets.extend(force.selected.iter().copied());
    // What the payload is filtered down to. Wider than `fetch_targets` on purpose: the merge
    // also has to reconcile the *provenance* of captures it is keeping, and it can only tell
    // an `average_price` from an `adjusted_price` for a type the payload was kept for. Nothing
    // is written for a type outside `wanted ∪ forced`, so widening the observation is free.
    let mut esi_scope = fetch_targets.clone();
    esi_scope.extend(held_captures.iter().copied());

    println!();
    println!(
        "{} what needs a captured price (plan §4.2)",
        style("[capture]").cyan().bold()
    );
    println!(
        "  {:<38}: {} of {} (blocked by {} distinct leaves)",
        "A or B blocked with no captures at all", natural_blocked, union_ab.len(), natural_leaves.len()
    );
    println!(
        "  {:<38}: {} of {}",
        "A or B blocked with the captures held", before_blocked, union_ab.len()
    );
    println!(
        "  {:<38}: {} ({} of them have no basePrice at all)",
        "leaves feeding an A∪B type",
        all_leaves.len(),
        natural_leaves.len()
    );
    println!(
        "  {:<38}: {} (capture-only: no capture, no seed row)",
        "bucket D candidates",
        classification.bucket_d.len()
    );
    println!(
        "  {:<38}: {} (every leaf ∪ D)",
        "types a capture is wanted for",
        wanted.len()
    );
    println!(
        "  {:<38}: {} ({} of them a real market price)",
        "captures already held",
        held_captures.len(),
        held_market_captures.len()
    );
    if held_captures.len() != held_market_captures.len() {
        println!(
            "  {:<38}  {} hold an adjusted_price-only record, which rule A will not spend; \
             they stay on the shopping list",
            "",
            held_captures.len() - held_market_captures.len()
        );
    }
    println!("  {:<38}: {}", "to fetch this run", fetch_targets.len());
    if !force.selected.is_empty() {
        println!(
            "  {:<38}: {} entr{} named by --force-refetch",
            "  forced",
            force.selected.len(),
            if force.selected.len() == 1 { "y" } else { "ies" }
        );
    }
    if !force.not_capturable.is_empty() {
        println!(
            "  {} --force-refetch named {} type(s) that hold no capture and need none; ignored",
            style("[warn]").yellow().bold(),
            force.not_capturable.len()
        );
        println!(
            "         (forcing cannot conjure a capture for a type the cost model already"
        );
        println!("         prices — that would reprice an index type off the live market).");
    }

    // ------------------------------------------------- capture source 1: the Jita snapshot
    //
    // Decision 6: the snapshot runs FIRST and ESI is the gap-filler. `esi_scope` is the set
    // both sources are allowed to look at — `fetch_targets` (everything wanted that holds no
    // market capture, plus anything `--force-refetch` named) widened by the captures already
    // held. Nothing outside `wanted ∪ forced` is ever written from either source, and
    // `manifest::merge` refuses to overwrite a held capture regardless, so a source added
    // this late can only fill gaps (§4.3).
    println!();
    println!(
        "{} Jita split capture (plan §4.2 source 1, before ESI)",
        style("[snapshot]").cyan().bold()
    );
    let mut snapshot_batch = CaptureBatch::default();
    let mut snapshot_stats = SnapshotCaptureStats::default();
    let mut reference_book = ReferenceBook::new(config.price_manifest.reference_solar_system_id);
    let cached_snapshot = if config.price_manifest.capture_missing_from_snapshot {
        crate::snapshot::find_cached_snapshot(&config.source.download_dir)?
    } else {
        None
    };
    match crate::overlay::choose_reference_capture_source(
        config.price_manifest.capture_missing_from_snapshot,
        cached_snapshot.as_ref().map(|cached| cached.path.as_path()),
    ) {
        ReferenceCaptureSource::Disabled => {
            println!("  skipped: [price_manifest] capture_missing_from_snapshot = false");
        }
        ReferenceCaptureSource::NoSnapshot => {
            // Not a failure, deliberately. `refresh-prices` is the command that repairs a
            // manifest; it must keep working in a sealed environment and against an already
            // complete manifest, where there is nothing to capture at all. `build` and
            // `audit` stop on a missing snapshot because there the NPC overlay would be
            // silently absent from the database — a different question.
            println!(
                "  skipped: no market-order snapshot is cached in {}",
                display_path(&config.source.download_dir)
            );
            println!(
                "  refresh-prices never downloads and never fails on this — it has to stay \
                 usable offline"
            );
            println!(
                "  against a complete manifest. ESI below is then the only capture source. To \
                 turn the"
            );
            println!(
                "  Jita split on: market-seederv3 snapshot-info --download --reuse-download"
            );
        }
        ReferenceCaptureSource::Snapshot(path) => {
            println!(
                "  {:<38}: {} ({})",
                "snapshot (cached)",
                display_path(path),
                cached_snapshot
                    .as_ref()
                    .map(crate::snapshot::CachedSnapshot::size_label)
                    .unwrap_or_default()
            );
            // The full overlay import, because the harvest happens inside it — above
            // `order_filter`, so the reference book is the same book whatever `[import]
            // order_filter` is set to. Only `reference_book` is read here; the collapsed
            // seed rows belong to `build`.
            let import = crate::overlay::import_overlay(
                path,
                &static_data,
                config.import.order_filter,
                config.import.npc_order_duration_threshold_days,
                &BTreeSet::new(),
                config.price_manifest.reference_solar_system_id,
                false,
            )?;
            reference_book = import.reference_book;
            let (batch, batch_stats) = collect_snapshot_capture(
                &reference_book,
                &esi_scope,
                &generated_at,
                format!(
                    "{} jita-split system {} @ {generated_at}",
                    path.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.to_string_lossy().to_string()),
                    config.price_manifest.reference_solar_system_id
                ),
            );
            snapshot_batch = batch;
            snapshot_stats = batch_stats;
        }
    }

    // What the snapshot source could do, and what §4.3's permanence lets it actually do.
    let snapshot_priceable = reference_book
        .types()
        .into_iter()
        .filter(|type_id| reference_book.reference_price(*type_id).is_some())
        .collect::<BTreeSet<_>>();
    let snapshot_wanted = snapshot_priceable
        .intersection(&wanted)
        .copied()
        .collect::<BTreeSet<_>>();
    let snapshot_already_market = snapshot_wanted
        .iter()
        .filter(|type_id| held_market_captures.contains(type_id))
        .count();
    let snapshot_already_adjusted = snapshot_wanted
        .iter()
        .filter(|type_id| {
            held_captures.contains(type_id) && !held_market_captures.contains(type_id)
        })
        .count();
    let snapshot_new = snapshot_wanted
        .iter()
        .filter(|type_id| !held_captures.contains(type_id))
        .collect::<BTreeSet<_>>();
    if snapshot_batch.attempted {
        println!(
            "  {:<38}: {} asks + {} bids in system {} ({} of them dropped from the overlay by \
             order_filter",
            "orders harvested",
            count(reference_book.ask_orders as usize),
            count(reference_book.bid_orders as usize),
            reference_book.reference_solar_system_id,
            count(reference_book.orders_the_overlay_filtered_out as usize)
        );
        println!(
            "  {:<38}  = \"{}\" and still harvested — the capture reads Jita's real book, not \
             the accepted subset)",
            "",
            config.import.order_filter.mode_key()
        );
        println!(
            "  {:<38}: {}",
            "types quoted on at least one side",
            count(snapshot_stats.types_in_book)
        );
        println!(
            "  {:<38}: {} ({} split, {} ask-only, {} bid-only; {} skipped with no usable side)",
            "types the snapshot could price",
            count(snapshot_stats.priced()),
            count(snapshot_stats.priced_split),
            count(snapshot_stats.priced_ask_only),
            count(snapshot_stats.priced_bid_only),
            count(snapshot_stats.skipped_unusable)
        );
        println!(
            "  {:<38}: {} of the {} types a capture is wanted for",
            "  of those, in scope this run",
            count(snapshot_wanted.len()),
            count(wanted.len())
        );
        println!(
            "  {:<38}: {} (permanent, §4.3 — left exactly as they are)",
            "  already hold a captured market price",
            count(snapshot_already_market)
        );
        if snapshot_already_adjusted > 0 {
            println!(
                "  {:<38}: {} (rule A spends nothing from those, so a Jita split is a FIRST",
                "  hold an adjusted_price-only record",
                count(snapshot_already_adjusted)
            );
            println!("  {:<38}  capture for them, not a refetch)", "");
        }
        println!(
            "  {:<38}: {}",
            "  genuinely new",
            count(snapshot_new.len())
        );

        // How far apart the two sources actually are, on the types where both have an
        // opinion. Reported and nothing more: those types already hold a permanent ESI
        // capture and §4.3 says it stands. This exists so "permanence" is a measured
        // decision rather than an unexamined one.
        let mut divergence = existing
            .prices
            .iter()
            .filter_map(|(type_id, entry)| {
                let capture = entry.capture_record()?;
                if capture.source != PriceSource::CcpEsiAverage {
                    return None;
                }
                let reference = reference_book.reference_price(*type_id)?;
                if capture.price <= 0.0 {
                    return None;
                }
                Some((*type_id, reference, capture.price, reference.price / capture.price))
            })
            .collect::<Vec<_>>();
        divergence.sort_by(|left, right| {
            let spread = |ratio: f64| if ratio >= 1.0 { ratio } else { 1.0 / ratio };
            spread(right.3)
                .partial_cmp(&spread(left.3))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if !divergence.is_empty() {
            println!(
                "  {:<38}: {} types carry both a held ccp-esi-average and a Jita split. The ESI",
                "snapshot vs ESI, where both exist",
                count(divergence.len())
            );
            println!(
                "  {:<38}  capture stands (§4.3); this is the measurement, top {} by spread:",
                "",
                top_leaves.min(divergence.len())
            );
            for (type_id, reference, esi, ratio) in divergence.iter().take(top_leaves) {
                println!(
                    "    {:>7}  {:<40} jita {:>18} ({:<16}) vs esi {:>18}  x{:.3}",
                    type_id,
                    type_name(&static_data, *type_id),
                    isk(reference.price),
                    reference.rule.key(),
                    isk(*esi),
                    ratio
                );
            }
        }
    }

    // ------------------------------------------------------ capture source 2: ESI gap-fill
    println!();
    println!("{} CCP capture", style("[esi]").cyan().bold());
    let mut batch = CaptureBatch::default();
    if esi_scope.is_empty() {
        println!("  nothing to fetch — every wanted price is already captured");
    } else if let Some(path) = from_file {
        let raw = read_esi_file(path)?;
        let rows = parse_esi_price_rows(&raw)?;
        batch = collect_esi_capture(
            &rows,
            &esi_scope,
            &generated_at,
            format!(
                "markets/prices from file {} @ {generated_at}",
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string_lossy().to_string())
            ),
        );
        println!("  read {} ({} rows)", display_path(path), batch.rows_total);
    } else if !config.price_manifest.capture_missing_from_esi {
        println!(
            "  skipped: [price_manifest] capture_missing_from_esi = false, and no --from-file"
        );
    } else {
        let url = config.price_manifest.esi_prices_url.clone();
        println!("  GET {url}");
        let raw = fetch_esi_body(&url, &config.source.user_agent)?;
        let rows = parse_esi_price_rows(&raw)?;
        batch = collect_esi_capture(
            &rows,
            &esi_scope,
            &generated_at,
            format!("markets/prices @ {generated_at}"),
        );
        println!("  {} bytes", raw.len());
    }
    if batch.attempted {
        println!(
            "  {:<38}: {} rows, {} with a usable number, {} with an average_price",
            "payload", batch.rows_total, batch.rows_usable, batch.rows_market
        );
        let covered = batch
            .prices
            .keys()
            .filter(|type_id| fetch_targets.contains(type_id))
            .count();
        let covered_market = batch
            .prices
            .iter()
            .filter(|(type_id, captured)| {
                fetch_targets.contains(type_id) && captured.source.is_market_price()
            })
            .count();
        println!(
            "  {:<38}: {} of {} requested types ({} with a real market price)",
            "covered",
            covered,
            fetch_targets.len(),
            covered_market
        );
        println!(
            "  {:<38}: {} (ESI knows no usable number for them at all)",
            "uncovered",
            fetch_targets.len() - covered
        );
        println!(
            "  {:<38}: {} of the types in scope carry adjusted_price and no average_price",
            "adjusted-price-only rows",
            batch.adjusted_only.len()
        );
    }

    // Decision 6's order, made concrete: one batch, the snapshot winning every type both
    // sources answer, ESI filling the rest. One batch rather than two chained merges so that
    // `merge` still measures permanence, provenance and `unchanged` against the manifest
    // that was loaded off disk.
    let esi_batch = batch;
    let batch = combine_captures(snapshot_batch, esi_batch);

    // -------------------------------------------------------------------------- the merge
    // Two merges on purpose: the first settles which captures the run ends up holding, so
    // the local half can be recomputed against exactly those captures, and the second is the
    // manifest that gets written. The precedence rules live in `manifest::merge` alone.
    let capture_only = MergeInput {
        sde_build: sde.build,
        cost_model: cost_model.to_string(),
        pricing_rules: pricing_rules.clone(),
        generated_at: generated_at.clone(),
        local: BTreeMap::new(),
        wanted: wanted.clone(),
        forced: force.selected.clone(),
        local_outranks_capture: BTreeSet::new(),
        // One-time: a manifest that already records rule A had its `ccp-esi-average` labels
        // checked when the rule first ran, and re-checking them every run would let a
        // transient gap in the payload demote a captured price.
        reconcile_capture_provenance: !existing
            .pricing_rules
            .iter()
            .any(|rule| rule == config::RULE_REJECT_ADJUSTED),
        policy,
    };
    let (capture_merged, _) = manifest::merge(&existing, &capture_only, &batch);
    // Rule A applies here: only captures the policy accepts as market prices reach the cost
    // map, so an `adjusted_price`-only record cannot price a leaf, a product built from that
    // leaf, or a bucket-D seed row.
    let final_captures = capture_merged.captured_leaf_prices(policy);

    let natural_inputs = CostInputs {
        data: &static_data,
        producers: &classification.producers,
        invention_lineage: &classification.invention_lineage,
        captures: &final_captures,
        model: pricing,
        leaf_source,
        twins: &no_twins,
        floors: &no_floors,
    };

    // ------------------------------------------------------------------ rules B and C
    // Roots for the reprocessing floor: everything that can end up with a seed row on both
    // sides, because check 1 of the pump audit walks exactly that set. Bucket-D candidates
    // are included whether or not they hold a capture; the ones that do not are dropped
    // later anyway, and the floor never invents a price for an unpriced type.
    let reprocessing = ReprocessingStatic::load(&static_data_dir)?;
    let seeded_universe = classification.seeded_types();
    // The captures that are the **seed price** rather than merely a rung of the cost ladder.
    // `merge` hands a held capture the entry whenever the ladder prefers it, even for a type
    // with a blueprint — so for those types the cost map's recursive answer is not what gets
    // seeded, and a rule computed against it would be computing against the wrong number.
    let seed_captures = if leaf_source.prefers_capture() {
        final_captures.clone()
    } else {
        // `base-price-first` hands every type with a basePrice back to its local entry.
        final_captures
            .iter()
            .filter(|(type_id, _)| natural_inputs.base_price(*type_id) <= 0.0)
            .collect::<CapturedLeafPrices>()
    };
    let rules = apply_pricing_rules(
        natural_inputs,
        &reprocessing,
        &seeded_universe,
        &seed_captures,
        floor_ask(&config, &union_ab),
        config.index_seed.derive_compressed_from_source,
        config.index_seed.floor_cost_at_reprocessing_value,
        REPROCESSING_FLOOR_MAX_PASSES,
    );
    print_pricing_rule_report(&static_data, &config, &rules);

    let after_inputs = CostInputs {
        twins: &rules.twins,
        floors: &rules.floors,
        ..natural_inputs
    };
    let mut after_map = CostMap::new(after_inputs);
    let after_report = CostReport::build(&mut after_map, union_ab.iter().copied());
    let mut local = local_prices_from_report(&after_report);

    // Make every rule's answer bind the **entry**, for two cases the cost map cannot express
    // on its own:
    //
    // * bucket D has no local entries at all (§2.4, capture-only) — but a junk module
    //   recycles into minerals exactly as an ore refines into them, so rule C lifts junk too,
    //   and the lifted number has to be what gets seeded or the rule would fix the index rows
    //   and leave the junk rows pumping;
    // * a type whose seed price is a held capture keeps that capture through the merge, so a
    //   floor above it has to be written as the entry even where the cost map's own recursive
    //   answer was already higher. This is the POS/structure class (Supercapital Ship
    //   Assembly Array and friends), and skipping it leaves precisely their loop open.
    let mut rule_entries = 0usize;
    let mut junk_repriced = 0usize;
    for type_id in &seeded_universe {
        let is_index = union_ab.contains(type_id);
        let capture = capture_merged
            .market_capture(*type_id, policy)
            .map(|capture| capture.price);
        if !is_index && capture.is_none() {
            continue; // unseedable junk: no capture, no seed row, nothing to correct
        }
        // What the merge would put in the entry with no correction: the capture when one is
        // held and the ladder prefers it, otherwise the locally computed price.
        let Some(basis) = capture
            .filter(|_| seed_captures.contains(*type_id))
            .or_else(|| local.get(type_id).map(|price| price.price))
        else {
            continue; // unpriced: rules never invent a price (§4.1)
        };
        // B first, then C — C's value was computed on top of B's, so it wins where both moved.
        let mut corrected = None;
        if let Some(twin) = rules.twins.get(*type_id)
            && (twin - basis).abs() > basis.abs().max(twin) * cost::PRICE_EPSILON
        {
            corrected = Some((twin, crate::cost::CostSource::DerivedTwin));
        }
        if let Some(floor) = rules.floors.get(*type_id)
            && floor > basis * (1.0 + cost::PRICE_EPSILON)
        {
            corrected = Some((floor, crate::cost::CostSource::ReprocessingFloor));
        }
        let Some((price, source)) = corrected else {
            continue;
        };
        if local
            .get(type_id)
            .is_some_and(|held| held.source.is_derived() && held.price >= price)
        {
            continue; // the cost map already wrote this exact correction
        }
        if let Some(entry) = LocalPrice::from_cost(price, source) {
            local.insert(*type_id, entry);
            rule_entries += 1;
            if !is_index {
                junk_repriced += 1;
            }
        }
    }
    if rule_entries > 0 {
        println!(
            "  {:<38}: {} ({} of them bucket D; their entry is the rewritten price and the",
            "entries a rule rewrote past the merge", rule_entries, junk_repriced
        );
        println!("  {:<38}  capture rides along in retainedCapture)", "");
    }

    // Which price is the entry when a type has both.
    //
    // `capture-first` used to make this set empty — the capture always won. Rules B and C
    // change that: a price they derived is *not* the capture, so the local entry has to be
    // the entry and the capture rides along in `retainedCapture`. Without this the merge
    // would hand the capture straight back and quietly undo both rules.
    //
    // `base-price-first` additionally hands every type the SDE prices back to its local
    // entry, as before.
    let mut local_outranks_capture = local
        .iter()
        .filter(|(_, price)| price.source.is_derived())
        .map(|(type_id, _)| *type_id)
        .collect::<BTreeSet<_>>();
    if !leaf_source.prefers_capture() {
        local_outranks_capture.extend(
            local
                .keys()
                .copied()
                .filter(|type_id| after_inputs.base_price(*type_id) > 0.0),
        );
    }

    let merge_input = MergeInput {
        local,
        local_outranks_capture,
        ..capture_only
    };
    let (merged, stats) = manifest::merge(&existing, &merge_input, &batch);

    // The §4.3 permanence proof, measured on the two manifests rather than trusted from the
    // merge's own counters — the question that matters when a second capture source is added
    // years after the first is whether anything already on disk moved, and *which* thing.
    //
    // Three ways a pre-existing entry can differ, and only one of them is a permanence
    // violation:
    //
    // * a held **market** capture was repriced — only `--force-refetch` may do this;
    // * an `adjusted_price`-only record gained a market price. Rule A spends nothing from
    //   CCP's industry index, so that type held no captured *price* — the run's own shopping
    //   list counts it as missing. This is a FIRST capture, not a refetch, and the merge has
    //   always worked this way; the snapshot source simply reaches more of them than ESI did;
    // * a local entry was recomputed. Locals are regenerated every run by design (§4.3), and
    //   feeding 169 new leaf captures into the cost map is *supposed* to move the products
    //   built out of those leaves.
    let mut new_captures_by_source: BTreeMap<PriceSource, usize> = BTreeMap::new();
    let mut repriced_market: Vec<(u32, RetainedCapture, RetainedCapture)> = Vec::new();
    let mut upgraded_from_adjusted: Vec<(u32, RetainedCapture, RetainedCapture)> = Vec::new();
    let mut local_recomputed = 0usize;
    let mut entries_changed = 0usize;
    let mut entries_added = 0usize;
    for (type_id, after) in &merged.prices {
        let Some(before) = existing.prices.get(type_id) else {
            entries_added += 1;
            if let Some(capture) = after.capture_record() {
                *new_captures_by_source.entry(capture.source).or_default() += 1;
            }
            continue;
        };
        if before != after {
            entries_changed += 1;
        }
        match (before.capture_record(), after.capture_record()) {
            (None, Some(capture)) => {
                *new_captures_by_source.entry(capture.source).or_default() += 1;
            }
            (Some(was), Some(now)) if was.price != now.price || was.source != now.source => {
                if was.source.is_market_price() {
                    repriced_market.push((*type_id, was, now));
                } else {
                    upgraded_from_adjusted.push((*type_id, was, now));
                }
            }
            (None, None) if before.price != after.price || before.source != after.source => {
                local_recomputed += 1;
            }
            _ => {}
        }
    }

    println!();
    println!("{} manifest changes", style("[merge]").cyan().bold());
    println!(
        "  {:<38}: {} -> {}",
        "entries", stats.entries_before, stats.entries_after
    );
    println!(
        "  {:<38}: {} (cost-recursive {}, base-price {}, derived-compressed-twin {}, \
         reprocessing-floor {})",
        "local entries written",
        stats.local_written,
        stats.local_written_cost_recursive,
        stats.local_written_base_price,
        stats.local_written_derived_twin,
        stats.local_written_reprocessing_floor
    );
    println!(
        "  {:<38}: {} (no longer an A∪B type, or no longer locally priced)",
        "local entries dropped", stats.local_dropped
    );
    println!(
        "  {:<38}: {}",
        "captures held (untouched)", stats.captures_held
    );
    println!("  {:<38}: {}", "captures newly fetched", stats.captures_new);
    for source in PriceSource::ALL.iter().filter(|source| source.is_capture()) {
        let new = new_captures_by_source.get(source).copied().unwrap_or(0);
        if new > 0 {
            println!("  {:<38}: {}", format!("  from {}", source.key()), new);
        }
    }
    println!();
    println!(
        "  {:<38}: {} entries added, {} pre-existing entries differ, split as:",
        "diff against the file on disk", entries_added, entries_changed
    );
    println!(
        "  {:<38}: {} (recomputed every run by design; new leaf captures move the products",
        "  local entries recomputed", local_recomputed
    );
    println!("  {:<38}  built out of those leaves)", "");
    println!(
        "  {:<38}: {} (§4.3 permits it: rule A spends nothing from CCP's industry index, so",
        "  adjusted_price records given a price",
        upgraded_from_adjusted.len()
    );
    println!(
        "  {:<38}  those types held no captured PRICE — this is a first capture, not a refetch)",
        ""
    );
    for (type_id, was, now) in upgraded_from_adjusted.iter().take(5) {
        println!(
            "    {:>7}  {:<40} {} {} -> {} {}",
            type_id,
            type_name(&static_data, *type_id),
            was.source.key(),
            isk(was.price),
            now.source.key(),
            isk(now.price)
        );
    }
    if upgraded_from_adjusted.len() > 5 {
        println!("    … and {} more", upgraded_from_adjusted.len() - 5);
    }
    if repriced_market.is_empty() {
        println!(
            "  {} {:<36}: 0 — every captured market price on disk survived this run \
             byte-for-byte",
            style("[ok]").green().bold(),
            "held market captures repriced"
        );
    } else {
        println!(
            "  {} {} held MARKET capture(s) were repriced. Only --force-refetch may do this:",
            style("[warn]").yellow().bold(),
            repriced_market.len()
        );
        for (type_id, was, now) in repriced_market.iter().take(top_leaves) {
            println!(
                "    {:>7}  {:<40} {} {} -> {} {}",
                type_id,
                type_name(&static_data, *type_id),
                was.source.key(),
                isk(was.price),
                now.source.key(),
                isk(now.price)
            );
        }
        if repriced_market.len() > top_leaves {
            println!("    … and {} more", repriced_market.len() - top_leaves);
        }
    }
    if stats.captures_relabelled_adjusted > 0 {
        println!(
            "  {:<38}: {} (the payload shows the number came from adjusted_price, not",
            "capture labels corrected", stats.captures_relabelled_adjusted
        );
        println!(
            "  {:<38}  average_price; the value and capturedAt do not move)",
            ""
        );
    }
    if stats.captures_upgraded_to_market > 0 {
        println!(
            "  {:<38}: {} (an adjusted_price-only record replaced by a real average_price)",
            "captures upgraded to a market price", stats.captures_upgraded_to_market
        );
    }
    println!(
        "  {:<38}: {} (kept and visible; rule A will not price anything from them)",
        "adjusted_price-only records", stats.captures_adjusted_records
    );
    if stats.captures_forced_replaced > 0 || stats.captures_forced_kept > 0 {
        println!(
            "  {:<38}: {} replaced, {} kept (no new price offered)",
            "captures refetched by --force-refetch",
            stats.captures_forced_replaced,
            stats.captures_forced_kept
        );
    }
    println!(
        "  {:<38}: {} (unseeded D candidates and, if any, blocking leaves)",
        "captures still missing", stats.captures_missing
    );
    if stats.captures_retained_unwanted > 0 {
        println!(
            "  {:<38}: {} (kept — captures are permanent)",
            "captures no longer needed", stats.captures_retained_unwanted
        );
    }
    println!(
        "  {:<38}: {} local -> ccp-*, {} ccp-* -> local",
        "entries that changed rung", stats.local_became_capture, stats.capture_became_local
    );
    if stats.local_suppressed_by_capture > 0 {
        println!(
            "  {:<38}: {} (both a local price and a capture; the leaf ladder takes the",
            "  capture is the entry", stats.local_suppressed_by_capture
        );
        println!("  {:<38}  capture, so the local price is discarded)", "");
    }
    if stats.captures_retained_beside_local > 0 {
        println!(
            "  {:<38}: {} (the ladder took the local price; the capture rides along in",
            "  local price is the entry", stats.captures_retained_beside_local
        );
        println!(
            "  {:<38}  retainedCapture so flipping the knob back needs no network)",
            ""
        );
    }

    // ------------------------------------------------------------- post-capture resolution
    let after_blocked = after_report
        .outcomes
        .iter()
        .filter(|(_, outcome)| !outcome.is_priced())
        .map(|(type_id, _)| *type_id)
        .collect::<Vec<_>>();
    println!();
    println!(
        "{} A∪B after the capture (§4.1)",
        style("[resolution]").cyan().bold()
    );
    println!(
        "  {:<38}: {} of {}",
        "priced",
        union_ab.len() - after_blocked.len(),
        union_ab.len()
    );
    if after_blocked.is_empty() {
        println!(
            "  {} every A∪B type is priced",
            style("[ok]").green().bold()
        );
    } else {
        println!(
            "  {:<38}: {} (each one is dropped and named in [dropped] below — an",
            "unpriced", after_blocked.len()
        );
        println!(
            "  {:<38}  unpriceable type is never seeded, and never seeded at a guess)",
            ""
        );
        let still_blocking = after_report.leaves_by_blast_radius();
        println!(
            "  {} leaves still blocking, top {}:",
            still_blocking.len(),
            top_leaves.min(still_blocking.len())
        );
        for (type_id, blocked) in still_blocking.into_iter().take(top_leaves) {
            println!(
                "    {:>7}  {:>5} blocked  {:<44} capture held: {}",
                type_id,
                blocked,
                type_name(&static_data, type_id),
                merged.has_capture(type_id)
            );
        }
    }

    // ------------------------------------------------------------------------- histogram
    println!();
    println!(
        "{} final manifest by source ({} entries)",
        style("[sources]").cyan().bold(),
        merged.prices.len()
    );
    for (source, count) in merged.source_histogram() {
        println!("  {:<26}: {:>6}", source.key(), count);
    }
    println!(
        "  {:<26}: {:>6}  (captures held in total, priced or merely retained)",
        "captures held", merged.capture_count()
    );
    for (key, value) in &merged.sources {
        println!("  sources.{key:<18}: {value}");
    }

    // ----------------------------------------------------------------------------- write
    println!();
    if dry_run {
        println!(
            "{} dry run: nothing written. {} would be {}.",
            style("[write]").cyan().bold(),
            display_path(&manifest_path),
            if !existed {
                "created"
            } else if stats.unchanged {
                "left byte-identical"
            } else {
                "rewritten"
            }
        );
    } else if stats.unchanged && existed {
        println!(
            "{} no changes — {} left byte-identical",
            style("[write]").cyan().bold(),
            display_path(&manifest_path)
        );
    } else {
        merged.save(&manifest_path)?;
        println!(
            "{} wrote {} ({} entries)",
            style("[write]").green().bold(),
            display_path(&manifest_path),
            merged.prices.len()
        );
        // Cheap proof the committed artifact is readable by the next run.
        let reloaded = PriceManifest::load(&manifest_path)?
            .ok_or_else(|| anyhow::anyhow!("the manifest vanished after being written"))?;
        if reloaded == merged {
            println!(
                "  {} re-read and parsed identically",
                style("[ok]").green().bold()
            );
        } else {
            bail!(
                "the manifest did not round-trip through {}: {}",
                display_path(&manifest_path),
                manifest::first_difference(&merged, &reloaded)
                    .unwrap_or_else(|| "no field-level difference found".to_string())
            );
        }
    }

    // ------------------------------------------------------------------------- seed plan
    // Deliberately after the write: this is the same resolution step piece 5's seed writer
    // calls, and it can fail on the drop budget. Resolving it here would throw away a
    // capture that was just fetched over the network, so the manifest lands on disk first
    // and the gate runs against what was actually written.
    // No NPC catalog here, deliberately: `refresh-prices` resolves *prices*, and importing a
    // 20 MB snapshot to decide which sides the overlay would take off the index seed would
    // make a price refresh depend on a downloaded market snapshot. The plan below is therefore
    // the pre-deferral one — a strict upper bound on what a build seeds, and the stricter
    // reading of the drop budget, since deferral only ever removes rows. The pricing pair is
    // still passed because `resolve` takes it unconditionally; with no catalog it is unused.
    let plan = SeedPlan::resolve(
        &classification,
        &static_data,
        &after_report,
        &merged,
        &NpcCatalog::none(),
        crate::build::SeedPricingPair::from_config(&config),
        &config,
    )?;

    println!();
    println!(
        "{} what a build from this manifest would seed (§4.1)",
        style("[seed plan]").cyan().bold()
    );
    println!(
        "  {:<38}: {} (A or B or D, each type counted once)",
        "seedable types",
        plan.seedable_count()
    );
    println!(
        "  {:<38}: {}",
        "  composition",
        plan.seedable_composition()
            .iter()
            .map(|(label, count)| format!("{label} {count}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "  {:<38}: {} of {} A∪B index types",
        "  index rows",
        plan.seedable_index_count(),
        union_ab.len()
    );
    println!(
        "  {:<38}: {} of {} bucket D candidates{}",
        "  junk rows",
        plan.seedable_junk_count(),
        classification.bucket_d.len(),
        if classification.junk_enabled {
            ""
        } else {
            " ([junk_seed] enabled = false)"
        }
    );
    println!(
        "  {} every seedable type carries a finite manifest price greater than 0",
        style("[ok]").green().bold()
    );
    println!(
        "  {:<38}: this count is BEFORE [index_seed] defer_to_npc_catalog, which a build \
         applies against",
        "note"
    );
    println!(
        "  {:<38}  the imported NPC catalog; `build`/`audit` report what it takes off the \
         index seed.",
        ""
    );

    println!();
    println!(
        "{} {} type(s) this manifest cannot price: not seeded, and never seeded at a guess",
        style("[dropped]").cyan().bold(),
        plan.dropped.len()
    );
    println!(
        "  {:<38}: {} of at most {} ([index_seed] max_unpriced_drops)",
        "unpriced A∪B index types",
        plan.index_drop_count(),
        config.index_seed.max_unpriced_drops
    );
    for dropped in plan.dropped_with(DropReason::UnpricedIndexType) {
        println!(
            "    {:>7}  {:<46} bucket {:<4} blocked by {:?}",
            dropped.type_id,
            dropped.name,
            dropped.bucket_label(),
            dropped.blocking_leaves
        );
    }
    println!(
        "  {:<38}: {} (no captured market price — unseeded by design (§2.4), never a",
        "uncaptured bucket D candidates",
        plan.junk_drop_count()
    );
    println!(
        "  {:<38}  basePrice fallback, and routine enough to stay outside the budget above)",
        ""
    );
    for dropped in plan.dropped_with(DropReason::UncapturedJunk).take(top_leaves) {
        println!("    {:>7}  {}", dropped.type_id, dropped.name);
    }
    if plan.junk_drop_count() > top_leaves {
        println!("    … and {} more", plan.junk_drop_count() - top_leaves);
    }

    Ok(())
}

/// What rules B and C did, in the shape a reviewer needs to sign them off: how many prices
/// moved, how far, and — for the fixpoint — that it actually reached one.
fn print_pricing_rule_report(
    static_data: &StaticData,
    config: &SeederConfig,
    rules: &cost::PricingRules,
) {
    if let Some(twin) = &rules.twin_report {
        println!();
        println!(
            "{} rule B — one price per compressed pair (compression is 1:1 both ways)",
            style("[twins]").cyan().bold()
        );
        println!(
            "  {:<38}: {} ({} priced, {} with no price on either side)",
            "compressed/uncompressed pairs", twin.pairs_total, twin.pairs_priced, twin.pairs_unpriceable
        );
        println!(
            "  {:<38}: {} ({} of them disagreed — every one an open arbitrage)",
            "pairs with a market capture on both sides", twin.pairs_both_captured, twin.pairs_disagreed
        );
        if let Some(worst) = twin.worst_disagreement {
            println!(
                "  {:<38}: x{:.3}  {} {} @ {} vs {} {} @ {}",
                "  worst disagreement",
                worst.ratio(),
                worst.source_type,
                type_name(static_data, worst.source_type),
                isk(worst.source_price),
                worst.compressed_type,
                type_name(static_data, worst.compressed_type),
                isk(worst.compressed_price)
            );
        }
        println!(
            "  {:<38}: {} ({} had no price at all before; {} had no capture of their own and",
            "sides repriced", twin.sides_repriced, twin.sides_rescued, twin.sides_off_the_sde
        );
        println!(
            "  {:<38}  now carry a real market price off their traded twin — the piece-7",
            ""
        );
        println!("  {:<38}  audit's class 3)", "");
    }

    if let Some(floor) = &rules.floor_report {
        println!();
        println!(
            "{} rule C — a type's ASK must cover what it reprocesses into",
            style("[floor]").cyan().bold()
        );
        println!(
            "  {:<38}: cost := max(cost, refine_revenue / sell_multiplier x {:.4}), where",
            "formula",
            1.0 + config.index_seed.reprocessing_floor_margin
        );
        println!(
            "  {:<38}  refine_revenue = sum(qty x buy_multiplier x cost) / portionSize",
            ""
        );
        println!(
            "  {:<38}  A∪B rows sell x{} / buy x{}, bucket D sells x{} / buys x{} — check 1",
            "",
            config.index_seed.sell_multiplier,
            config.index_seed.buy_multiplier,
            config.junk_seed.sell_multiplier,
            config.junk_seed.buy_multiplier
        );
        println!(
            "  {:<38}  compares the ask against what the bids pay, so both sides are priced",
            ""
        );
        println!(
            "  {:<38}: {} seeded types with a usable reprocessing row",
            "candidates", floor.candidates
        );
        println!(
            "  {:<38}: {} pass{} to the fixpoint ({})",
            "relaxation",
            floor.passes,
            if floor.passes == 1 { "" } else { "es" },
            if floor.converged {
                style("converged".to_string()).green()
            } else {
                style(format!(
                    "DID NOT CONVERGE — {} types still rising at the {}-pass cap",
                    floor.still_moving.len(),
                    REPROCESSING_FLOOR_MAX_PASSES
                ))
                .red()
                .bold()
            }
        );
        println!("  {:<38}: {}", "types lifted", floor.lifted);
        if let Some(largest) = floor.largest_lift() {
            println!(
                "  {:<38}: x{:.3}  {} {} — {} -> {}",
                "  largest lift",
                largest.ratio(),
                largest.type_id,
                type_name(static_data, largest.type_id),
                isk(largest.from),
                isk(largest.to)
            );
        }
        for lift in floor.lifts.iter().take(5).skip(1) {
            println!(
                "  {:<38}  x{:.3}  {} {} — {} -> {}",
                "",
                lift.ratio(),
                lift.type_id,
                type_name(static_data, lift.type_id),
                isk(lift.from),
                isk(lift.to)
            );
        }
        if !floor.converged {
            println!(
                "  {} the reprocessing graph contains a value-gaining cycle: {:?}",
                style("[warn]").red().bold(),
                floor.still_moving.iter().take(10).collect::<Vec<_>>()
            );
            println!("         Prices below are the capped relaxation, not a fixpoint.");
        }
    }
}

/// One anchor line: bucket, producer shape, resolved cost, seed ask, and the server EIV.
fn print_anchor(
    static_data: &StaticData,
    classification: &Classification,
    map: &mut CostMap<'_>,
    report: &CostReport,
    config: &SeederConfig,
    type_id: u32,
) {
    let name = type_name(static_data, type_id);
    let flags = classification.flags(type_id);
    let outcome = match report.outcomes.get(&type_id) {
        Some(outcome) => outcome.clone(),
        None => map.resolve(type_id),
    };
    let producer = classification.producers.get(type_id);
    println!(
        "  {} ({}): bucket {}, {}",
        name,
        type_id,
        if flags.is_classified() {
            flags.label()
        } else {
            "unseeded"
        },
        match producer {
            Some(producer) => format!(
                "blueprint {} ({}), {} per run, {} materials",
                producer.blueprint_type_id,
                producer.activity.label(),
                producer.per_run,
                producer.materials.len()
            ),
            None => "no producer (leaf)".to_string(),
        }
    );
    match outcome.unit_cost() {
        Some(unit_cost) => println!(
            "    unit cost {} ISK ({}), ask x{} = {} ISK, bid x{} = {} ISK",
            isk(unit_cost),
            outcome.source_label(),
            config.index_seed.sell_multiplier,
            isk(unit_cost * config.index_seed.sell_multiplier),
            config.index_seed.buy_multiplier,
            isk(unit_cost * config.index_seed.buy_multiplier)
        ),
        None => println!(
            "    needs capture: blocked by {} leaf type(s) {:?}",
            outcome.missing_leaves().len(),
            outcome.missing_leaves().iter().take(8).collect::<Vec<_>>()
        ),
    }
    println!(
        "    server EIV (per run, no divide) {} ISK, basePrice {} ISK",
        isk(map.server_parity_eiv(type_id)),
        isk(map.inputs().base_price(type_id))
    );
}

/// Ship rigs: category 7, group name starting with `Rig `. Structure rigs live in category
/// 66 and are deliberately not counted here.
fn is_ship_rig(static_data: &StaticData, type_id: u32) -> bool {
    static_data.item_type(type_id).is_some_and(|item| {
        item.category_id == Some(MODULE_CATEGORY_ID)
            && item
                .group_name
                .as_deref()
                .is_some_and(|group| group.starts_with("Rig "))
    })
}

fn type_name(static_data: &StaticData, type_id: u32) -> &str {
    static_data
        .item_type(type_id)
        .map(|item| item.name.as_str())
        .unwrap_or("<unknown type>")
}

/// Thousands-grouped ISK with two decimals, so a 12-digit capital price is readable.
fn isk(value: f64) -> String {
    if !value.is_finite() {
        return format!("{value}");
    }
    let negative = value < 0.0;
    let formatted = format!("{:.2}", value.abs());
    let (integer, fraction) = formatted
        .split_once('.')
        .unwrap_or((formatted.as_str(), "00"));
    let mut grouped = String::new();
    for (index, digit) in integer.chars().enumerate() {
        if index > 0 && (integer.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!(
        "{}{}.{}",
        if negative { "-" } else { "" },
        grouped,
        fraction
    )
}

/// Thousands-grouped integer. The crate-wide copy: `audit` and `overlay` call this one,
/// `build` keeps its own generic `format_count` for the `i64` config values it prints.
fn count(value: usize) -> String {
    let digits = value.to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

fn print_funnel_row(label: &str, remaining: usize, removed: Option<usize>) {
    match removed {
        Some(removed) => println!("  {label:<26}: {remaining:>6}   (-{removed})"),
        None => println!("  {label:<26}: {remaining:>6}"),
    }
}

fn print_path(label: &str, path: &Path) {
    println!("  {:<24}: {}", label, display_path(path));
}

/// Config paths are relative to the working directory the seeder runs from, so the doctor
/// prints the absolute form whenever it can resolve one.
fn display_path(path: &Path) -> String {
    let shown = path.to_string_lossy().to_string();
    match std::fs::canonicalize(path) {
        Ok(absolute) => {
            let absolute = absolute.to_string_lossy().to_string();
            let absolute = absolute.strip_prefix(r"\\?\").unwrap_or(&absolute).to_string();
            if absolute == shown {
                shown
            } else {
                format!("{shown} -> {absolute}")
            }
        }
        Err(_) => format!("{shown} (does not exist yet)"),
    }
}
