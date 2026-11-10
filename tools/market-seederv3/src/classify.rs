//! Seed-universe classifier — `doc/JITA_INDEX_SEED_PLAN.md` §2.
//!
//! Splits the published/market-grouped type universe into the buckets the later passes
//! price and write:
//!
//! | bucket | contents                                   | priced by                    |
//! |--------|--------------------------------------------|------------------------------|
//! | **A**  | manufacturable T1 (incl. reaction outputs) | bottom-up blueprint cost     |
//! | **B**  | ores / minerals / materials                | cost if craftable, else leaf |
//! | **D**  | market-priced junk candidates              | captured CCP price only      |
//!
//! Two data traps this module exists to avoid:
//!
//! 1. **The reaction index hole.** All 120 reaction blueprints carry a top-level
//!    `productTypeID` of 0, so `industryBlueprints`' precomputed
//!    `blueprintTypeIDsByProductTypeID` misses every reaction output. The producer index
//!    here is therefore built by scanning `activities.manufacturing.products[]` *and*
//!    `activities.reaction.products[]`; the precomputed index is never read.
//! 2. **The faction leak.** 714 types with an SDE blueprint and Tech Level 1 are
//!    faction/storyline/officer/deadspace gear (navy hulls, CONCORD capital modules, AT
//!    prizes). Only dogma attribute 1692 (metaGroupID) separates them from real T1, and
//!    only after the category and lineage rules have already run — see [`BucketAFunnel`].
//!
//! A and B deliberately overlap (~183 types: fuel blocks, composites, intermediates are
//! both manufacturable and raw materials). Membership is therefore a flag set
//! ([`BucketFlags`]), not an enum, and the seeded set is the *union* A ∪ B ∪ D so an
//! overlapping type is counted exactly once.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{Result, bail};

use crate::config::JunkSeedConfig;
use crate::staticdata::{MaterialEntry, StaticData};

/// Categories that are never index- or junk-seeded (plan §2.1, §2.5). Blueprints are
/// excluded here because T1 BPOs belong to bucket C (the NPC overlay), and T2 BPOs are
/// never seeded at all.
pub const EXCLUDED_CATEGORY_IDS: &[(u32, &str)] = &[
    (5, "PLEX / services / injectors"),
    (9, "Blueprints"),
    (16, "Skills"),
    (30, "Apparel"),
    (63, "Special Edition Commodities"),
    (91, "SKINs (permanent / 30-day)"),
    (2100, "Expert Systems"),
    (2118, "Sequence Binders (SKIN design)"),
];

/// Bucket B categories (plan §2.2). Deliberately **not** filtered by tech level or
/// metaGroup: these are raw materials, and the T1/faction vocabulary does not apply to
/// ore, ice, moon goo, PI, or reagents.
pub const MATERIAL_CATEGORY_IDS: &[(u32, &str)] = &[
    (4, "Material"),
    (25, "Asteroid"),
    (42, "Planetary Resources"),
    (43, "Planetary Commodities"),
    (2143, "Colony Reagents"),
];

/// Category 2 (Celestial) is mostly scenery, so only the two harvestable gas groups join
/// bucket B rather than the whole category.
pub const GAS_CATEGORY_ID: u32 = 2;
/// Group names inside [`GAS_CATEGORY_ID`] that are bucket B materials.
pub const GAS_GROUP_NAMES: &[&str] = &["Harvestable Cloud", "Compressed Gas"];

/// `[junk_seed] categories` vocabulary → category ID (plan §2.4, decision record #3).
/// This is the whole legal vocabulary: a name outside this table is a hard config error,
/// never a silently ignored line.
pub const JUNK_CATEGORY_TABLE: &[(&str, u32, &str)] = &[
    ("modules", 7, "Module"),
    ("commodities", 17, "Commodity"),
    ("charges", 8, "Charge"),
    ("drones", 18, "Drone"),
    // Category 35 holds 44 types, but only the 8 Generic Decryptors (34201-34208) carry a
    // market group and so reach the universe at all. The other 36 — the racial
    // Esoteric/Cryptic/Occult/Incognito decryptors and the four Subsystems Data Interfaces —
    // are published with `marketGroupID: null` and never enter the seed. No category-35 type
    // has a blueprint or a reprocessing row, so this adds bucket D members and nothing else.
    ("decryptors", 35, "Decryptor"),
];

/// A resolved `[junk_seed] categories` entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JunkCategory {
    /// The config spelling, e.g. `"modules"`.
    pub config_name: &'static str,
    pub category_id: u32,
    /// The SDE category name, for reporting.
    pub category_name: &'static str,
}

/// Maps configured junk-category names onto category IDs, rejecting anything outside
/// [`JUNK_CATEGORY_TABLE`]. Repeated names collapse to one entry (order preserved) so a
/// duplicated line cannot double-count bucket D.
pub fn resolve_junk_categories(names: &[String]) -> Result<Vec<JunkCategory>> {
    let mut resolved: Vec<JunkCategory> = Vec::with_capacity(names.len());
    for name in names {
        let key = name.trim().to_ascii_lowercase();
        let Some(&(config_name, category_id, category_name)) = JUNK_CATEGORY_TABLE
            .iter()
            .find(|(candidate, _, _)| *candidate == key)
        else {
            let legal = JUNK_CATEGORY_TABLE
                .iter()
                .map(|(candidate, id, _)| format!("{candidate} ({id})"))
                .collect::<Vec<_>>()
                .join(", ");
            bail!("[junk_seed] categories contains unknown category \"{name}\". Legal values: {legal}");
        };
        if resolved
            .iter()
            .any(|entry| entry.category_id == category_id)
        {
            continue;
        }
        resolved.push(JunkCategory {
            config_name,
            category_id,
            category_name,
        });
    }
    Ok(resolved)
}

/// Which industry activity yields a product. Only these two make things; invention makes
/// *blueprints*, which is what [`Classification::invention_lineage`] tracks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProducerActivity {
    Manufacturing,
    Reaction,
}

impl ProducerActivity {
    pub fn label(self) -> &'static str {
        match self {
            Self::Manufacturing => "Manufacturing",
            Self::Reaction => "Reaction",
        }
    }
}

/// How one product type is made. `per_run` is the *product* quantity, which the cost map
/// must divide by — 368 blueprints yield more than one unit per run (plan §3.1).
#[derive(Debug, Clone)]
pub struct Producer {
    pub blueprint_type_id: u32,
    /// The blueprint's own `published` flag. Unpublished formulas exist in the data and
    /// lose the tie-break to a published rival regardless of file order — see
    /// [`ProducerCollision`].
    pub blueprint_published: bool,
    pub activity: ProducerActivity,
    pub per_run: i64,
    pub materials: Vec<MaterialEntry>,
}

/// A second blueprint claiming an already-claimed product type. A published blueprint
/// beats an unpublished one; between two blueprints with the same `published` flag the
/// first in `blueprintDefinitions` order wins, which keeps the index deterministic. The
/// loser is recorded with enough detail for the report to show what the tie-break chose.
///
/// This is not cosmetic. Tungsten Carbide (16672) is claimed by an unpublished "Test
/// Reaction Blueprint" (45732, 20 per run) *before* the real formula (46207, 10,000 per
/// run), so plain first-wins would divide EIV by 20 instead of 10,000 and price the
/// material ~500x too high. The published rule is what keeps 46207. The report still
/// flags any collision whose per-run output or published flag disagrees.
#[derive(Debug, Clone, Copy)]
pub struct ProducerCollision {
    pub product_type_id: u32,
    pub kept_blueprint_type_id: u32,
    pub kept_activity: ProducerActivity,
    pub kept_per_run: i64,
    pub kept_published: bool,
    pub dropped_blueprint_type_id: u32,
    pub dropped_activity: ProducerActivity,
    pub dropped_per_run: i64,
    pub dropped_published: bool,
}

impl ProducerCollision {
    /// True when the losing blueprint would have priced the product differently — the
    /// only collisions the cost map has to care about.
    pub fn is_material_disagreement(&self) -> bool {
        self.kept_per_run != self.dropped_per_run || self.kept_published != self.dropped_published
    }
}

/// Everything a collision report needs from one side of a tie-break. Copied out of the
/// index so the winner can be written back without holding a borrow on it.
#[derive(Debug, Clone, Copy)]
struct ProducerSummary {
    blueprint_type_id: u32,
    activity: ProducerActivity,
    per_run: i64,
    published: bool,
}

impl Producer {
    fn summary(&self) -> ProducerSummary {
        ProducerSummary {
            blueprint_type_id: self.blueprint_type_id,
            activity: self.activity,
            per_run: self.per_run,
            published: self.blueprint_published,
        }
    }
}

/// product typeID → how it is made, built by scanning activity products (never the
/// precomputed `blueprintTypeIDsByProductTypeID` index — see the module docs).
#[derive(Debug, Default)]
pub struct ProducerIndex {
    by_product: HashMap<u32, Producer>,
    collisions: Vec<ProducerCollision>,
}

impl ProducerIndex {
    pub fn build(data: &StaticData) -> Self {
        let mut index = Self::default();
        for blueprint in &data.blueprints {
            let activities = [
                (
                    ProducerActivity::Manufacturing,
                    blueprint.activities.manufacturing.as_ref(),
                ),
                (
                    ProducerActivity::Reaction,
                    blueprint.activities.reaction.as_ref(),
                ),
            ];
            for (activity, definition) in activities {
                let Some(definition) = definition else {
                    continue;
                };
                for product in &definition.products {
                    let candidate = Producer {
                        blueprint_type_id: blueprint.blueprint_type_id,
                        blueprint_published: blueprint.published,
                        activity,
                        per_run: product.quantity,
                        materials: definition.materials.clone(),
                    };
                    let Some(incumbent) =
                        index.by_product.get(&product.type_id).map(Producer::summary)
                    else {
                        index.by_product.insert(product.type_id, candidate);
                        continue;
                    };

                    // Tie-break, in order:
                    //   1. published beats unpublished (Tungsten Carbide 16672 — see
                    //      `ProducerCollision`);
                    //   2. otherwise the incumbent stays, so equal-published rivals resolve
                    //      by `blueprintDefinitions` order and the index is deterministic.
                    let candidate_wins = candidate.blueprint_published && !incumbent.published;
                    let (kept, dropped) = if candidate_wins {
                        (candidate.summary(), incumbent)
                    } else {
                        (incumbent, candidate.summary())
                    };
                    index.collisions.push(ProducerCollision {
                        product_type_id: product.type_id,
                        kept_blueprint_type_id: kept.blueprint_type_id,
                        kept_activity: kept.activity,
                        kept_per_run: kept.per_run,
                        kept_published: kept.published,
                        dropped_blueprint_type_id: dropped.blueprint_type_id,
                        dropped_activity: dropped.activity,
                        dropped_per_run: dropped.per_run,
                        dropped_published: dropped.published,
                    });
                    if candidate_wins {
                        index.by_product.insert(product.type_id, candidate);
                    }
                }
            }
        }
        index
    }

    pub fn get(&self, product_type_id: u32) -> Option<&Producer> {
        self.by_product.get(&product_type_id)
    }

    pub fn len(&self) -> usize {
        self.by_product.len()
    }

    pub fn collisions(&self) -> &[ProducerCollision] {
        &self.collisions
    }
}

/// Every blueprint typeID that some `activities.invention.products[]` yields. Everything
/// those blueprints build is T2/T3 by construction, and the blueprints themselves are
/// never seeded (plan §2.1 rule 2). Expected size at SDE 3396210: 1,209.
fn build_invention_lineage(data: &StaticData) -> HashSet<u32> {
    let mut lineage = HashSet::new();
    for blueprint in &data.blueprints {
        let Some(invention) = blueprint.activities.invention.as_ref() else {
            continue;
        };
        for product in &invention.products {
            lineage.insert(product.type_id);
        }
    }
    lineage
}

/// Bucket A candidate survival after each rule, applied **in sequence**.
///
/// The order matters for reading the numbers: the raw universe holds ~2,683 types with
/// metaGroup ≥ 3, but most are SKINs and apparel that the category rule already removed.
/// Applied where it actually sits — after category, lineage and tech level — the
/// metaGroup rule removes the ~714 faction/storyline items the plan calls load-bearing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BucketAFunnel {
    /// Published types carrying a market group.
    pub universe: usize,
    /// …of which some blueprint manufactures or reacts them.
    pub manufacturable: usize,
    /// …minus the excluded categories (SKINs, apparel, skills, blueprints, …).
    pub after_category_exclusions: usize,
    /// …minus products whose blueprint is an invention product (T2/T3 lineage).
    pub after_invention_lineage: usize,
    /// …minus dogma Tech Level ≥ 2.
    pub after_tech_level: usize,
    /// …minus dogma metaGroupID ≥ 3. Equals `|A|`.
    pub after_meta_group: usize,
    /// Universe types with metaGroup ≥ 3 before any other rule, for contrast only.
    pub universe_meta_group_three_plus: usize,
}

impl BucketAFunnel {
    pub fn removed_as_not_manufacturable(&self) -> usize {
        self.universe - self.manufacturable
    }
    pub fn removed_by_category_exclusions(&self) -> usize {
        self.manufacturable - self.after_category_exclusions
    }
    pub fn removed_by_invention_lineage(&self) -> usize {
        self.after_category_exclusions - self.after_invention_lineage
    }
    pub fn removed_by_tech_level(&self) -> usize {
        self.after_invention_lineage - self.after_tech_level
    }
    pub fn removed_by_meta_group(&self) -> usize {
        self.after_tech_level - self.after_meta_group
    }
}

/// Bucket membership. A type may be in A and B at once (manufacturable materials), which
/// is why this is a flag set: it takes A's computed cost for pricing while still being
/// counted once in the seeded union.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BucketFlags {
    /// Bucket A — manufacturable T1.
    pub manufacturable_t1: bool,
    /// Bucket B — ore / mineral / material.
    pub material: bool,
    /// Bucket D — junk candidate, seeded only if a captured price exists (plan §2.4).
    pub junk_candidate: bool,
}

impl BucketFlags {
    /// D is mutually exclusive with A and B by construction, so any true flag means the
    /// type is part of the seeded set (subject to `[junk_seed] enabled` for D).
    pub fn is_classified(self) -> bool {
        self.manufacturable_t1 || self.material || self.junk_candidate
    }

    /// Short label for reports: `A`, `B`, `A+B`, `D`, or `-`.
    pub fn label(self) -> &'static str {
        match (self.manufacturable_t1, self.material, self.junk_candidate) {
            (true, true, _) => "A+B",
            (true, false, _) => "A",
            (false, true, _) => "B",
            (false, false, true) => "D",
            _ => "-",
        }
    }
}

/// Which bucket-D candidates the price manifest lets through (plan §2.4).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JunkSeedability {
    /// Candidates holding a captured real-market price: these get seed rows.
    pub seedable: BTreeSet<u32>,
    /// Candidates with no capture. Unseeded **by design** — never an error, and never a
    /// `basePrice` fallback.
    pub dropped: BTreeSet<u32>,
    /// `[junk_seed] enabled = false`: the bucket is off entirely, so nothing was dropped
    /// for want of a price.
    pub junk_disabled: bool,
}

/// The classified seed universe.
#[derive(Debug)]
pub struct Classification {
    pub universe_size: usize,
    pub producers: ProducerIndex,
    pub invention_lineage: HashSet<u32>,
    pub bucket_a: BTreeSet<u32>,
    pub bucket_b: BTreeSet<u32>,
    /// Junk *candidates*. They only become seed rows once a captured price exists.
    pub bucket_d: BTreeSet<u32>,
    pub junk_categories: Vec<JunkCategory>,
    pub junk_counts_by_category: BTreeMap<u32, usize>,
    /// Mirrors `[junk_seed] enabled`; when false, D contributes nothing to the seeded set.
    pub junk_enabled: bool,
    pub funnel: BucketAFunnel,
}

impl Classification {
    pub fn compute(data: &StaticData, junk: &JunkSeedConfig) -> Result<Self> {
        let junk_categories = resolve_junk_categories(&junk.categories)?;
        let producers = ProducerIndex::build(data);
        let invention_lineage = build_invention_lineage(data);

        let excluded_categories = EXCLUDED_CATEGORY_IDS
            .iter()
            .map(|(id, _)| *id)
            .collect::<HashSet<_>>();
        let material_categories = MATERIAL_CATEGORY_IDS
            .iter()
            .map(|(id, _)| *id)
            .collect::<HashSet<_>>();
        let junk_category_ids = junk_categories
            .iter()
            .map(|category| category.category_id)
            .collect::<HashSet<_>>();

        let mut funnel = BucketAFunnel::default();
        let mut bucket_a = BTreeSet::new();
        let mut bucket_b = BTreeSet::new();
        let mut bucket_d = BTreeSet::new();
        let mut junk_counts_by_category = BTreeMap::new();

        let universe = data.marketable_item_types().collect::<Vec<_>>();
        funnel.universe = universe.len();
        funnel.universe_meta_group_three_plus = universe
            .iter()
            .filter(|item| {
                data.meta_group_id(item.type_id)
                    .is_some_and(|value| value >= 3)
            })
            .count();

        for item in &universe {
            let type_id = item.type_id;
            let category_id = item.category_id;
            let excluded = category_id.is_some_and(|id| excluded_categories.contains(&id));

            // --- Bucket A, one rule at a time so the funnel can report where each bites.
            if let Some(producer) = producers.get(type_id) {
                funnel.manufacturable += 1;
                let mut survives = true;
                if excluded {
                    survives = false;
                }
                if survives {
                    funnel.after_category_exclusions += 1;
                    if invention_lineage.contains(&producer.blueprint_type_id) {
                        survives = false;
                    }
                }
                if survives {
                    funnel.after_invention_lineage += 1;
                    if data.tech_level(type_id) >= 2 {
                        survives = false;
                    }
                }
                if survives {
                    funnel.after_tech_level += 1;
                    if data
                        .meta_group_id(type_id)
                        .is_some_and(|meta_group| meta_group >= 3)
                    {
                        survives = false;
                    }
                }
                if survives {
                    funnel.after_meta_group += 1;
                    bucket_a.insert(type_id);
                }
            }

            // --- Bucket B: raw materials. No tech-level or metaGroup filter by design;
            // the overlap with A (~183 manufacturable materials) is expected and fine.
            if !excluded {
                let is_material = category_id.is_some_and(|id| material_categories.contains(&id))
                    || (category_id == Some(GAS_CATEGORY_ID)
                        && item
                            .group_name
                            .as_deref()
                            .is_some_and(|group| GAS_GROUP_NAMES.contains(&group)));
                if is_material {
                    bucket_b.insert(type_id);
                }
            }

            // --- Bucket D: the T1, metaGroup <= 1 leftovers in the enabled categories.
            if !excluded
                && !bucket_a.contains(&type_id)
                && !bucket_b.contains(&type_id)
                && category_id.is_some_and(|id| junk_category_ids.contains(&id))
                && !is_invention_lineage(&producers, &invention_lineage, type_id)
                && data.tech_level(type_id) < 2
                && data
                    .meta_group_id(type_id)
                    .is_none_or(|meta_group| meta_group <= 1)
            {
                bucket_d.insert(type_id);
                if let Some(id) = category_id {
                    *junk_counts_by_category.entry(id).or_insert(0) += 1;
                }
            }
        }

        Ok(Self {
            universe_size: universe.len(),
            producers,
            invention_lineage,
            bucket_a,
            bucket_b,
            bucket_d,
            junk_categories,
            junk_counts_by_category,
            junk_enabled: junk.enabled,
            funnel,
        })
    }

    pub fn flags(&self, type_id: u32) -> BucketFlags {
        BucketFlags {
            manufacturable_t1: self.bucket_a.contains(&type_id),
            material: self.bucket_b.contains(&type_id),
            junk_candidate: self.bucket_d.contains(&type_id),
        }
    }

    /// Types in both A and B — manufacturable materials such as fuel blocks.
    pub fn overlap_ab(&self) -> BTreeSet<u32> {
        self.bucket_a
            .intersection(&self.bucket_b)
            .copied()
            .collect()
    }

    /// The index seed set.
    pub fn union_ab(&self) -> BTreeSet<u32> {
        self.bucket_a.union(&self.bucket_b).copied().collect()
    }

    /// Everything that *may* get a seed row: A ∪ B ∪ D, each type counted once. D drops out
    /// entirely when junk seeding is disabled.
    ///
    /// D members here are **candidates**: whether each one is actually seeded depends on the
    /// price manifest holding a capture for it — see [`Classification::junk_seedability`].
    pub fn seeded_types(&self) -> BTreeSet<u32> {
        let mut seeded = self.union_ab();
        if self.junk_enabled {
            seeded.extend(self.bucket_d.iter().copied());
        }
        seeded
    }

    /// The seeded set broken down by membership label (`A`, `A+B`, `B`, `D`). The parts
    /// sum to `seeded_types().len()`, which is the point: an A∩B type appears once, under
    /// `A+B`, never twice.
    pub fn seeded_composition(&self) -> Vec<(&'static str, usize)> {
        let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
        for type_id in self.seeded_types() {
            let flags = self.flags(type_id);
            debug_assert!(flags.is_classified(), "seeded type {type_id} has no bucket");
            *counts.entry(flags.label()).or_insert(0) += 1;
        }
        ["A", "A+B", "B", "D"]
            .into_iter()
            .map(|label| (label, counts.get(label).copied().unwrap_or(0)))
            .collect()
    }

    /// Splits bucket D by whether the price manifest holds a **captured** price for each
    /// candidate (plan §2.4, §3.3).
    ///
    /// This is the whole bucket-D pricing rule, in one place:
    /// `cost(type) := manifest.fetchedPrice(type)` and nothing else. A D type is seeded
    /// **iff** such a capture exists. There is deliberately no ladder here — no computed
    /// cost, no `basePrice` fallback — because a D price that did not come from the real
    /// market is an invented price, and §2.4 exists to avoid inventing prices for loot.
    /// A candidate without a capture is dropped, which is the designed outcome and not an
    /// error condition.
    ///
    /// `has_capture` is a predicate rather than the manifest itself so this rule stays
    /// testable without one; production callers pass `|id| manifest.has_capture(id)`.
    pub fn junk_seedability(&self, has_capture: impl Fn(u32) -> bool) -> JunkSeedability {
        let mut seedability = JunkSeedability::default();
        if !self.junk_enabled {
            // The whole bucket is off; nothing is seedable and nothing was "dropped" for
            // want of a price.
            seedability.junk_disabled = true;
            return seedability;
        }
        for type_id in &self.bucket_d {
            if has_capture(*type_id) {
                seedability.seedable.insert(*type_id);
            } else {
                seedability.dropped.insert(*type_id);
            }
        }
        seedability
    }

    /// Bucket A types whose producer is a reaction — proves the reaction scan works.
    pub fn reaction_produced_in_a(&self) -> usize {
        self.bucket_a
            .iter()
            .filter(|type_id| {
                self.producers
                    .get(**type_id)
                    .is_some_and(|producer| producer.activity == ProducerActivity::Reaction)
            })
            .count()
    }

    /// Bucket A types whose blueprint yields more than one unit per run. The cost map
    /// must divide by `per_run` for these (plan §3.1).
    pub fn multi_output_in_a(&self) -> usize {
        self.bucket_a
            .iter()
            .filter(|type_id| {
                self.producers
                    .get(**type_id)
                    .is_some_and(|producer| producer.per_run > 1)
            })
            .count()
    }

    /// Distinct input material types across bucket A's blueprints, and how many of them
    /// sit outside A ∪ B — a preview of the cost map's leaf surface (plan §3.2/§3.3).
    pub fn bucket_a_material_surface(&self) -> (usize, usize) {
        let union = self.union_ab();
        let mut materials = HashSet::new();
        for type_id in &self.bucket_a {
            let Some(producer) = self.producers.get(*type_id) else {
                continue;
            };
            for material in &producer.materials {
                materials.insert(material.type_id);
            }
        }
        let outside = materials
            .iter()
            .filter(|type_id| !union.contains(type_id))
            .count();
        (materials.len(), outside)
    }

    /// Bucket A grouped by category, most populous first, with a couple of sample names.
    pub fn bucket_a_by_category<'a>(
        &self,
        data: &'a StaticData,
    ) -> Vec<(Option<u32>, usize, Vec<&'a str>)> {
        let mut by_category: BTreeMap<Option<u32>, (usize, Vec<&str>)> = BTreeMap::new();
        for type_id in &self.bucket_a {
            let Some(item) = data.item_type(*type_id) else {
                continue;
            };
            let entry = by_category.entry(item.category_id).or_insert((0, Vec::new()));
            entry.0 += 1;
            if entry.1.len() < 2 {
                entry.1.push(item.name.as_str());
            }
        }
        let mut rows = by_category
            .into_iter()
            .map(|(category_id, (count, samples))| (category_id, count, samples))
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
        rows
    }
}

/// True when a type's T2/T3 lineage is provable: either the blueprint that makes it is an
/// invention product, or the type *is* such a blueprint. The second arm is belt and
/// braces — category 9 is excluded before this runs — but it keeps the rule honest if the
/// category list ever changes.
fn is_invention_lineage(
    producers: &ProducerIndex,
    invention_lineage: &HashSet<u32>,
    type_id: u32,
) -> bool {
    if invention_lineage.contains(&type_id) {
        return true;
    }
    producers
        .get(type_id)
        .is_some_and(|producer| invention_lineage.contains(&producer.blueprint_type_id))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::config::{JunkSeedConfig, SeederConfig};
    use crate::staticdata::{
        BlueprintActivities, BlueprintActivity, BlueprintDefinition, DogmaProjection,
        InventionActivity, InventionProductEntry, ItemTypeRecord, MaterialEntry, ProductEntry,
    };

    const CATEGORY_MODULE: u32 = 7;
    const CATEGORY_MATERIAL: u32 = 4;
    const CATEGORY_ASTEROID: u32 = 25;
    const CATEGORY_SKILL: u32 = 16;
    const CATEGORY_BLUEPRINT: u32 = 9;
    const CATEGORY_DECRYPTOR: u32 = 35;
    /// The category the four unpublished "decryptor"-named test rows live in. Not in any
    /// table here, and deliberately so.
    const CATEGORY_SALVAGE_DECRYPTOR: u32 = 350_001;

    fn item(type_id: u32, category_id: u32, name: &str) -> ItemTypeRecord {
        ItemTypeRecord {
            type_id,
            group_id: Some(1),
            category_id: Some(category_id),
            group_name: Some("Test Group".to_string()),
            name: name.to_string(),
            mass: None,
            volume: None,
            capacity: None,
            portion_size: None,
            race_id: None,
            base_price: Some(1.0),
            market_group_id: Some(1),
            icon_id: None,
            sound_id: None,
            graphic_id: None,
            radius: None,
            published: true,
        }
    }

    fn blueprint(blueprint_type_id: u32, activities: BlueprintActivities) -> BlueprintDefinition {
        BlueprintDefinition {
            blueprint_type_id,
            blueprint_name: format!("Blueprint {blueprint_type_id}"),
            // Deliberately 0 for every fixture blueprint: the real reaction rows carry 0
            // here, and the classifier must never depend on this field.
            product_type_id: 0,
            product_name: String::new(),
            max_production_limit: None,
            published: true,
            activities,
        }
    }

    fn activity(product_type_id: u32, per_run: i64, materials: &[(u32, i64)]) -> BlueprintActivity {
        BlueprintActivity {
            materials: materials
                .iter()
                .map(|(type_id, quantity)| MaterialEntry {
                    type_id: *type_id,
                    quantity: *quantity,
                })
                .collect(),
            products: vec![ProductEntry {
                type_id: product_type_id,
                quantity: per_run,
            }],
            time: Some(100),
        }
    }

    fn manufacturing(
        blueprint_type_id: u32,
        product_type_id: u32,
        per_run: i64,
    ) -> BlueprintDefinition {
        blueprint(
            blueprint_type_id,
            BlueprintActivities {
                manufacturing: Some(activity(product_type_id, per_run, &[(34, 100)])),
                ..BlueprintActivities::default()
            },
        )
    }

    fn reaction(blueprint_type_id: u32, product_type_id: u32, per_run: i64) -> BlueprintDefinition {
        blueprint(
            blueprint_type_id,
            BlueprintActivities {
                reaction: Some(activity(product_type_id, per_run, &[(16634, 100)])),
                ..BlueprintActivities::default()
            },
        )
    }

    /// A T1 blueprint whose invention activity yields `invented_blueprint_type_id` — the
    /// shape that puts a blueprint into the invention-lineage set.
    fn inventor(blueprint_type_id: u32, invented_blueprint_type_id: u32) -> BlueprintDefinition {
        blueprint(
            blueprint_type_id,
            BlueprintActivities {
                invention: Some(InventionActivity {
                    materials: Vec::new(),
                    products: vec![InventionProductEntry {
                        type_id: invented_blueprint_type_id,
                        quantity: 1,
                        probability: Some(0.3),
                    }],
                    time: Some(100),
                }),
                ..BlueprintActivities::default()
            },
        )
    }

    fn dogma(tech_level: Option<f64>, meta_group_id: Option<i64>) -> DogmaProjection {
        DogmaProjection {
            tech_level,
            meta_group_id,
        }
    }

    fn fixture(
        item_types: Vec<ItemTypeRecord>,
        blueprints: Vec<BlueprintDefinition>,
        dogma: Vec<(u32, DogmaProjection)>,
    ) -> StaticData {
        let mut item_types = item_types;
        item_types.sort_by_key(|item| item.type_id);
        let item_type_index = item_types
            .iter()
            .enumerate()
            .map(|(index, item)| (item.type_id, index))
            .collect::<HashMap<_, _>>();
        StaticData {
            dir: PathBuf::from("."),
            stations: Vec::new(),
            station_index: HashMap::new(),
            solar_systems: Vec::new(),
            solar_system_index: HashMap::new(),
            item_types,
            item_type_index,
            blueprints,
            dogma: dogma.into_iter().collect::<HashMap<_, _>>(),
        }
    }

    fn classify(data: &StaticData) -> Classification {
        Classification::compute(data, &JunkSeedConfig::default()).expect("fixture classifies")
    }

    #[test]
    fn reaction_only_blueprint_products_are_found_despite_top_level_product_type_id_zero() {
        // Regression for the trap that motivates the whole producer index: reaction
        // blueprints carry productTypeID 0, so the precomputed
        // blueprintTypeIDsByProductTypeID index misses all 120 of them.
        let data = fixture(
            vec![item(16670, CATEGORY_MATERIAL, "Crystalline Carbonide")],
            vec![reaction(46168, 16670, 10_000)],
            Vec::new(),
        );

        let result = classify(&data);
        let producer = result
            .producers
            .get(16670)
            .expect("the reaction product must be indexed");
        assert_eq!(producer.blueprint_type_id, 46168);
        assert_eq!(producer.activity, ProducerActivity::Reaction);
        assert_eq!(producer.per_run, 10_000);
        assert_eq!(producer.materials.len(), 1);
        assert!(result.bucket_a.contains(&16670));
        assert_eq!(result.reaction_produced_in_a(), 1);
        assert_eq!(result.multi_output_in_a(), 1);
    }

    #[test]
    fn invention_lineage_product_is_excluded_from_bucket_a() {
        // 2488 is built by blueprint 2489, which invention yields → the product is T2.
        let data = fixture(
            vec![
                item(2488, CATEGORY_MODULE, "Warp Disruptor II"),
                item(2487, CATEGORY_MODULE, "Warp Disruptor I"),
            ],
            vec![
                manufacturing(2489, 2488, 1),
                manufacturing(2486, 2487, 1),
                inventor(2486, 2489),
            ],
            Vec::new(),
        );

        let result = classify(&data);
        assert!(result.invention_lineage.contains(&2489));
        assert!(!result.bucket_a.contains(&2488));
        assert!(result.bucket_a.contains(&2487));
        assert_eq!(result.funnel.removed_by_invention_lineage(), 1);
        // Nor may it fall through into the junk bucket.
        assert!(!result.bucket_d.contains(&2488));
    }

    #[test]
    fn tech_level_two_type_is_excluded_from_bucket_a() {
        // Dogma-only T2 signal: no invention lineage recorded, attribute 422 = 2.
        let data = fixture(
            vec![item(3001, CATEGORY_MODULE, "Something II")],
            vec![manufacturing(3002, 3001, 1)],
            vec![(3001, dogma(Some(2.0), Some(2)))],
        );

        let result = classify(&data);
        assert!(!result.bucket_a.contains(&3001));
        assert_eq!(result.funnel.removed_by_tech_level(), 1);
        assert!(!result.bucket_d.contains(&3001));
    }

    #[test]
    fn meta_group_four_faction_type_with_a_t1_blueprint_is_excluded_from_bucket_a_714_item_leak() {
        // The 714-item leak class from plan §2.1 rule 4: an SDE blueprint, Tech Level 1
        // (attribute 422 absent), and only metaGroupID 4 marks it as faction gear.
        let data = fixture(
            vec![
                item(4005, CATEGORY_MODULE, "Domination Warp Disruptor"),
                item(4006, CATEGORY_MODULE, "Warp Disruptor I"),
            ],
            vec![manufacturing(4105, 4005, 1), manufacturing(4106, 4006, 1)],
            vec![
                (4005, dogma(None, Some(4))),
                (4006, dogma(None, Some(1))),
            ],
        );

        let result = classify(&data);
        assert_eq!(data.tech_level(4005), 1, "the leak class is Tech Level 1");
        assert!(!result.bucket_a.contains(&4005));
        assert!(result.bucket_a.contains(&4006));
        assert_eq!(result.funnel.removed_by_meta_group(), 1);
        // metaGroup 4 also fails bucket D's `<= 1` rule, so it is seeded nowhere.
        assert!(!result.bucket_d.contains(&4005));
        assert!(!result.flags(4005).is_classified());
    }

    #[test]
    fn skills_and_blueprints_never_land_in_any_bucket() {
        let data = fixture(
            vec![
                item(3300, CATEGORY_SKILL, "Gunnery"),
                item(1234, CATEGORY_BLUEPRINT, "Rifter Blueprint"),
                item(587, CATEGORY_MODULE, "Rifter"),
            ],
            // The blueprint type is itself manufacturable (BPO copies aside, the fixture
            // just needs it to reach the funnel) and produces the ship.
            vec![manufacturing(1234, 587, 1), manufacturing(9999, 1234, 1)],
            Vec::new(),
        );

        let result = classify(&data);
        for type_id in [3300_u32, 1234] {
            assert!(
                !result.flags(type_id).is_classified(),
                "type {type_id} must not be classified"
            );
        }
        assert!(result.bucket_a.contains(&587));
        assert_eq!(result.funnel.removed_by_category_exclusions(), 1);
    }

    #[test]
    fn ore_lands_in_b_and_a_fuel_block_lands_in_both_a_and_b_counted_once() {
        let data = fixture(
            vec![
                item(1230, CATEGORY_ASTEROID, "Veldspar"),
                item(4051, CATEGORY_MATERIAL, "Nitrogen Fuel Block"),
                item(587, CATEGORY_MODULE, "Rifter"),
            ],
            vec![manufacturing(4312, 4051, 40), manufacturing(688, 587, 1)],
            Vec::new(),
        );

        let result = classify(&data);
        assert_eq!(result.bucket_b, BTreeSet::from([1230, 4051]));
        assert_eq!(result.bucket_a, BTreeSet::from([4051, 587]));
        assert_eq!(result.overlap_ab(), BTreeSet::from([4051]));
        assert_eq!(result.flags(4051).label(), "A+B");
        assert_eq!(result.flags(1230).label(), "B");

        // |A| + |B| = 4, but the union — the number of seeded types — is 3.
        assert_eq!(result.bucket_a.len() + result.bucket_b.len(), 4);
        assert_eq!(result.union_ab().len(), 3);
        assert_eq!(result.seeded_types().len(), 3);
        // Ore carries no blueprint and is never filtered on tech level or metaGroup.
        assert!(result.producers.get(1230).is_none());
    }

    #[test]
    fn junk_candidates_exclude_a_and_b_members_and_respect_the_enabled_flag() {
        let data = fixture(
            vec![
                item(1230, CATEGORY_ASTEROID, "Veldspar"),
                item(587, CATEGORY_MODULE, "Rifter"),
                item(5001, CATEGORY_MODULE, "Some Named Module"),
            ],
            vec![manufacturing(688, 587, 1)],
            Vec::new(),
        );

        let result = classify(&data);
        assert_eq!(result.bucket_d, BTreeSet::from([5001]));
        assert_eq!(result.junk_counts_by_category.get(&CATEGORY_MODULE), Some(&1));
        assert_eq!(result.seeded_types().len(), 3);

        let disabled = JunkSeedConfig {
            enabled: false,
            ..JunkSeedConfig::default()
        };
        let result = Classification::compute(&data, &disabled).expect("fixture classifies");
        assert_eq!(result.bucket_d.len(), 1, "candidates are still reported");
        assert_eq!(result.seeded_types().len(), 2, "but none are seeded");
    }

    #[test]
    fn decryptors_resolve_to_category_thirty_five() {
        let resolved = resolve_junk_categories(&["decryptors".to_string()])
            .expect("decryptors is a legal category name");
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].config_name, "decryptors");
        assert_eq!(resolved[0].category_id, CATEGORY_DECRYPTOR);
        assert_eq!(resolved[0].category_name, "Decryptor");

        // The default config enables it, so a stock build seeds the bucket.
        assert!(
            JunkSeedConfig::default()
                .categories
                .iter()
                .any(|name| name == "decryptors"),
            "the shipped default must enable the category the table now knows"
        );
    }

    #[test]
    fn every_supported_decryptor_lands_in_bucket_d_and_unpublished_test_rows_do_not() {
        // The eight Generic Decryptors are the published, market-grouped types the emulator
        // accepts for invention. They have no dogma (so Tech 1 and no metaGroup) and no
        // blueprint. 367777 is one of the four category-350001 test rows: unpublished, no
        // market group, and outside every table here.
        let mut salvage_junk = item(367_777, CATEGORY_SALVAGE_DECRYPTOR, "Basic Decryptor2");
        salvage_junk.published = false;
        salvage_junk.market_group_id = None;

        let data = fixture(
            vec![
                item(34_201, CATEGORY_DECRYPTOR, "Accelerant Decryptor"),
                item(34_202, CATEGORY_DECRYPTOR, "Attainment Decryptor"),
                item(34_203, CATEGORY_DECRYPTOR, "Augmentation Decryptor"),
                item(34_204, CATEGORY_DECRYPTOR, "Parity Decryptor"),
                item(34_205, CATEGORY_DECRYPTOR, "Process Decryptor"),
                item(34_206, CATEGORY_DECRYPTOR, "Symmetry Decryptor"),
                item(34_207, CATEGORY_DECRYPTOR, "Optimized Attainment Decryptor"),
                item(34_208, CATEGORY_DECRYPTOR, "Optimized Augmentation Decryptor"),
                salvage_junk,
            ],
            Vec::new(),
            Vec::new(),
        );

        let result = classify(&data);
        assert_eq!(
            result.universe_size, 8,
            "every published, market-grouped Generic Decryptor"
        );
        assert_eq!(
            result.bucket_d,
            BTreeSet::from([
                34_201, 34_202, 34_203, 34_204, 34_205, 34_206, 34_207, 34_208,
            ])
        );
        assert_eq!(
            result.junk_counts_by_category.get(&CATEGORY_DECRYPTOR),
            Some(&8)
        );
        assert_eq!(result.flags(34_201).label(), "D");
        assert_eq!(result.flags(34_208).label(), "D");
        // Bucket D is capture-only, and every real decryptor has basePrice 0, so nothing here
        // can be seeded off static data alone.
        assert!(result.bucket_a.is_empty());
        assert!(result.bucket_b.is_empty());

        // The test junk is in neither the universe nor any bucket, whatever its name says.
        assert!(!result.flags(367_777).is_classified());
        assert!(!result.bucket_d.contains(&367_777));

        // And category 350001 is not a legal config word, so it cannot be opted into either.
        resolve_junk_categories(&["salvage decryptors".to_string()])
            .expect_err("only the table's own names resolve");
    }

    #[test]
    fn junk_seedability_needs_a_capture_and_never_falls_back_to_base_price() {
        // Every fixture item carries basePrice 1.0, so if bucket D had any fallback at all
        // this would seed both candidates. §2.4 says only the captured one is seeded.
        let data = fixture(
            vec![
                item(5001, CATEGORY_MODULE, "Captured Named Module"),
                item(5002, CATEGORY_MODULE, "Uncaptured Named Module"),
            ],
            Vec::new(),
            Vec::new(),
        );
        let result = classify(&data);
        assert_eq!(result.bucket_d, BTreeSet::from([5001, 5002]));
        assert!(
            data.item_type(5002).and_then(|item| item.base_price).unwrap() > 0.0,
            "the uncaptured candidate does have a basePrice — that is the trap"
        );

        let seedability = result.junk_seedability(|type_id| type_id == 5001);
        assert_eq!(seedability.seedable, BTreeSet::from([5001]));
        assert_eq!(seedability.dropped, BTreeSet::from([5002]));
        assert!(!seedability.junk_disabled);

        // With no captures at all, the whole bucket is dropped — the designed outcome, not
        // an error.
        let none = result.junk_seedability(|_| false);
        assert!(none.seedable.is_empty());
        assert_eq!(none.dropped.len(), 2);

        let disabled = Classification::compute(
            &data,
            &JunkSeedConfig {
                enabled: false,
                ..JunkSeedConfig::default()
            },
        )
        .expect("fixture classifies");
        let off = disabled.junk_seedability(|_| true);
        assert!(off.junk_disabled);
        assert!(off.seedable.is_empty());
        assert!(off.dropped.is_empty());
    }

    #[test]
    fn unknown_junk_category_name_is_rejected() {
        let error = resolve_junk_categories(&["modules".to_string(), "wormholes".to_string()])
            .expect_err("an unknown category name must be a hard error");
        let message = format!("{error:#}");
        assert!(message.contains("wormholes"), "message: {message}");
        assert!(message.contains("modules (7)"), "message: {message}");
        assert!(message.contains("drones (18)"), "message: {message}");
        assert!(message.contains("decryptors (35)"), "message: {message}");

        // …and the same rejection happens at config-parse time, not at classify time.
        let error = SeederConfig::from_toml_str("[junk_seed]\ncategories = [\"wormholes\"]\n")
            .expect_err("config must reject the unknown category");
        assert!(format!("{error:#}").contains("wormholes"));
    }

    #[test]
    fn every_documented_junk_category_name_resolves() {
        let names = JUNK_CATEGORY_TABLE
            .iter()
            .map(|(name, _, _)| (*name).to_string())
            .collect::<Vec<_>>();
        let resolved = resolve_junk_categories(&names).expect("the whole table is legal");
        assert_eq!(resolved.len(), JUNK_CATEGORY_TABLE.len());
        assert_eq!(
            resolved.iter().map(|c| c.category_id).collect::<Vec<_>>(),
            vec![7, 17, 8, 18, 35]
        );

        // Duplicates collapse rather than double-counting bucket D.
        let deduped = resolve_junk_categories(&["modules".to_string(), "modules".to_string()])
            .expect("duplicates are legal");
        assert_eq!(deduped.len(), 1);
    }

    #[test]
    fn unpublished_and_market_groupless_types_are_outside_the_universe() {
        let mut unpublished = item(6001, CATEGORY_MODULE, "Unpublished Module");
        unpublished.published = false;
        let mut no_market_group = item(6002, CATEGORY_MODULE, "Non-market Module");
        no_market_group.market_group_id = None;

        let data = fixture(
            vec![unpublished, no_market_group, item(587, CATEGORY_MODULE, "Rifter")],
            vec![
                manufacturing(6101, 6001, 1),
                manufacturing(6102, 6002, 1),
                manufacturing(688, 587, 1),
            ],
            Vec::new(),
        );

        let result = classify(&data);
        assert_eq!(result.universe_size, 1);
        assert_eq!(result.bucket_a, BTreeSet::from([587]));
        assert!(!result.flags(6001).is_classified());
        assert!(!result.flags(6002).is_classified());
    }

    #[test]
    fn two_published_blueprints_for_one_product_keep_the_first_and_are_counted() {
        // Both sides published, so rule 1 cannot separate them and file order decides.
        // This is the determinism guarantee: the published tie-break must not reorder
        // collisions that it has no opinion about.
        let data = fixture(
            vec![item(7001, CATEGORY_MATERIAL, "Contested Product")],
            vec![manufacturing(7100, 7001, 1), reaction(7200, 7001, 5)],
            Vec::new(),
        );

        let result = classify(&data);
        let producer = result.producers.get(7001).expect("indexed");
        assert!(producer.blueprint_published);
        assert_eq!(producer.blueprint_type_id, 7100);
        assert_eq!(producer.per_run, 1);
        assert_eq!(producer.activity, ProducerActivity::Manufacturing);
        assert_eq!(result.producers.collisions().len(), 1);
        let collision = result.producers.collisions()[0];
        assert_eq!(collision.product_type_id, 7001);
        assert_eq!(collision.kept_blueprint_type_id, 7100);
        assert_eq!(collision.dropped_blueprint_type_id, 7200);
        assert_eq!(collision.dropped_activity, ProducerActivity::Reaction);
        assert_eq!(collision.kept_per_run, 1);
        assert_eq!(collision.dropped_per_run, 5);
        assert!(collision.kept_published);
        assert!(collision.dropped_published);
    }

    #[test]
    fn a_published_formula_registered_after_an_unpublished_one_wins_tungsten_carbide_16672() {
        // The real shape of Tungsten Carbide (product 16672) at SDE 3396210:
        //   bp 45732 "Test Reaction Blueprint"        published false,     20 / run
        //   bp 46207 "Tungsten Carbide Reaction Fmla" published true,  10,000 / run
        // 45732 comes first in blueprintDefinitions order, so plain first-wins would keep
        // it and the cost map's EIV / per-run divide would price the material ~500x high.
        // Rule 1 (published beats unpublished) has to override file order here.
        let mut test_formula = reaction(45732, 16672, 20);
        test_formula.published = false;
        test_formula.activities.reaction =
            Some(activity(16672, 20, &[(16657, 100), (16661, 100)]));
        let real_formula = blueprint(
            46207,
            BlueprintActivities {
                reaction: Some(activity(
                    16672,
                    10_000,
                    &[(4051, 5), (16657, 100), (16661, 100)],
                )),
                ..BlueprintActivities::default()
            },
        );
        let data = fixture(
            vec![item(16672, CATEGORY_MATERIAL, "Tungsten Carbide")],
            vec![test_formula, real_formula],
            Vec::new(),
        );

        let result = classify(&data);
        let producer = result.producers.get(16672).expect("indexed");
        assert_eq!(producer.blueprint_type_id, 46207);
        assert!(producer.blueprint_published);
        assert_eq!(producer.per_run, 10_000);
        // The materials the cost map will read must come from the winner, not the loser.
        assert_eq!(
            producer
                .materials
                .iter()
                .map(|entry| (entry.type_id, entry.quantity))
                .collect::<Vec<_>>(),
            vec![(4051, 5), (16657, 100), (16661, 100)]
        );

        // …and the losing side is still reported, oriented the way the rule chose.
        assert_eq!(result.producers.collisions().len(), 1);
        let collision = result.producers.collisions()[0];
        assert!(collision.is_material_disagreement());
        assert_eq!(collision.kept_blueprint_type_id, 46207);
        assert_eq!(collision.kept_per_run, 10_000);
        assert!(collision.kept_published);
        assert_eq!(collision.dropped_blueprint_type_id, 45732);
        assert_eq!(collision.dropped_per_run, 20);
        assert!(!collision.dropped_published);
    }

    #[test]
    fn a_resolved_tie_break_still_reports_the_collision_in_either_file_order() {
        // Same pair as above with the published blueprint first, where rule 1 and file
        // order agree. The kept side must be identical, and the collision must still be
        // recorded and still flagged `!` — resolving a tie-break never silences it.
        let mut test_formula = reaction(45732, 16672, 20);
        test_formula.published = false;
        let data = fixture(
            vec![item(16672, CATEGORY_MATERIAL, "Tungsten Carbide")],
            vec![reaction(46207, 16672, 10_000), test_formula],
            Vec::new(),
        );

        let result = classify(&data);
        let producer = result.producers.get(16672).expect("indexed");
        assert_eq!(producer.blueprint_type_id, 46207);
        assert_eq!(producer.per_run, 10_000);

        assert_eq!(result.producers.collisions().len(), 1);
        let collision = result.producers.collisions()[0];
        assert!(collision.is_material_disagreement());
        assert_eq!(collision.product_type_id, 16672);
        assert_eq!(collision.kept_blueprint_type_id, 46207);
        assert_eq!(collision.dropped_blueprint_type_id, 45732);
    }
}
